/**
 * The system-type editor's server checks (modify_model duplicate_type, edit_type, delete_type, plan_only; review item 3,
 * approved 28 Nov 13:24). The add-in does the type work (FmcModelTypes.cs); these checks refuse before anything is sent.
 * - delete_type is never run for the AI: deleting a type needs a person (FMC-NEEDS-PERSON). It may only be planned.
 * - plan_only takes type ops only, and goes to Revit as a dry run with no transaction at all (nothing borrowed).
 */
export const CODE_NEEDS_PERSON = "FMC-NEEDS-PERSON";
export const CODE_PLAN_ONLY_TYPES = "FMC-PLAN-ONLY-TYPES";

/** Ops a plan_only batch may hold (set_param only with on_type true). */
export const PLAN_OPS = new Set(["edit_type", "duplicate_type", "delete_type", "set_param"]);

type Op = { op?: string; on_type?: boolean; [k: string]: unknown };

export interface Refusal { code: string; reason: string; ops: number[] }

/** Null when the batch may be sent; otherwise why not, with the 1-based ops that cause it. */
export function typeBatchRefusal(ops: Op[], planOnly: boolean): Refusal | null {
  const list = Array.isArray(ops) ? ops : [];
  const deletes = list.map((o, i) => (o?.op === "delete_type" ? i + 1 : 0)).filter(Boolean);
  if (!planOnly && deletes.length) {
    return {
      code: CODE_NEEDS_PERSON, ops: deletes,
      reason: "Deleting a type needs a person: the AI never deletes a type (a person does it in Revit: Project Browser, or Manage > " +
        "Purge Unused). Run delete_type with plan_only true to list what uses the type.",
    };
  }
  if (planOnly) {
    const bad = list.map((o, i) => (!PLAN_OPS.has(String(o?.op)) || (o?.op === "set_param" && o?.on_type !== true) ? i + 1 : 0)).filter(Boolean);
    if (bad.length) {
      return {
        code: CODE_PLAN_ONLY_TYPES, ops: bad,
        reason: "plan_only plans type ops only (edit_type, duplicate_type, delete_type, set_param on_type): use dry_run for the other ops.",
      };
    }
  }
  return null;
}

/** What goes to fmc_model_edit: plan_only is sent as a dry run too, so every dry-run rule on the way applies. */
export function wireParams(ops: Op[], dryRun: boolean, planOnly: boolean, why?: string): Record<string, unknown> {
  return { ops, dry_run: planOnly ? true : dryRun, ...(planOnly ? { plan_only: true } : {}), ...(why ? { why } : {}) };
}

/** True when a batch would delete a type for real (the AI gate refuses it too, as a second check). */
export function deletesTypes(params: unknown): boolean {
  const p = (params ?? {}) as { ops?: Op[]; dry_run?: boolean; plan_only?: boolean };
  if (p.plan_only === true) return false;
  return Array.isArray(p.ops) && p.ops.some((o) => o?.op === "delete_type");
}
