/**
 * A calculation sheet for the engineer: Markdown to read, CSV for a spreadsheet, JSON for tools. Written only into the
 * project's 01_WIP\<Role>\_Calcs, never over an earlier sheet (rule 2). Every sheet says it is a draft the engineer checks
 * and signs, and lists every TBC with what is missing.
 */
import path from "node:path";
import { GuardConfig, checkWritePath, csvLine, isInside } from "../policy.js";
import { CalcResult, Row, Val } from "./types.js";

const win = path.win32;

export const DRAFT_HEADER = "Draft for the engineer to check and sign — Formcraft does not size or sign";

export interface SheetMeta { model: string; kit: string; date: string; project: string }

const show = (v: Val) => (v.value === null ? "TBC" : `${v.value}${v.unit ? ` ${v.unit}` : ""}`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function table(rows: Row[]): string[] {
  if (!rows.length) return ["(none)"];
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.values)))];
  const hasCheck = rows.some((r) => r.check);
  const head = ["Item", ...keys.map((k) => k.replace(/_/g, " ")), ...(hasCheck ? ["Check", "Result"] : []), "Source"];
  const out = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of rows) {
    const sources = [...new Set(Object.values(r.values).map((v) => v.source).filter((s) => s !== "calc"))];
    const cells = [r.item + (r.note ? ` (${r.note})` : ""), ...keys.map((k) => (r.values[k] ? show(r.values[k]) : "")),
      ...(hasCheck ? [r.check?.rule ?? "", r.check ? r.check.result.toUpperCase() : ""] : []), sources.join(", ")];
    out.push(`| ${cells.map(cell).join(" | ")} |`);
  }
  return out;
}

export function sheetMarkdown(r: CalcResult, meta: SheetMeta): string {
  const lines = [
    `# ${r.id} ${r.title}`, "", `**${DRAFT_HEADER}.**`, "",
    `- Project: ${meta.project || "(not set)"}`, `- Model: ${meta.model || "(not read)"}`, `- Date: ${meta.date}`, `- Kit: ${meta.kit}`,
    `- Method (${r.method_source}): ${r.method || "(not in the kit)"}`, `- Result: **${r.result.toUpperCase()}**`, "",
    "## Calculation", "", ...table(r.rows), "",
  ];
  if (r.totals.length) lines.push("## Totals and checks", "", ...table(r.totals), "");
  lines.push("## TBC: what is missing", "");
  if (r.tbc.length) lines.push(...r.tbc.map((t) => `- ${t.item}: ${t.missing}${t.kit_request ? " (kit change request)" : ""}`));
  else lines.push("Nothing is TBC.");
  lines.push("");
  if (r.notes.length) lines.push("## Notes", "", ...r.notes.map((n) => `- ${n}`), "");
  lines.push("## Sources", "", "kit:<tab>!<cell> is the kit workbook's value; model:<id> the Revit element; model a sum over the model; engineer a value given in the call; calc worked out with the kit's formula; TBC missing.", "",
    "## Check and sign", "", "| | Name | Signature | Date |", "|---|---|---|---|", "| Checked by | | | |", "| Approved by (engineer of record) | | | |", "");
  return lines.join("\n");
}

export function sheetCsv(r: CalcResult): string {
  let s = csvLine(["calc", "section", "item", "field", "value", "unit", "source", "check", "result", "note"]);
  const put = (section: string, rows: Row[]) => {
    for (const row of rows) {
      const entries = Object.entries(row.values);
      if (!entries.length) s += csvLine([r.id, section, row.item, "", "", "", "", row.check?.rule ?? "", row.check?.result ?? "", row.note ?? ""]);
      entries.forEach(([k, v], i) => {
        const last = i === entries.length - 1;
        s += csvLine([r.id, section, row.item, k, v.value === null ? "TBC" : v.value, v.unit ?? "", v.source, last ? row.check?.rule ?? "" : "", last ? row.check?.result ?? "" : "", last ? row.note ?? "" : ""]);
      });
    }
  };
  put("calculation", r.rows);
  put("totals", r.totals);
  for (const t of r.tbc) s += csvLine([r.id, "tbc", t.item, "missing", t.missing, "", t.kit_request ? "kit change request" : "", "", "TBC", ""]);
  return s;
}

export function sheetJson(r: CalcResult, meta: SheetMeta): string {
  return JSON.stringify({ header: DRAFT_HEADER, ...meta, ...r }, null, 2);
}

export interface SheetPlan { ok: boolean; reasons: string[]; base: string; files: { md: string; csv: string; json: string } }

/** <project>\01_WIP\<Role>\_Calcs\<date>_<calc>.md|.csv|.json; a later sheet the same day gets _2, _3… */
export function sheetPlan(projectFolder: string, calc: CalcResult, date: string, cfg: GuardConfig, exists: (p: string) => boolean): SheetPlan {
  const project = projectFolder.trim();
  const empty = { md: "", csv: "", json: "" };
  if (!project) return { ok: false, reasons: ["Set project_folder: the sheet is saved in the project's 01_WIP"], base: "", files: empty };
  if (!win.isAbsolute(project)) return { ok: false, reasons: [`project_folder must be an absolute path: ${project}`], base: "", files: empty };
  const wip = win.join(project, "01_WIP");
  const folder = win.join(wip, calc.role, "_Calcs");
  const name = `${date}_${calc.id}`;
  let base = win.join(folder, name);
  for (let n = 2; [".md", ".csv", ".json"].some((x) => exists(base + x)); n++) base = win.join(folder, `${name}_${n}`);
  const files = { md: base + ".md", csv: base + ".csv", json: base + ".json" };
  const reasons: string[] = [];
  if (!isInside(files.md, wip)) reasons.push("Calculation sheets go only into the project's 01_WIP");
  reasons.push(...checkWritePath(files.md, cfg, { checkName: false }).reasons);
  return { ok: reasons.length === 0, reasons, base, files };
}
