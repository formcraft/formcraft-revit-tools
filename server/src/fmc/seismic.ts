/**
 * NBRB seismic screening form and building database (G028, L011-F15: "Digital version of a screening checklist feeding a
 * map and register; demo data only"). Pure: the tool (tools/fmc_seismic_screen.ts) reads the model, the kit and the
 * database file and writes the files.
 *
 * Rules kept here:
 * - Seismic values come only from the kit's seismic.* standards (US 319:2003, UNBS), resolved by fmc/standards.ts. Code
 *   never holds a zone factor, coefficient, importance or K value. A value the kit does not give as a number is TBC.
 * - Every field says where its value came from: model (read from the Revit model), kit (the standards bank), user (typed
 *   by the person screening), derived (worked out here from model, kit and user values, with the working shown), or TBC.
 * - The screening outcome is the inspector's (CLAUDE.md rule 5): the tool never decides it. Cd is "indicative": a
 *   screening figure from proposed kit values, never a design value.
 */
import type { Resolved } from "./standards.js";

export const DB_SCHEMA = "fmc-seismic-screening/1";

export type Source = "model" | "kit" | "user" | "derived" | "TBC";
export const TBC = "TBC" as const;

export interface Field {
  value: unknown;
  source: Source;
  /** How the value was found: the model rule, the kit key, or the formula. */
  basis?: string;
  unit?: string;
  /** When the person typed over a model value, the model's value is kept here. */
  model_value?: unknown;
}

export type Answer = "yes" | "no" | "unknown" | "n/a";
export interface ChecklistAnswer { answer: Answer; note?: string; source: "user" | "TBC" }

export interface SeismicResult {
  applies: "yes" | "no" | typeof TBC;
  criteria: Array<{ text: string; met: boolean | null; basis: string }>;
  Z: number | typeof TBC; C: number | typeof TBC; I: number | typeof TBC; K: number | typeof TBC;
  T1_s: number | typeof TBC; Cd: number | typeof TBC;
  formula: string;
  notes: string[];
  kit_status: string;
}

export interface ScreeningRecord {
  id: string;
  version: number;
  status: "draft" | "submitted" | "archived";
  demo: boolean;
  created_at: string;
  updated_at: string;
  updated_by: string;
  model: { name: string; read_at: string; link?: string } | null;
  fields: Record<string, Field>;
  checklist: Record<string, ChecklistAnswer>;
  seismic: SeismicResult;
  concerns: string[];
  tbc: string[];
  history: Array<{ version: number; at: string; by: string; changed: string[] }>;
}

export interface ScreeningDb {
  schema: typeof DB_SCHEMA;
  title: string;
  created_at: string;
  updated_at: string;
  revision: number;
  records: ScreeningRecord[];
}

export function emptyDb(now: Date, title = "NBRB seismic screening register"): ScreeningDb {
  const at = now.toISOString();
  return { schema: DB_SCHEMA, title, created_at: at, updated_at: at, revision: 0, records: [] };
}

/** A database file's text made safe: refused (not guessed at, never overwritten) when it doesn't parse or isn't ours. */
export function parseDb(text: string): { db?: ScreeningDb; error?: string } {
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (e) { return { error: `The screening database does not parse (${e instanceof Error ? e.message : String(e)}). Nothing was written; fix or move the file.` }; }
  const db = raw as Partial<ScreeningDb>;
  if (!db || typeof db !== "object" || db.schema !== DB_SCHEMA || !Array.isArray(db.records))
    return { error: `The file is not a ${DB_SCHEMA} database. Nothing was written.` };
  return { db: db as ScreeningDb };
}

// ---------------------------------------------------------------- the form

export interface FormField {
  key: string; group: string; label: string; type: "text" | "number" | "choice" | "date" | "yesno" | "list";
  unit?: string; from: "model" | "user"; help?: string;
  /** For a choice backed by the kit: the seismic.* key whose value names the options. */
  kit_choices?: string; choices?: string[];
}

export const GROUPS = ["A. Identification", "B. Building (from the model where it can)", "C. Seismic inputs", "D. Screening checklist", "E. Inspector"];

export const FORM_FIELDS: FormField[] = [
  { key: "building_name", group: GROUPS[0], label: "Building name", type: "text", from: "user" },
  { key: "address", group: GROUPS[0], label: "Address or plot", type: "text", from: "user" },
  { key: "district", group: GROUPS[0], label: "District / division", type: "text", from: "user" },
  { key: "gps_lat", group: GROUPS[0], label: "Latitude (WGS84, decimal degrees)", type: "number", from: "user", help: "Puts the building on the register map" },
  { key: "gps_lon", group: GROUPS[0], label: "Longitude (WGS84, decimal degrees)", type: "number", from: "user" },
  { key: "ownership", group: GROUPS[0], label: "Ownership", type: "choice", choices: ["public", "private", "unknown"], from: "user" },
  { key: "use_category", group: GROUPS[0], label: "Use / occupancy", type: "text", from: "user", help: "e.g. school, hospital, office, dwelling, market" },
  { key: "public_building", group: GROUPS[0], label: "Public building (US 319 cl 1.1 applies to public buildings)", type: "yesno", from: "user" },
  { key: "year_built", group: GROUPS[0], label: "Year built (approx.)", type: "number", from: "user" },
  { key: "permit_number", group: GROUPS[0], label: "Building permit number (if sighted)", type: "text", from: "user" },

  { key: "model_name", group: GROUPS[1], label: "Revit model read", type: "text", from: "model" },
  { key: "storeys_above_ground", group: GROUPS[1], label: "Storeys above ground", type: "number", from: "model" },
  { key: "basement_levels", group: GROUPS[1], label: "Basement levels", type: "number", from: "model" },
  { key: "height_m", group: GROUPS[1], label: "Height above ground", type: "number", unit: "m", from: "model" },
  { key: "gross_floor_area_m2", group: GROUPS[1], label: "Floor area (floor slabs, all levels)", type: "number", unit: "m²", from: "model" },
  { key: "rooms_area_m2", group: GROUPS[1], label: "Room area (net, all levels)", type: "number", unit: "m²", from: "model" },
  { key: "plan_length_m", group: GROUPS[1], label: "Plan length (wall extents)", type: "number", unit: "m", from: "model" },
  { key: "plan_width_m", group: GROUPS[1], label: "Plan width (wall extents)", type: "number", unit: "m", from: "model" },
  { key: "plan_aspect_ratio", group: GROUPS[1], label: "Plan aspect ratio (length / width)", type: "number", from: "model" },
  { key: "main_wall_material", group: GROUPS[1], label: "Main wall material (by wall length)", type: "text", from: "model" },
  { key: "masonry_concrete_walls_tall", group: GROUPS[1], label: "Masonry or concrete walls over the kit's height limit", type: "number", from: "model" },
  { key: "structural_columns", group: GROUPS[1], label: "Structural columns", type: "number", from: "model" },
  { key: "structural_beams", group: GROUPS[1], label: "Structural beams (framing)", type: "number", from: "model" },
  { key: "foundations", group: GROUPS[1], label: "Foundation elements", type: "number", from: "model" },
  { key: "concrete_structural_walls", group: GROUPS[1], label: "Structural concrete walls", type: "number", from: "model" },
  { key: "column_materials", group: GROUPS[1], label: "Column materials", type: "list", from: "model" },
  { key: "system_hint", group: GROUPS[1], label: "Structural system the model suggests (to confirm)", type: "text", from: "model" },

  { key: "seismic_zone", group: GROUPS[2], label: "Seismic zone (US 319 Fig 2)", type: "choice", kit_choices: "seismic.zone_factor", from: "user" },
  { key: "subsoil_class", group: GROUPS[2], label: "Subsoil class (US 319 cl 9.1.5)", type: "choice", kit_choices: "seismic.subsoil", from: "user" },
  { key: "importance_class", group: GROUPS[2], label: "Importance class (US 319 Table 3)", type: "choice", kit_choices: "seismic.importance", from: "user" },
  { key: "structural_system", group: GROUPS[2], label: "Structural system (US 319 Table 4)", type: "choice", kit_choices: "seismic.performance_K", from: "user" },

  { key: "inspector", group: GROUPS[4], label: "Screened by", type: "text", from: "user" },
  { key: "screened_on", group: GROUPS[4], label: "Date screened", type: "date", from: "user" },
  { key: "outcome", group: GROUPS[4], label: "Screening outcome (the inspector's call)", type: "choice", choices: ["no_further_action", "detailed_evaluation", "urgent_referral"], from: "user" },
  { key: "notes", group: GROUPS[4], label: "Notes", type: "text", from: "user" },
  { key: "photos", group: GROUPS[4], label: "Photo files or references", type: "list", from: "user" },
];

export interface ChecklistItem { key: string; question: string; concern_if: "yes" | "no"; kit_key?: string }

/** The checklist. Each item is a question the inspector answers on site; concern_if says which answer is a concern. */
export const CHECKLIST: ChecklistItem[] = [
  { key: "visible_structural_cracks", question: "Visible cracks in columns, beams, slabs or load-bearing walls?", concern_if: "yes" },
  { key: "soft_storey", question: "A storey much more open or flexible than the one above (e.g. open ground floor, shops, parking)?", concern_if: "yes", kit_key: "seismic.principles" },
  { key: "plan_irregular", question: "Plan irregular or unsymmetrical, or with re-entrant corners (L, T, U shapes)?", concern_if: "yes", kit_key: "seismic.principles" },
  { key: "vertical_irregular", question: "Setbacks, overhangs or a storey with a very different stiffness from the others?", concern_if: "yes", kit_key: "seismic.principles" },
  { key: "short_columns", question: "Short or captive columns (columns partly restrained by walls or windows bands)?", concern_if: "yes" },
  { key: "strong_column_weak_beam", question: "Columns visibly stronger (larger) than the beams framing into them?", concern_if: "no", kit_key: "seismic.principles" },
  { key: "foundation_ties", question: "Foundations tied both ways by ground beams?", concern_if: "no", kit_key: "seismic.foundation_ties" },
  { key: "wall_anchorage", question: "Walls anchored to the floors and roof?", concern_if: "no", kit_key: "seismic.wall_anchorage" },
  { key: "unrestrained_parapets", question: "Unrestrained parapets, gables, chimneys or water tanks on the roof?", concern_if: "yes" },
  { key: "pounding_risk", question: "Touching or very close to a neighbouring building of different height?", concern_if: "yes" },
  { key: "poor_materials", question: "Poor materials or workmanship visible (honeycombed concrete, exposed or corroded bars, weak blocks)?", concern_if: "yes" },
  { key: "unapproved_alterations", question: "Additions, extra storeys or removed walls without an approved plan?", concern_if: "yes" },
  { key: "qualified_professional", question: "Evidence a qualified professional designed or supervised the works?", concern_if: "no" },
];

const ANSWERS: Answer[] = ["yes", "no", "unknown", "n/a"];

// ---------------------------------------------------------------- the kit

export type KitLookup = (key: string) => Resolved | undefined;
export function kitLookup(all: Resolved[]): KitLookup {
  const m = new Map(all.map((r) => [r.key, r]));
  return (k) => m.get(k);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The options a kit-backed choice offers: the keys of the kit value (object), never invented. */
export function kitChoices(kit: KitLookup, key: string): string[] {
  return Object.keys(obj(kit(key)?.value));
}

/** The form the person fills in, with each kit-backed choice's options and values and the kit key it came from. */
export function formView(kit: KitLookup) {
  return {
    groups: GROUPS,
    fields: FORM_FIELDS.map((f) => ({
      ...f,
      ...(f.kit_choices ? { choices: kitChoices(kit, f.kit_choices), kit_values: kit(f.kit_choices)?.value ?? TBC, kit_note: kit(f.kit_choices)?.note ?? `missing from the kit: ${f.kit_choices}` } : {}),
    })),
    checklist: CHECKLIST.map((c) => ({ ...c, answers: ANSWERS, ...(c.kit_key ? { kit_value: kit(c.kit_key)?.value ?? TBC } : {}) })),
  };
}

// ---------------------------------------------------------------- the model

export interface ModelFacts {
  from?: string;
  levels?: Array<{ name: string; elevation_mm: number }>;
  walls?: Array<{ id?: number; type?: string; function?: string; structural?: boolean; thickness_mm?: number; length_mm?: number; height_mm?: number; base_level?: string; base_offset_mm?: number; start_mm?: number[]; end_mm?: number[]; layers?: Array<{ function?: string; material?: string; class?: string | null }> }>;
  floors?: Array<{ level?: string; area_m2?: number; structural?: boolean }>;
  roofs?: Array<{ level?: string; area_m2?: number; type?: string; plan_max_mm?: number[] | null }>;
  rooms?: Array<{ level?: string; area_m2?: number }>;
  columns?: Array<{ material?: string | null; type?: string }>;
  framing?: unknown[];
  foundations?: unknown[];
}

const MASONRY = /masonry|brick|block|stone|adobe|earth/i;
const CONCRETE = /concrete|\brc\b|cement/i;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;

function wallMaterial(w: NonNullable<ModelFacts["walls"]>[number]): string {
  const layers = w.layers ?? [];
  const core = layers.find((l) => /structure/i.test(l.function ?? "")) ?? layers[0];
  const text = `${core?.material ?? ""} ${core?.class ?? ""} ${w.type ?? ""}`;
  // Masonry first: "Concrete Block" and "Masonry - Concrete Block" are masonry, plain "Concrete" is concrete.
  if (MASONRY.test(text)) return "masonry";
  if (CONCRETE.test(text)) return "concrete";
  if (/glaz|curtain|glass/i.test(text)) return "glazing";
  if (/timber|wood/i.test(text)) return "timber";
  if (/steel|metal/i.test(text)) return "steel";
  return core?.material ? `other (${core.material})` : "unknown";
}

/** A number in a kit sentence such as "height > 5 m": the threshold the kit gives, or null when it gives none. */
export function kitThreshold(list: unknown, pattern: RegExp): { value: number; text: string } | null {
  for (const s of Array.isArray(list) ? list : []) {
    if (typeof s !== "string") continue;
    const m = pattern.exec(s);
    if (m) return { value: Number(m[1]), text: s };
  }
  return null;
}

export const CRITERIA = {
  area: /floor area\s*>\s*([\d.]+)\s*m/i,
  height: /height\s*>\s*([\d.]+)\s*m/i,
  walls: /walls?\s*>\s*([\d.]+)\s*m/i,
  public: /public/i,
};

/**
 * The building's fields read from the model. Each says the rule it used. Fields the model can't give are TBC with the
 * reason, so the person fills them in.
 */
export function fieldsFromModel(f: ModelFacts | null, kit: KitLookup, why = "no model read"): Record<string, Field> {
  const out: Record<string, Field> = {};
  const put = (key: string, value: unknown, basis: string, unit?: string) => {
    out[key] = value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))
      ? { value: TBC, source: "TBC", basis, ...(unit ? { unit } : {}) }
      : { value, source: "model", basis, ...(unit ? { unit } : {}) };
  };
  const modelKeys = FORM_FIELDS.filter((x) => x.from === "model").map((x) => x.key);
  if (!f) { for (const k of modelKeys) out[k] = { value: TBC, source: "TBC", basis: why }; return out; }

  const levels = (f.levels ?? []).filter((l) => isNum(l.elevation_mm));
  const elev = new Map(levels.map((l) => [l.name, l.elevation_mm]));
  const walls = f.walls ?? [];
  const floors = f.floors ?? [];
  const rooms = f.rooms ?? [];
  const roofs = f.roofs ?? [];

  put("model_name", f.from || null, "the model fmc_struct_facts read");

  // Storeys: levels that carry a floor slab or a room. Ground is the occupied level closest to 0.
  const occupied = levels.filter((l) => floors.some((x) => x.level === l.name) || rooms.some((x) => x.level === l.name));
  const ground = occupied.length ? occupied.reduce((a, b) => (Math.abs(b.elevation_mm) < Math.abs(a.elevation_mm) ? b : a)) : null;
  const tol = 500;
  put("storeys_above_ground", ground ? occupied.filter((l) => l.elevation_mm >= ground.elevation_mm - tol).length : null,
    ground ? `levels carrying floors or rooms at or above ${ground.name} (closest occupied level to 0)` : "no level carries a floor slab or a room");
  put("basement_levels", ground ? occupied.filter((l) => l.elevation_mm < ground.elevation_mm - tol).length : null,
    "levels carrying floors or rooms below the ground level");

  // Height: highest wall top or roof top above the ground level.
  const tops: number[] = [];
  for (const w of walls) { const b = elev.get(w.base_level ?? ""); if (isNum(b) && isNum(w.height_mm)) tops.push(b + (w.base_offset_mm ?? 0) + w.height_mm); }
  for (const r of roofs) { const z = r.plan_max_mm?.[2]; if (isNum(z)) tops.push(z); }
  put("height_m", ground && tops.length ? r2((Math.max(...tops) - ground.elevation_mm) / 1000) : null,
    ground ? "highest wall top or roof top, less the ground level's elevation" : "no ground level", "m");

  const slab = floors.reduce((s, x) => s + (isNum(x.area_m2) ? x.area_m2 : 0), 0);
  put("gross_floor_area_m2", floors.length ? r1(slab) : null, "sum of floor slab areas on every level (Revit computed area)", "m²");
  const net = rooms.reduce((s, x) => s + (isNum(x.area_m2) ? x.area_m2 : 0), 0);
  put("rooms_area_m2", rooms.length ? r1(net) : null, "sum of room areas", "m²");

  // Plan extents: the bounding box of every wall's ends (rotation is not removed: a rotated building reads larger).
  const xs: number[] = [], ys: number[] = [];
  for (const w of walls) for (const p of [w.start_mm, w.end_mm]) if (p && isNum(p[0]) && isNum(p[1])) { xs.push(p[0]); ys.push(p[1]); }
  const dx = xs.length ? (Math.max(...xs) - Math.min(...xs)) / 1000 : null;
  const dy = ys.length ? (Math.max(...ys) - Math.min(...ys)) / 1000 : null;
  const len = dx !== null && dy !== null ? Math.max(dx, dy) : null, wid = dx !== null && dy !== null ? Math.min(dx, dy) : null;
  const extentBasis = "bounding box of wall ends in the model's axes (a rotated plan reads larger)";
  put("plan_length_m", len !== null ? r2(len) : null, extentBasis, "m");
  put("plan_width_m", wid !== null ? r2(wid) : null, extentBasis, "m");
  put("plan_aspect_ratio", len !== null && wid ? r2(len / wid) : null, "plan length / plan width");

  const byMat = new Map<string, number>();
  for (const w of walls) byMat.set(wallMaterial(w), (byMat.get(wallMaterial(w)) ?? 0) + (w.length_mm ?? 0));
  const main = [...byMat.entries()].filter(([m]) => m !== "glazing").sort((a, b) => b[1] - a[1])[0];
  put("main_wall_material", main ? main[0] : null, "the core layer's material on the greatest wall length (glazing left out)");

  const limit = kitThreshold(kit("seismic.applies_to")?.value, CRITERIA.walls);
  const tall = walls.filter((w) => ["masonry", "concrete"].includes(wallMaterial(w)) && isNum(w.height_mm) && limit && w.height_mm > limit.value * 1000).length;
  put("masonry_concrete_walls_tall", limit ? tall : null, limit ? `walls of masonry or concrete taller than ${limit.value} m (kit seismic.applies_to: "${limit.text}")` : "the kit gives no wall height in seismic.applies_to");

  put("structural_columns", (f.columns ?? []).length, "structural columns in the model");
  put("structural_beams", (f.framing ?? []).length, "structural framing in the model");
  put("foundations", (f.foundations ?? []).length, "structural foundations in the model");
  put("concrete_structural_walls", walls.filter((w) => (w.structural || /bearing|shear/i.test(w.function ?? "")) && wallMaterial(w) === "concrete").length,
    "walls marked structural, of concrete");
  const mats = [...new Set((f.columns ?? []).map((c) => c.material).filter((m): m is string => !!m))];
  put("column_materials", (f.columns ?? []).length ? mats : null, "structural material of each column");

  put("system_hint", systemHint(out, kit), "a hint from columns, beams and wall materials: the engineer confirms structural_system (rule 5)");
  return out;
}

/** A Table 4 key the model points at, only when the kit lists it. Never used for K until the person confirms it. */
function systemHint(out: Record<string, Field>, kit: KitLookup): string | null {
  const keys = kitChoices(kit, "seismic.performance_K");
  const n = (k: string) => (isNum(out[k]?.value) ? (out[k].value as number) : 0);
  const mat = String(out.main_wall_material?.value ?? "");
  let want = "";
  if (n("structural_columns") > 0 && n("structural_beams") > 0) {
    if (n("concrete_structural_walls") > 0) want = "frame_with_rc_shear_walls";
    else if (mat === "masonry") want = "frame_with_masonry_infill";
    else if (mat === "concrete") want = "frame_with_rc_infill";
    else want = "ductile_moment_frame";
  } else if (mat === "masonry") want = "minimal_ductility";
  return keys.includes(want) ? want : null;
}

// ---------------------------------------------------------------- the record

export interface ScreeningInput {
  fields?: Record<string, unknown>;
  checklist?: Record<string, Answer | { answer: Answer; note?: string }>;
}

/** Problems with what the person typed: unknown keys, answers or choices the kit doesn't list. */
export function validateInput(input: ScreeningInput, kit: KitLookup): string[] {
  const problems: string[] = [];
  const byKey = new Map(FORM_FIELDS.map((f) => [f.key, f]));
  for (const [k, v] of Object.entries(input.fields ?? {})) {
    const f = byKey.get(k);
    if (!f) { problems.push(`Unknown field: ${k}`); continue; }
    if (v === null || v === undefined || v === "") continue;
    const options = f.kit_choices ? kitChoices(kit, f.kit_choices) : f.choices;
    if (f.type === "choice" && options && !options.includes(String(v))) problems.push(`${k}: "${v}" is not one of ${options.length ? options.join(", ") : `(the kit has no ${f.kit_choices})`}`);
    if (f.type === "number" && !isNum(typeof v === "string" && v.trim() !== "" ? Number(v) : v)) problems.push(`${k}: a number is needed`);
    if (f.type === "yesno" && !["yes", "no", "unknown"].includes(String(v))) problems.push(`${k}: yes, no or unknown`);
    if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) problems.push(`${k}: a date as YYYY-MM-DD`);
  }
  if (isNum(Number(input.fields?.gps_lat)) && input.fields?.gps_lat !== undefined && Math.abs(Number(input.fields.gps_lat)) > 90) problems.push("gps_lat: between -90 and 90");
  if (isNum(Number(input.fields?.gps_lon)) && input.fields?.gps_lon !== undefined && Math.abs(Number(input.fields.gps_lon)) > 180) problems.push("gps_lon: between -180 and 180");
  const items = new Set(CHECKLIST.map((c) => c.key));
  for (const [k, v] of Object.entries(input.checklist ?? {})) {
    if (!items.has(k)) { problems.push(`Unknown checklist item: ${k}`); continue; }
    const a = typeof v === "string" ? v : v?.answer;
    if (!ANSWERS.includes(a as Answer)) problems.push(`${k}: answer yes, no, unknown or n/a`);
  }
  return problems;
}

/** Model fields, then the record's earlier values, then what the person typed now (user wins; the model value is kept). */
export function mergeFields(model: Record<string, Field>, previous: Record<string, Field> | undefined, typed: Record<string, unknown> | undefined): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const f of FORM_FIELDS) {
    const m = model[f.key];
    const p = previous?.[f.key];
    // A fresh model read replaces an earlier model value; an earlier user value stays.
    let cur: Field = p && p.source === "user" ? { ...p, ...(m && m.source === "model" ? { model_value: m.value } : {}) } : m ?? p ?? { value: TBC, source: "TBC", basis: f.from === "model" ? "no model read" : "not filled in" };
    if (typed && f.key in typed && typed[f.key] !== undefined) {
      const raw = typed[f.key];
      if (raw === null || raw === "") cur = { value: TBC, source: "TBC", basis: "cleared by the person" };
      else {
        const value = f.type === "number" ? Number(raw) : raw;
        cur = { value, source: "user", basis: "entered by the person screening", ...(f.unit ? { unit: f.unit } : {}),
          ...(m && m.source === "model" && m.value !== value ? { model_value: m.value } : {}) };
      }
    }
    out[f.key] = cur;
  }
  return out;
}

export function mergeChecklist(previous: Record<string, ChecklistAnswer> | undefined, typed: ScreeningInput["checklist"]): Record<string, ChecklistAnswer> {
  const out: Record<string, ChecklistAnswer> = {};
  for (const c of CHECKLIST) {
    const t = typed?.[c.key];
    if (t !== undefined) {
      const answer = (typeof t === "string" ? t : t.answer) as Answer;
      const note = typeof t === "string" ? undefined : t.note;
      out[c.key] = { answer, source: "user", ...(note ? { note } : {}) };
    } else out[c.key] = previous?.[c.key] ?? { answer: "unknown", source: "TBC" };
  }
  return out;
}

const val = (fields: Record<string, Field>, k: string) => fields[k]?.value;
const known = (v: unknown) => v !== undefined && v !== null && v !== TBC && v !== "";

/** US 319 applicability and the indicative Cd, from the kit's seismic.* values only. Anything missing is TBC with the reason. */
export function seismicResult(fields: Record<string, Field>, kit: KitLookup): SeismicResult {
  const notes: string[] = [];
  const statuses = new Set<string>();
  const k = (key: string) => { const r = kit(key); if (r) statuses.add(r.status); return r; };

  // Applicability (kit seismic.applies_to, US 319 cl 1.1)
  const applies = k("seismic.applies_to")?.value;
  const criteria: SeismicResult["criteria"] = [];
  const num = (x: unknown) => (isNum(x) ? x : null);
  const test = (pattern: RegExp, field: string, label: string) => {
    const t = kitThreshold(applies, pattern);
    if (!t) return;
    const v = num(val(fields, field));
    criteria.push({ text: t.text, met: v === null ? null : v > t.value, basis: v === null ? `${label} is TBC` : `${label} ${v}` });
  };
  test(CRITERIA.area, "gross_floor_area_m2", "floor area (m²)");
  test(CRITERIA.height, "height_m", "height (m)");
  const wallsT = kitThreshold(applies, CRITERIA.walls);
  if (wallsT) { const v = num(val(fields, "masonry_concrete_walls_tall")); criteria.push({ text: wallsT.text, met: v === null ? null : v > 0, basis: v === null ? "wall count is TBC" : `${v} such walls` }); }
  const pub = (Array.isArray(applies) ? applies : []).find((s) => typeof s === "string" && CRITERIA.public.test(s));
  if (pub) { const v = val(fields, "public_building"); criteria.push({ text: String(pub), met: v === "yes" ? true : v === "no" ? false : null, basis: `public building: ${known(v) ? v : "TBC"}` }); }
  const appliesState: SeismicResult["applies"] = !criteria.length ? TBC : criteria.some((c) => c.met === true) ? "yes" : criteria.every((c) => c.met === false) ? "no" : TBC;
  if (!criteria.length) notes.push("The kit gives no seismic.applies_to criteria: applicability is TBC");

  // Factors: a value the kit gives as a number for the chosen key, else TBC with the kit's own words.
  const factor = (kitKey: string, field: string, label: string): number | typeof TBC => {
    const choice = val(fields, field);
    if (!known(choice)) { notes.push(`${label}: ${field} not chosen yet`); return TBC; }
    const v = obj(k(kitKey)?.value)[String(choice)];
    if (isNum(v)) return v;
    notes.push(`${label}: the kit gives no number for ${choice}${typeof v === "string" ? ` ("${v}")` : ""} (${kitKey})`);
    return TBC;
  };
  const Z = factor("seismic.zone_factor", "seismic_zone", "Z");
  const I = factor("seismic.importance", "importance_class", "I");
  const K = factor("seismic.performance_K", "structural_system", "K");

  // C: the plateau value while T1 is within the plateau for the subsoil class (kit seismic.basic_coefficient, Fig 1).
  let C: number | typeof TBC = TBC, T1: number | typeof TBC = TBC;
  const basic = obj(k("seismic.basic_coefficient")?.value);
  const formula = String(k("seismic.coefficient")?.value ?? "");
  const tm = /T1\s*=\s*([\d.]+)\s*H\b/i.exec(formula);
  const system = String(val(fields, "structural_system") ?? "");
  const H = num(val(fields, "height_m"));
  if (tm && H !== null && /frame/i.test(system) && !/minimal/i.test(system)) T1 = r2(Number(tm[1]) * H);
  else if (!tm) notes.push("T1: the kit's seismic.coefficient gives no period formula");
  else if (H === null) notes.push("T1: height is TBC");
  else notes.push(`T1: the kit's formula (${tm[0]}) is for RC frames; ${system || "the structural system"} needs the engineer's period`);
  const subsoil = String(val(fields, "subsoil_class") ?? "");
  const plateauEnds = obj(basic.plateau_to_T_s);
  const endKey = Object.keys(plateauEnds).find((x) => x.split("_")[0] === subsoil);
  const end = endKey ? plateauEnds[endKey] : undefined;
  if (!isNum(basic.plateau_C)) notes.push("C: the kit gives no plateau_C in seismic.basic_coefficient");
  else if (!known(val(fields, "subsoil_class"))) notes.push("C: subsoil_class not chosen yet");
  else if (!isNum(end)) notes.push(`C: the kit gives no plateau end for subsoil ${subsoil}`);
  else if (T1 === TBC) notes.push("C: needs T1");
  else if (T1 <= end) C = basic.plateau_C;
  else notes.push(`C: T1 ${T1} s is past the plateau (${end} s for subsoil ${subsoil}); the kit gives no number beyond it ("${String(basic.beyond ?? "read US 319 Fig 1")}")`);

  const Cd = [C, Z, I, K].every(isNum) ? Math.round((C as number) * (Z as number) * (I as number) * (K as number) * 1000) / 1000 : TBC;
  const kit_status = statuses.size ? [...statuses].join(", ") : "missing";
  if (kit_status.includes("proposed")) notes.push("The kit's seismic values are proposed (not yet approved by the BIM Manager); an engineer confirms any figure used beyond screening");
  return { applies: appliesState, criteria, Z, C, I, K, T1_s: T1, Cd, formula: formula || TBC, notes, kit_status };
}

export function concernsOf(checklist: Record<string, ChecklistAnswer>): string[] {
  return CHECKLIST.filter((c) => checklist[c.key]?.answer === c.concern_if).map((c) => c.key);
}

export function tbcOf(fields: Record<string, Field>, checklist: Record<string, ChecklistAnswer>, s: SeismicResult): string[] {
  const out = FORM_FIELDS.filter((f) => !["notes", "photos", "permit_number"].includes(f.key) && !known(fields[f.key]?.value)).map((f) => f.key);
  out.push(...CHECKLIST.filter((c) => checklist[c.key]?.answer === "unknown").map((c) => `checklist.${c.key}`));
  for (const k of ["Z", "C", "I", "K", "Cd"] as const) if (s[k] === TBC) out.push(`seismic.${k}`);
  if (s.applies === TBC) out.push("seismic.applies");
  return out;
}

/** A new or updated record: version, history and every derived part recomputed. */
export function buildRecord(opts: {
  id: string; previous?: ScreeningRecord; modelFields: Record<string, Field>; model: ScreeningRecord["model"]; input: ScreeningInput;
  kit: KitLookup; now: Date; by: string; demo?: boolean; status?: ScreeningRecord["status"];
}): ScreeningRecord {
  const at = opts.now.toISOString();
  const fields = mergeFields(opts.modelFields, opts.previous?.fields, opts.input.fields);
  const checklist = mergeChecklist(opts.previous?.checklist, opts.input.checklist);
  const seismic = seismicResult(fields, opts.kit);
  const changed = opts.previous ? changedKeys(opts.previous, fields, checklist) : ["created"];
  const version = (opts.previous?.version ?? 0) + 1;
  return {
    id: opts.id, version, status: opts.status ?? opts.previous?.status ?? "draft", demo: opts.demo ?? opts.previous?.demo ?? false,
    created_at: opts.previous?.created_at ?? at, updated_at: at, updated_by: opts.by,
    model: opts.model ?? opts.previous?.model ?? null, fields, checklist, seismic,
    concerns: concernsOf(checklist), tbc: tbcOf(fields, checklist, seismic),
    history: [...(opts.previous?.history ?? []), { version, at, by: opts.by, changed }],
  };
}

function changedKeys(prev: ScreeningRecord, fields: Record<string, Field>, checklist: Record<string, ChecklistAnswer>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(fields)) if (JSON.stringify(prev.fields[k]?.value) !== JSON.stringify(fields[k].value) || prev.fields[k]?.source !== fields[k].source) out.push(k);
  for (const k of Object.keys(checklist)) if (JSON.stringify(prev.checklist[k]) !== JSON.stringify(checklist[k])) out.push(`checklist.${k}`);
  return out;
}

export function nextId(db: ScreeningDb, demo = false): string {
  const prefix = demo ? "DEMO-" : "SS-";
  const n = db.records.filter((r) => r.id.startsWith(prefix)).map((r) => Number(r.id.slice(prefix.length))).filter(Number.isFinite);
  return `${prefix}${String((n.length ? Math.max(...n) : 0) + 1).padStart(4, "0")}`;
}

/** The database with the record put in (replacing the same id), revision bumped. Never removes a record. */
export function upsert(db: ScreeningDb, rec: ScreeningRecord, now: Date): ScreeningDb {
  const records = db.records.some((r) => r.id === rec.id) ? db.records.map((r) => (r.id === rec.id ? rec : r)) : [...db.records, rec];
  return { ...db, records, revision: db.revision + 1, updated_at: now.toISOString() };
}

// ---------------------------------------------------------------- demo data

/**
 * Fictional buildings for the conference demo (L011-F15 "demo data only"; safeguard 4: no client's building). Every one
 * is marked demo, named "(fictional)", and its inputs are typed values a person would enter, never code values: zone,
 * class and system are kit keys, so Z, I, K and C still come from the kit.
 */
export const DEMO_INPUTS: Array<{ model: Record<string, unknown>; input: ScreeningInput }> = [
  {
    model: { model_name: "DEMO sample school block (fictional)", storeys_above_ground: 2, basement_levels: 0, height_m: 7.2, gross_floor_area_m2: 640, plan_length_m: 32, plan_width_m: 10, plan_aspect_ratio: 3.2, main_wall_material: "masonry", masonry_concrete_walls_tall: 48, structural_columns: 36, structural_beams: 60, foundations: 36, concrete_structural_walls: 0 },
    input: {
      fields: { building_name: "Demo Primary School, Block A (fictional)", address: "Plot 0, Demo Road (fictional)", district: "Kampala Central (demo)", gps_lat: 0.3163, gps_lon: 32.5822, ownership: "public", use_category: "school", public_building: "yes", year_built: 2004, seismic_zone: "zone_2", subsoil_class: "II", importance_class: "schools_halls", structural_system: "frame_with_masonry_infill", inspector: "Demo inspector", screened_on: "2026-12-09", outcome: "detailed_evaluation", notes: "Demo record for the NBRB conference. Not a real building." },
      checklist: { visible_structural_cracks: "yes", soft_storey: "no", plan_irregular: "no", vertical_irregular: "no", short_columns: "yes", strong_column_weak_beam: "unknown", foundation_ties: "unknown", wall_anchorage: "no", unrestrained_parapets: "yes", pounding_risk: "no", poor_materials: "no", unapproved_alterations: "no", qualified_professional: "yes" },
    },
  },
  {
    model: { model_name: "DEMO sample clinic (fictional)", storeys_above_ground: 1, basement_levels: 0, height_m: 4.2, gross_floor_area_m2: 180, plan_length_m: 18, plan_width_m: 10, plan_aspect_ratio: 1.8, main_wall_material: "masonry", masonry_concrete_walls_tall: 22, structural_columns: 0, structural_beams: 0, foundations: 0, concrete_structural_walls: 0 },
    input: {
      fields: { building_name: "Demo Health Centre III (fictional)", address: "Demo Trading Centre (fictional)", district: "Wakiso (demo)", gps_lat: 0.4044, gps_lon: 32.4594, ownership: "public", use_category: "health centre", public_building: "yes", year_built: 1998, seismic_zone: "zone_2", subsoil_class: "III", importance_class: "hospitals_power", structural_system: "minimal_ductility", inspector: "Demo inspector", screened_on: "2026-12-09", outcome: "urgent_referral", notes: "Demo record. Load-bearing masonry, no columns in the sample model." },
      checklist: { visible_structural_cracks: "yes", soft_storey: "no", plan_irregular: "yes", vertical_irregular: "no", short_columns: "n/a", strong_column_weak_beam: "n/a", foundation_ties: "no", wall_anchorage: "no", unrestrained_parapets: "yes", pounding_risk: "no", poor_materials: "yes", unapproved_alterations: "yes", qualified_professional: "no" },
    },
  },
  {
    model: { model_name: "DEMO sample office (fictional)", storeys_above_ground: 4, basement_levels: 1, height_m: 15, gross_floor_area_m2: 2400, plan_length_m: 24, plan_width_m: 20, plan_aspect_ratio: 1.2, main_wall_material: "masonry", masonry_concrete_walls_tall: 110, structural_columns: 120, structural_beams: 260, foundations: 24, concrete_structural_walls: 4 },
    input: {
      fields: { building_name: "Demo Office Block (fictional)", address: "Demo Avenue (fictional)", district: "Nakawa (demo)", gps_lat: 0.3322, gps_lon: 32.6105, ownership: "private", use_category: "office", public_building: "no", year_built: 2016, seismic_zone: "zone_2", subsoil_class: "III", structural_system: "frame_with_rc_shear_walls", inspector: "Demo inspector", screened_on: "2026-12-10", notes: "Demo record. Importance class left blank on purpose: offices are not in US 319 Table 3, so I shows as TBC." },
      checklist: { visible_structural_cracks: "no", soft_storey: "yes", plan_irregular: "no", vertical_irregular: "no", short_columns: "no", strong_column_weak_beam: "yes", foundation_ties: "yes", wall_anchorage: "yes", unrestrained_parapets: "no", pounding_risk: "yes", poor_materials: "no", unapproved_alterations: "no", qualified_professional: "yes" },
    },
  },
];

export function demoModelFields(m: Record<string, unknown>): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const f of FORM_FIELDS.filter((x) => x.from === "model")) {
    const v = m[f.key];
    out[f.key] = v === undefined ? { value: TBC, source: "TBC", basis: "not in the demo sample" } : { value: v, source: "model", basis: "demo sample model (fictional)", ...(f.unit ? { unit: f.unit } : {}) };
  }
  return out;
}

// ---------------------------------------------------------------- reports

type Block = { h: 1 | 2 | 3; text: string } | { p: string } | { table: { head: string[]; rows: string[][] } } | { list: string[] };

const SOURCE_TAG: Record<Source, string> = { model: "Model", kit: "Kit", user: "Entered", derived: "Worked out", TBC: "TBC" };
const show = (v: unknown, unit?: string): string => {
  if (!known(v)) return "TBC";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
  return unit ? `${v} ${unit}` : String(v);
};
const label = (k: string) => FORM_FIELDS.find((f) => f.key === k)?.label ?? k;
const fmtFactor = (v: number | typeof TBC) => (v === TBC ? "TBC" : String(v));

export function recordBlocks(r: ScreeningRecord, kit: KitLookup): Block[] {
  const b: Block[] = [];
  const name = show(r.fields.building_name?.value);
  b.push({ h: 2, text: `${r.id}: ${name}${r.demo ? (/fictional/i.test(name) ? " (DEMO DATA)" : " (DEMO DATA, fictional)") : ""}` });
  b.push({ p: `Status ${r.status}, version ${r.version}, updated ${r.updated_at.slice(0, 10)}. Model read: ${r.model ? `${r.model.name} (${r.model.read_at.slice(0, 10)})` : "none"}.` });
  b.push({ h: 3, text: "Summary" });
  b.push({ table: { head: ["Item", "Result"], rows: [
    ["US 319 applies", r.seismic.applies],
    ["Indicative seismic coefficient Cd", fmtFactor(r.seismic.Cd)],
    ["Checklist concerns", `${r.concerns.length} of ${CHECKLIST.length}`],
    ["Inspector's outcome", show(r.fields.outcome?.value).replace(/_/g, " ")],
    ["Items still TBC", String(r.tbc.length)],
  ] } });
  for (const g of [GROUPS[0], GROUPS[1], GROUPS[2], GROUPS[4]]) {
    b.push({ h: 3, text: g });
    b.push({ table: { head: ["Field", "Value", "Source", "How"], rows: FORM_FIELDS.filter((f) => f.group === g).map((f) => {
      const x = r.fields[f.key] ?? { value: TBC, source: "TBC" as Source };
      return [f.label, show(x.value, x.unit ?? f.unit) + (known(x.model_value) ? ` (model: ${show(x.model_value, f.unit)})` : ""), SOURCE_TAG[x.source], x.basis ?? ""];
    }) } });
  }
  b.push({ h: 3, text: "US 319 applicability (kit seismic.applies_to)" });
  b.push(r.seismic.criteria.length ? { table: { head: ["Criterion (kit)", "Met", "Basis"], rows: r.seismic.criteria.map((c) => [c.text, c.met === null ? "TBC" : c.met ? "yes" : "no", c.basis]) } } : { p: "TBC: the kit gives no criteria." });
  b.push({ h: 3, text: "Seismic figures (kit values, US 319:2003)" });
  const kv = (key: string) => kit(key) ? `${key} (${kit(key)!.status}): ${kit(key)!.note ?? ""}` : `${key}: missing from the kit`;
  b.push({ table: { head: ["Symbol", "Value", "From"], rows: [
    ["Z zone factor", fmtFactor(r.seismic.Z), kv("seismic.zone_factor")],
    ["C basic coefficient", fmtFactor(r.seismic.C), kv("seismic.basic_coefficient")],
    ["T1 period (s)", fmtFactor(r.seismic.T1_s), kv("seismic.coefficient")],
    ["I importance factor", fmtFactor(r.seismic.I), kv("seismic.importance")],
    ["K performance factor", fmtFactor(r.seismic.K), kv("seismic.performance_K")],
    ["Cd = C·Z·I·K (indicative)", fmtFactor(r.seismic.Cd), `formula from the kit: ${r.seismic.formula}`],
  ] } });
  if (r.seismic.notes.length) b.push({ list: r.seismic.notes });
  b.push({ h: 3, text: "Screening checklist" });
  b.push({ table: { head: ["Question", "Answer", "Concern", "Note"], rows: CHECKLIST.map((c) => {
    const a = r.checklist[c.key] ?? { answer: "unknown" as Answer, source: "TBC" as const };
    return [c.question, a.answer === "unknown" ? "unknown (TBC)" : a.answer, a.answer === c.concern_if ? "yes" : "", a.note ?? ""];
  }) } });
  if (r.tbc.length) { b.push({ h: 3, text: "Still to be confirmed (TBC)" }); b.push({ list: r.tbc.map((k) => k.startsWith("checklist.") || k.startsWith("seismic.") ? k : `${k}: ${label(k)}`) }); }
  return b;
}

const DISCLAIMER = "This is a rapid screening record, not a structural assessment or a design. Model values are read from the Revit model as drawn; " +
  "entered values are the inspector's; seismic factors come from the Formcraft standards bank (US 319:2003, UNBS) and are proposed values until the BIM Manager approves them. " +
  "Cd is an indicative screening figure only. The outcome is the inspector's decision; a qualified engineer decides on any further evaluation.";

export function buildingReport(r: ScreeningRecord, kit: KitLookup, now: Date): Block[] {
  return [
    { h: 1, text: `Seismic screening record ${r.id}` },
    { p: `Prepared ${now.toISOString().slice(0, 10)} for the building committee by the Formcraft seismic screening tool (fmc_seismic_screen).${r.demo ? " DEMO DATA: this building is fictional." : ""}` },
    ...recordBlocks(r, kit),
    { h: 3, text: "Read this first" }, { p: DISCLAIMER },
  ];
}

export function registerReport(db: ScreeningDb, now: Date, includeArchived = false): Block[] {
  const recs = db.records.filter((r) => includeArchived || r.status !== "archived");
  const demo = recs.filter((r) => r.demo).length;
  const onMap = recs.filter((r) => coords(r)).length;
  const byOutcome = new Map<string, number>();
  for (const r of recs) { const o = show(r.fields.outcome?.value); byOutcome.set(o, (byOutcome.get(o) ?? 0) + 1); }
  return [
    { h: 1, text: db.title },
    { p: `Prepared ${now.toISOString().slice(0, 10)}. ${recs.length} buildings (${demo} demo, fictional); ${onMap} on the map. Database revision ${db.revision}.` },
    { h: 2, text: "Outcomes" },
    { table: { head: ["Outcome (inspector)", "Buildings"], rows: [...byOutcome.entries()].map(([o, n]) => [o.replace(/_/g, " "), String(n)]) } },
    { h: 2, text: "Register" },
    { table: { head: ["Id", "Building", "District", "Use", "Storeys", "Height m", "Applies", "Cd", "Concerns", "Outcome", "TBC"], rows: recs.map((r) => [
      r.id + (r.demo ? " (demo)" : ""), show(r.fields.building_name?.value), show(r.fields.district?.value), show(r.fields.use_category?.value),
      show(r.fields.storeys_above_ground?.value), show(r.fields.height_m?.value), r.seismic.applies, fmtFactor(r.seismic.Cd),
      String(r.concerns.length), show(r.fields.outcome?.value).replace(/_/g, " "), String(r.tbc.length)]) } },
    ...(recs.length > onMap ? [{ p: `Not on the map (no coordinates): ${recs.filter((r) => !coords(r)).map((r) => r.id).join(", ")}.` } as Block] : []),
    { h: 3, text: "Read this first" }, { p: DISCLAIMER },
  ];
}

export function toMarkdown(blocks: Block[]): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return blocks.map((x) => {
    if ("h" in x) return `${"#".repeat(x.h)} ${x.text}`;
    if ("p" in x) return x.p;
    if ("list" in x) return x.list.map((l) => `- ${l}`).join("\n");
    return [`| ${x.table.head.map(cell).join(" | ")} |`, `|${x.table.head.map(() => "---").join("|")}|`, ...x.table.rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
  }).join("\n\n") + "\n";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One self-contained page (no scripts, no web fonts, no outside links) a committee can open or print. */
export function toHtml(title: string, blocks: Block[]): string {
  const body = blocks.map((x) => {
    if ("h" in x) return `<h${x.h}>${esc(x.text)}</h${x.h}>`;
    if ("p" in x) return `<p>${esc(x.p)}</p>`;
    if ("list" in x) return `<ul>${x.list.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
    return `<table><thead><tr>${x.table.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${x.table.rows.map((r) => `<tr>${r.map((c) => `<td${c === "TBC" || c.startsWith("TBC") ? ' class="tbc"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }).join("\n");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>` +
    "body{font-family:Segoe UI,Arial,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#1d2433}" +
    "table{border-collapse:collapse;width:100%;margin:8px 0 16px}th,td{border:1px solid #c9ced8;padding:4px 8px;text-align:left;vertical-align:top;font-size:13px}" +
    "th{background:#eef1f6}td.tbc{background:#fff4d6}h1{font-size:24px}h2{font-size:19px;margin-top:28px}h3{font-size:15px}@media print{body{margin:0}}" +
    `</style></head><body>\n${body}\n</body></html>\n`;
}

function coords(r: ScreeningRecord): [number, number] | null {
  const lat = r.fields.gps_lat?.value, lon = r.fields.gps_lon?.value;
  return isNum(lat) && isNum(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null;
}

/** The map layer: one GeoJSON point per building with coordinates (RFC 7946: longitude, latitude). */
export function toGeoJson(db: ScreeningDb, includeArchived = false) {
  return {
    type: "FeatureCollection",
    features: db.records.filter((r) => includeArchived || r.status !== "archived").flatMap((r) => {
      const c = coords(r);
      return c ? [{ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: {
        id: r.id, demo: r.demo, status: r.status, name: show(r.fields.building_name?.value), district: show(r.fields.district?.value),
        use: show(r.fields.use_category?.value), storeys: r.fields.storeys_above_ground?.value ?? TBC, applies: r.seismic.applies,
        Cd: r.seismic.Cd, concerns: r.concerns.length, outcome: r.fields.outcome?.value ?? TBC, tbc: r.tbc.length } }] : [];
    }),
  };
}

export const CSV_HEAD = ["id", "demo", "status", "version", "building_name", "district", "gps_lat", "gps_lon", "ownership", "use_category", "storeys_above_ground",
  "height_m", "gross_floor_area_m2", "main_wall_material", "structural_system", "seismic_zone", "subsoil_class", "importance_class", "Z", "C", "I", "K", "Cd",
  "applies", "concerns", "outcome", "inspector", "screened_on", "tbc_count", "updated_at"];

export function csvRows(db: ScreeningDb, includeArchived = false): Array<Array<string | number | boolean>> {
  return db.records.filter((r) => includeArchived || r.status !== "archived").map((r) => {
    const v = (k: string) => { const x = r.fields[k]?.value; return known(x) ? (Array.isArray(x) ? x.join("; ") : (x as string | number)) : TBC; };
    return [r.id, r.demo, r.status, r.version, v("building_name"), v("district"), v("gps_lat"), v("gps_lon"), v("ownership"), v("use_category"), v("storeys_above_ground"),
      v("height_m"), v("gross_floor_area_m2"), v("main_wall_material"), v("structural_system"), v("seismic_zone"), v("subsoil_class"), v("importance_class"),
      r.seismic.Z, r.seismic.C, r.seismic.I, r.seismic.K, r.seismic.Cd, r.seismic.applies, r.concerns.length, v("outcome"), v("inspector"), v("screened_on"), r.tbc.length, r.updated_at];
  });
}
