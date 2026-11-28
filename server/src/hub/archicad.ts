/**
 * Formcraft family → ArchiCAD GDL object (docs/PLAN_ARCHICAD.md, AC1 "build", the generator step).
 *
 * The approach is the one scripts/gdl/fmc_gdl.py proved on 19 Oct (four hospital objects compiled with LP_XMLConverter
 * in ArchiCAD 28), ported into the hub so it is one tool call:
 *   a family's recipe (fmc-recipe/0.1), or the fmc_doc report of a family opened in staging
 *   → one neutral description (parameters, types, solids, materials, subcategories)
 *   → a mapping report (what maps to GDL, what maps in part, what doesn't and why: the dry run)
 *   → GDL scripts (master, 2D, 3D, parameter, interface) and the parameter list
 *   → the library part as XML, laid out for LP_XMLConverter xml2libpart (never run here).
 *
 * Coordinates: Revit family millimetres (x right, y back, z up) → GDL metres, shifted so the object's box runs
 * 0..A, 0..B, 0..ZZYZX. Geometry is frozen at the default type's size (reference planes resolved to numbers);
 * parameters, types and formulas still come across as GDL parameters.
 *
 * Pure: no Revit, no ArchiCAD, no files.
 */
import crypto from "node:crypto";

type Pt = number[];
type Op = Record<string, any>;

export type Status = "mapped" | "partial" | "unsupported";
export type GdlType = "Length" | "Angle" | "RealNum" | "Integer" | "Boolean" | "String" | "Material" | "PenColor" | "FillPattern" | "Title";

// ------------------------------------------------------------------------------------------------ formatting

/** A number for GDL: 5 decimals at most, no trailing zeros, never "-0". */
export function F(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return "0";
  const s = v.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}
/** Millimetres → metres, formatted. */
export const M = (mm: number) => F(mm / 1000);

/** RFC 4122 version 5 UUID (SHA-1), upper case: the same MainGUID fmc_gdl.py gave (uuid.uuid5). */
export function uuid5(name: string, namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const h = crypto.createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex").toUpperCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function objectGuid(family: string): string { return uuid5("formcraft-gdl:" + family); }

// ------------------------------------------------------------------------------------------------ GDL names

/** Names GDL or this generator already uses; a family parameter with one of these names gets a suffix. */
const RESERVED = new Set([
  "a", "b", "zzyzx", "ilod", "ilod3d", "ilod2d", "ires", "res", "soft", "penmodel", "pencontour",
  "penclear", "bkitsurfaces", "bshowclearance", "bclear3d", "fmctype", "fmc_family", "fmc_source", "fmck", "tmodel", "tplan",
  "tfamily", "tdata", "if", "then", "else", "endif", "for", "to", "next", "step", "while", "do", "endwhile", "repeat", "until",
  "goto", "gosub", "return", "end", "exit", "and", "or", "not", "exor", "mod", "dim", "values", "parameters", "lock", "hide",
  "call", "print", "group", "endgroup", "pi",
]);

/** A GDL parameter name: letters, digits and _, starting with a letter, 32 characters at most, unique. */
export function gdlName(revit: string, used: Set<string>): string {
  let n = revit.normalize("NFKD").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/__+/g, "_");
  if (!/^[A-Za-z]/.test(n)) n = "p" + (n ? "_" + n : "");
  n = n.slice(0, 32);
  if (/^(glob|symb|wido|gdl|ac)_/i.test(n)) n = ("p_" + n).slice(0, 32);
  let out = n, k = 2;
  while (RESERVED.has(out.toLowerCase()) || used.has(out.toLowerCase())) {
    const suf = "_" + k++;
    out = n.slice(0, 32 - suf.length) + suf;
  }
  used.add(out.toLowerCase());
  return out;
}

// ------------------------------------------------------------------------------------------------ the neutral model

export interface FamParam {
  name: string;                 // Revit name
  revitType: string;            // Length, YesNo, Material, Text, … or "unknown"
  instance: boolean;
  shared: boolean;
  builtin?: boolean;            // a Revit built-in (Description, Keynote…) only set by a type value
  formula?: string;
  value?: unknown;              // the default type's value (Revit units: mm, degrees)
}

export interface Solid {
  name: string;
  kind: "box" | "extrude" | "revolve" | "tube" | "ruled" | "bbox";
  revit: string;                // what Revit calls it, e.g. "extrusion (rect)", "Sweep"
  void: boolean;
  sub: string;
  vis: [boolean, boolean, boolean];   // coarse, medium, fine
  visParam?: string;
  materialParam?: string;
  status: Status;
  reason: string;
  geom: Record<string, any>;    // kind-specific, recipe mm
  array?: { countParam: string; max: number; direction: string; spacing: number };
}

export interface Unmapped { name: string; revit: string; status: Status; reason: string; gdl?: string }

export interface FamilyModel {
  family: string;
  source: "recipe" | "fmc_doc_report";
  category: string;
  template: string;
  about: string;
  params: FamParam[];
  types: Array<{ name: string; values: Record<string, unknown> }>;
  solids: Solid[];
  /** non-solid elements: nested families, connectors, symbolic lines, profiles */
  others: Unmapped[];
  /** plan symbolic lines GDL can draw (recipe mm) */
  plan2d: Array<{ name: string; points?: Pt[]; arc?: { center: Pt; radius: number; start_deg: number; end_deg: number } }>;
  hotspots: Array<{ name: string; at: Pt; why: string }>;
  materials: Array<{ param: string; material: string }>;
  subcategories: string[];
  constraintOps: Record<string, number>;
  notes: string[];
}

// ------------------------------------------------------------------------------------------------ Revit → GDL types

const MEP_UNITS = /^(Voltage|ApparentPower|Power|Current|Wattage|Flow|AirFlow|PipeFlow|Pressure|Temperature|HeatGain|Illuminance|LuminousFlux|Efficacy|Frequency|Velocity|Mass|Weight|Force|Energy|Currency|Slope|Number)$/i;

/** One Revit parameter type → its GDL type, how well it maps, and why. */
export function mapParamType(revitType: string): { gdl: GdlType | null; status: Status; note: string } {
  const t = (revitType || "").replace(/\s+/g, "");
  switch (t.toLowerCase()) {
    case "length": return { gdl: "Length", status: "mapped", note: "mm → m" };
    case "yesno": case "boolean": return { gdl: "Boolean", status: "mapped", note: "" };
    case "integer": case "numberofpoles": return { gdl: "Integer", status: "mapped", note: "" };
    case "angle": return { gdl: "Angle", status: "mapped", note: "degrees" };
    case "material": return { gdl: "Material", status: "mapped", note: "kit surface defined inline; the GDL Material parameter is the stand-in when kit surfaces are off" };
    case "text": case "multilinetext": case "url": return { gdl: "String", status: "mapped", note: "" };
    case "area": return { gdl: "RealNum", status: "partial", note: "area as a plain number (m²); GDL has no area parameter type" };
    case "volume": return { gdl: "RealNum", status: "partial", note: "volume as a plain number (m³); GDL has no volume parameter type" };
    case "familytype": return { gdl: null, status: "unsupported", note: "a nested family type selector: GDL has no family types (CALL a macro object instead)" };
    case "image": return { gdl: null, status: "unsupported", note: "an image parameter: GDL objects use the preview picture section instead" };
    case "unknown": return { gdl: "String", status: "partial", note: "the source carries no parameter type: exported as String" };
  }
  if (MEP_UNITS.test(t)) return { gdl: "RealNum", status: "partial", note: `${t} as a plain number in Revit's display unit; GDL has no ${t} type` };
  return { gdl: null, status: "unsupported", note: `no GDL type for Revit ${revitType || "(none)"}` };
}

/** A type value in Revit units → the GDL value of that type. */
function gdlValue(t: GdlType, v: unknown): number | string {
  if (t === "String") return v === undefined || v === null ? "" : String(v);
  if (t === "Boolean") return v === true || v === 1 || v === "1" || /^(yes|true)$/i.test(String(v)) ? 1 : 0;
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (t === "Length") return n / 1000;
  if (t === "Integer") return Math.round(n);
  return n;
}

// ------------------------------------------------------------------------------------------------ recipe → model

type PlaneMap = Map<string, { axis: "x" | "y" | "z"; at: number; assumed?: string }>;

function firstTypeValue(ops: Op[], param: string): unknown {
  const o = ops.find((x) => x.op === "set_type_value" && x.param === param);
  return o?.value;
}

/** Reference planes by name → axis and position (mm), as scripts/gdl/ir.py reads them, plus the template's own planes. */
export function recipePlanes(ops: Op[], template = ""): PlaneMap {
  const planes: PlaneMap = new Map([
    ["Center (Front/Back)", { axis: "y", at: 0 }], ["Center (Left/Right)", { axis: "x", at: 0 }], ["Ref. Level", { axis: "z", at: 0 }],
  ]);
  for (const o of ops) {
    if (o.op !== "add_ref_plane" || !Array.isArray(o.from) || !Array.isArray(o.to)) continue;
    const [x1, y1] = o.from as number[], [x2] = o.to as number[];
    const view = String(o.view ?? "");
    if (/^(front|back|right|left)$/i.test(view)) planes.set(o.name, { axis: "z", at: y1 });
    else if (Math.abs(x1 - x2) < 1e-6) planes.set(o.name, { axis: "x", at: x1 });
    else planes.set(o.name, { axis: "y", at: y1 });
  }
  // Metric Door.rft / Metric Window.rft ship Left, Right, Head (and Sill): their places follow the type's Width/Height.
  const num = (p: string) => { const v = Number(firstTypeValue(ops, p)); return Number.isFinite(v) && firstTypeValue(ops, p) !== undefined ? v : undefined; };
  const width = num("Width"), height = num("Height");
  const sill = /window/i.test(template) ? (num("Default Sill Height") ?? num("Sill Height") ?? 0) : 0;
  if (width !== undefined) {
    if (!planes.has("Left")) planes.set("Left", { axis: "x", at: -width / 2, assumed: "template plane Left at -Width/2" });
    if (!planes.has("Right")) planes.set("Right", { axis: "x", at: width / 2, assumed: "template plane Right at +Width/2" });
  }
  if (!planes.has("Sill") && /window/i.test(template)) planes.set("Sill", { axis: "z", at: sill, assumed: "template plane Sill at the default sill height" });
  if (height !== undefined && !planes.has("Head")) planes.set("Head", { axis: "z", at: sill + height, assumed: "template plane Head at sill + Height" });
  return planes;
}

const isPts = (p: unknown): p is Pt[] => Array.isArray(p) && p.length > 0 && p.every((q) => Array.isArray(q) && q.length >= 2 && q.every((n) => typeof n === "number"));

/** A sweep's path from path_planes (FmcDocSweep: corners where two planes cross; path_offsets shift each segment's plane). */
export function pathFromPlanes(o: Op, planes: PlaneMap, numParam: (n: string) => number | undefined): { path: Pt[]; at: number; notes: string[] } | { error: string } {
  const view = String(o.path_plane ?? "plan");
  const across = view === "right" ? "y" : "x", up = view === "plan" ? "y" : "z";
  const corners = o.path_planes as string[][];
  const notes: string[] = [];
  for (const c of corners) for (const n of c) {
    if (!planes.has(n)) return { error: `reference plane "${n}" comes from the template or a level and its position isn't known` };
    const a = planes.get(n)!.assumed; if (a && !notes.includes(a)) notes.push(a);
  }
  const closed = corners.length > 2 && new Set(corners[0]).size === new Set([...corners[0], ...corners[corners.length - 1]]).size;
  const nSeg = corners.length - 1;
  const along: string[] = [];
  for (let k = 0; k < nSeg; k++) {
    const shared = corners[k].filter((n) => corners[k + 1].includes(n));
    if (shared.length !== 1) return { error: `segment ${k + 1} doesn't run along one plane` };
    along.push(shared[0]);
  }
  const offs = Array.isArray(o.path_offsets) ? o.path_offsets : [];
  const off = (k: number) => {
    const v = offs[k];
    if (typeof v === "number") return v;
    if (typeof v === "string") { const p = numParam(v); if (p === undefined) notes.push(`path offset ${v} has no default value: 0 used`); return p ?? 0; }
    return 0;
  };
  const shifted = (k: number) => { const p = planes.get(along[k])!; return { axis: p.axis, at: p.at + off(k) }; };
  const nV = closed ? nSeg : nSeg + 1;
  const pts: Pt[] = [];
  for (let i = 0; i < nV; i++) {
    let before = i - 1, after = i;
    if (closed && before < 0) before = nSeg - 1;
    if (!closed && after >= nSeg) after = -1;
    const fixes: Array<{ axis: string; at: number }> = [];
    if (before >= 0 && after >= 0 && along[before] !== along[after]) fixes.push(shifted(before), shifted(after));
    else {
      const k = before >= 0 ? before : after;
      fixes.push(shifted(k));
      const other = corners[i].find((n) => n !== along[k]) ?? corners[i][0];
      fixes.push(planes.get(other)!);
    }
    const u = fixes.find((f) => f.axis === across), v = fixes.find((f) => f.axis === up);
    if (!u || !v) return { error: `corner ${i + 1} [${corners[i].join(", ")}] isn't two crossing planes in the ${view} view` };
    pts.push([u.at, v.at]);
  }
  if (closed) pts.push([...pts[0]]);
  let at = Number(o.at ?? 0);
  if (o.path_host) {
    const h = planes.get(String(o.path_host));
    if (!h) return { error: `path_host "${o.path_host}" isn't a known plane` };
    at = h.at;
  }
  return { path: pts, at, notes };
}

const SOLID_OPS = ["extrusion", "void_extrusion", "revolution", "sweep", "void_sweep", "blend", "void_blend", "swept_blend", "void_swept_blend"];
const CONSTRAINT_OPS = ["add_ref_plane", "add_dimension", "add_eq_dimension", "lock_face", "set_default_size", "name_template_plane",
  "delete_template_element", "link_connector_param", "set_type_image", "set_family_params"];

/** Reads a recipe into the neutral model. Never throws on a solid: what it can't read is reported with a reason. */
export function recipeModel(recipe: Record<string, any>): FamilyModel {
  const ops: Op[] = Array.isArray(recipe.ops) ? recipe.ops : [];
  const family = String(recipe.family ?? "Unnamed");
  const template = String(recipe.template ?? "");
  const planes = recipePlanes(ops, template);
  const m: FamilyModel = {
    family, source: "recipe", category: "", template, about: String(recipe.about ?? ""), params: [], types: [], solids: [], others: [],
    plan2d: [], hotspots: [], materials: [], subcategories: [], constraintOps: {}, notes: [],
  };
  const by = (op: string, key = "name") => { const r = new Map<string, Op>(); for (const o of ops) if (o.op === op && o[key] !== undefined) r.set(String(o[key]), o); return r; };
  const subcat = by("set_subcategory"), matParam = by("set_material_param"), vis = by("set_visibility"), visParam = by("set_visible_param", "solid");
  const formulas = by("set_formula");
  const arrays = by("array", "solid");

  // parameters
  const seen = new Set<string>();
  const addParam = (p: FamParam) => { if (seen.has(p.name)) return; seen.add(p.name); m.params.push(p); };
  for (const o of ops) {
    if (o.op === "add_family_param") addParam({ name: o.name, revitType: String(o.type ?? "Text"), instance: o.instance !== false, shared: false });
    if (o.op === "add_shared_param") {
      const v = firstTypeValue(ops, o.name);
      addParam({ name: o.name, revitType: typeof v === "number" ? "Number" : "Text", instance: o.instance === true, shared: true });
    }
    if (o.op === "set_category") m.category = String(o.name);
  }
  for (const o of ops) {
    if (o.op === "set_type_value" && !seen.has(o.param)) {
      const v = o.value;
      const t = typeof v === "number" ? (/elevation|height|width|depth|length|offset/i.test(o.param) ? "Length" : "Number") : "Text";
      addParam({ name: o.param, revitType: t, instance: false, shared: false, builtin: true });
    }
  }
  for (const p of m.params) {
    p.value = firstTypeValue(ops, p.name);
    const f = formulas.get(p.name); if (f) p.formula = String(f.formula ?? "");
  }
  // types
  for (const o of ops) {
    if (o.op === "add_type" && !m.types.some((t) => t.name === o.name)) m.types.push({ name: String(o.name), values: {} });
    if (o.op === "set_type_value") {
      let t = m.types.find((x) => x.name === o.type);
      if (!t) { t = { name: String(o.type), values: {} }; m.types.push(t); }
      t.values[o.param] = o.value;
    }
  }
  // materials and subcategories
  for (const o of ops) {
    if (o.op === "add_material" && o.param) m.materials.push({ param: String(o.param), material: String(o.name) });
    if (o.op === "add_subcategory" && !m.subcategories.includes(o.name)) m.subcategories.push(String(o.name));
  }
  const numParam = (n: string) => { const v = Number(firstTypeValue(ops, n)); return Number.isFinite(v) && firstTypeValue(ops, n) !== undefined ? v : undefined; };

  // solids
  for (const o of ops) {
    const k = String(o.op);
    if (!SOLID_OPS.includes(k)) continue;
    const name = String(o.name);
    const v = vis.get(name);
    const s: Solid = {
      name, kind: "box", revit: k, void: k.startsWith("void"), sub: String(subcat.get(name)?.subcategory ?? o.subcategory ?? ""),
      vis: [v?.coarse !== false, v?.medium !== false, v?.fine !== false],
      visParam: visParam.get(name)?.param, materialParam: matParam.get(name)?.param, status: "mapped", reason: "", geom: {},
    };
    const ar = arrays.get(name);
    if (ar) s.array = { countParam: String(ar.count_param ?? ""), max: Number(ar.max ?? 1), direction: String(ar.direction ?? "x"), spacing: Number(ar.spacing_mm ?? 0) };
    const notes: string[] = [];
    if (k === "extrusion" || k === "void_extrusion") {
      const z0 = o.start_plane && planes.has(o.start_plane) ? planes.get(o.start_plane)!.at : Number(o.start ?? 0);
      const z1 = o.end_plane && planes.has(o.end_plane) ? planes.get(o.end_plane)!.at : Number(o.end ?? 1000);
      if (o.end_plane && !planes.has(o.end_plane)) notes.push(`end plane ${o.end_plane} unknown: end ${o.end} used`);
      if (Array.isArray(o.rect)) {
        s.revit += " (rect)";
        const miss = (o.rect as string[]).filter((n) => !planes.has(n));
        if (miss.length) { s.status = "unsupported"; s.reason = `reference plane(s) ${miss.join(", ")} come from the template and their position isn't known`; m.solids.push(s); continue; }
        const [a, b, c, d] = (o.rect as string[]).map((n) => planes.get(n)!.at);
        for (const n of o.rect as string[]) { const as = planes.get(n)!.assumed; if (as) notes.push(as); }
        s.kind = "box";
        s.geom = { box: [Math.min(a, b), Math.min(c, d), Math.min(z0, z1), Math.max(a, b), Math.max(c, d), Math.max(z0, z1)] };
        s.reason = "BLOCK at the default type's plane positions";
      } else if (isPts(o.points)) {
        s.kind = "extrude"; s.revit += " (points)";
        s.geom = { points: o.points, start: z0, end: z1, sketch: String(o.sketch ?? "plan") };
        s.reason = "EXTRUDE";
      } else { s.status = "unsupported"; s.reason = "the profile isn't a list of [x, y] points (arcs or splines)"; }
    } else if (k === "revolution") {
      if (!isPts(o.profile)) { s.status = "unsupported"; s.reason = "the profile isn't a list of [r, z] points"; }
      else {
        s.kind = "revolve"; s.geom = { profile: o.profile, axis: o.axis ?? "z", axis_at: o.axis_at ?? [0, 0], start_deg: o.start_deg ?? 0, end_deg: o.end_deg ?? 360 };
        s.reason = "REVOLVE";
        if ((o.start_deg ?? 0) !== 0 || (o.end_deg ?? 360) !== 360) { s.status = "partial"; notes.push("a part revolution is drawn as a full turn"); }
      }
    } else if (k === "sweep" || k === "void_sweep") {
      if (!isPts(o.profile)) {
        s.status = "unsupported";
        s.reason = o.profile_family ? `the profile is the loaded profile family ${o.profile_family}: GDL needs its outline (no profile points in the recipe)` : "no profile points";
      } else {
        let path: Pt[] | undefined, at = Number(o.at ?? 0);
        if (Array.isArray(o.path_planes)) {
          const r = pathFromPlanes(o, planes, numParam);
          if ("error" in r) { s.status = "unsupported"; s.reason = r.error; m.solids.push(s); continue; }
          path = r.path; at = r.at; notes.push(...r.notes);
        } else if (isPts(o.path)) path = o.path;
        if (!path || path.length < 2) { s.status = "unsupported"; s.reason = "no path"; }
        else {
          s.kind = "tube"; s.geom = { profile: o.profile, path, path_plane: String(o.path_plane ?? "plan"), at };
          s.reason = "TUBE along the path";
          s.status = "partial"; notes.push("profile orientation along the path follows GDL TUBE, not checked against Revit's sweep");
        }
      }
    } else if (k === "blend" || k === "void_blend") {
      if (!isPts(o.base) || !isPts(o.top)) { s.status = "unsupported"; s.reason = "base or top holds arcs or splines"; }
      else if ((o.base as Pt[]).length !== (o.top as Pt[]).length) {
        s.status = "unsupported";
        s.reason = `base has ${(o.base as Pt[]).length} points and top ${(o.top as Pt[]).length}: GDL RULED joins point to point (re-sample the outlines to the same count)`;
      } else {
        s.kind = "ruled"; s.geom = { base: o.base, top: o.top, start: Number(o.start ?? 0), end: Number(o.end ?? 1000) };
        s.reason = "RULED (base to top, point to point)";
      }
    } else {
      s.status = "unsupported"; s.reason = "a swept blend: no GDL generator yet (RULEDSEGMENTED or COONS would be needed)";
    }
    if (s.array && s.status !== "unsupported") notes.push(`repeated by ${s.array.countParam} (at most ${s.array.max}) every ${s.array.spacing} mm along ${s.array.direction}`);
    if (notes.length) {
      s.reason += (s.reason ? "; " : "") + notes.join("; ");
      if (s.status === "mapped" && notes.some((n) => /template plane|unknown|no default/.test(n))) s.status = "partial";
    }
    m.solids.push(s);
  }

  // non-solids
  const solidBy = new Map(m.solids.map((s) => [s.name, s]));
  for (const o of ops) {
    const k = String(o.op);
    if (k === "place_nested") {
      const at: Pt = Array.isArray(o.at) ? o.at : [0, 0, 0];
      m.others.push({ name: String(o.name), revit: `nested family ${o.family ?? ""}${o.type ? " : " + o.type : ""}`, status: "unsupported",
        reason: "a nested family needs its own GDL object (CALL as a macro); a hotspot marks where it sits", gdl: "HOTSPOT (placeholder)" });
      m.hotspots.push({ name: String(o.name), at: [at[0] ?? 0, at[1] ?? 0, at[2] ?? 0], why: "nested family" });
    } else if (k === "add_connector") {
      const s = solidBy.get(String(o.solid));
      const c = s ? faceCentre(s, String(o.side ?? "")) : null;
      m.others.push({ name: String(o.name), revit: `connector (${o.domain ?? "?"}${o.system ? ", " + o.system : ""})`, status: "partial",
        reason: c ? `a hotspot at the ${o.side || "centre"} of ${o.solid}; MEP ports wait for PLAN_ARCHICAD AC2a (learn the MEP library's port macros first)`
          : "a connector on a solid that isn't drawn: no hotspot; MEP ports wait for AC2a",
        gdl: c ? "HOTSPOT" : undefined });
      if (c) m.hotspots.push({ name: String(o.name), at: c, why: "connector" });
    } else if (k === "symbolic_lines") {
      const view = String(o.view ?? "plan");
      if (view !== "plan") m.others.push({ name: String(o.name), revit: `symbolic lines (${view})`, status: "unsupported", reason: "GDL objects have no elevation symbols: sections and elevations show the 3D model" });
      else if (o.arc && Array.isArray(o.arc.center) && typeof o.arc.radius === "number") {
        m.plan2d.push({ name: String(o.name), arc: { center: o.arc.center, radius: o.arc.radius, start_deg: Number(o.arc.start_deg ?? 0), end_deg: Number(o.arc.end_deg ?? 360) } });
        m.others.push({ name: String(o.name), revit: "symbolic arc (plan)", status: "mapped", reason: "ARC2 in the 2D script", gdl: "ARC2" });
      } else if (isPts(o.points)) {
        m.plan2d.push({ name: String(o.name), points: o.points });
        m.others.push({ name: String(o.name), revit: "symbolic lines (plan)", status: "mapped", reason: "LINE2 in the 2D script", gdl: "LINE2" });
      } else m.others.push({ name: String(o.name), revit: "symbolic lines (plan, on planes)", status: "unsupported", reason: "ends on planes or a labelled radius: no fixed points to draw" });
    } else if (k === "profile_lines") {
      m.others.push({ name: String(o.name), revit: "profile family outline", status: "unsupported", reason: "a profile family is not an object: in ArchiCAD it is a Complex Profile" });
    } else if (k === "load_family") {
      m.others.push({ name: String(o.name), revit: "loaded family", status: "partial", reason: "loaded for a nested part or a sweep profile; nothing is drawn from it in GDL" });
    } else if (CONSTRAINT_OPS.includes(k)) {
      m.constraintOps[k] = (m.constraintOps[k] ?? 0) + 1;
    }
  }
  if (/door|window/i.test(m.category) || /door|window/i.test(template))
    m.notes.push("A door or window comes across as a free-standing Model Element: the ArchiCAD Door/Window subtype (wall opening, WALLHOLE, frame parameters) isn't generated.");
  if (Object.keys(m.constraintOps).length)
    m.notes.push("Reference planes, dimensions, locks and EQ constraints are frozen into the coordinates at the default type's size.");
  return m;
}

/** fmc_doc report (F-056: a family opened in staging): parameters without types and each form's box. */
export function reportModel(report: Record<string, any>): FamilyModel {
  const family = String(report.family_name ?? report.title ?? "Unnamed").replace(/\.rfa$/i, "");
  const m: FamilyModel = {
    family, source: "fmc_doc_report", category: String(report.category ?? ""), template: "", about: "", params: [], types: [], solids: [], others: [],
    plan2d: [], hotspots: [], materials: [], subcategories: [], constraintOps: {},
    notes: ["From an fmc_doc report: every form is its bounding box. Export the family's recipe for the real profiles."],
  };
  for (const p of Array.isArray(report.parameters) ? report.parameters : []) {
    const t = typeof p.type === "string" && p.type ? p.type : "unknown";
    m.params.push({ name: String(p.name), revitType: t, instance: p.instance !== false, shared: p.shared === true, formula: p.formula || undefined, value: p.value });
  }
  for (const t of Array.isArray(report.types) ? report.types : []) m.types.push({ name: String(typeof t === "string" ? t : t.name), values: {} });
  for (const f of Array.isArray(report.solids_detail) ? report.solids_detail : []) {
    const box = f.box_mm;
    const vi = f.visible_in ?? {};
    const s: Solid = {
      name: String(f.name), kind: "bbox", revit: String(f.kind ?? "form"), void: f.void === true, sub: String(f.subcategory ?? ""),
      vis: [vi.coarse !== false, vi.medium !== false, vi.fine !== false], status: "partial",
      reason: "BLOCK of the form's bounding box (the report has no profile)", geom: {},
    };
    if (!box || !Array.isArray(box.min) || !Array.isArray(box.max)) { s.status = "unsupported"; s.reason = "no box in the report"; }
    else s.geom = { box: [box.min[0], box.min[1], box.min[2], box.max[0], box.max[1], box.max[2]] };
    if (s.sub && !m.subcategories.includes(s.sub)) m.subcategories.push(s.sub);
    m.solids.push(s);
  }
  for (const n of Array.isArray(report.nested) ? report.nested : []) {
    const at = Array.isArray(n.at_mm) ? n.at_mm : null;
    m.others.push({ name: String(n.family ?? "nested"), revit: `nested family ${n.family ?? ""} : ${n.type ?? ""}`, status: "unsupported",
      reason: "a nested family needs its own GDL object (CALL as a macro); a hotspot marks where it sits", gdl: at ? "HOTSPOT (placeholder)" : undefined });
    if (at) m.hotspots.push({ name: String(n.family), at, why: "nested family" });
  }
  for (const c of Array.isArray(report.connectors_detail) ? report.connectors_detail : []) {
    const at = Array.isArray(c.origin_mm) ? c.origin_mm : null;
    m.others.push({ name: String(c.name ?? "connector"), revit: `connector (${c.domain ?? "?"})`, status: "partial", reason: "a hotspot at the connector; MEP ports wait for PLAN_ARCHICAD AC2a", gdl: at ? "HOTSPOT" : undefined });
    if (at) m.hotspots.push({ name: String(c.name), at, why: "connector" });
  }
  return m;
}

// ------------------------------------------------------------------------------------------------ geometry helpers

function toWorldExtrude(sk: string, u: number, v: number, w: number): Pt {
  if (sk === "front") return [u, -w, v];
  if (sk === "right") return [w, u, v];
  return [u, v, w];
}
function toWorldRevolve(axis: string, at: Pt, r: number, t: number, ang: number): Pt {
  const c = r * Math.cos(ang), s = r * Math.sin(ang);
  if (axis === "x") return [t, at[0] + c, at[1] + s];
  if (axis === "y") return [at[0] + c, -t, at[1] + s];
  return [at[0] + c, at[1] + s, t];
}
function toWorldPath(plane: string, at: number, u: number, v: number): Pt {
  if (plane === "front") return [u, at, v];
  if (plane === "right") return [at, u, v];
  return [u, v, at];
}

function samplePoints(s: Solid): Pt[] {
  const g = s.geom;
  if (s.kind === "box" || s.kind === "bbox") {
    const [x0, y0, z0, x1, y1, z1] = g.box;
    const out: Pt[] = [];
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) out.push([x, y, z]);
    return out;
  }
  if (s.kind === "extrude") return (g.points as Pt[]).flatMap(([u, v]) => [g.start, g.end].map((w: number) => toWorldExtrude(g.sketch, u, v, w)));
  if (s.kind === "revolve") {
    const out: Pt[] = [];
    for (const [r, t] of g.profile as Pt[]) for (let i = 0; i <= 24; i++) out.push(toWorldRevolve(g.axis, g.axis_at, r, t, (2 * Math.PI * i) / 24));
    return out;
  }
  if (s.kind === "tube") {
    const rad = Math.max(...(g.profile as Pt[]).map((p) => Math.hypot(p[0], p[1])));
    const out: Pt[] = [];
    for (const [u, v] of g.path as Pt[]) {
      const [x, y, z] = toWorldPath(g.path_plane, g.at, u, v);
      for (const dx of [-rad, rad]) for (const dy of [-rad, rad]) for (const dz of [-rad, rad]) out.push([x + dx, y + dy, z + dz]);
    }
    return out;
  }
  if (s.kind === "ruled") return [...(g.base as Pt[]).map(([x, y]) => [x, y, g.start]), ...(g.top as Pt[]).map(([x, y]) => [x, y, g.end])];
  return [];
}

/** A solid's box in recipe mm, including its array copies. */
export function solidBox(s: Solid): { lo: Pt; hi: Pt } | null {
  const p = samplePoints(s);
  if (!p.length) return null;
  const lo = [0, 1, 2].map((i) => Math.min(...p.map((q) => q[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...p.map((q) => q[i])));
  if (s.array && s.array.max > 1) {
    const i = s.array.direction === "y" ? 1 : s.array.direction === "z" ? 2 : 0;
    const d = s.array.spacing * (s.array.max - 1);
    if (d >= 0) hi[i] += d; else lo[i] += d;
  }
  return { lo, hi };
}

function faceCentre(s: Solid, side: string): Pt | null {
  if (s.status === "unsupported") return null;
  const b = solidBox(s); if (!b) return null;
  const c = [0, 1, 2].map((i) => (b.lo[i] + b.hi[i]) / 2);
  switch (side) {
    case "back": c[1] = b.hi[1]; break;
    case "front": c[1] = b.lo[1]; break;
    case "left": c[0] = b.lo[0]; break;
    case "right": c[0] = b.hi[0]; break;
    case "top": c[2] = b.hi[2]; break;
    case "bottom": c[2] = b.lo[2]; break;
  }
  return c;
}

function turnDeg(a: Pt, b: Pt, c: Pt): number {
  const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const n1 = Math.hypot(v1[0], v1[1]), n2 = Math.hypot(v2[0], v2[1]);
  if (n1 < 1e-9 || n2 < 1e-9) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))) * 180) / Math.PI;
}
function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) if (!out.length || p.some((v, i) => Math.abs(v - out[out.length - 1][i]) > 1e-6)) out.push(p);
  return out;
}
function smoothFlags(pts: Pt[], closed: boolean, limit = 28): boolean[] {
  const n = pts.length;
  return pts.map((_, i) => {
    if (!closed && (i === 0 || i === n - 1)) return false;
    return turnDeg(pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]) < limit;
  });
}
/** Data rows of a GDL command, one per line, comma after every row but the last. */
const listRows = (rows: string[]) => rows.map((r, i) => "\t" + r + (i < rows.length - 1 ? "," : ""));
const same = (a: Pt, b: Pt) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

/** 3D script lines for one solid (recipe mm → GDL m). Uses the script variable soft (0/1). Ported from fmc_gdl.py gdl_solid. */
export function gdlSolid(s: Solid): string[] {
  const g = s.geom, L: string[] = [];
  if (s.kind === "box" || s.kind === "bbox") {
    const [x0, y0, z0, x1, y1, z1] = g.box;
    L.push(`ADD ${M(x0)}, ${M(y0)}, ${M(z0)}`, `BLOCK ${M(x1 - x0)}, ${M(y1 - y0)}, ${M(z1 - z0)}`, "DEL 1");
  } else if (s.kind === "extrude") {
    let pts = dedupe(g.points as Pt[]);
    if (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts = pts.slice(0, -1);
    const sm = smoothFlags(pts, true);
    const lo = Math.min(g.start, g.end), hi = Math.max(g.start, g.end);
    let nt = 0;
    if (g.sketch === "front") { L.push("ROTX 90"); nt++; } else if (g.sketch === "right") { L.push("ROTZ 90", "ROTX 90"); nt += 2; }
    L.push(`ADDZ ${M(lo)}`); nt++;
    const rows = pts.map((p, i) => `${M(p[0])}, ${M(p[1])}, ${sm[i] ? "soft" : "0"}`);
    rows.push(`${M(pts[0][0])}, ${M(pts[0][1])}, ${sm[0] ? "soft" : "0"}`);
    L.push(`EXTRUDE ${rows.length}, 0, 0, ${M(hi - lo)}, 1+2+16+32,`, ...listRows(rows), `DEL ${nt}`);
  } else if (s.kind === "revolve") {
    let prof = dedupe(g.profile as Pt[]);
    const closed = !(prof[0][0] === 0 || prof[prof.length - 1][0] === 0);
    if (closed && same(prof[0], prof[prof.length - 1])) prof = prof.slice(0, -1);
    const sm = smoothFlags(prof, closed);
    const nodes = prof.map(([r, t], i) => [t, r, sm[i] ? 1 : 0]);
    if (closed) nodes.push(nodes[0]);
    const mask = closed ? 0 : 1 + 2 + 16 + 32;
    const at: Pt = g.axis_at ?? [0, 0];
    let nt = 0;
    if (g.axis === "x") { L.push(`ADD 0, ${M(at[0])}, ${M(at[1])}`); nt = 1; }
    else if (g.axis === "y") { L.push(`ADD ${M(at[0])}, 0, ${M(at[1])}`, "ROTZ -90"); nt = 2; }
    else { L.push(`ADD ${M(at[0])}, ${M(at[1])}, 0`, "ROTY -90"); nt = 2; }
    const rows = nodes.map(([t, r, f]) => `${M(t)}, ${M(r)}, ${f ? "soft" : "0"}`);
    L.push(`REVOLVE ${rows.length}, 360, ${mask},`, ...listRows(rows), `DEL ${nt}`);
  } else if (s.kind === "tube") {
    let prof = dedupe(g.profile as Pt[]);
    if (prof.length > 1 && same(prof[0], prof[prof.length - 1])) prof = prof.slice(0, -1);
    const sm = smoothFlags(prof, true, 50);
    const path = dedupe((g.path as Pt[]).map(([u, v]) => toWorldPath(g.path_plane, g.at, u, v)));
    if (path.length < 2) return [];
    const ext = (a: Pt, b: Pt) => [0, 1, 2].map((i) => 2 * a[i] - b[i]);
    const full = [ext(path[0], path[1]), ...path, ext(path[path.length - 1], path[path.length - 2])];
    const prow = prof.map((p, i) => `${M(p[0])}, ${M(p[1])}, ${sm[i] ? "soft" : "0"}`);
    const trow = full.map((p) => `${M(p[0])}, ${M(p[1])}, ${M(p[2])}, 0`);
    L.push(`TUBE ${prow.length}, ${trow.length}, 1+2+16+32,`, ...listRows([...prow, ...trow]));
  } else if (s.kind === "ruled") {
    let base = g.base as Pt[], top = g.top as Pt[];
    if (base.length > 1 && same(base[0], base[base.length - 1]) && top.length > 1 && same(top[0], top[top.length - 1])) { base = base.slice(0, -1); top = top.slice(0, -1); }
    const h = g.end - g.start;
    L.push(`ADDZ ${M(g.start)}`, `RULED ${base.length}, 1+2+4+16+32,`,
      ...listRows([...base.map((p) => `${M(p[0])}, ${M(p[1])}`), ...top.map((p) => `${M(p[0])}, ${M(p[1])}, ${M(h)}`)]), "DEL 1");
  }
  return L;
}

// ------------------------------------------------------------------------------------------------ materials and formulas

export interface KitMaterial { name: string; class?: string; graphics?: { shaded?: string } }

function hexRgb(h: string): number[] { const x = (h || "#B4B4B4").replace(/^#/, ""); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255); }

/** DEFINE MATERIAL type 0 (16 values) from a kit material (fmc_gdl.py material_def). */
export function materialDef(mat: KitMaterial): string {
  const name = mat.name, cls = mat.class ?? "";
  const [r, g, b] = hexRgb(mat.graphics?.shaded ?? "#B4B4B4");
  let [amb, dif, spe, tra, shi, att] = [0.7, 0.75, 0.35, 0.0, 20.0, 1.0];
  let em: number[] = [0, 0, 0];
  const n = name.toLowerCase();
  if (cls === "Glass" || n.includes("glass")) {
    [amb, dif, spe, tra, shi, att] = [0.6, 0.35, 0.9, 0.72, 60.0, 1.6];
    if (n.includes("frosted")) { tra = 0.45; spe = 0.4; }
    if (n.includes("display") || n.includes("black")) { tra = 0.05; spe = 0.85; shi = 80.0; }
  } else if (cls === "Metal" || /metal|chrome|stainless/.test(n)) {
    [amb, dif, spe, shi] = [0.6, 0.55, 0.9, n.includes("chrome") ? 70.0 : 45.0];
    if (n.includes("painted") || n.includes("epoxy")) [dif, spe, shi] = [0.8, 0.45, 25.0];
  } else if (n.includes("rubber")) [amb, dif, spe, shi] = [0.7, 0.85, 0.1, 5.0];
  else if (/fabric|upholstery|vinyl/.test(n)) [amb, dif, spe, shi] = [0.75, 0.85, 0.25, 12.0];
  else if (n.includes("led")) { [amb, dif, spe, shi] = [0.9, 0.6, 0.6, 50.0]; em = [r, g, b]; }
  const spec = spe > 0.5 ? [1, 1, 1] : [r, g, b];
  const vals = [r, g, b, amb, dif, spe, tra, shi, att, ...spec, ...em, em.every((v) => v === 0) ? 0 : 2];
  return `DEFINE MATERIAL "${name.replace(/"/g, "'")}" 0, ${vals.map(F).join(", ")}`;
}

/** Revit formula → GDL expression, when every token is a mapped parameter, a number or a plain operator. */
export function translateFormula(formula: string, names: Map<string, { gdl: string; type: GdlType }>, target: GdlType): { expr?: string; reason?: string } {
  let f = ` ${formula} `;
  if (/\bif\s*\(|\bround(up|down)?\s*\(|\bsize_lookup\s*\(|\blog\s*\(|\bexp\s*\(/i.test(f)) return { reason: "uses if(), rounding, lookups or logs: no one-line GDL equivalent generated" };
  const keys = [...names.keys()].sort((a, b) => b.length - a.length);
  const slots: string[] = [];
  for (const k of keys) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    f = f.replace(new RegExp(`(^|[^A-Za-z0-9_])${esc}(?=$|[^A-Za-z0-9_])`, "g"), (_m, pre) => { slots.push(names.get(k)!.gdl); return `${pre}\u0001${slots.length - 1}\u0002`; });
  }
  let plainNumbers = false;
  f = f.replace(/(\d+(?:\.\d+)?)\s*mm\b/g, (_m, n) => `\u0003${F(Number(n) / 1000)}\u0004`).replace(/(\d+(?:\.\d+)?)\s*m\b/g, (_m, n) => `\u0003${n}\u0004`);
  f = f.replace(/\band\b/gi, "AND").replace(/\bor\b/gi, "OR").replace(/\bnot\s*\(/gi, "NOT(").replace(/\bsqrt\s*\(/gi, "SQR(")
    .replace(/\babs\s*\(/gi, "ABS(").replace(/\bsin\s*\(/gi, "SIN(").replace(/\bcos\s*\(/gi, "COS(").replace(/\btan\s*\(/gi, "TAN(");
  const rest = f.replace(/\u0001\d+\u0002/g, " ").replace(/\u0003[^\u0004]*\u0004/g, " ").replace(/\b(AND|OR|NOT|SQR|ABS|SIN|COS|TAN)\b/g, " ");
  if (/[A-Za-z_]/.test(rest.replace(/\d+(?:\.\d+)?/g, " "))) {
    const words = rest.replace(/\d+(?:\.\d+)?/g, " ").split(/[^A-Za-z_]+/).filter(Boolean).slice(0, 3);
    return { reason: `names something that isn't a mapped parameter (${words.join(", ")})` };
  }
  if (/[^\s\d.+\-*/()=<>,^]/.test(rest)) return { reason: "uses an operator GDL doesn't read" };
  if (target === "Length" && /(^|[+\-]\s*)\d+(\.\d+)?\s*($|[+\-)])/.test(rest.trim())) plainNumbers = true;
  f = f.replace(/\u0001(\d+)\u0002/g, (_m, i) => slots[Number(i)]).replace(/\u0003([^\u0004]*)\u0004/g, "$1").replace(/\s+/g, " ").trim();
  return plainNumbers ? { expr: f, reason: "a plain number added to a length: Revit reads it in display units (mm), GDL in metres; check it" } : { expr: f };
}

// ------------------------------------------------------------------------------------------------ mapping + build

export interface ParamRow {
  revit: string; revit_type: string; instance: boolean; shared: boolean; builtin?: boolean;
  gdl?: string; gdl_type?: GdlType; default?: number | string; status: Status; note: string; formula?: string; formula_gdl?: string;
}
export interface GdlParam { type: GdlType; name: string; desc: string; value: number | string | null; flags: string[] }
type Tally = { mapped: number; partial: number; unsupported: number };

export interface MappingReport {
  family: string;
  source: string;
  category: string;
  gdl_object: string;
  size_mm: [number, number, number];
  summary: Record<string, Tally>;
  parameters: ParamRow[];
  geometry: Array<{ name: string; revit: string; gdl: string; status: Status; reason: string; subcategory?: string; void?: boolean }>;
  materials: Array<{ revit_param: string; kit_material: string; gdl: string; status: Status; note: string }>;
  subcategories: Array<{ name: string; status: Status; gdl: string; note: string }>;
  other: Unmapped[];
  types: { count: number; default: string; gdl: string; status: Status; note: string };
  constraints_frozen: Record<string, number>;
  notes: string[];
}

export interface GdlObject {
  family: string;
  guid: string;
  params: GdlParam[];
  master: string; s2d: string; s3d: string; spr: string; sui: string;
  size_mm: [number, number, number];
  report: MappingReport;
}

/** Zones (clearance, coverage) are switched and kept out of the object box, like fmc_gdl.py kept clearance out. */
const ZONE = /clearance|coverage/i;
const isClear = (s: Solid) => ZONE.test(s.sub) || ZONE.test(s.name);
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

/** The mapping report and the GDL object for one family model. */
export function buildGdl(model: FamilyModel, kit: Map<string, KitMaterial> = new Map()): GdlObject {
  const used = new Set<string>();
  const report: MappingReport = {
    family: model.family, source: model.source, category: model.category, gdl_object: model.family, size_mm: [0, 0, 0], summary: {},
    parameters: [], geometry: [], materials: [], subcategories: [], other: model.others,
    types: { count: 0, default: "", gdl: "", status: "mapped", note: "no types" },
    constraints_frozen: model.constraintOps, notes: [...model.notes],
  };

  // ---- parameters
  const pmap = new Map<string, { gdl: string; type: GdlType }>();
  const familyParams: GdlParam[] = [], dataParams: GdlParam[] = [];
  for (const p of model.params) {
    const t = mapParamType(p.revitType);
    const row: ParamRow = { revit: p.name, revit_type: p.revitType, instance: p.instance, shared: p.shared, status: t.status, note: t.note };
    if (p.builtin) row.builtin = true;
    if (!t.gdl) { report.parameters.push(row); continue; }
    const gname = gdlName(p.name, used);
    const def = t.gdl === "Material" ? 1 : gdlValue(t.gdl, p.value);
    row.gdl = gname; row.gdl_type = t.gdl; row.default = def;
    if (!p.instance && model.source === "recipe" && model.types.length)
      row.note = [row.note, "a type parameter: GDL parameters are per placed object (types come from fmcType)"].filter(Boolean).join("; ");
    pmap.set(p.name, { gdl: gname, type: t.gdl });
    const gp: GdlParam = { type: t.gdl, name: gname, desc: p.name.slice(0, 60), value: def, flags: ["child"] };
    (p.shared || p.builtin ? dataParams : familyParams).push(gp);
    report.parameters.push(row);
  }
  const formulaLines: string[] = [];
  for (const p of model.params) {
    if (!p.formula) continue;
    const row = report.parameters.find((r) => r.revit === p.name)!;
    row.formula = p.formula;
    const target = pmap.get(p.name);
    if (!target) continue;
    const tr = translateFormula(p.formula, pmap, target.type);
    if (tr.expr) {
      row.formula_gdl = tr.expr; formulaLines.push(`${target.gdl} = ${tr.expr}`);
      if (tr.reason) { row.status = "partial"; row.note = [row.note, tr.reason].filter(Boolean).join("; "); }
    } else { row.status = "partial"; row.note = [row.note, `formula not carried: ${tr.reason}`].filter(Boolean).join("; "); }
  }

  // ---- the object box
  const drawn = model.solids.filter((s) => s.status !== "unsupported");
  let boxes = drawn.filter((s) => !s.void && !isClear(s)).map(solidBox).filter((b): b is { lo: Pt; hi: Pt } => !!b);
  if (!boxes.length) boxes = drawn.filter((s) => !s.void).map(solidBox).filter((b): b is { lo: Pt; hi: Pt } => !!b);
  let lo = [0, 0, 0], hi = [0, 0, 0];
  if (boxes.length) {
    lo = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.lo[i])));
    hi = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.hi[i])));
  } else report.notes.push("No solid could be drawn: the object is an empty box with hotspots.");
  const size: [number, number, number] = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  report.size_mm = size.map((v) => Math.round(v * 10) / 10) as [number, number, number];
  const hasClear = drawn.some(isClear);

  // ---- materials
  const matOfParam = new Map(model.materials.map((x) => [x.param, x.material]));
  const usedMats = new Set<string>();
  for (const s of drawn) if (s.materialParam && matOfParam.has(s.materialParam)) usedMats.add(matOfParam.get(s.materialParam)!);
  for (const x of model.materials) {
    const k = kit.get(x.material), gp = pmap.get(x.param);
    report.materials.push({ revit_param: x.param, kit_material: x.material,
      gdl: gp ? `${gp.gdl} (Material) + DEFINE MATERIAL "${x.material}"` : `DEFINE MATERIAL "${x.material}"`,
      status: k ? "mapped" : "partial", note: k ? "kit colour and finish inline" : "not in the kit materials file: a grey stand-in is defined" });
  }
  for (const s of drawn) if (s.materialParam && !matOfParam.has(s.materialParam) && !report.materials.some((r) => r.revit_param === s.materialParam)) {
    const gp = pmap.get(s.materialParam);
    report.materials.push({ revit_param: s.materialParam, kit_material: "", gdl: gp ? `${gp.gdl} (Material)` : "", status: gp ? "partial" : "unsupported",
      note: gp ? "no kit material on the parameter: the GDL Material parameter's surface" : "the material parameter isn't a family parameter" });
  }

  // ---- subcategories
  for (const n of model.subcategories) {
    if (ZONE.test(n)) report.subcategories.push({ name: n, status: "mapped", gdl: "bShowClearance / bClear3D", note: "a switch for the zone; the 2D script draws its outline" });
    else if (/envelope|coarse/i.test(n)) report.subcategories.push({ name: n, status: "mapped", gdl: "iLOD3D = 1", note: "drawn by detail level" });
    else report.subcategories.push({ name: n, status: "partial", gdl: "comment", note: "GDL objects have no subcategories: each solid keeps it as a comment; line weights and colours aren't carried (ArchiCAD pens and layers)" });
  }

  // ---- 3D script
  const S: string[] = [
    `! Formcraft ${model.family} · generated by fmc_archicad from the family ${model.source === "recipe" ? "recipe" : "report"}`,
    "! Kit surfaces defined inline, so the object looks the same in any template.",
  ];
  for (const mname of [...usedMats].sort()) S.push(materialDef(kit.get(mname) ?? { name: mname }));
  S.push("", "iLOD = iLOD3D", "IF GLOB_CONTEXT = 5 THEN iLOD = 3", "IF iLOD = 3 THEN", "\tres = iRes : soft = 1", "ELSE", "\tres = 10 : soft = 0", "ENDIF",
    "RESOL res", "PEN penModel", "", `ADD ${M(-lo[0])}, ${M(-lo[1])}, ${M(-lo[2])}`, "");
  const voids = drawn.filter((s) => s.void), bodies = drawn.filter((s) => !s.void);
  const cut = new Map<string, Solid[]>();
  for (const v of voids) {
    const vb = solidBox(v); if (!vb) continue;
    let any = false;
    for (const s of bodies) {
      const sb = solidBox(s); if (!sb) continue;
      if ([0, 1, 2].every((i) => sb.lo[i] < vb.hi[i] && vb.lo[i] < sb.hi[i])) { if (!cut.has(s.name)) cut.set(s.name, []); cut.get(s.name)!.push(v); any = true; }
    }
    report.geometry.push({ name: v.name, revit: v.revit, gdl: any ? "GROUP + SUBGROUP (boolean cut)" : "nothing (the void cuts no solid)", status: any ? v.status : "partial",
      reason: any ? `${v.reason}; subtracted from the solids it meets` : "the void meets no drawn solid", void: true, ...(v.sub ? { subcategory: v.sub } : {}) });
  }
  for (const s of bodies) {
    const cond: string[] = [];
    const lv = [1, 2, 3].filter((_, i) => s.vis[i]);
    if (lv.length === 0) cond.push("0");
    else if (lv.length < 3) cond.push("(" + lv.map((l) => `iLOD = ${l}`).join(" OR ") + ")");
    if (s.visParam) { const gp = pmap.get(s.visParam); if (gp) cond.push(gp.gdl); }
    if (isClear(s)) cond.push("bShowClearance AND bClear3D");
    const ind = cond.length ? "\t" : "";
    if (cond.length) S.push(`IF ${cond.join(" AND ")} THEN`);
    S.push(`${ind}! ${s.name}${s.sub ? " · " + s.sub : ""}`);
    if (s.materialParam) {
      const gp = pmap.get(s.materialParam), km = matOfParam.get(s.materialParam);
      if (km && gp) S.push(`${ind}IF bKitSurfaces THEN SET MATERIAL "${km}" ELSE SET MATERIAL ${gp.gdl}`);
      else if (km) S.push(`${ind}SET MATERIAL "${km}"`);
      else if (gp) S.push(`${ind}SET MATERIAL ${gp.gdl}`);
    }
    const emit = (lines: string[], pre: string) => {
      if (!s.array || s.array.max <= 1) { S.push(...lines.map((l) => pre + l)); return; }
      const cp = pmap.get(s.array.countParam);
      const n = cp ? `MIN(${cp.gdl}, ${s.array.max})` : String(s.array.max);
      const ax = s.array.direction === "y" ? "ADDY" : s.array.direction === "z" ? "ADDZ" : "ADDX";
      S.push(`${pre}FOR fmcK = 0 TO ${n} - 1`, `${pre}\t${ax} ${M(s.array.spacing)} * fmcK`, ...lines.map((l) => pre + "\t" + l), `${pre}\tDEL 1`, `${pre}NEXT fmcK`);
    };
    const vs = cut.get(s.name);
    if (vs) {
      const g = "g_" + s.name.replace(/[^A-Za-z0-9]+/g, "_");
      S.push(`${ind}GROUP "${g}"`); emit(gdlSolid(s), ind + "\t"); S.push(`${ind}ENDGROUP`);
      vs.forEach((v, j) => { S.push(`${ind}GROUP "${g}_v${j}"`, ...gdlSolid(v).map((l) => ind + "\t" + l), `${ind}ENDGROUP`); });
      let expr = `"${g}"`;
      vs.forEach((_, j) => { expr = `SUBGROUP(${expr}, "${g}_v${j}")`; });
      S.push(`${ind}PLACEGROUP ${expr}`);
    } else emit(gdlSolid(s), ind);
    if (cond.length) S.push("ENDIF");
    const prim = { box: "BLOCK", bbox: "BLOCK (bounding box)", extrude: "EXTRUDE", revolve: "REVOLVE", tube: "TUBE", ruled: "RULED" }[s.kind];
    report.geometry.push({ name: s.name, revit: s.revit, gdl: prim + (s.array ? " in a FOR loop" : "") + (vs ? " minus voids" : ""), status: s.status, reason: s.reason, ...(s.sub ? { subcategory: s.sub } : {}) });
  }
  for (const s of model.solids.filter((x) => x.status === "unsupported"))
    report.geometry.push({ name: s.name, revit: s.revit, gdl: "not drawn", status: "unsupported", reason: s.reason, ...(s.sub ? { subcategory: s.sub } : {}), ...(s.void ? { void: true } : {}) });
  S.push("", "DEL TOP", "! box hotspots",
    "HOTSPOT 0, 0, 0 : HOTSPOT A, 0, 0 : HOTSPOT A, B, 0 : HOTSPOT 0, B, 0",
    "HOTSPOT 0, 0, ZZYZX : HOTSPOT A, 0, ZZYZX : HOTSPOT A, B, ZZYZX : HOTSPOT 0, B, ZZYZX");
  for (const h of model.hotspots) S.push(`HOTSPOT ${M(h.at[0] - lo[0])}, ${M(h.at[1] - lo[1])}, ${M(h.at[2] - lo[2])}  ! ${h.why}: ${h.name}`);
  const s3d = S.join("\n");

  // ---- 2D script
  const T: string[] = ["! Formcraft plan symbol", "PEN penContour", "IF iLOD2D = 1 THEN", "\tRECT2 0, 0, A, B", "ELSE", "\tPROJECT2 3, 270, 2", "ENDIF"];
  if (hasClear) {
    const cb = drawn.filter(isClear).map(solidBox).filter((b): b is { lo: Pt; hi: Pt } => !!b);
    const x0 = Math.min(...cb.map((b) => b.lo[0])) - lo[0], y0 = Math.min(...cb.map((b) => b.lo[1])) - lo[1];
    const x1 = Math.max(...cb.map((b) => b.hi[0])) - lo[0], y1 = Math.max(...cb.map((b) => b.hi[1])) - lo[1];
    T.push("", "! clearance zone outline", "IF bShowClearance THEN", "\tPEN penClear", `\tRECT2 ${M(x0)}, ${M(y0)}, ${M(x1)}, ${M(y1)}`, "\tPEN penContour", "ENDIF");
  }
  if (model.plan2d.length) {
    T.push("", "! symbolic lines from the family (plan)");
    for (const l of model.plan2d) {
      if (l.arc) T.push(`ARC2 ${M(l.arc.center[0] - lo[0])}, ${M(l.arc.center[1] - lo[1])}, ${M(l.arc.radius)}, ${F(l.arc.start_deg)}, ${F(l.arc.end_deg)}  ! ${l.name}`);
      else if (l.points) for (let i = 0; i + 1 < l.points.length; i++)
        T.push(`LINE2 ${M(l.points[i][0] - lo[0])}, ${M(l.points[i][1] - lo[1])}, ${M(l.points[i + 1][0] - lo[0])}, ${M(l.points[i + 1][1] - lo[1])}${i === 0 ? "  ! " + l.name : ""}`);
    }
  }
  T.push("", "HOTSPOT2 0, 0 : HOTSPOT2 A, 0 : HOTSPOT2 A, B : HOTSPOT2 0, B : HOTSPOT2 A/2, B/2");
  const s2d = T.join("\n");

  // ---- parameter list
  const P: GdlParam[] = [
    { type: "Length", name: "A", desc: "Width", value: size[0] / 1000, flags: ["fix"] },
    { type: "Length", name: "B", desc: "Depth", value: size[1] / 1000, flags: ["fix"] },
    { type: "Length", name: "ZZYZX", desc: "Height", value: size[2] / 1000, flags: ["fix"] },
    { type: "Title", name: "tModel", desc: "Model and detail", value: null, flags: ["bold"] },
    { type: "Integer", name: "iLOD3D", desc: "Model detail", value: 3, flags: ["child"] },
    { type: "Integer", name: "iRes", desc: "Smoothness (Fine)", value: 36, flags: ["child"] },
    { type: "PenColor", name: "penModel", desc: "3D contour pen", value: 1, flags: ["child"] },
    { type: "Boolean", name: "bKitSurfaces", desc: "Use Formcraft kit surfaces", value: 1, flags: ["child"] },
    { type: "Title", name: "tPlan", desc: "Plan graphics", value: null, flags: ["bold"] },
    { type: "Integer", name: "iLOD2D", desc: "Plan detail", value: 2, flags: ["child"] },
    { type: "PenColor", name: "penContour", desc: "Contour pen", value: 1, flags: ["child"] },
  ];
  if (hasClear) P.push(
    { type: "Boolean", name: "bShowClearance", desc: "Show clearance zone", value: 1, flags: ["child"] },
    { type: "Boolean", name: "bClear3D", desc: "Clearance zone in 3D", value: 0, flags: ["child"] },
    { type: "PenColor", name: "penClear", desc: "Clearance pen", value: 3, flags: ["child"] });
  if (familyParams.length) P.push({ type: "Title", name: "tFamily", desc: "Family parameters", value: null, flags: ["bold"] }, ...familyParams);
  P.push({ type: "Title", name: "tData", desc: "Formcraft data", value: null, flags: ["bold"] }, ...dataParams);
  const typeNames = model.types.map((t) => t.name).filter(Boolean);
  if (typeNames.length) P.push({ type: "String", name: "fmcType", desc: "Family type", value: typeNames[0], flags: ["child"] });
  P.push({ type: "String", name: "FMC_Family", desc: "Formcraft family", value: model.family, flags: ["child"] });
  P.push({ type: "String", name: "FMC_Source", desc: "Generated from", value: `${model.source} · fmc_archicad`, flags: ["child"] });

  // ---- types
  const typeLines: string[] = [];
  if (typeNames.length) {
    report.types = { count: typeNames.length, default: typeNames[0], gdl: "fmcType (String, VALUES list)", status: "partial",
      note: "GDL has no family types: picking fmcType sets the mapped parameters' values in the parameter script; the geometry stays at the default type's size" };
    typeLines.push(`VALUES "fmcType" ${typeNames.map(q).join(", ")}`, 'IF GLOB_MODPAR_NAME = "fmcType" THEN');
    for (const t of model.types) {
      const sets: string[] = [];
      for (const [k, v] of Object.entries(t.values)) {
        const gp = pmap.get(k); if (!gp || gp.type === "Material") continue;
        const gv = gdlValue(gp.type, v);
        sets.push(`${gp.gdl} = ${typeof gv === "string" ? q(gv) : F(gv)}`);
      }
      if (sets.length) typeLines.push(`\tIF fmcType = ${q(t.name)} THEN PARAMETERS ${sets.join(", ")}`);
    }
    typeLines.push("ENDIF");
  }

  // ---- parameter script (Script_VL; Script_PR is Properties: PLAN_ARCHICAD finding 1)
  const PR = [
    'VALUES{2} "iLOD3D" 1, "Coarse", 2, "Medium", 3, "Fine"',
    'VALUES{2} "iLOD2D" 1, "Outline", 2, "Projected"',
    'VALUES "iRes" RANGE [12, 72]',
    `PARAMETERS A = ${F(size[0] / 1000)}, B = ${F(size[1] / 1000)}, ZZYZX = ${F(size[2] / 1000)}`,
    'LOCK "A", "B", "ZZYZX"',
    'IF iLOD3D <> 3 THEN LOCK "iRes"',
  ];
  if (hasClear) PR.push('IF NOT(bShowClearance) THEN LOCK "bClear3D", "penClear"');
  PR.push(...typeLines);
  for (const l of formulaLines) { const n = l.split(" = ")[0]; PR.push(l, `PARAMETERS ${n} = ${n}`, `LOCK "${n}"`); }
  const spr = PR.join("\n");

  // ---- master script: formulas, so 2D and 3D see them on every run
  const master = ["! Formcraft master script: Revit formulas carried across", ...(formulaLines.length ? formulaLines : ["! (no formulas)"])].join("\n");

  // ---- interface script: one page per ten parameters
  const rows = P.filter((p) => p.type !== "Title" && !["A", "B", "ZZYZX", "FMC_Source"].includes(p.name)).map((p) => [p.desc.slice(0, 30).replace(/"/g, "'"), p.name]);
  const U = [`UI_DIALOG ${q("Formcraft · " + model.family.replace(/^FMC_/, "").replace(/_/g, " "))}`, "UI_STYLE 0, 0"];
  const pages: string[][][] = [];
  for (let i = 0; i < rows.length; i += 10) pages.push(rows.slice(i, i + 10));
  pages.forEach((pg, pi) => {
    U.push(`UI_PAGE ${pi + 1}`, "UI_STYLE 1, 1", `UI_OUTFIELD "FORMCRAFT  ·  PAGE ${pi + 1}/${pages.length}", 10, 4, 424, 18`, "UI_SEPARATOR 10, 24, 434, 24", "UI_STYLE 0, 0");
    pg.forEach(([lab, nm], i) => U.push(`UI_OUTFIELD "${lab}", 10, ${34 + 22 * i}, 210, 18`, `UI_INFIELD "${nm}", 225, ${32 + 22 * i}, 200, 20`));
    if (pi > 0) U.push('UI_BUTTON UI_PREV, "<", 344, 278, 40, 18');
    if (pi < pages.length - 1) U.push('UI_BUTTON UI_NEXT, ">", 394, 278, 40, 18');
  });
  const sui = U.join("\n");

  const tally = (xs: Array<{ status: Status }>): Tally => ({
    mapped: xs.filter((x) => x.status === "mapped").length, partial: xs.filter((x) => x.status === "partial").length, unsupported: xs.filter((x) => x.status === "unsupported").length,
  });
  report.summary = { parameters: tally(report.parameters), geometry: tally(report.geometry), materials: tally(report.materials), subcategories: tally(report.subcategories), other: tally(report.other) };
  return { family: model.family, guid: objectGuid(model.family), params: P, master, s2d, s3d, spr, sui, size_mm: size, report };
}

// ------------------------------------------------------------------------------------------------ XML

export function cdata(s: string): string { return `<![CDATA[${s.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`; }
function xmlAttr(s: string): string { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

export function paramXml(p: GdlParam): string {
  const f: string[] = [];
  if (p.flags.includes("child")) f.push("<ParFlg_Child/>");
  if (p.flags.includes("bold")) f.push("<ParFlg_BoldName/>");
  let out = `\t\t<${p.type} Name="${xmlAttr(p.name)}">\n\t\t\t<Description>${cdata(q(p.desc))}</Description>\n`;
  if (p.flags.includes("fix")) out += "\t\t\t<Fix/>\n";
  if (f.length) out += `\t\t\t<Flags>\n\t\t\t\t${f.join("\n\t\t\t\t")}\n\t\t\t</Flags>\n`;
  if (p.type !== "Title") {
    let v: string;
    if (p.type === "String") v = cdata(q(String(p.value ?? "")));
    else if (p.type === "Length" || p.type === "RealNum" || p.type === "Angle") v = F(Number(p.value ?? 0));
    else v = String(Math.trunc(Number(p.value ?? 0)));
    out += `\t\t\t<Value>${v}</Value>\n`;
  }
  return out + `\t\t</${p.type}>\n`;
}

/** The library part as XML for LP_XMLConverter xml2libpart (the layout fmc_gdl.py compiled in ArchiCAD 28). */
export function toXml(o: GdlObject): string {
  const sect = (tag: string, body: string) => `<${tag} SectVersion="20" SectionFlags="0" SubIdent="0">\n${cdata(body)}\n</${tag}>\n\n`;
  const x: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<Symbol IsArchivable="false" IsPlaceable="true" MainGUID="${o.guid}" MigrationValue="Normal" Owner="0" Signature="0" Version="44">\n`,
    '<Ancestry SectVersion="1" SectionFlags="0" SubIdent="0" Template="false">\n',
    "\t<MainGUID>F938E33A-329D-4A36-BE3E-85E126820996</MainGUID>\n",
    "\t<MainGUID>103E8D2C-8230-42E1-9597-46F84CCE28C0</MainGUID>\n",
    "</Ancestry>\n\n",
    '<CalledMacros SectVersion="2" SectionFlags="0" SubIdent="0">\n</CalledMacros>\n\n',
    '<ParamSection SectVersion="27" SectionFlags="0" SubIdent="0">\n',
    "\t<ParamSectHeader>\n\t\t<AutoHotspots>false</AutoHotspots>\n\t\t<StatBits>\n\t\t\t<STBit_FixSize/>\n\t\t</StatBits>\n" +
    "\t\t<WDLeftFrame>0</WDLeftFrame>\n\t\t<WDRightFrame>0</WDRightFrame>\n\t\t<WDTopFrame>0</WDTopFrame>\n\t\t<WDBotFrame>0</WDBotFrame>\n" +
    "\t\t<LayFlags>65535</LayFlags>\n\t\t<WDMirrorThickness>0</WDMirrorThickness>\n\t\t<WDWallInset>0</WDWallInset>\n\t</ParamSectHeader>\n",
    "\t<Parameters>\n",
  ];
  for (const p of o.params) x.push(paramXml(p));
  x.push("\t</Parameters>\n</ParamSection>\n\n");
  x.push(sect("Script_1D", o.master), sect("Script_2D", o.s2d), sect("Script_3D", o.s3d), sect("Script_PR", ""), sect("Script_UI", o.sui), sect("Script_VL", o.spr));
  x.push(`<Comment SectVersion="20" SectionFlags="0" SubIdent="0">\n${cdata(`Formcraft Studio · ${o.family} · generated by fmc_archicad (${o.report.source}). Coarse, Medium and Fine detail; kit surfaces inline.`)}\n</Comment>\n\n`);
  x.push(`<Keywords SectVersion="1" SectionFlags="0" SubIdent="0">\n${cdata("Formcraft " + o.family)}\n</Keywords>\n\n`);
  x.push("</Symbol>\n");
  return x.join("");
}

/** The parameter list as data: name, GDL type, default, description and the Revit parameter it came from. */
export function paramList(o: GdlObject): Array<{ name: string; type: GdlType; default: number | string | null; description: string; revit?: string }> {
  const back = new Map(o.report.parameters.filter((r) => r.gdl).map((r) => [r.gdl!, r.revit]));
  return o.params.filter((p) => p.type !== "Title").map((p) => ({ name: p.name, type: p.type, default: p.value, description: p.desc, ...(back.has(p.name) ? { revit: back.get(p.name) } : {}) }));
}

/** The scripts as separate .gdl texts, for reading and diffing beside the XML. */
export function scriptFiles(o: GdlObject): Record<string, string> {
  return { "master.gdl": o.master, "2d.gdl": o.s2d, "3d.gdl": o.s3d, "parameter.gdl": o.spr, "ui.gdl": o.sui };
}

/**
 * Structural check of a generated XML (LP_XMLConverter isn't run here): the sections xml2libpart reads, each once;
 * every parameter declared once; IF/ENDIF, FOR/NEXT and GROUP/ENDGROUP balanced; LOCK and PARAMETERS name only
 * parameters the object has (PLAN_ARCHICAD finding 2).
 */
export function checkXml(xml: string): string[] {
  const problems: string[] = [];
  for (const t of ["Symbol", "Ancestry", "CalledMacros", "ParamSection", "Parameters", "Script_1D", "Script_2D", "Script_3D", "Script_PR", "Script_UI", "Script_VL", "Comment", "Keywords"]) {
    const open = (xml.match(new RegExp(`<${t}[ >]`, "g")) ?? []).length, close = (xml.match(new RegExp(`</${t}>`, "g")) ?? []).length;
    if (open !== 1 || close !== 1) problems.push(`section ${t}: ${open} open, ${close} close`);
  }
  const names = [...xml.matchAll(/<(?:Length|Angle|RealNum|Integer|Boolean|String|Material|PenColor|FillPattern|Title) Name="([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) problems.push(`parameters declared twice: ${[...new Set(dup)].join(", ")}`);
  for (const n of names) if (!/^[a-z][a-z0-9_]{0,31}$/.test(n)) problems.push(`parameter name ${n} isn't a GDL name`);
  for (const t of ["Script_1D", "Script_2D", "Script_3D", "Script_VL", "Script_UI"]) {
    const m = new RegExp(`<${t}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${t}>`).exec(xml);
    if (!m) { problems.push(`${t} has no CDATA body`); continue; }
    const body = m[1].split("\n").map((l) => l.replace(/!.*$/, "").trim());
    let ifs = 0, fors = 0, groups = 0;
    for (const l of body) {
      if (/^IF\b.*\bTHEN$/.test(l)) ifs++;
      if (/^ENDIF\b/.test(l)) ifs--;
      if (/^FOR\b/.test(l)) fors++;
      if (/^NEXT\b/.test(l)) fors--;
      if (/^GROUP\b/.test(l)) groups++;
      if (/^ENDGROUP\b/.test(l)) groups--;
      const lock = /\bLOCK\s+(.*)$/.exec(l);
      if (lock) for (const mm of lock[1].matchAll(/"([^"]+)"/g)) if (!names.includes(mm[1].toLowerCase())) problems.push(`${t}: LOCK names ${mm[1]}, which isn't a parameter`);
      const pars = /\bPARAMETERS\s+(.*)$/.exec(l);
      if (pars) for (const mm of pars[1].matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) if (!names.includes(mm[1].toLowerCase())) problems.push(`${t}: PARAMETERS names ${mm[1]}, which isn't a parameter`);
    }
    if (ifs !== 0) problems.push(`${t}: IF/ENDIF off by ${ifs}`);
    if (fors !== 0) problems.push(`${t}: FOR/NEXT off by ${fors}`);
    if (groups !== 0) problems.push(`${t}: GROUP/ENDGROUP off by ${groups}`);
  }
  return problems;
}

/** One family source → model, GDL object, XML and its structural check. */
export function exportFamily(source: { recipe?: Record<string, any>; report?: Record<string, any> }, kit: Map<string, KitMaterial> = new Map()) {
  const model = source.recipe ? recipeModel(source.recipe) : reportModel(source.report ?? {});
  const obj = buildGdl(model, kit);
  const xml = toXml(obj);
  return { model, obj, xml, problems: checkXml(xml) };
}

/** Kit materials (07_Materials/FMC_Materials.json, { materials: [...] }) by name. */
export function kitMaterials(json: unknown): Map<string, KitMaterial> {
  const list = (json as { materials?: KitMaterial[] } | null)?.materials;
  return new Map(Array.isArray(list) ? list.filter((m) => m && typeof m.name === "string").map((m) => [m.name, m]) : []);
}
