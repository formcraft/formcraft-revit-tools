/**
 * fmc_selftest: one call that says whether this PC is ready for a test run, link by link. Pure.
 *
 * The tester runs it first: the build in Revit, the AI connection, every command known to Revit, the guard's paths
 * and the kit's layout. Each line is Pass, Warn or Fail with what to do; the result is "Ready to test" or "Fix first".
 */
import path from "node:path";
import { GuardConfig } from "./policy.js";
import { BuildStamp, buildDrift, restartAdvice } from "./buildinfo.js";

const win = path.win32;

export type State = "Pass" | "Warn" | "Fail" | "Info";
export interface Line { area: string; check: string; state: State; detail: string }

export interface PathProbe { exists(p: string): boolean; isDir(p: string): boolean; list(p: string): string[] }

/** The kit layout the plugin reads (kit r4). Must: without it a part of the plugin can't run; Should: shown as Warn. */
export const KIT_LAYOUT: Array<{ rel: string; kind: "file" | "dir" | "json-dir" | "rte-dir"; need: "Must" | "Should"; what: string }> = [
  { rel: "FMC_Kit.json", kind: "file", need: "Must", what: "kit manifest (kit and rulebook versions)" },
  { rel: "01_Shared_Parameters\\FMC_SharedParameters.txt", kind: "file", need: "Must", what: "shared parameters" },
  { rel: "03_Master_Data\\FMC_Family_Specs.json", kind: "file", need: "Must", what: "family specs" },
  { rel: "03_Master_Data\\FMC_Sheet_Register.csv", kind: "file", need: "Should", what: "sheet register template" },
  { rel: "03_Master_Data\\FMC_Rulebook", kind: "json-dir", need: "Must", what: "rulebooks (QA, Rules, Issue)" },
  { rel: "04_Families\\_Staging", kind: "dir", need: "Must", what: "family staging (write root)" },
  { rel: "06_Templates\\_Staging", kind: "dir", need: "Must", what: "template staging (write root)" },
  { rel: "06_Templates", kind: "rte-dir", need: "Should", what: "project templates (.rte) for Setup › Project and Templates" },
];

export function kitLayout(folder: string, fs: PathProbe): Line[] {
  if (!folder) return [{ area: "Kit", check: "Kit folder", state: "Fail", detail: "Not set: Settings › General › kit folder" }];
  if (!fs.isDir(folder)) return [{ area: "Kit", check: "Kit folder", state: "Fail", detail: `Not found: ${folder}` }];
  const lines: Line[] = [{ area: "Kit", check: "Kit folder", state: "Pass", detail: folder }];
  for (const item of KIT_LAYOUT) {
    const p = win.join(folder, item.rel);
    let ok: boolean, detail = item.what;
    if (item.kind === "file") ok = fs.exists(p) && !fs.isDir(p);
    else if (item.kind === "dir") ok = fs.isDir(p);
    else {
      const ext = item.kind === "json-dir" ? ".json" : ".rte";
      const files = fs.isDir(p) ? fs.list(p).filter((f) => f.toLowerCase().endsWith(ext)) : [];
      ok = files.length > 0;
      detail = ok ? `${files.length} ${ext} · ${item.what}` : fs.isDir(p) ? `folder is there, no ${ext} files yet · ${item.what}` : item.what;
    }
    const folderThere = item.kind !== "file" && item.kind !== "dir" && fs.isDir(p);
    lines.push({ area: "Kit", check: item.rel, state: ok ? "Pass" : item.need === "Must" ? "Fail" : "Warn",
      detail: ok || folderThere ? detail : `Missing: ${detail}` });
  }
  return lines;
}

/** Folders and files the guard names: the ones a tool needs must exist (a write root may be a pattern with *). */
export function guardPaths(cfg: GuardConfig, fs: PathProbe, expand: (p: string) => string): Line[] {
  const base = (p: string) => { const e = expand(p); const i = e.indexOf("*"); return i < 0 ? e : e.slice(0, i).replace(/[\\/]+$/, ""); };
  const lines: Line[] = [];
  const many = (key: string, list: string[]) => {
    const missing = list.filter((r) => !fs.isDir(base(r)));
    lines.push({ area: "Guard", check: key, state: !list.length ? "Warn" : missing.length ? "Warn" : "Pass",
      detail: !list.length ? "None set" : missing.length ? `${list.length - missing.length} of ${list.length} reachable; missing ${missing.join("; ")}` : `${list.length} reachable` });
  };
  many("write_roots", cfg.write_roots);
  many("template_roots", cfg.template_roots);
  const one = (key: string, p: string | undefined, dir: boolean, need: "Must" | "Should") => {
    if (!p) { lines.push({ area: "Guard", check: key, state: "Warn", detail: "Not set" }); return; }
    const ok = dir ? fs.isDir(expand(p)) : fs.exists(expand(p));
    lines.push({ area: "Guard", check: key, state: ok ? "Pass" : need === "Must" ? "Fail" : "Warn", detail: ok ? p : `Not found: ${p}` });
  };
  one("rulebooks_dir", cfg.rulebooks_dir, true, "Must");
  one("specs_path", cfg.specs_path, false, "Must");
  one("shared_parameter_file", cfg.shared_parameter_file, false, "Must");
  one("keynote_file", cfg.keynote_file, false, "Should");
  one("materials_file", cfg.materials_file, false, "Should");
  one("annotation_standard_file", cfg.annotation_standard_file, false, "Should");
  return lines;
}

export interface AddinFacts {
  addin?: { commit?: string; built?: string; path?: string };
  installed?: { commit?: string; installed_at?: string } | null;
  revit?: string;
  connection?: { port?: number; start_with_revit?: boolean; listening?: boolean };
  commands?: { registered?: number; listed?: number; missing?: string[] };
  ribbon?: { updates?: number; changes?: number };
  kit_folder?: string;
  documents?: Array<{ title: string; saved: boolean; modified: boolean; workshared: boolean }>;
}

export function revitLines(f: AddinFacts | null, server: { commit: string; built: string }, notListening: string): Line[] {
  if (!f) return [{ area: "Revit", check: "AI connection", state: "Fail", detail: notListening }];
  const lines: Line[] = [
    { area: "Revit", check: "AI connection", state: "Pass", detail: `Revit ${f.revit ?? "?"} answers on port ${f.connection?.port ?? "?"}` +
      (f.connection?.start_with_revit === false ? " · start_with_revit is off" : "") },
  ];
  const a = f.addin?.commit ?? "unknown";
  const same = a.replace("+local", "") === server.commit.replace("+local", "");
  lines.push({ area: "Build", check: "Add-in in Revit", state: a === "unknown" || a.endsWith("+local") ? "Warn" : "Pass",
    detail: `${a} · built ${f.addin?.built ?? "?"}` + (f.installed?.commit ? ` · installed ${f.installed.installed_at ?? ""}` : "") });
  lines.push({ area: "Build", check: "Server and add-in match", state: same ? "Pass" : "Warn",
    detail: same ? `both ${server.commit}` : `server ${server.commit}, add-in ${a}: install both from the same merge` });
  const missing = f.commands?.missing ?? [];
  lines.push({ area: "Revit", check: "Commands known to Revit", state: missing.length ? "Fail" : "Pass",
    detail: missing.length ? `${missing.length} missing: ${missing.join(", ")}` : `${f.commands?.registered ?? 0} registered, all ${f.commands?.listed ?? 0} listed` });
  const docs = f.documents ?? [];
  const risky = docs.filter((d) => d.saved || d.modified);
  lines.push({ area: "Revit", check: "Safe to close Revit for an install", state: risky.length ? "Warn" : "Pass",
    detail: !docs.length ? "No documents open" : risky.length
      ? `Ask the user first: ${risky.map((d) => `${d.title}${d.saved ? " (saved file)" : ""}${d.modified ? " (changed)" : ""}`).join(", ")}`
      : `${docs.length} document${docs.length === 1 ? "" : "s"}, all new and unchanged` });
  lines.push({ area: "Revit", check: "Ribbon updates", state: "Info", detail: `${f.ribbon?.updates ?? 0} updates, ${f.ribbon?.changes ?? 0} changed the ribbon (F-008)` });
  return lines;
}

/**
 * F-041 (issue #133): the AI-modeller rulebook. Missing or without its section is a Fail with the fix, so a test run
 * doesn't find out from fmc_ai that AI-assisted modelling is Off. The fix is a kit change (rule 7), never a value in code.
 */
export function aiRulebookLine(r: { book: unknown; file: string; section: string; problems: string[] }, rulebooksDir: string): Line {
  const name = win.basename(r.file || "");
  if (r.book) return { area: "Kit", check: "AI-use rulebook", state: "Pass", detail: `Read ${name}${r.section && r.section !== "whole file" ? ` (section ${r.section})` : ""} · ${r.file}` };
  return {
    area: "Kit", check: "AI-use rulebook", state: "Fail",
    detail: `${r.problems.join("; ") || "No AI-modeller rulebook"}. AI-assisted modelling stays Off. Fix: add FMC_Rulebook_AIUse.json ` +
      `(schema fmc-aiuse/0.1: bands, groups, limits; the proposal is docs/kit-proposals/FMC_Rulebook_AIUse.json) to ${rulebooksDir}, ` +
      `or the same as an "ai_use" section in FMC_Rulebook_ClaudeUse.json: a kit change request (rule 7).`,
  };
}

/**
 * Owner 26 Oct: "General AI switch: section present / state". The guard's ai_modeller section (created by the switch on
 * first use), the switch's state firm-wide and per project, Stop AI, and whether the kit rulebook has the general block.
 */
export function generalSwitchLine(ai: { general?: boolean; stop: boolean; projects: Record<string, { general?: boolean }> } | null,
  book: { general?: { groups: string[] } } | null): Line {
  const check = "General AI switch";
  if (!book?.general) return { area: "AI", check, state: "Warn", detail: "The kit rulebook has no general block, so the switch can't turn AI on (a kit change request: FMC_Rulebook_AIUse.json \"general\")." };
  if (!ai) return { area: "AI", check, state: "Info", detail: "Section missing: AI is off everywhere. The AI switch creates it (safe defaults) the first time someone uses it." };
  const on = Object.entries(ai.projects ?? {}).filter(([, p]) => p?.general === true).map(([k]) => k);
  const state = ai.stop ? "Stopped (Stop AI is on)" : `firm ${ai.general ? "On" : "Off"}; On for ${on.length ? on.join(", ") : "no project"}`;
  return { area: "AI", check, state: ai.stop ? "Warn" : "Pass", detail: `Section present · ${state} · covers ${book.general.groups.join(", ")}` };
}

/** Owner 20 Oct: the Rhino rulebook. Without it no Rhino part passes and no family made from a picture can be judged. */
export function rhinoRulebookLine(r: { book: { version: string } | null; file: string; problems: string[] }): Line {
  if (r.book) return { area: "Kit", check: "Rhino rulebook", state: "Pass", detail: `Read ${r.file} v${r.book.version}` };
  return { area: "Kit", check: "Rhino rulebook", state: "Fail",
    detail: `${r.problems.join("; ")}. No Rhino part passes and likeness can't be judged. Fix: add FMC_Rulebook_Rhino.json ` +
      `(schema fmc-rhino/0.1; the proposal is docs/kit-proposals/FMC_Rulebook_Rhino.json) to the kit's rulebooks folder: a kit change request (rule 7).` };
}

/**
 * F-042 (issue #143): the build this process runs (read into memory at startup) against build-info.json on disk now.
 * The updater replaces the files, but the Claude app's MCP server keeps running the code it started with (old tools,
 * old ops refused as "invalid discriminator"), so a difference is a Fail with the restart that fixes it.
 */
export function runningBuildLine(running: BuildStamp, disk: BuildStamp): Line {
  const check = "Running server is the installed build";
  if (disk.commit === "unknown")
    return { area: "Server", check, state: "Warn", detail: `No build-info.json on disk beside the server: can't compare with the running build ${running.commit}` };
  if (running.commit === "unknown")
    return { area: "Server", check, state: "Warn", detail: `The running server has no build stamp (started without build-info.json); ${disk.commit} is installed. ${restartAdvice(disk)}` };
  if (buildDrift(running, disk))
    return { area: "Server", check, state: "Fail",
      detail: `This process runs ${running.commit} (built ${running.built || "?"}), but ${disk.commit} (built ${disk.built || "?"}) is installed: ` +
        `tools and ops added since are missing or refused as invalid. ${restartAdvice(disk)}.` };
  return { area: "Server", check, state: "Pass", detail: `${running.commit} running and installed` };
}

export function summary(lines: Line[]) {
  const fail = lines.filter((l) => l.state === "Fail").length, warn = lines.filter((l) => l.state === "Warn").length;
  return { result: fail ? "Fix first" : "Ready to test", fail, warn, pass: lines.filter((l) => l.state === "Pass").length };
}
