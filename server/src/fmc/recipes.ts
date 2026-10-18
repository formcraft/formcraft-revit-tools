import path from "node:path";
import { z } from "zod";
import { OP } from "./ops.js";
import { RUNNING_BUILD, diskBuild, invalidOpNote } from "./buildinfo.js";
import { ROLE_CODES } from "./policy.js";

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
    /** A nested helper or clearance family that is never scheduled: Gate A shows the keynote check as exempt, with this reason. */
    keynote_exempt: z.string().min(3).optional(),
  }).optional().default({}),
});
export type Recipe = z.infer<typeof RECIPE>;

export function parseRecipe(raw: string): { recipe: Recipe | null; problems: string[] } {
  let o: unknown;
  try { o = JSON.parse(raw.replace(/^﻿/, "")); } catch (e) { return { recipe: null, problems: [`Not JSON: ${e instanceof Error ? e.message : e}`] }; }
  const r = RECIPE.safeParse(o);
  if (!r.success) {
    const problems = r.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`);
    // F-042: an op this build doesn't know may be one the installed build knows (the Claude app runs an old server)
    if (r.error.issues.some((i) => i.code === "invalid_union_discriminator" || /discriminator/i.test(i.message))) problems.push(invalidOpNote(RUNNING_BUILD, diskBuild()));
    return { recipe: null, problems };
  }
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

// ---- size follow (flex: solids and sweeps move with Width, Height and the other size parameters) ----------------------

/**
 * The planes each family template drives with its own size parameters (Metric Door.rft and Metric Window.rft label
 * Width across Left/Right and Height up to Head). The centre planes, Ref. Level and a window's Sill stay put.
 */
export const TEMPLATE_DRIVEN: Record<string, Record<string, string[]>> = {
  "metric door.rft": { Left: ["Width"], Right: ["Width"], Head: ["Height"], Exterior: [], Interior: [] },
  "metric window.rft": { Left: ["Width"], Right: ["Width"], Head: ["Height"], Sill: [], Exterior: [], Interior: [] },
};
const FIXED_PLANES = ["Center (Left/Right)", "Center (Front/Back)", "Ref. Level"];

/**
 * Which size parameters move each reference plane: the template's own (TEMPLATE_DRIVEN), a plane the recipe draws on a
 * centre line or the level (0 across) stays put, and a labelled dimension from a plane we know carries that plane's
 * parameters plus its label to the other one (Head Inner, Frame Width from Head: Height and Frame Width).
 */
export function planeParams(recipe: Recipe): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const f of FIXED_PLANES) m.set(f, new Set());
  for (const [pl, ps] of Object.entries(TEMPLATE_DRIVEN[win.basename(recipe.template).toLowerCase()] ?? {})) m.set(pl, new Set(ps));
  const ops = recipe.ops as Array<Record<string, any>>;
  for (const o of ops) {
    if (o.op !== "add_ref_plane" || m.has(o.name)) continue;
    const [a, b] = [o.from as number[], o.to as number[]];
    // a line along an axis at 0: a plane on a centre line or on the level
    if ((a[0] === 0 && b[0] === 0) || (a[1] === 0 && b[1] === 0)) m.set(o.name, new Set());
  }
  const dims = ops.filter((o) => o.op === "add_dimension" && o.label && Array.isArray(o.between));
  for (let changed = true; changed;) {
    changed = false;
    for (const d of dims) {
      const [a, b] = d.between as string[];
      const from = m.has(a) && !m.has(b) ? a : m.has(b) && !m.has(a) ? b : null;
      if (!from) continue;
      m.set(from === a ? b : a, new Set([...m.get(from)!, String(d.label)]));
      changed = true;
    }
  }
  return m;
}

export interface FollowParam { param: string; low_mm: number; high_mm: number; stepped: boolean }

/**
 * The size parameters flex exercises: Width and Height, and every labelled parameter whose value differs between the
 * types (Fanlight Height), each at its lowest and highest type value. A parameter every type gives the same value
 * (a one-type family) is moved 10% up so it is still exercised (stepped).
 */
export function followParams(recipe: Recipe): FollowParam[] {
  const tv = typeValues(recipe);
  const labelled = new Set((recipe.ops as Array<Record<string, any>>).filter((o) => o.op === "add_dimension" && o.label).map((o) => String(o.label)));
  const out: FollowParam[] = [];
  const names = new Set<string>(["Width", "Height", ...labelled]);
  for (const p of names) {
    const vals = [...tv.values()].map((v) => v.get(p)).filter((v): v is number => typeof v === "number");
    if (!vals.length) continue;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    if (p !== "Width" && p !== "Height" && lo === hi) continue;
    out.push(lo === hi ? { param: p, low_mm: lo, high_mm: Math.round((lo * 1.1) / 10) * 10, stepped: true } : { param: p, low_mm: lo, high_mm: hi, stepped: false });
  }
  return out;
}

/** The planes a solid or sweep is tied to by the recipe: path_planes and its host, rect and end_plane, lock_face. */
export function solidPlanes(recipe: Recipe): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (s: string, pls: string[]) => { if (!out.has(s)) out.set(s, new Set()); for (const p of pls) out.get(s)!.add(p); };
  for (const o of recipe.ops as Array<Record<string, any>>) {
    if ((o.op === "sweep" || o.op === "void_sweep") && Array.isArray(o.path_planes)) add(o.name, (o.path_planes as string[][]).flat());
    else if ((o.op === "extrusion" || o.op === "void_extrusion") && (o.rect || o.end_plane)) add(o.name, [...(o.rect ?? []), ...(o.end_plane ? [o.end_plane] : [])]);
    else if (o.op === "lock_face") add(o.solid, [o.plane]);
  }
  return out;
}

/** Each solid's governing size parameters: the exercised parameters that move a plane it is tied to. */
export function expectedFollows(recipe: Recipe, follow: FollowParam[] = followParams(recipe)): Map<string, string[]> {
  const pp = planeParams(recipe);
  const exercised = new Set(follow.map((f) => f.param));
  const out = new Map<string, string[]>();
  for (const [solid, pls] of solidPlanes(recipe)) {
    const g = new Set<string>();
    for (const pl of pls) for (const p of pp.get(pl) ?? []) if (exercised.has(p)) g.add(p);
    if (g.size) out.set(solid, [...g].sort((a, b) => order(a) - order(b) || a.localeCompare(b)));
  }
  return out;
}
const order = (p: string) => (p === "Width" ? 0 : p === "Height" ? 1 : 2);

/** fmc_doc flex's follow report: per size parameter the values used, per named solid the parameters it moved with. */
export interface FlexFollow {
  params: Array<{ param: string; low_mm?: number; high_mm?: number; type?: string; ok: boolean; error?: string }>;
  elements: Array<{ name: string; kind?: string; moved: string[]; fixed: string[]; no_box?: boolean }>;
}

export interface FollowLine { solid: string; follows: string; governed_by: string; state: GateState }

function followCheck(recipe: Recipe, follow: FlexFollow | undefined): { line: GateLine | null; follows: FollowLine[] } {
  const expected = expectedFollows(recipe);
  if (!expected.size) return { line: null, follows: [] };
  const check = "Solids and sweeps follow the size parameters";
  if (!follow) return { line: { check, state: "Not checked", detail: "This add-in's flex doesn't move the size parameters: update the add-in" }, follows: [] };
  const okParams = new Set(follow.params.filter((p) => p.ok).map((p) => p.param));
  const bad = follow.params.filter((p) => !p.ok);
  const byName = new Map(follow.elements.map((e) => [e.name, e]));
  const follows: FollowLine[] = [];
  for (const [solid, gov] of expected) {
    const e = byName.get(solid);
    const tested = gov.filter((p) => okParams.has(p));
    if (!e || e.no_box) { follows.push({ solid, follows: e ? "no bounding box" : "not in the family", governed_by: gov.join("/"), state: "Not checked" }); continue; }
    const missed = tested.filter((p) => !e.moved.includes(p));
    follows.push({ solid, follows: e.moved.length ? `follows ${e.moved.join("/")}` : "follows nothing", governed_by: gov.join("/"),
      state: missed.length ? "Fail" : tested.length ? "Pass" : "Not checked" });
  }
  const failing = follows.filter((f) => f.state === "Fail");
  const notChecked = follows.filter((f) => f.state === "Not checked");
  const groups = new Map<string, string[]>();
  for (const f of follows.filter((x) => x.state === "Pass")) { if (!groups.has(f.follows)) groups.set(f.follows, []); groups.get(f.follows)!.push(f.solid); }
  const parts: string[] = [];
  if (failing.length) parts.push(failing.slice(0, 4).map((f) => `${f.solid} ${f.follows}, but its planes move with ${f.governed_by}`).join("; ") +
    (failing.length > 4 ? ` (and ${failing.length - 4} more)` : ""));
  for (const [what, names] of groups) parts.push(`${what}: ${names.length} (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""})`);
  if (bad.length) parts.push(`not moved: ${bad.map((b) => `${b.param}${b.error ? ` (${b.error})` : ""}`).join("; ")}`);
  if (notChecked.length) parts.push(`not checked: ${notChecked.slice(0, 3).map((f) => `${f.solid} (${f.follows})`).join(", ")}${notChecked.length > 3 ? ", …" : ""}`);
  const state: GateState = failing.length ? "Fail" : follows.some((f) => f.state === "Pass") && !bad.length ? "Pass" : "Not checked";
  return { line: { check, state, detail: parts.join("; ") || "nothing to check" }, follows };
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
    /** Each size parameter at its lowest and highest type value, and which named solids moved with it. */
    follow?: FlexFollow;
    /** A flex call that failed (session gone, file open in a window) answers with an error, not types. */
    error?: string; refused?: boolean; reasons?: string[];
  } | null;
  flexError?: string;
  registerCategory: string | null;
  /** F-047: the family's category in FMC_Family_Specs.json (null: not in the specs). */
  specCategory?: string | null;
  /** F-047: the kit's Family_Name_Tokens (token → Revit category); null when the table couldn't be read. */
  tokenCategories?: Map<string, string> | null;
  /** F-045: the dimension sides the build's own flex recorded (FMC_Recipe_Builds.json), when the gate can't flex the file now. */
  recordedSides?: RecordedSides | null;
}

/** What a build's flex said about labelled dimension sides, kept in its build record (F-045). */
export interface RecordedSides {
  at: string;
  dimension_sides: { checked: number; unrecorded: number };
  wrong: Array<DimensionSide & { type: string }>;
}

/** The sides part of a flex result, for the build record; null when this add-in's flex doesn't report sides. */
export function recordSides(flex: GateInputs["flex"], at: string): RecordedSides | null {
  if (!flex || !flex.dimension_sides || !Array.isArray(flex.types)) return null;
  return { at, dimension_sides: flex.dimension_sides, wrong: flex.types.flatMap((t) => (t.dimension_sides ?? []).map((s) => ({ type: t.type, ...s }))) };
}

const REQUIRED_PARAMS = "Required FMC parameters present (by GUID)";
export const CATEGORY_CHECK = "Category against the register, the spec and the name";
export const SIDES_CHECK = "Labelled dimensions keep their planes' sides";

const normCat = (c: string) => c.toLowerCase().replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
/** "Walls (system) / Generic Models": either; "Generic Annotations (nested)": Generic Annotations. */
const sameCategory = (actual: string, ref: string) => ref.split("/").map(normCat).filter(Boolean).includes(normCat(actual));

/**
 * The category token in a family's name: FMC_<Role>_<Token>_…, a project family's [Project]_[Role]_<Token>_…, and
 * Profile for FMC_Profile_*. Title blocks and annotations (FMC_TitleBlock, FMC_TB_, FMC_SYM_, FMC_TAG_, FMC_GA_) carry none.
 */
export function nameToken(family: string): string | null {
  if (/^FMC_Profile_/.test(family)) return "Profile";
  if (/^FMC_(TitleBlock|TB_|SYM_|TAG_|GA_)/.test(family)) return null;
  const lib = /^FMC_([A-Z]{1,2})_([A-Za-z0-9]+)_/.exec(family);
  if (lib) return ROLE_CODES.includes(lib[1]) ? lib[2] : null;
  const project = /^([A-Z0-9]{2,6})_([A-Z]{1,2})_([A-Za-z0-9]+)_/.exec(family);
  return project && ROLE_CODES.includes(project[2]) ? project[3] : null;
}

/**
 * F-047 (issue #148): the family's own category against the register's, the spec's and the one its name's token stands
 * for (the kit's Family_Name_Tokens). Any mismatch Fails: FMC_A_GenericModel_FloorFall in Generic Annotations fails on
 * its token even though the register files it there too. A register entry that records the exception in its category
 * text ("…; GenericModel until StrConnection is added") is a Warn.
 */
export function categoryLine(family: string, actual: string, inputs: Pick<GateInputs, "registerCategory" | "specCategory" | "tokenCategories">): GateLine {
  const register = inputs.registerCategory ?? null, spec = inputs.specCategory ?? null;
  if (!actual) return { check: CATEGORY_CHECK, state: "Not checked", detail: "The saved file's category wasn't read" };
  const fails: string[] = [], warns: string[] = [], passes: string[] = [];
  if (register != null) (sameCategory(actual, register) ? passes : fails).push(`the register says ${register}`);
  if (spec != null && (register == null || normCat(spec) !== normCat(register))) (sameCategory(actual, spec) ? passes : fails).push(`the spec says ${spec}`);
  const token = nameToken(family);
  if (token) {
    const tokens = inputs.tokenCategories;
    const meant = tokens?.get(token);
    if (!tokens) warns.push(`the name's token ${token} wasn't checked: the kit's Family_Name_Tokens table wasn't readable`);
    else if (!meant) warns.push(`the name's token ${token} isn't in the kit's Family_Name_Tokens`);
    else if (sameCategory(actual, meant)) passes.push(`the name's token ${token} is ${meant}`);
    else if (register && new RegExp(`\\b${token}\\b`).test(register)) warns.push(`the name's token ${token} is ${meant}; the register records the exception (${register})`);
    else fails.push(`the name's token ${token} means ${meant}` + (register != null && sameCategory(actual, register)
      ? `, but the register files it under ${register}: the kit's entry disagrees with its own name (rename the family or change the register: a kit change request)` : ""));
  }
  if (!fails.length && !warns.length && !passes.length)
    return { check: CATEGORY_CHECK, state: "Not checked", detail: `${actual}: ${family} isn't in FMC_Family_Register.csv or the specs, and its name has no category token` };
  const state: GateState = fails.length ? "Fail" : warns.length ? "Warn" : "Pass";
  return { check: CATEGORY_CHECK, state, detail: `${actual}` + (fails.length ? `; ${fails.join("; ")}` : "") + (warns.length ? `; ${warns.join("; ")}` : "") +
    (!fails.length && !warns.length && passes.length ? ` (${passes.join("; ")})` : "") };
}

/**
 * F-045 (issue #146): the labelled-dimension sides line, on every gate. From this gate's flex of the saved file when it
 * ran and the add-in reports sides; else from the build's own flex (its record); else Not checked with why.
 */
export function sidesLine(flex: GateInputs["flex"], flexUsable: boolean, flexError: string, recorded: RecordedSides | null | undefined): GateLine {
  const fromFlex = flexUsable && flex?.dimension_sides
    ? { sides: flex.dimension_sides, wrong: (flex.types ?? []).flatMap((t) => (t.dimension_sides ?? []).map((s) => ({ type: t.type, ...s }))), source: "" }
    : null;
  const from = fromFlex ?? (recorded ? { sides: recorded.dimension_sides, wrong: recorded.wrong, source: ` (from the build's flex, ${recorded.at}: the saved file couldn't be flexed now${flexError ? `: ${flexError}` : ""})` } : null);
  if (!from) {
    const why = !flexUsable ? `Flex didn't run${flexError ? `: ${flexError}` : ""}, and no build record holds the sides`
      : "This add-in's flex doesn't report dimension sides: update the add-in";
    return { check: SIDES_CHECK, state: "Not checked", detail: why };
  }
  const { sides, wrong } = from;
  return { check: SIDES_CHECK,
    state: wrong.length ? "Fail" : sides.checked ? "Pass" : "Not checked",
    detail: (wrong.length
      ? wrong.slice(0, 4).map((w) => `${w.type}: ${w.b} was drawn ${side(w.axis, w.drawn)} ${w.a}${w.label ? ` (${w.label})` : ""}, now ${Math.abs(w.now_mm)} mm ${side(w.axis, w.now_mm)} it`).join("; ")
      : sides.checked ? `${sides.checked} labelled dimensions keep their sides in every type${sides.unrecorded ? `; ${sides.unrecorded} older ones have no recorded side` : ""}`
      : `No dimension recorded the side it was drawn on${sides.unrecorded ? ` (${sides.unrecorded} were made before this check: rebuild the family)` : " (the family has no labelled dimensions between two planes)"}`) + from.source };
}
const SIDE_WORDS: Record<string, [string, string]> = { z: ["above", "below"], x: ["to the right of (+x)", "to the left of (-x)"], y: ["on the +y side of", "on the -y side of"] };
const side = (axis: string, sign: number) => (SIDE_WORDS[axis] ?? ["after", "before"])[sign > 0 ? 0 : 1];

export function gateA(family: string, recipe: Recipe | null, inputs: GateInputs): { verdict: "Pass" | "Fail"; lines: GateLine[]; follows?: FollowLine[] } {
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
    } else if (/keynote/i.test(c.check) && line.state === "Fail" && recipe?.checks.keynote_exempt) {
      // a nested helper or clearance family, never scheduled: exempt, and the reason stays in the gate record
      line = { ...line, state: "Pass", detail: `Exempt: ${recipe.checks.keynote_exempt} (the file has none: ${c.detail})` };
    } else if (c.check === REQUIRED_PARAMS && line.state === "Pass" && /^0 /.test(c.detail)) {
      line = { ...line, state: "Fail", detail: `0 required and 0 checked: the kit spec lists none and the recipe adds none, so nothing shows the family carries its kit parameters` };
    }
    lines.push(line);
  }
  if (!inputs.inspect) lines.push({ check: "Library checks on the saved file", state: "Not checked", detail: `The file couldn't be inspected: ${inputs.inspectError || "no reason given"}` });
  else {
    // F-045: "Required FMC parameters" never passes on nothing, whatever shape the library's line came in
    const req = lines.find((l) => l.check === REQUIRED_PARAMS);
    if (!req) lines.push({ check: REQUIRED_PARAMS, state: "Not checked", detail: "The library's checks didn't include it: update the add-in and server" });
    else if (req.state === "Pass" && (/^0\b|\b0 (present|of|required)\b/.test(req.detail) || !/[1-9]/.test(req.detail)))
      Object.assign(req, { state: "Fail", detail: `${req.detail}: nothing shows the family carries its kit parameters (never a pass on 0)` });
  }

  // F-047: the category against the register, the spec and the name's token
  lines.push(categoryLine(family, inputs.inspect?.category ?? "", inputs));

  // A flex that answered with an error (session gone, the file open in a window) didn't run (F-045)
  const flexUsable = !!inputs.flex && !inputs.flex.error && !inputs.flex.refused && (Array.isArray(inputs.flex.types) || inputs.flex.ok === true);
  const flexError = inputs.flexError || (inputs.flex && !flexUsable ? String(inputs.flex.error ?? (inputs.flex.reasons ?? []).join("; ")) : "");
  if (!flexUsable || !inputs.flex) lines.push({ check: "Every type flexes", state: "Not checked", detail: `Flex didn't run${flexError ? `: ${flexError}` : ""}` });
  else {
    const types = inputs.flex.types ?? [];
    const failing = types.filter((t) => !t.ok);
    // F-039: a type bigger than the template's host wall can't cut its opening; say what to change
    const cutOut = failing.some((f) => (f.errors ?? []).some((e) => /cut-?out|cut the host|opening.*host/i.test(e)));
    lines.push({ check: "Every type flexes", state: inputs.flex.ok && !failing.length ? "Pass" : "Fail",
      detail: (failing.length ? failing.slice(0, 3).map((f) => `${f.type}${f.errors?.length ? `: ${f.errors[0]}` : ""}`).join("; ") : `${types.length || "all"} types regenerate`) +
        (cutOut ? ". The opening is bigger than the template's host wall: raise the host wall (its height, and its length for wide types) in the recipe's template so the largest type cuts" : "") });
  }
  // F-039/F-026/F-045: a labelled dimension whose plane ended on the other side of its reference; on every gate
  lines.push(sidesLine(inputs.flex, flexUsable, flexError, inputs.recordedSides));

  // Fully parametric: every solid and sweep tied to a plane that a size parameter moves must move with it
  const fc = recipe && inputs.flex ? followCheck(recipe, inputs.flex.follow) : { line: null, follows: [] as FollowLine[] };
  if (fc.line) lines.push(fc.line);

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
  return { verdict: lines.some((l) => l.state === "Fail") ? "Fail" : "Pass", lines, ...(fc.follows.length ? { follows: fc.follows } : {}) };
}
