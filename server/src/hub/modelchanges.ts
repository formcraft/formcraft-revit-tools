/**
 * fmc_changes model read (tool research 1-25, approved 28 Nov). Revit keeps no time on an element, so "changed since a
 * time" is answered with document versions: every model read records the document's version (GUID and saves) with the
 * time it was read, in %LOCALAPPDATA%\Formcraft\changes\FMC_Model_Versions.jsonl. "since" picks the newest version
 * recorded at or before that time and Revit's Document.GetChangedElements lists what changed after it. Read-only.
 * Severity: high, medium or low per change, so a person sees deletions and datum, structure and link changes first.
 */
import fs from "node:fs";
import path from "node:path";
import type { Change } from "./changes.js";

export type Severity = "high" | "medium" | "low";
export const SEVERITIES: Severity[] = ["high", "medium", "low"];
const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export function atLeast(severity: Severity, min: Severity): boolean {
  return RANK[severity] >= RANK[min];
}

export interface VersionRow { at: string; document: string; guid: string; saves: number }

export function versionsFile(env: NodeJS.ProcessEnv = process.env): string {
  const own = (env.FMC_CHANGES_DIR ?? "").trim();
  const base = own || path.join(env.LOCALAPPDATA || path.join(env.USERPROFILE || env.HOME || ".", "AppData", "Local"), "Formcraft", "changes");
  return path.join(base, "FMC_Model_Versions.jsonl");
}

export function readVersions(env: NodeJS.ProcessEnv = process.env): VersionRow[] {
  let text = "";
  try { text = fs.readFileSync(versionsFile(env), "utf8"); } catch { return []; }
  const out: VersionRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as VersionRow;
      if (row && row.document && row.guid && row.at) out.push(row);
    } catch { /* a torn line */ }
  }
  return out;
}

/** Record a version unless the newest row for this document already has it. */
export function recordVersion(row: VersionRow, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!row.guid || !row.document) return false;
  const rows = readVersions(env).filter((r) => docKey(r.document) === docKey(row.document));
  const last = rows[rows.length - 1];
  if (last && last.guid === row.guid && last.saves === row.saves) return false;
  const file = versionsFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
  return true;
}

/** A title and its file path are the same document: the file name without .rvt, lower case. */
export function docKey(name: string): string {
  const base = String(name ?? "").trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.rvt$/i, "").toLowerCase();
}

/**
 * The newest recorded version of this document at or before since (ms). null with the earliest recorded time when
 * none is that old, so the reply can say why there is nothing to compare with.
 */
export function pickBaseline(rows: VersionRow[], documents: string[], sinceMs: number): { row: VersionRow | null; earliest?: string } {
  const keys = new Set(documents.map(docKey).filter(Boolean));
  const mine = rows.filter((r) => keys.has(docKey(r.document))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const before = mine.filter((r) => Date.parse(r.at) <= sinceMs);
  return { row: before[before.length - 1] ?? null, earliest: mine[0]?.at };
}

export interface ModelRow {
  id: number; unique_id?: string; category?: string; bic?: string; category_type?: string; class?: string; name?: string;
  is_type?: boolean; missing?: boolean;
}
export type ModelChangeKind = "created" | "modified" | "deleted";
export interface ModelChange extends ModelRow { change: ModelChangeKind; severity: Severity; why: string }

/** Built-in categories whose change moves other trades' work: datums, structure, the building shell, links, boards. */
const HIGH_BIC = new Set([
  "OST_Levels", "OST_Grids", "OST_ProjectBasePoint", "OST_SharedBasePoint", "OST_RvtLinks", "OST_Walls", "OST_Floors",
  "OST_Roofs", "OST_Stairs", "OST_StructuralColumns", "OST_StructuralFraming", "OST_StructuralFoundation", "OST_Columns",
  "OST_ElectricalEquipment", "OST_MechanicalEquipment", "OST_PlumbingEquipment",
]);

export function modelSeverity(row: ModelRow, change: ModelChangeKind): { severity: Severity; why: string } {
  if (change === "deleted") return { severity: "high", why: "deleted" };
  if (row.missing) return { severity: "medium", why: "the element is no longer in the model" };
  if (row.bic && HIGH_BIC.has(row.bic)) return { severity: "high", why: `${row.category || row.bic} ${change}: other trades depend on it` };
  if (row.category_type === "Model" && !row.is_type) return { severity: "medium", why: `model element ${change}` };
  return { severity: "low", why: row.category_type ? `${row.category_type.toLowerCase()} element ${change}` : `non-model element ${change}` };
}

export function modelChanges(reply: { created?: ModelRow[]; modified?: ModelRow[]; deleted?: ModelRow[] }): ModelChange[] {
  const out: ModelChange[] = [];
  for (const change of ["deleted", "created", "modified"] as ModelChangeKind[]) {
    for (const row of reply[change] ?? []) out.push({ ...row, change, ...modelSeverity(row, change) });
  }
  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

/** Severity of a file flag: a missing part blocks a rebuild (high); a stale family or result (medium); tree exports (low). */
export function changeSeverity(c: Change): Severity {
  if (c.kind === "part" && /missing/.test(c.why)) return "high";
  if (c.kind === "part" || c.kind === "recipe" || c.kind === "flow") return "medium";
  return "low";
}

export function countBySeverity(rows: Array<{ severity: Severity }>): Record<Severity, number> {
  const out: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const row of rows) out[row.severity] += 1;
  return out;
}
