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

/** A labelled dimension whose plane ended on the other side of its reference (F-026), as the add-in's flex reports it. */
export interface DimensionSide { a: string; b: string; label?: string; axis: string; drawn: number; now_mm: number }

/** What fmc_library inspect says about the saved file (its checks), and what fmc_doc flex says. */
export interface GateInputs {
  inspect: {
    checks?: Array<{ check: string; state: string; detail: string }>; category?: string;
    /** The kit shared parameters the saved file carries (name and GUID). */
    shared_parameters?: Array<{ name: string; guid: string }>;
  } | null;
  /** Why inspect gave nothing (F-039: never swallowed). */
  inspectError?: string;
  /** fmc_doc flex: every type, whether it regenerated, and why not; labelled dimensions that changed side. */
  flex: {
    ok?: boolean;
    types?: Array<{ type: string; ok: boolean; errors?: string[]; dimension_sides?: DimensionSide[] }>;
    dimension_sides?: { checked: number; unrecorded: number };
  } | null;
  flexError?: string;
  registerCategory: string | null;
}

const REQUIRED_PARAMS = "Required FMC parameters present (by GUID)";
const SIDE_WORDS: Record<string, [string, string]> = { z: ["above", "below"], x: ["to the right of (+x)", "to the left of (-x)"], y: ["on the +y side of", "on the -y side of"] };
const side = (axis: string, sign: number) => (SIDE_WORDS[axis] ?? ["after", "before"])[sign > 0 ? 0 : 1];

export function gateA(family: string, recipe: Recipe | null, inputs: GateInputs): { verdict: "Pass" | "Fail"; lines: GateLine[] } {
  const lines: GateLine[] = [];
  // F-039: the recipe's kit parameters (add_shared_param, by GUID) are what the saved file must carry
  const expected = (recipe?.ops ?? []).filter((o) => o.op === "add_shared_param").map((o) => ({ name: o.name, guid: String((o as { guid?: string }).guid ?? "") }));
  // 1-4: the library's own checks on the saved file (name, kit parameters by GUID, keynotes, size, type names)
  for (const c of inputs.inspect?.checks ?? []) {
    let line: GateLine = { check: c.check, state: c.state === "pass" ? "Pass" : c.state === "fail" ? "Fail" : "Not checked", detail: c.detail };
    if (c.check === REQUIRED_PARAMS && expected.length && inputs.inspect?.shared_parameters) {
      // Never Pass on 0: the recipe names what the file must hold, so check every GUID and list the missing ones.
      const have = new Set(inputs.inspect.shared_parameters.map((p) => p.guid.toLowerCase()));
      const missing = expected.filter((p) => !have.has(p.guid.toLowerCase()));
      const spec = line.state === "Fail" && !/^0 required/.test(c.detail) ? line : null;
      line = { check: c.check, state: missing.length || spec ? "Fail" : "Pass",
        detail: (missing.length ? `${expected.length - missing.length} of ${expected.length} present; missing ${missing.map((p) => `${p.name} (${p.guid})`).join(", ")}`
          : `${expected.length} of ${expected.length} present by GUID: ${expected.map((p) => p.name).join(", ")}`) + (spec ? `; the kit spec: ${spec.detail}` : "") };
    } else if (c.check === REQUIRED_PARAMS && line.state === "Pass" && /^0 /.test(c.detail)) {
      line = { ...line, state: "Fail", detail: `0 required and 0 checked: the kit spec lists none and the recipe adds none, so nothing shows the family carries its kit parameters` };
    }
    lines.push(line);
  }
  if (!inputs.inspect) lines.push({ check: "Library checks on the saved file", state: "Not checked", detail: `The file couldn't be inspected: ${inputs.inspectError || "no reason given"}` });

  if (inputs.registerCategory == null) lines.push({ check: "Category against the register", state: "Not checked", detail: `${family} isn't in FMC_Family_Register.csv` });
  else {
    const cat = inputs.inspect?.category ?? "";
    lines.push({ check: "Category against the register", state: !cat ? "Not checked" : cat === inputs.registerCategory ? "Pass" : "Fail",
      detail: cat ? `${cat}${cat === inputs.registerCategory ? "" : `, the register says ${inputs.registerCategory}`}` : "Category not read" });
  }

  if (!inputs.flex) lines.push({ check: "Every type flexes", state: "Not checked", detail: `Flex didn't run${inputs.flexError ? `: ${inputs.flexError}` : ""}` });
  else {
    const types = inputs.flex.types ?? [];
    const failing = types.filter((t) => !t.ok);
    // F-039: a type bigger than the template's host wall can't cut its opening; say what to change
    const cutOut = failing.some((f) => (f.errors ?? []).some((e) => /cut-?out|cut the host|opening.*host/i.test(e)));
    lines.push({ check: "Every type flexes", state: inputs.flex.ok && !failing.length ? "Pass" : "Fail",
      detail: (failing.length ? failing.slice(0, 3).map((f) => `${f.type}${f.errors?.length ? `: ${f.errors[0]}` : ""}`).join("; ") : `${types.length || "all"} types regenerate`) +
        (cutOut ? ". The opening is bigger than the template's host wall: raise the host wall (its height, and its length for wide types) in the recipe's template so the largest type cuts" : "") });

    // F-039/F-026: a labelled dimension whose plane ended on the other side of its reference
    const sides = inputs.flex.dimension_sides;
    if (!sides) lines.push({ check: "Labelled dimensions keep their planes' sides", state: "Not checked", detail: "This add-in's flex doesn't report dimension sides: update the add-in" });
    else {
      const wrong = types.flatMap((t) => (t.dimension_sides ?? []).map((s) => ({ type: t.type, ...s })));
      lines.push({ check: "Labelled dimensions keep their planes' sides",
        state: wrong.length ? "Fail" : sides.checked ? "Pass" : "Not checked",
        detail: wrong.length
          ? wrong.slice(0, 4).map((w) => `${w.type}: ${w.b} was drawn ${side(w.axis, w.drawn)} ${w.a}${w.label ? ` (${w.label})` : ""}, now ${Math.abs(w.now_mm)} mm ${side(w.axis, w.now_mm)} it`).join("; ")
          : sides.checked ? `${sides.checked} labelled dimensions keep their sides in every type${sides.unrecorded ? `; ${sides.unrecorded} older ones have no recorded side` : ""}`
          : `No dimension recorded the side it was drawn on${sides.unrecorded ? ` (${sides.unrecorded} were made before this check: rebuild the family)` : ""}` });
    }
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
