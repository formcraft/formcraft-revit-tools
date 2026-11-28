/**
 * GAP-18 fmc_print_sets: view and sheet sets (Revit ViewSheetSet) built from the project's drawing register. Pure.
 *
 * Names come from the register: one set per issue set the register names (PERMIT, TENDER, ...), exactly as
 * fmc_issue reads it (planned(): a sheet with no sets listed is in every set). Members are the model's sheets whose
 * numbers the register plans for that set. Nothing here invents a set name, a discipline split or a sheet number.
 */
import crypto from "node:crypto";
import { planned, type RegisterSheet } from "./sheets.js";

export interface ModelSheetRef { id: string; number: string; name: string }
export interface ModelSet { id: string; name: string; view_ids: string[] }

export interface SetPlan {
  name: string;
  action: "create" | "update" | "unchanged" | "skip";
  /** model sheet ids the set holds after the write, in register order */
  sheet_ids: string[];
  sheet_numbers: string[];
  /** register numbers with no sheet in the model: not in the set, never created here */
  missing: string[];
  /** update only: what changes against the set already in the model */
  add?: string[];
  remove?: string[];
  /** update only: members of the existing set that are not sheets (views). They are dropped when the set is replaced. */
  non_sheet_views?: string[];
  existing_id?: string;
  code?: string;
  reason?: string;
}

export interface PrintSetsPlan {
  sets: SetPlan[];
  register_sets: string[];
  unknown: string[];
  changes: boolean;
  plan_hash: string;
}

export const PRINT_SETS_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "[FMC-DOC-REQUIRED] fmc_print_sets needs document: the title or full path of the open model. It never uses the active document.",
  "FMC-PRINTSETS-REGISTER": "[FMC-PRINTSETS-REGISTER] The drawing register (FMC_Sheet_Register .xlsx or .csv, absolute path) was not found or lists no sheets.",
  "FMC-PRINTSETS-NO-SETS": "[FMC-PRINTSETS-NO-SETS] The register names no issue sets, so there is no set name to use. Fill the register's Issue sets column.",
  "FMC-PRINTSETS-UNKNOWN": "[FMC-PRINTSETS-UNKNOWN] That set is not an issue set in the register. Set names come only from the register.",
  "FMC-PRINTSETS-NAME": "[FMC-PRINTSETS-NAME] Revit does not allow these characters in a name: \\ : { } [ ] | ; < > ? ` ~. Fix the issue set in the register.",
  "FMC-PRINTSETS-EMPTY": "[FMC-PRINTSETS-EMPTY] None of the register's sheets for this set are in the model. An empty set is not created.",
  "FMC-PRINTSETS-EXISTS": "[FMC-PRINTSETS-EXISTS] A set with this name is already in the model and differs. It is only replaced with replace_existing true, after a person has seen the dry run.",
  "FMC-BATCH-LOCKED": "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was changed.",
  "FMC-PRINTSETS-REFERENCES": "[FMC-PRINTSETS-REFERENCES] A write needs references.kit, references.standards and references.rulebook. Nothing was changed.",
  "FMC-PRINTSETS-STALE": "[FMC-PRINTSETS-STALE] plan_hash does not match the plan just read: the model or the register changed since the dry run. Run the dry run again.",
};

const BAD_NAME = /[\\:{}[\]|;<>?`~]/;

/** Every issue set the register names, in first-seen order (upper case, as splitSets gives them). */
export function registerSets(register: RegisterSheet[]): string[] {
  const out: string[] = [];
  for (const sheet of register) for (const set of sheet.sets) if (!out.includes(set)) out.push(set);
  return out;
}

/**
 * The plan: for each wanted set (default every register set), which model sheets it holds and how that differs from a
 * set of the same name already in the model (names compared case-insensitively, as Revit does).
 */
export function planPrintSets(register: RegisterSheet[], sheets: ModelSheetRef[], existing: ModelSet[],
  wanted: string[] = [], opts: { replaceExisting?: boolean; document?: string } = {}): PrintSetsPlan {
  const names = registerSets(register);
  const asked = [...new Set(wanted.map((w) => w.trim().toUpperCase()).filter(Boolean))];
  const unknown = asked.filter((w) => !names.includes(w));
  const targets = asked.length ? asked.filter((w) => names.includes(w)) : names;
  const byNumber = new Map(sheets.map((s) => [s.number.trim(), s]));
  const sheetIds = new Set(sheets.map((s) => s.id));
  const plans: SetPlan[] = targets.map((name) => {
    const members = planned(register, name, []);
    const hits = members.map((m) => byNumber.get(m.number.trim())).filter((s): s is ModelSheetRef => !!s);
    const missing = members.filter((m) => !byNumber.has(m.number.trim())).map((m) => m.number);
    const sheet_ids = hits.map((s) => s.id);
    const sheet_numbers = hits.map((s) => s.number);
    const base: SetPlan = { name, action: "create", sheet_ids, sheet_numbers, missing };
    if (BAD_NAME.test(name)) return { ...base, action: "skip", code: "FMC-PRINTSETS-NAME", reason: PRINT_SETS_FIX["FMC-PRINTSETS-NAME"] };
    if (!sheet_ids.length) return { ...base, action: "skip", code: "FMC-PRINTSETS-EMPTY", reason: PRINT_SETS_FIX["FMC-PRINTSETS-EMPTY"] };
    const same = existing.find((e) => e.name.trim().toUpperCase() === name);
    if (!same) return base;
    const now = new Set(same.view_ids);
    const want = new Set(sheet_ids);
    const add = sheet_ids.filter((id) => !now.has(id));
    const remove = same.view_ids.filter((id) => sheetIds.has(id) && !want.has(id));
    const non_sheet_views = same.view_ids.filter((id) => !sheetIds.has(id));
    const diff = { add, remove, non_sheet_views, existing_id: same.id };
    if (!add.length && !remove.length && !non_sheet_views.length) return { ...base, ...diff, action: "unchanged" };
    if (!opts.replaceExisting) return { ...base, ...diff, action: "skip", code: "FMC-PRINTSETS-EXISTS", reason: PRINT_SETS_FIX["FMC-PRINTSETS-EXISTS"] };
    return { ...base, ...diff, action: "update" };
  });
  const changes = plans.some((p) => p.action === "create" || p.action === "update");
  return { sets: plans, register_sets: names, unknown, changes, plan_hash: printSetsHash(opts.document ?? "", plans) };
}

/** A short hash of what the write would do, so the real run can be tied to the dry run a person saw. */
export function printSetsHash(document: string, plans: SetPlan[]): string {
  const body = JSON.stringify({ document: document.trim().toLowerCase(),
    sets: plans.filter((p) => p.action === "create" || p.action === "update").map((p) => [p.name, p.action, p.existing_id ?? "", [...p.sheet_ids]]) });
  return crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
}

/** What the add-in's write gets: only creates and updates, by name and sheet ids. */
export function applyOps(plan: PrintSetsPlan): Array<{ name: string; action: "create" | "update"; sheet_ids: string[]; existing_id?: string }> {
  return plan.sets.filter((p) => p.action === "create" || p.action === "update")
    .map((p) => ({ name: p.name, action: p.action as "create" | "update", sheet_ids: p.sheet_ids, ...(p.existing_id ? { existing_id: p.existing_id } : {}) }));
}
