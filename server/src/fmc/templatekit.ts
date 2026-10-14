/**
 * Templates as data (Phase 1, B5 of docs/PLAN_EXECUTION.md; U29). The base template's contents read from the kit itself:
 * FMC_Revit_Kit.xlsx (Graphics, Electrical_Settings, Discipline_Settings, Filters, View_Templates, Schedules) and
 * FMC_Master_Data.json (parameters), so the kit stays the only source (rule 7). The hand-run build of 14 Oct
 * (scripts/kitbuild/template) proved each layer in Revit 2025; this turns the kit's wording into the same layers.
 *
 * Where the kit's wording leaves a choice open, the reader makes the choice the hand build made and says so in
 * `notes`, so each one can become a kit column through a change request.
 */

export type Rows = string[][];

/** A tab as objects keyed by its header row. */
export function table(rows: Rows | undefined): Array<Record<string, string>> {
  if (!rows?.length) return [];
  const head = rows[0].map((h) => (h ?? "").trim());
  return rows.slice(1).filter((r) => r.some((c) => (c ?? "").trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// ---------- categories ----------

/** The kit's category names (Revit's English UI names) to built-in categories. Unknown names are passed on and Revit resolves them. */
export const CATEGORY: Record<string, string> = {
  "Walls": "OST_Walls", "Doors": "OST_Doors", "Windows": "OST_Windows", "Floors": "OST_Floors", "Roofs": "OST_Roofs", "Ceilings": "OST_Ceilings",
  "Rooms": "OST_Rooms", "Structural Columns": "OST_StructuralColumns", "Structural Framing": "OST_StructuralFraming",
  "Structural Foundations": "OST_StructuralFoundation", "Electrical Fixtures": "OST_ElectricalFixtures", "Electrical Equipment": "OST_ElectricalEquipment",
  "Wires": "OST_Wire", "Lighting Fixtures": "OST_LightingFixtures", "Lighting Devices": "OST_LightingDevices", "Data Devices": "OST_DataDevices",
  "Communication Devices": "OST_CommunicationDevices", "Security Devices": "OST_SecurityDevices", "Nurse Call Devices": "OST_NurseCallDevices",
  "Fire Alarm Devices": "OST_FireAlarmDevices", "Cable Trays": "OST_CableTray", "Cable Tray Fittings": "OST_CableTrayFitting",
  "Conduits": "OST_Conduit", "Conduit Fittings": "OST_ConduitFitting", "Generic Models": "OST_GenericModel", "Ducts": "OST_DuctCurves",
  "Duct Fittings": "OST_DuctFitting", "Air Terminals": "OST_DuctTerminal", "Flex Ducts": "OST_FlexDuctCurves", "Pipes": "OST_PipeCurves",
  "Pipe Fittings": "OST_PipeFitting", "Pipe Accessories": "OST_PipeAccessory", "Plumbing Fixtures": "OST_PlumbingFixtures",
  "Plumbing Equipment": "OST_PlumbingEquipment", "Sprinklers": "OST_Sprinklers", "Specialty Equipment": "OST_SpecialityEquipment",
  "Mechanical Equipment": "OST_MechanicalEquipment", "Toposolid": "OST_Toposolid", "Planting": "OST_Planting", "Sheets": "OST_Sheets",
  "Areas": "OST_Areas", "Casework": "OST_Casework", "Furniture": "OST_Furniture",
};
/** "All 5D model categories" and "All model categories": the categories FMC_Keynote_Code is bound to, resolved in Revit. */
export const FIVE_D = "5D";

export function categories(text: string): string[] {
  const t = text.trim();
  if (/^all (5d )?model categories$/i.test(t)) return [FIVE_D];
  return t.split(",").map((c) => c.trim()).filter(Boolean).map((c) => CATEGORY[c] ?? c);
}

// ---------- filter rules ----------

/** The kit's field names that are Revit built-in parameters ("B." + BuiltInParameter). */
const BUILT_IN: Record<string, string> = {
  "Type Name": "B.ALL_MODEL_TYPE_NAME", "System Classification": "B.RBS_SYSTEM_CLASSIFICATION_PARAM", "Function": "B.FUNCTION_PARAM",
  "Phase Created": "B.PHASE_CREATED", "Phase Demolished": "B.PHASE_DEMOLISHED",
};
/** Wall Function values, as Revit stores them (WallFunction). */
const WALL_FUNCTION: Record<string, number> = { Interior: 0, Exterior: 1, Foundation: 2, Retaining: 3, Soffit: 4, CoreShaft: 5 };

const PIPES = ["OST_PipeCurves", "OST_PipeFitting", "OST_PipeAccessory"];

export interface Translated { rule: string; note?: string }

/**
 * One filter rule in the kit's words to the rule language the Revit side runs:
 * noval, hasval, eq, begins, notbegins, contains, ieq, gt, sys (piping system type), phase; or:/and: joined by ";".
 * "none" is a category-only filter.
 */
export function translateRule(text: string, cats: string[]): Translated {
  const t = text.trim();
  if (/^category (is|in)\b/i.test(t)) return { rule: "none" };
  const or = t.split(/\s+OR\s+/), and = t.split(/\s+AND\s+/);
  if (or.length > 1 || and.length > 1) {
    const parts = (or.length > 1 ? or : and).map((p) => translateRule(p, cats));
    const bad = parts.find((p) => p.rule === "none");
    if (bad) return { rule: "none", note: `"${t}": ${bad.note ?? "a part can't be mapped"}; made category-only` };
    return { rule: (or.length > 1 ? "or:" : "and:") + parts.map((p) => p.rule).join(";") };
  }
  const m = /^(.+?)\s+(has no value|has a value|does not begin with|begins with|equals|contains|is greater than)\s*(.*)$/i.exec(t);
  if (!m) return { rule: "none", note: `"${t}": not a rule the plugin reads; made category-only` };
  const [, rawField, op, rawValue] = m;
  const field = rawField.trim(), value = rawValue.trim();
  const opl = op.toLowerCase();
  if (field === "System Type") {
    // Pipes carry a piping system type element; ducts are matched on the system name text.
    if (opl === "equals" && cats.some((c) => PIPES.includes(c))) return { rule: `sys:${value}` };
    if (opl === "contains" && cats.some((c) => c.startsWith("OST_Duct") || c === "OST_FlexDuctCurves")) return { rule: `contains:B.RBS_SYSTEM_NAME_PARAM:${value}` };
    return { rule: "none", note: `"${t}": System Type on these categories has no common parameter` };
  }
  let p: string;
  if (/^FMC_\w+$/.test(field)) p = field;
  else if (BUILT_IN[field]) p = BUILT_IN[field];
  else return { rule: "none", note: `"${t}": the plugin has no Revit parameter for "${field}"` };
  if (p === "B.FUNCTION_PARAM") {
    const v = WALL_FUNCTION[value];
    if (v === undefined) return { rule: "none", note: `"${t}": unknown wall function ${value}` };
    return { rule: `ieq:${p}:${v}` };
  }
  if (p === "B.PHASE_CREATED" || p === "B.PHASE_DEMOLISHED") return { rule: `phase:${p}:${value}` };
  switch (opl) {
    case "has no value": return { rule: `noval:${p}` };
    case "has a value": return { rule: `hasval:${p}` };
    case "begins with": return { rule: `begins:${p}:${value}` };
    case "does not begin with": return { rule: `notbegins:${p}:${value}` };
    case "equals": return { rule: `eq:${p}:${value}` };
    case "contains": return { rule: `contains:${p}:${value}` };
    case "is greater than": return { rule: `gt:${p}:${value}` };
  }
  return { rule: "none", note: `"${t}": unknown operator` };
}

const PATTERN: Record<string, string> = { "Solid": "", "Dash": "FMC_Dash", "Dash dot": "FMC_DashDot", "Dash dot dot": "FMC_DashDotDot", "Dot": "FMC_Dot" };

export interface FilterSpec { name: string; categories: string[]; rule: string; rgb: [number, number, number]; pattern: string; surface: boolean }

export function filters(rows: Rows | undefined, notes: string[]): FilterSpec[] {
  return table(rows).map((r) => {
    const cats = categories(r["Categories"] ?? "");
    const tr = translateRule(r["Rule"] ?? "", cats);
    if (tr.note) notes.push(`Filter ${r["Name"]}: ${tr.note}`);
    const rgb = (r["RGB"] ?? "0,0,0").split(",").map((x) => Number(x.trim()) || 0) as [number, number, number];
    const lp = r["Line pattern"] ?? "Solid";
    if (!(lp in PATTERN)) notes.push(`Filter ${r["Name"]}: unknown line pattern "${lp}", drawn solid`);
    // The kit doesn't say surface fill or line colour: filters over the whole model (QA, zones) fill surfaces, the
    // rest colour lines, as the hand build did. A kit column would decide it.
    return { name: r["Name"], categories: cats, rule: tr.rule, rgb, pattern: PATTERN[lp] ?? "", surface: cats[0] === FIVE_D };
  }).filter((f) => f.name);
}

// ---------- view templates ----------

const VIEW_TYPE: Record<string, string> = {
  "Floor plan": "FP", "Ceiling plan": "CP", "Structural plan": "SP", "Area plan": "AP", "3D": "3D", "Elevation": "EL",
  "Section": "SE", "Section / callout": "SE", "Drafting": "DR",
};

export interface ViewTemplateSpec { name: string; type: string; scale: number; detail: string; discipline: string; filters: string[] }

/** "1:100" → 100; "1:10-1:20" → 20 (the larger, so detail is never lost); "NTS" → 0 (no scale). */
export function scaleOf(text: string): number {
  const all = [...text.matchAll(/1\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  return all.length ? Math.max(...all) : 0;
}

/** Expands the kit's group words into filter names. */
export function expandFilters(text: string, names: string[], specs: FilterSpec[], notes: string[], vt: string): string[] {
  const t = text.trim();
  if (!t || t === "-") return [];
  const all = (prefix: string) => names.filter((n) => n.startsWith(prefix));
  let m: RegExpExecArray | null;
  if ((m = /^All (\w+) filters$/i.exec(t))) return all(`F_${m[1]}_`);
  if (/^Duct system filters$/i.test(t)) return specs.filter((s) => s.categories.includes("OST_DuctCurves")).map((s) => s.name);
  if (/^Discipline colour filters$/i.test(t)) {
    // The first filter of each design discipline, the way the hand build read it; a list in the kit would settle it.
    const out = ["A", "S", "E", "M", "P", "FP"].map((d) => all(`F_${d}_`)[0]).filter((x): x is string => !!x);
    notes.push(`${vt}: "Discipline colour filters" read as the first filter of each discipline (${out.join(", ")})`);
    return out;
  }
  const list = t.split(";").map((x) => x.trim()).filter(Boolean);
  for (const n of list) if (!names.includes(n)) notes.push(`${vt}: no filter ${n} in the Filters tab`);
  return list.filter((n) => names.includes(n));
}

export function viewTemplates(rows: Rows | undefined, specs: FilterSpec[], notes: string[]): ViewTemplateSpec[] {
  const names = specs.map((s) => s.name);
  return table(rows).filter((r) => r["Name"]).map((r) => {
    const type = VIEW_TYPE[r["View type"]] ?? "";
    if (!type) notes.push(`${r["Name"]}: unknown view type "${r["View type"]}"`);
    return { name: r["Name"], type, scale: scaleOf(r["Scale"] ?? ""), detail: (r["Detail level"] ?? "Medium").charAt(0).toUpperCase(),
      discipline: r["Discipline"] ?? "Coordination", filters: expandFilters(r["Filters"] ?? "", names, specs, notes, r["Name"]) };
  }).filter((v) => v.type);
}

// ---------- graphics ----------

export interface TextTypeSpec { name: string; font: string; size_mm: number; bold: boolean }
export interface LineSegment { kind: "dash" | "space" | "dot"; mm: number }
export interface FillSpec { name: string; target: "Drafting" | "Model"; kind: "hatch" | "crosshatch" | "grid" | "copy" | "solid"; angle?: number; spacing_mm?: number; copy_of?: string }

/** The gap after a dash or dot when the kit doesn't give one: the kit's own 1.5 mm space (FMC_Dash). */
const GAP = 1.5;

/** "3 mm dash, 1.5 mm space", "6 dash, dot, dot", "12 dash, 3 dot" (three dots), "Dot 1.5 mm". */
export function lineSegments(text: string): LineSegment[] {
  const out: LineSegment[] = [];
  const mark = (s: LineSegment) => { out.push(s); };
  const parts = text.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    let m: RegExpExecArray | null;
    if ((m = /^([\d.]+)\s*(mm)?\s*space$/.exec(p))) { mark({ kind: "space", mm: Number(m[1]) }); continue; }
    if ((m = /^([\d.]+)\s*(mm)?\s*dash$/.exec(p)) || (m = /^dash\s*([\d.]+)/.exec(p))) mark({ kind: "dash", mm: Number(m[1]) });
    else if ((m = /^dot\s*([\d.]+)\s*(mm)?$/.exec(p))) { mark({ kind: "dot", mm: 0 }); mark({ kind: "space", mm: Number(m[1]) }); continue; }
    else if ((m = /^(\d+)\s*dots?$/.exec(p))) { for (let k = 0; k < Number(m[1]); k++) { mark({ kind: "dot", mm: 0 }); if (k < Number(m[1]) - 1) mark({ kind: "space", mm: GAP }); } }
    else if (p === "dot") mark({ kind: "dot", mm: 0 });
    else continue;
    if (!/space/.test(parts[i + 1] ?? "")) mark({ kind: "space", mm: GAP });
  }
  return out;
}

/** The Revit fill patterns the kit's drafting fills stand on, as the hand build chose them (no API to draw them). */
const FILL_COPIES: Record<string, string> = {
  FMC_Concrete: "Concrete", FMC_Earth: "Earth", FMC_Sand: "Sand", FMC_Insulation: "Insulation - Rigid", FMC_Timber: "Wood 1",
  FMC_Screed: "Sand - Dense", FMC_Hardcore: "Masonry - Concrete  Block",
};

export function graphics(rows: Rows | undefined, notes: string[]) {
  const text: TextTypeSpec[] = [], lines: Array<{ name: string; segments: LineSegment[] }> = [], fills: FillSpec[] = [];
  for (const r of table(rows)) {
    const kind = r["Kind"], name = r["Name"], def = r["Definition"] ?? "";
    if (kind === "Text type") {
      const m = /^(.+?)\s+([\d.]+)\s*mm\s*(bold)?$/i.exec(def);
      if (!m) { notes.push(`${name}: can't read "${def}"`); continue; }
      text.push({ name, font: m[1], size_mm: Number(m[2]), bold: !!m[3] });
    } else if (kind === "Line pattern") {
      const segments = lineSegments(def);
      if (!segments.length) notes.push(`${name}: can't read "${def}"`);
      else lines.push({ name, segments });
    } else if (kind === "Fill pattern") {
      const target = /^model/i.test(def) ? "Model" : "Drafting";
      let m: RegExpExecArray | null;
      if (/solid/i.test(def)) { fills.push({ name, target, kind: "solid" }); notes.push(`${name}: Revit allows one solid fill, so the built-in <Solid fill> stands in`); }
      else if ((m = /diagonal\s+([\d.]+)\s*deg\s+([\d.]+)\s*mm/i.exec(def))) fills.push({ name, target, kind: "hatch", angle: Number(m[1]), spacing_mm: Number(m[2]) });
      else if (/crosshatch/i.test(def)) { fills.push({ name, target, kind: "crosshatch", angle: 45, spacing_mm: GAP }); notes.push(`${name}: crosshatch spacing ${GAP} mm (not given in the kit)`); }
      else if ((m = /([\d.]+)\s*x\s*([\d.]+)\s*grid/i.exec(def))) fills.push({ name, target, kind: "grid", spacing_mm: Number(m[1]) });
      else if (FILL_COPIES[name]) { fills.push({ name, target, kind: "copy", copy_of: FILL_COPIES[name] }); notes.push(`${name}: "${def}" drawn from Revit's "${FILL_COPIES[name]}"`); }
      else notes.push(`${name}: can't draw "${def}"`);
    } else if (kind === "Line weight") {
      // Line weights have no API: the BIM Manager sets them by hand (kit change request).
    }
  }
  if (table(rows).some((r) => r["Kind"] === "Line weight")) notes.push("Line weights: no Revit API sets them; set by hand once in the template");
  return { text, lines, fills };
}

// ---------- electrical and systems ----------

export function electrical(rows: Rows | undefined, notes: string[]) {
  const voltages: Array<{ name: string; value: number; min: number; max: number }> = [];
  const systems: Array<{ name: string; phase: "Three" | "Single"; config: string; wires: number; ll: string | null; lg: string | null }> = [];
  const loads: string[] = [];
  for (const r of table(rows)) {
    const item = r["Item"], name = r["Name"];
    if (item === "Voltage") voltages.push({ name, value: Number(r["Value / phase / factor"]), min: Number(r["Min / config"]), max: Number(r["Max / wires"]) });
    else if (item === "Distribution system") {
      const none = (v: string) => (!v || v === "None" || v === "-" ? null : v);
      systems.push({ name, phase: r["Value / phase / factor"] === "Single" ? "Single" : "Three", config: r["Min / config"] === "-" ? "Undefined" : r["Min / config"],
        wires: Number(r["Max / wires"]), ll: none(r["L-L"]), lg: none(r["L-G"]) });
    } else if (item === "Load classification") loads.push(name);
  }
  if (loads.length) notes.push("Load classifications are made by name only: demand factors are the electrical engineer's (rule 5) and never set");
  return { voltages, systems, loads };
}

const CLASS: Record<string, string> = {
  "Other": "OtherPipe", "Sanitary": "Sanitary", "Fire Protection Wet": "FireProtectWet", "Fire Protection Dry": "FireProtectDry",
  "Domestic Cold Water": "DomesticColdWater", "Domestic Hot Water": "DomesticHotWater", "Vent": "Vent",
};

export function systems(rows: Rows | undefined, notes: string[]) {
  const piping: Array<{ name: string; classification: string }> = [];
  const duct: Array<{ name: string; from: string }> = [];
  for (const r of table(rows)) {
    const setting = (r["Setting"] ?? "").toLowerCase(), value = r["Formcraft value"] ?? "";
    if (setting.startsWith("piping system")) {
      for (const part of value.split(",").map((p) => p.trim())) {
        let m: RegExpExecArray | null;
        if ((m = /^(\w+)\s*\(([^)]+)\)/.exec(part))) piping.push({ name: m[1], classification: CLASS[m[2].trim()] ?? "OtherPipe" });
        else if ((m = /^([A-Z]+_\w+)\b/.exec(part)) && !/where needed/i.test(part)) {
          piping.push({ name: m[1], classification: "OtherPipe" });
          notes.push(`Piping system ${m[1]}: no classification in the kit, made as Other`);
        } else if (/where needed/i.test(part)) notes.push(`Piping system "${part}": made only where a project needs it`);
      }
    } else if (setting.startsWith("duct system")) {
      // Supply, Return and Exhaust Air are Revit's own; a new name is copied from Supply Air.
      for (const part of value.replace(/\s+with .*$/i, "").split(",").map((p) => p.trim()))
        if (part && !["Supply Air", "Return Air", "Exhaust Air"].includes(part)) duct.push({ name: part, from: "SupplyAir" });
    }
  }
  return { piping: piping.filter((p, i, a) => a.findIndex((x) => x.name === p.name) === i), duct };
}

// ---------- schedules ----------

export interface ScheduleSpec { name: string; category: string; fields: string[]; ops: string[]; itemized: boolean }

const KNOWN_FIELDS = ["Type", "Mark", "Width", "Height", "Length", "Area", "Volume", "Level", "Base Constraint", "Number", "Name", "Family and Type",
  "Count", "Sheet Number", "Sheet Name", "Current Revision", "Current Revision Date"];

/** The base schedules (00–09, kit TPL-017): the kit's words for fields and "Filter / sort / group" to the build's list. */
export function schedules(rows: Rows | undefined, notes: string[]): ScheduleSpec[] {
  return table(rows).filter((r) => /^0\d_/.test(r["Name"] ?? "")).map((r) => {
    const name = r["Name"];
    const raw = (r["Fields"] ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    const fields = raw.filter((f) => /^FMC_\w+$/.test(f) || KNOWN_FIELDS.includes(f));
    const dropped = raw.filter((f) => !fields.includes(f));
    if (dropped.length) notes.push(`${name}: not schedulable fields, left out: ${dropped.join(", ")}`);
    const fsg = (r["Filter / sort / group"] ?? "").trim();
    const ops: string[] = [];
    const field = (word: string) => {
      const w = word.toLowerCase();
      if (w === "code") return "FMC_Keynote_Code";
      if (w === "package") return "FMC_Trade_Package";
      if (w === "level") return fields.find((f) => f === "Level" || f === "Base Constraint") ?? "Level";
      return fields.find((f) => f.toLowerCase() === w) ?? word.charAt(0).toUpperCase() + word.slice(1);
    };
    let m: RegExpExecArray | null;
    if ((m = /^group by (.+)$/i.exec(fsg))) for (const w of m[1].split(/\s+and\s+/)) ops.push(`g:${field(w.trim())}`);
    else if ((m = /^sort by (.+)$/i.exec(fsg))) ops.push(`s:${field(m[1].trim())}`);
    else if ((m = /^(FMC_\w+) has no value$/i.exec(fsg))) ops.push(`none:${m[1]}`);
    else if (fsg && fsg !== "-") notes.push(`${name}: "${fsg}" needs an OR filter, which schedules don't have: left unfiltered`);
    const cat = r["Category"] === "Multi-category" ? "*" : CATEGORY[r["Category"]] ?? r["Category"];
    return { name, category: cat, fields, ops, itemized: !fields.includes("Count") };
  });
}

// ---------- the recipe ----------

export interface ParamSpec { name: string; binding: string; categories: string[]; group: string }

export interface BaseRecipe {
  kit: string;
  units: Array<{ spec: string; unit: string; accuracy: number; symbol?: string }>;
  revisions: Array<{ name: string; prefix: string; digits: number }>;
  params: ParamSpec[];
  tbc: string[];
  graphics: ReturnType<typeof graphics>;
  electrical: ReturnType<typeof electrical>;
  systems: ReturnType<typeof systems>;
  filters: FilterSpec[];
  view_templates: ViewTemplateSpec[];
  qa_views: Array<{ name: string; template: string }>;
  schedules: ScheduleSpec[];
  notes: string[];
}

export const LAYERS = ["units_params", "graphics", "electrical", "systems", "filters", "view_templates", "qa_views", "schedules"] as const;
export type Layer = (typeof LAYERS)[number];

export function baseRecipe(kitName: string, sheets: Map<string, Rows>, masterData: any): BaseRecipe {
  const notes: string[] = [];
  const params: ParamSpec[] = Object.entries((masterData?.params ?? {}) as Record<string, any>).map(([name, p]) => ({
    name, binding: String(p?.binding ?? ""), categories: Array.isArray(p?.categories) ? p.categories : [], group: String(p?.group ?? ""),
  }));
  const f = filters(sheets.get("Filters"), notes);
  notes.push("Units (TPL-004), revision sequences (TPL-010) and the QA views (TPL-014–016) follow the rulebook's text; a kit table would make them data");
  return {
    kit: kitName,
    units: [
      { spec: "Length", unit: "Millimeters", accuracy: 1 }, { spec: "Area", unit: "SquareMeters", accuracy: 0.01, symbol: "MSup2" },
      { spec: "Volume", unit: "CubicMeters", accuracy: 0.001, symbol: "MSup3" }, { spec: "Angle", unit: "Degrees", accuracy: 0.01, symbol: "Degree" },
      { spec: "Slope", unit: "Percentage", accuracy: 0.01, symbol: "Percent" }, { spec: "Currency", unit: "Currency", accuracy: 1 },
    ],
    revisions: [{ name: "FMC_P_Sequence", prefix: "P", digits: 2 }, { name: "FMC_C_Sequence", prefix: "C", digits: 2 }],
    params,
    tbc: params.filter((p) => p.group === "FMC_01_Project_Governance").map((p) => p.name),
    graphics: graphics(sheets.get("Graphics"), notes),
    electrical: electrical(sheets.get("Electrical_Settings"), notes),
    systems: systems(sheets.get("Discipline_Settings"), notes),
    filters: f,
    view_templates: viewTemplates(sheets.get("View_Templates"), f, notes),
    qa_views: [
      { name: "Z_3D_Model_Review", template: "VT_Z_3D_ModelReview" }, { name: "Z_3D_Warnings", template: "VT_Z_3D_ModelReview" },
      { name: "Z_3D_QA_NoCode", template: "VT_Z_3D_QA" }, { name: "Z_3D_QA_Unpriced", template: "VT_Z_3D_QA" }, { name: "Z_3D_QA_NoStage", template: "VT_Z_3D_QA" },
      { name: "Z_3D_NWC_Export", template: "VT_Z_3D_Export" }, { name: "Z_3D_IFC_Export", template: "VT_Z_3D_Export" },
    ],
    schedules: schedules(sheets.get("Schedules"), notes),
    notes,
  };
}

/** The part of the recipe one layer needs, for one call to Revit. */
export function layerPayload(r: BaseRecipe, layer: Layer): object {
  switch (layer) {
    case "units_params": return { units: r.units, revisions: r.revisions, params: r.params, tbc: r.tbc };
    case "graphics": return r.graphics;
    case "electrical": return r.electrical;
    case "systems": return r.systems;
    case "filters": return { filters: r.filters };
    case "view_templates": return { view_templates: r.view_templates, filters: r.filters.map((f) => ({ name: f.name, rgb: f.rgb, pattern: f.pattern, surface: f.surface })) };
    case "qa_views": return { qa_views: r.qa_views };
    case "schedules": return { schedules: r.schedules };
  }
}

/** The names a finished template should hold, for compare. */
export function expectedNames(r: BaseRecipe) {
  return {
    text_types: r.graphics.text.map((t) => t.name), line_patterns: r.graphics.lines.map((l) => l.name),
    fill_patterns: r.graphics.fills.filter((f) => f.kind !== "solid").map((f) => f.name), filters: r.filters.map((f) => f.name),
    view_templates: r.view_templates.map((v) => v.name), views: r.qa_views.map((q) => q.name), schedules: r.schedules.map((s) => s.name),
    parameters: r.params.map((p) => p.name),
  };
}
