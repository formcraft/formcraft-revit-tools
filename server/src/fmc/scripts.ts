import path from "node:path";

const win = path.win32;

/**
 * Check › Scripts (U24, board model/PaneScripts): the kit's scripts (05_Scripts) read from their own headers. The kit
 * has no script register, so nothing here is invented: name, what it does, inputs and the status line come from the
 * file; "changes the model" is read from the code (a Transaction). Formcraft lists them and says where they run
 * (pyRevit's FMC tab, Dynamo Player, a Python prompt); it doesn't run them (Manual 17: scripts pass the release gate in
 * their own tool).
 */
export interface KitScript {
  name: string;
  type: "pyRevit" | "Dynamo (Python node)" | "Python tool";
  file: string;
  does: string;
  status: string;
  manual: string;
  inputs: string[];
  changes_model: boolean;
  runs_in: string;
  formcraft: string;
}

/** Formcraft's own section that does the same job, so a person can use the one with a dry run in the pane. */
const FORMCRAFT_DOES: Array<[RegExp, string]> = [
  [/CreateSheets/i, "Drawings › Sheets (Create, dry run first)"],
  [/SheetQA/i, "Drawings › Issue (Ready to issue check)"],
  [/ModelHealth/i, "Check › QA"],
  [/ProjectMetrics/i, "Setup › Project"],
  [/BindSharedParameters/i, "Setup › Templates"],
  [/name_check/i, "Check › QA (naming rules)"],
  [/new_project/i, "Setup › Project (create the folders)"],
];

function firstParagraph(lines: string[]): string {
  const out: string[] = [];
  for (const l of lines) {
    if (!l.trim()) { if (out.length) break; continue; }
    out.push(l.trim());
  }
  return out.join(" ");
}

function statusOf(text: string): string {
  const m = text.match(/Status:\s*([^\n|]+)/i);
  if (m) return m[1].trim().replace(/\.$/, "");
  if (/not yet run|validate on a copy|pilot[- ]test/i.test(text)) return "Pilot test before production";
  return "Not stated in the file";
}

const manualOf = (text: string) => (text.match(/Manual Part [\d.]+|FMC-BIM-STD-\d+[^|\n]*/i)?.[0] ?? "").trim();
// pyRevit opens a Transaction; a Dynamo Python node asks Dynamo's TransactionManager for one.
const changes = (text: string) => /\bTransaction\s*\(|EnsureInTransaction|TransactionManager\.Instance/.test(text);

/** A Dynamo Python node: "# NAME  -  Dynamo Python Script node", a comment block, then IN[n] lines. */
export function readDynamo(file: string, text: string): KitScript {
  const comments = text.split(/\r?\n/).filter((l) => l.startsWith("#")).map((l) => l.replace(/^#\s?/, ""));
  const name = (comments[0] ?? "").split(/\s+-\s+/)[0].trim() || win.basename(file, ".py");
  const body = comments.slice(1).filter((l) => !/^Formcraft kit|^Inputs|^Output|^\s*IN\[|^\s*OUT/.test(l));
  const inputs = comments.filter((l) => /^\s*IN\[\d+\]/.test(l)).map((l) => l.trim().replace(/\s+/g, " "));
  return { name, type: "Dynamo (Python node)", file, does: firstParagraph(body), status: statusOf(text), manual: manualOf(text), inputs,
    changes_model: changes(text), runs_in: "Dynamo Player (a Python Script node in a graph)", formcraft: formcraftFor(name) };
}

/** A pyRevit pushbutton: bundle.yaml title and tooltip, script.py docstring. */
export function readPyRevit(folder: string, bundle: string, script: string): KitScript {
  const title = bundle.match(/^title:\s*"?([^"\n]+)"?/m)?.[1]?.trim() ?? win.basename(folder, ".pushbutton");
  const doc = script.match(/"""([\s\S]*?)"""/)?.[1] ?? "";
  const docLines = doc.split(/\r?\n/);
  const name = docLines[0]?.split(/\s+-\s+/)[0].trim() || title;
  return { name, type: "pyRevit", file: win.join(folder, "script.py"), does: firstParagraph(docLines.slice(1).filter((l) => !/Status:/i.test(l))) || docLines[0] || title,
    status: statusOf(doc + "\n" + bundle), manual: manualOf(doc + "\n" + bundle), inputs: [], changes_model: changes(script),
    runs_in: `pyRevit › FMC tab › ${title}`, formcraft: formcraftFor(name) };
}

/** A command-line tool in 05_Scripts\tools: its docstring. */
export function readTool(file: string, text: string): KitScript {
  const doc = text.match(/"""([\s\S]*?)"""/)?.[1] ?? "";
  const lines = doc.split(/\r?\n/);
  const name = win.basename(file, ".py");
  return { name, type: "Python tool", file, does: lines[0]?.trim() || name, status: statusOf(doc), manual: manualOf(doc), inputs: [],
    changes_model: false, runs_in: `python ${win.basename(file)} (outside Revit)`, formcraft: formcraftFor(name) };
}

function formcraftFor(name: string): string {
  return FORMCRAFT_DOES.find(([re]) => re.test(name))?.[1] ?? "";
}

/** The steps an automation can chain: Formcraft's own read-only checks and its report (never a model change). */
export const STEPS = {
  selftest: "Self-test (connection, add-in, kit)",
  qa: "QA check (the gate's rules)",
  links: "Links audit",
  workshare: "Workshare check",
  annotate: "Annotation check (current view)",
  review: "Open review items",
  report: "Weekly project report (Markdown and CSV)",
} as const;
export type StepId = keyof typeof STEPS;

/** One line about a step's result, from the tool's own reply. */
export function stepSummary(step: StepId, body: any): string {
  if (!body || typeof body !== "object") return "done";
  if (body.error) return String(body.error);
  if (body.refused) return (body.reasons ?? []).join(" ");
  switch (step) {
    case "selftest": return `${body.result ?? "done"}: ${body.pass ?? 0} pass, ${body.warn ?? 0} warn, ${body.fail ?? 0} fail`;
    case "qa": return `${body.verdict ?? "done"}: ${body.fail ?? 0} fail, ${body.warning ?? 0} warnings`;
    case "links": return `${(body.links ?? []).length} links, ${body.to_fix ?? 0} to fix`;
    case "workshare": return body.workshared ? `${(body.missing ?? []).length} standard worksets missing, ${(body.naming ?? []).length} names to fix` : "Not workshared";
    case "annotate": return `${(body.checks ?? []).filter((c: any) => c.state === "Fail").length} of ${(body.checks ?? []).length} checks fail`;
    case "review": return `${body.count ?? 0} open items, ${body.overdue ?? 0} overdue`;
    case "report": return body.done ? `Saved ${body.name ?? ""}` : "done";
  }
  return "done";
}
