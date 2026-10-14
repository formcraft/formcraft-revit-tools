import path from "node:path";
import { z } from "zod";
import { OP } from "./ops.js";

const win = path.win32;

/**
 * Family recipes and Gate A (Phase 2, B2 of docs/PLAN_EXECUTION.md; U30). A recipe is the family's build as data: the
 * template, the fmc_doc ops in order, and where each value came from. The B1 water-heater batch
 * (tests/doc/*.ops.json) is a recipe already; fmc-recipe/0.1 adds the source of each value and the code checks.
 *
 * Gate A is the quality gate before release: what the plugin can check, it checks; what needs the family placed in a
 * project (tags, schedules, legends, detail levels) is listed as not checked, never as passed. Release itself is a
 * person's act in the pane (Family Librarian, with a reviewer and a note), never a tool's.
 */

export const SOURCE_STATUS = ["verified", "EA", "assumed", "pending"] as const;

export const RECIPE = z.object({
  schema: z.string().optional().default("fmc-recipe/0.1"),
  family: z.string().min(1),
  template: z.string().min(1).describe("the family template (.rft) the build starts from"),
  about: z.string().optional().default(""),
  ops: z.array(OP).min(1),
  /** Each value's source: verified (a datasheet or measurement), EA (East African, not this country), assumed, pending. */
  values: z.record(z.object({ value: z.union([z.string(), z.number()]), source_status: z.enum(SOURCE_STATUS), source: z.string().optional() })).optional().default({}),
  checks: z.object({
    clear_opening_min_mm: z.number().positive().optional(),
    clear_opening_param: z.string().optional().default("Width"),
  }).optional().default({}),
});
export type Recipe = z.infer<typeof RECIPE>;

export function parseRecipe(raw: string): { recipe: Recipe | null; problems: string[] } {
  let o: unknown;
  try { o = JSON.parse(raw.replace(/^﻿/, "")); } catch (e) { return { recipe: null, problems: [`Not JSON: ${e instanceof Error ? e.message : e}`] }; }
  const r = RECIPE.safeParse(o);
  if (!r.success) return { recipe: null, problems: r.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) };
  if (!/^fmc-recipe\/0\.\d+$/.test(r.data.schema)) return { recipe: null, problems: [`schema must be fmc-recipe/0.1 (found ${r.data.schema})`] };
  return { recipe: r.data, problems: [] };
}

/** FMC_<Role>_<Token>_<Description>: the role folder the family is staged in and released to. */
export function roleOf(family: string): string {
  return /^FMC_([A-Z]{1,2})_/.exec(family)?.[1] ?? "";
}

export function stagingPath(stagingRoot: string, family: string): string {
  return win.join(stagingRoot, roleOf(family) || "_Unsorted", family + ".rfa");
}

/** 04_Families\<Role>\<family>.rfa: where release puts it (the staging root's parent is 04_Families). */
export function releasePath(stagingRoot: string, family: string): string {
  return win.join(win.dirname(win.normalize(stagingRoot).replace(/\\+$/, "")), roleOf(family), family + ".rfa");
}

/** Each type's values from the recipe's set_type_value ops, in mm for lengths. */
export function typeValues(recipe: Recipe): Map<string, Map<string, number | string>> {
  const out = new Map<string, Map<string, number | string>>();
  for (const o of recipe.ops as Array<Record<string, any>>) {
    if (o.op !== "set_type_value") continue;
    const t = String(o.type ?? ""), p = String(o.param ?? o.name ?? "");
    if (!out.has(t)) out.set(t, new Map());
    out.get(t)!.set(p, o.value);
  }
  return out;
}

export type GateState = "Pass" | "Fail" | "Warn" | "Not checked";
export interface GateLine { check: string; state: GateState; detail: string }

/** What fmc_library inspect says about the saved file (its checks), and what fmc_doc flex says. */
export interface GateInputs {
  inspect: { checks?: Array<{ check: string; state: string; detail: string }>; category?: string } | null;
  /** fmc_doc flex: every type, whether it regenerated, and why not. */
  flex: { ok?: boolean; types?: Array<{ type: string; ok: boolean; errors?: string[] }> } | null;
  registerCategory: string | null;
}

export function gateA(family: string, recipe: Recipe | null, inputs: GateInputs): { verdict: "Pass" | "Fail"; lines: GateLine[] } {
  const lines: GateLine[] = [];
  // 1-4: the library's own checks on the saved file (name, kit parameters by GUID, keynotes, size, type names)
  for (const c of inputs.inspect?.checks ?? [])
    lines.push({ check: c.check, state: c.state === "pass" ? "Pass" : c.state === "fail" ? "Fail" : "Not checked", detail: c.detail });
  if (!inputs.inspect) lines.push({ check: "Library checks on the saved file", state: "Not checked", detail: "The file couldn't be inspected" });

  if (inputs.registerCategory == null) lines.push({ check: "Category against the register", state: "Not checked", detail: `${family} isn't in FMC_Family_Register.csv` });
  else {
    const cat = inputs.inspect?.category ?? "";
    lines.push({ check: "Category against the register", state: !cat ? "Not checked" : cat === inputs.registerCategory ? "Pass" : "Fail",
      detail: cat ? `${cat}${cat === inputs.registerCategory ? "" : `, the register says ${inputs.registerCategory}`}` : "Category not read" });
  }

  if (!inputs.flex) lines.push({ check: "Every type flexes", state: "Not checked", detail: "Flex didn't run" });
  else {
    const types = inputs.flex.types ?? [];
    const failing = types.filter((t) => !t.ok);
    lines.push({ check: "Every type flexes", state: inputs.flex.ok && !failing.length ? "Pass" : "Fail",
      detail: failing.length ? failing.slice(0, 3).map((f) => `${f.type}${f.errors?.length ? `: ${f.errors[0]}` : ""}`).join("; ") : `${types.length || "all"} types regenerate` });
  }

  if (!recipe) lines.push({ check: "Code checks and value sources", state: "Not checked", detail: "No recipe beside the family (.recipe.json)" });
  else {
    const min = recipe.checks.clear_opening_min_mm;
    if (min) {
      const param = recipe.checks.clear_opening_param;
      const small = [...typeValues(recipe)].filter(([, v]) => typeof v.get(param) === "number" && (v.get(param) as number) < min).map(([t, v]) => `${t} ${v.get(param)} mm`);
      lines.push({ check: `Clear opening at least ${min} mm`, state: small.length ? "Fail" : "Pass", detail: small.length ? small.join(", ") : `every type's ${param} is ${min} mm or more` });
    }
    const ifc = (recipe.ops as Array<Record<string, any>>).some((o) => (o.op === "set_type_value" || o.op === "set_family_params") && /IfcExportAs/i.test(String(o.param ?? o.name ?? "")));
    lines.push({ check: "IFC class set", state: ifc ? "Pass" : "Warn", detail: ifc ? "IfcExportAs is set" : "IfcExportAs isn't set by the recipe (IFC export guesses the class)" });
    const by = (s: string) => Object.entries(recipe.values).filter(([, v]) => v.source_status === s).map(([k]) => k);
    const pending = by("pending"), assumed = by("assumed"), ea = by("EA");
    lines.push({ check: "Values from a verified source", state: pending.length ? "Fail" : assumed.length ? "Warn" : "Pass",
      detail: pending.length ? `Pending, so not releasable: ${pending.join(", ")}`
        : assumed.length ? `Assumed (the reviewer accepts them): ${assumed.join(", ")}${ea.length ? `; East African, not local: ${ea.join(", ")}` : ""}`
        : ea.length ? `East African, not local: ${ea.join(", ")}` : `${Object.keys(recipe.values).length || "No"} values recorded, all verified` });
  }
  lines.push({ check: "Tag, schedule and legend; Coarse, Medium and Fine", state: "Not checked", detail: "Run the load test in the role's chain-test project (fmc_family load_test)" });
  return { verdict: lines.some((l) => l.state === "Fail") ? "Fail" : "Pass", lines };
}
