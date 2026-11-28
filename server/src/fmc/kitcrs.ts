import fs from "node:fs";
import path from "node:path";
import type { GuardConfig } from "./policy.js";
import type { Line, PathProbe } from "./selftest.js";

/**
 * Kit change requests raised 28 Nov 2026 (docs/kit-proposals/KIT_CHANGE_REQUEST_2026-11-28_MissingKitFiles.md).
 * Templates only: this module never writes the live kit or fmc_guard.json. Tools should report
 * `kit file missing, see <id>` instead of silently passing or a bare ENOENT.
 */

export const KIT_CR_DOC = "docs/kit-proposals/KIT_CHANGE_REQUEST_2026-11-28_MissingKitFiles.md";

export interface KitChangeRequest {
  id: string;
  title: string;
  /** Kit-relative path, when the request is a file or folder in the kit. */
  target: string;
  tools: string[];
}

/** Approved for this branch. K-16, K-18, K-19, K-20 and the other batch 7–9 items are not listed. */
export const KIT_CHANGE_REQUESTS: readonly KitChangeRequest[] = [
  { id: "K-02", title: "Keynote seed model", target: "02_Keynotes\\Seeds\\FMC_Keynote_Seed.rvt", tools: ["fmc_keynote_place"] },
  { id: "K-03", title: "Typical details folder and catalogue", target: "Details\\FMC_Details.json", tools: ["fmc_details"] },
  { id: "K-04", title: "Script library index", target: "05_Scripts\\library\\index.json", tools: ["fmc_library"] },
  { id: "K-05", title: "Project templates layout", target: "06_Templates\\", tools: ["fmc_template", "fmc_selftest"] },
  { id: "K-06", title: "Schedule sets", target: "03_Master_Data\\FMC_Schedule_Sets.json", tools: ["fmc_schedules"] },
  { id: "K-14", title: "Keynote legend spec", target: "03_Master_Data\\FMC_KeynoteLegend.json", tools: ["fmc_keynote_legend"] },
  { id: "CR-TagScale", title: "Tag scale table", target: "03_Master_Data\\FMC_TagScale.json", tools: ["fmc_tags", "fmc_annotate"] },
  { id: "K-15", title: "Build parameters and sync_exclude spelling", target: "", tools: ["fmc_build", "fmc_batch"] },
] as const;

const win = path.win32;

export function kitCr(id: string): KitChangeRequest | undefined {
  return KIT_CHANGE_REQUESTS.find((r) => r.id === id);
}

export function kitCrForTarget(rel: string): KitChangeRequest | undefined {
  const n = rel.replace(/\//g, "\\").replace(/^\\+/, "").toLowerCase();
  return KIT_CHANGE_REQUESTS.find((r) => r.target && n === r.target.replace(/\\+$/, "").toLowerCase());
}

/** One line a tool can put in reasons or problems. */
export function missingKitMessage(id: string, what?: string): string {
  const cr = kitCr(id);
  const title = cr ? `${id} (${cr.title})` : id;
  const head = what?.trim() ? `${what.trim().replace(/\.*$/, "")}. ` : "";
  return `${head}kit file missing, see ${title} — ${KIT_CR_DOC}`;
}

export const BUILD_PARAMS = ["FMC_Keynote_Code", "FMC_Construction_Status", "FMC_Trade_Package"] as const;

/** True when quantities would measure nothing because the three kit parameters are unbound. */
export function buildParamsUnbound(paramsInModel: Record<string, boolean> | null | undefined): string[] {
  const bag = paramsInModel ?? {};
  return BUILD_PARAMS.filter((p) => bag[p] !== true);
}

export function buildParamsUnboundMessage(unbound: string[]): string {
  return missingKitMessage(
    "K-15",
    `${unbound.join(", ")} ${unbound.length === 1 ? "is" : "are"} unbound in this model, so nothing was measured`,
  );
}

const HEBERT = "HEBERT HOSTELS";
const HERBERT = "HERBERT HOSTELS";

function namesIn(list: string[] | undefined): string[] {
  return (list ?? []).map((s) => s.trim()).filter(Boolean);
}

function mentions(list: string[], name: string): boolean {
  const u = name.toUpperCase();
  return list.some((s) => s.toUpperCase().includes(u) || u.includes(s.toUpperCase()));
}

/**
 * Both spellings of the same project on save/sync exclude lists. The loader never edits the guard file.
 * The standing spelling in this repo is HEBERT HOSTELS (one B), still for Emlyn to confirm.
 */
export function syncExcludeSpellingProblem(cfg: Pick<GuardConfig, "sync_exclude" | "save_exclude"> | { sync_exclude?: string[]; save_exclude?: string[] }): string | null {
  const list = [...namesIn(cfg.sync_exclude), ...namesIn(cfg.save_exclude)];
  if (mentions(list, HEBERT) && mentions(list, HERBERT)) {
    return `sync_exclude / save_exclude lists both HEBERT HOSTELS and HERBERT HOSTELS. Confirm the official spelling and keep one entry. kit file missing, see K-15 — ${KIT_CR_DOC}`;
  }
  return null;
}

function existsFile(fs: PathProbe, p: string): boolean {
  return fs.exists(p) && !fs.isDir(p);
}

function listRte(fs: PathProbe, dir: string): string[] {
  if (!fs.isDir(dir)) return [];
  return fs.list(dir).filter((f) => f.toLowerCase().endsWith(".rte"));
}

/**
 * Self-test lines for the approved change requests. Should-grade: a miss is Warn, never Fail
 * (the rest of the kit can still be tested). Does not write anything.
 */
export function kitCrLines(folder: string, probe: PathProbe, cfg?: Pick<GuardConfig, "sync_exclude" | "save_exclude">): Line[] {
  const lines: Line[] = [];
  if (!folder || !probe.isDir(folder)) return lines;
  const checkFile = (id: string, rel: string, check: string) => {
    const p = win.join(folder, rel);
    const ok = existsFile(probe, p);
    lines.push({
      area: "Kit",
      check,
      state: ok ? "Pass" : "Warn",
      detail: ok ? p : missingKitMessage(id, `Missing ${rel}`),
    });
  };
  checkFile("K-02", "02_Keynotes\\Seeds\\FMC_Keynote_Seed.rvt", "K-02 keynote seed");
  const detailsDir = win.join(folder, "Details");
  const detailsCat = win.join(detailsDir, "FMC_Details.json");
  const detailsOk = probe.isDir(detailsDir) && existsFile(probe, detailsCat);
  lines.push({
    area: "Kit",
    check: "K-03 details catalogue",
    state: detailsOk ? "Pass" : "Warn",
    detail: detailsOk ? detailsCat : missingKitMessage("K-03", "Missing Details\\FMC_Details.json"),
  });
  checkFile("K-04", "05_Scripts\\library\\index.json", "K-04 library index");
  const templates = win.join(folder, "06_Templates");
  const staging = win.join(templates, "_Staging");
  const top = listRte(probe, templates);
  const staged = listRte(probe, staging);
  if (top.length) {
    lines.push({ area: "Kit", check: "K-05 project templates", state: "Pass", detail: `${top.length} .rte at the top of 06_Templates` });
  } else if (staged.length) {
    lines.push({
      area: "Kit",
      check: "K-05 project templates",
      state: "Warn",
      detail: `${staged.length} .rte in 06_Templates\\_Staging, none at the top of 06_Templates. kit file missing, see K-05 — ${KIT_CR_DOC}. Emlyn decides: promote the templates, or make the check read _Staging.`,
    });
  } else {
    lines.push({
      area: "Kit",
      check: "K-05 project templates",
      state: "Warn",
      detail: missingKitMessage("K-05", "No .rte files in 06_Templates or 06_Templates\\_Staging"),
    });
  }
  checkFile("K-06", "03_Master_Data\\FMC_Schedule_Sets.json", "K-06 schedule sets");
  checkFile("K-14", "03_Master_Data\\FMC_KeynoteLegend.json", "K-14 keynote legend");
  checkFile("CR-TagScale", "03_Master_Data\\FMC_TagScale.json", "CR-TagScale tag scale");
  if (cfg) {
    const spelling = syncExcludeSpellingProblem(cfg);
    if (spelling) lines.push({ area: "Guard", check: "K-15 sync_exclude spelling", state: "Warn", detail: spelling });
  }
  return lines;
}

/** Read a JSON file if present; used only in tests. */
export function readIfExists(file: string, read: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): string | null {
  try { return read(file); } catch { return null; }
}
