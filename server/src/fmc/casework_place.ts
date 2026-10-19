/**
 * Casework in the model (CW2, docs/PLAN_CASEWORK.md). Pure: no Revit. The Revit commands only carry these plans out.
 *
 *   room reading (fmc_casework_room)  → a run's walls with their place in the model, and the services points
 *   units + walls + kit               → placement plan for fmc_casework_place (FMC_I_Casework_* unit families)
 *   units + walls + services          → coordination checks that flag, never decide (rule 5)
 *   units + sheet register + rulebook → shop-drawing views laid out on A3 sheets for fmc_casework_pack
 *
 * Families, types, parameters, sheets, scales, title blocks and view templates all come from the kit's own files
 * (FMC_Family_Register.csv, FMC_Master_Data.json, FMC_Sheet_Register.csv, FMC_Rulebook_Sheets.json, the material
 * library's keynotes). What the kit lacks comes back as a kit change request; nothing is filled in (rule 7).
 */
import { KitRequest, LibMaterial, RunWall, Standards, Unit } from "./casework.js";

// ---------------------------------------------------------------------------------------------------------------
// The kit's casework family (03_Master_Data\FMC_Family_Register.csv)

export interface KitFamily { family: string; category: string; types: string[]; key_parameters: string[] }

/** A register row by family name: its category, its types ("Base, Wall, Tall" → three) and its key parameters. */
export function registerFamily(rows: string[][], family: string): KitFamily | null {
  const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const cFam = head.indexOf("family"), cCat = head.indexOf("category"), cTypes = head.indexOf("types"), cKey = head.indexOf("keyparameters");
  if (cFam < 0) return null;
  const list = (r: string[], c: number) => (c < 0 ? [] : (r[c] ?? "").split(",").map((t) => t.trim()).filter(Boolean));
  for (const r of rows.slice(1)) {
    if ((r[cFam] ?? "").trim() !== family) continue;
    return { family, category: cCat < 0 ? "" : (r[cCat] ?? "").trim(), types: list(r, cTypes), key_parameters: list(r, cKey) };
  }
  return null;
}

/** The kit's parameters the placement writes, and the binding each must have (FMC_Master_Data.json params). */
export const PLACE_PARAMS: Record<string, "Instance" | "Type"> = {
  FMC_Assembly_Mark: "Instance",
  FMC_Carcass_Spec: "Type",
  FMC_Worktop_Spec: "Type",
};

/** Which of the placement's parameters the kit has for Casework, with their binding; the rest are kit change requests. */
export function kitParams(masterData: unknown): { found: Record<string, "Instance" | "Type">; requests: KitRequest[] } {
  const params = (masterData && typeof masterData === "object" ? (masterData as Record<string, unknown>).params : null) as Record<string, any> | null;
  const found: Record<string, "Instance" | "Type"> = {};
  const requests: KitRequest[] = [];
  for (const [name, want] of Object.entries(PLACE_PARAMS)) {
    const p = params?.[name];
    const cats: string[] = Array.isArray(p?.categories) ? p.categories : [];
    if (!p || !cats.includes("OST_Casework")) {
      requests.push({ item: name, request: `Add ${name} (bound to Casework) to the shared parameters and FMC_Master_Data.json`, why: "fmc_casework_place writes it on every unit" });
      continue;
    }
    const binding = p.binding === "Type" ? "Type" : "Instance";
    if (binding !== want) requests.push({ item: name, request: `Check ${name}'s binding: the kit has it as ${binding}`, why: `The placement expects a ${want} parameter` });
    found[name] = binding;
  }
  return { found, requests };
}

// ---------------------------------------------------------------------------------------------------------------
// Placement plan

export interface PlaceOptions {
  family: KitFamily;
  /** The person's choice of register type for a unit kind the family has no type for (e.g. {"sink": "Base"}) */
  type_for?: Record<string, string>;
  /** Underside of the wall units above the level, mm: a design input, never defaulted */
  wall_unit_bottom?: number;
  /** The kit's parameters as FMC_Master_Data.json has them (kitParams) */
  params: Record<string, "Instance" | "Type">;
  /** The material library, for the carcass and worktop keynotes (J.CAB_xx, J.TOP_xx) */
  lib: Map<string, LibMaterial> | null;
}

export interface PlaceOp {
  mark: string;
  kind: string;
  type: string;
  width: number;
  wall: string;
  /** Back-centre of the unit on the wall face, mm in model coordinates; z is above the level */
  at: [number, number, number];
  /** Unit vector the unit's front faces (into the room) */
  facing: [number, number];
  /** Instance parameters to set */
  params: Record<string, string>;
}

export interface PlacePlan {
  family: string;
  ops: PlaceOp[];
  /** Type parameters, per type */
  type_params: Record<string, Record<string, string>>;
  skipped: Array<{ mark: string; why: string }>;
  problems: string[];
  notes: string[];
  kit_requests: KitRequest[];
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** The wall's direction and room-side normal, or why it can't be placed. */
export function wallFrame(w: RunWall): { origin: [number, number]; dir: [number, number]; normal: [number, number]; length: number } | string {
  if (!w.start || !w.end) return `Wall ${w.name} has no place in the model (start, end): read the room (fmc_casework room) or give them`;
  const dx = w.end[0] - w.start[0], dy = w.end[1] - w.start[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return `Wall ${w.name}: start and end are the same point`;
  if (Math.abs(len - w.length) > 1) return `Wall ${w.name}: the run says ${w.length} long but start → end is ${Math.round(len)}`;
  const dir: [number, number] = [dx / len, dy / len];
  const k = w.side === "right" ? -1 : 1;
  return { origin: w.start, dir, normal: [-dir[1] * k, dir[0] * k], length: len };
}

/** The register type for a unit kind: the type named like the kind (Base, Wall, Tall), or the person's choice. */
export function typeFor(kind: string, family: KitFamily, chosen?: Record<string, string>): { type?: string; why?: string } {
  const pick = chosen?.[kind];
  if (pick) {
    const t = family.types.find((x) => x.toLowerCase() === pick.toLowerCase());
    return t ? { type: t } : { why: `type_for names ${pick} for ${kind}, which isn't a ${family.family} type (${family.types.join(", ")})` };
  }
  const t = family.types.find((x) => x.toLowerCase() === kind.toLowerCase());
  return t ? { type: t } : { why: `${family.family} has no ${kind} type (the kit's types: ${family.types.join(", ")})` };
}

function keynote(lib: Map<string, LibMaterial> | null, material: string | undefined, group: string, what: string, req: KitRequest[]): string | null {
  if (!material) return null;
  if (!lib) return null;
  const m = lib.get(material);
  if (!m) { req.push({ item: material, request: `Add ${material} to 07_Materials\\FMC_Materials.json with its ${group} keynote`, why: `${what} is written from the material's keynote` }); return null; }
  if (!m.keynote || !m.keynote.startsWith(group + "_")) {
    req.push({ item: material, request: `Give ${material} a ${group}_xx keynote in 07_Materials\\FMC_Materials.json${m.keynote ? ` (it has ${m.keynote})` : ""}`, why: `${what} takes a ${group} code` });
    return null;
  }
  return m.keynote;
}

/**
 * Where each unit goes: back-centre on its wall's room-side face, facing into the room, the wall units at the given
 * underside. Gaps (cooker, fridge, hood) hold no unit and are skipped; a kind the family has no type for is skipped
 * and asked of the kit. FMC_Assembly_Mark is each unit's mark; FMC_Carcass_Spec and FMC_Worktop_Spec are the library
 * keynotes of the carcass board and the worktop, set on the types (they are Type parameters in the kit).
 */
export function placementPlan(units: Unit[], walls: RunWall[], s: Standards, o: PlaceOptions): PlacePlan {
  const ops: PlaceOp[] = [];
  const skipped: PlacePlan["skipped"] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const req: KitRequest[] = [];
  const frames = new Map(walls.map((w) => [w.name, wallFrame(w)]));
  const askedKinds = new Set<string>();

  const carcass = o.params.FMC_Carcass_Spec ? keynote(o.lib, s.carcass_board, "J.CAB", "FMC_Carcass_Spec", req) : null;
  const worktop = o.params.FMC_Worktop_Spec ? keynote(o.lib, s.worktop, "J.TOP", "FMC_Worktop_Spec", req) : null;
  if (o.params.FMC_Worktop_Spec && !s.worktop) notes.push("No worktop material in the standards, so FMC_Worktop_Spec is left empty");
  if (!o.lib) notes.push("The kit's material library isn't readable, so FMC_Carcass_Spec and FMC_Worktop_Spec are left empty");

  const typeParams: Record<string, Record<string, string>> = {};
  const setType = (type: string, name: string, value: string | null) => {
    if (value === null || !o.params[name]) return;
    const t = (typeParams[type] ??= {});
    if (t[name] !== undefined && t[name] !== value) problems.push(`${o.family.family} : ${type} would need two values of ${name} (${t[name]}, ${value}); it is a Type parameter`);
    t[name] = value;
  };

  const needsWallBottom = units.some((u) => u.kind === "wall");
  if (needsWallBottom && !(typeof o.wall_unit_bottom === "number" && o.wall_unit_bottom > 0)) {
    problems.push("Give wall_unit_bottom: the underside of the wall units above the level, mm (a design input; nothing is assumed)");
    req.push({ item: "Wall-unit height", request: "Add the wall units' mounting height (underside above floor) to 03_Master_Data\\FMC_Casework_Standards.json", why: "Placing wall units needs it and the kit has no casework standards" });
  }

  for (const u of units) {
    if (u.kind === "gap") { skipped.push({ mark: u.mark, why: `${u.fronts} space: no unit stands there` }); continue; }
    const t = typeFor(u.kind, o.family, o.type_for);
    if (!t.type) {
      skipped.push({ mark: u.mark, why: t.why! });
      if (!o.type_for?.[u.kind] && !askedKinds.has(u.kind)) {
        askedKinds.add(u.kind);
        req.push({ item: `${o.family.family} ${u.kind} type`, request: `Add a ${u.kind[0].toUpperCase()}${u.kind.slice(1)} type to ${o.family.family} (the register has ${o.family.types.join(", ")})`,
          why: `The ${u.kind} units can't be placed without it; or name a type for them with type_for (your choice, not the tool's)` });
      }
      continue;
    }
    const f = frames.get(u.wall);
    if (!f) { problems.push(`${u.mark}: wall ${u.wall || "(none)"} isn't in the run`); continue; }
    if (typeof f === "string") { problems.push(`${u.mark}: ${f}`); continue; }
    const along = u.offset + u.width / 2;
    if (u.offset < 0 || u.offset + u.width > f.length + 1) { problems.push(`${u.mark} runs off wall ${u.wall}`); continue; }
    const z = u.layer === "wall" ? (o.wall_unit_bottom ?? 0) : 0;
    const params: Record<string, string> = {};
    if (o.params.FMC_Assembly_Mark) params.FMC_Assembly_Mark = u.mark;
    ops.push({ mark: u.mark, kind: u.kind, type: t.type, width: u.width, wall: u.wall,
      at: [r1(f.origin[0] + f.dir[0] * along), r1(f.origin[1] + f.dir[1] * along), z], facing: [Math.round(f.normal[0] * 1e6) / 1e6 + 0, Math.round(f.normal[1] * 1e6) / 1e6 + 0], params });
    setType(t.type, "FMC_Carcass_Spec", carcass);
    if (u.layer === "base" && u.kind !== "tall") setType(t.type, "FMC_Worktop_Spec", worktop);
  }
  const gaps = skipped.filter((x) => /space/.test(x.why)).length;
  if (gaps) notes.push(`${gaps} appliance or hood space(s) stay empty: no appliance family is placed`);
  return { family: o.family.family, ops, type_params: typeParams, skipped, problems, notes, kit_requests: req };
}

// ---------------------------------------------------------------------------------------------------------------
// Room reading → a run's walls and the services

export interface RoomRead {
  room: { number: string; name: string; level: string };
  /** The room's outer boundary, anticlockwise, on the finish faces; mm */
  walls: Array<{ start: [number, number]; end: [number, number]; wall_id?: number }>;
  openings: Array<{ kind: "door" | "window"; wall_id?: number; at: [number, number]; width: number; sill?: number }>;
  points: Array<{ category: string; family: string; type: string; at: [number, number, number]; system?: string }>;
}

export type ServiceKind = "water" | "waste" | "gas" | "socket" | "other";
export interface Service { kind: ServiceKind; label: string; at: [number, number, number] }

/** What a point is, from its category and names (gas before waste before water: a "gas tap" is gas). */
export function serviceKind(p: { category: string; family: string; type: string; system?: string }): ServiceKind {
  const text = `${p.family} ${p.type} ${p.system ?? ""}`;
  if (/gas|lpg/i.test(text)) return "gas";
  if (/waste|soil|sanitary|drain|trap|sw\b/i.test(text)) return "waste";
  if (/water|dcw|dhw|cold|hot|tap|stop ?cock|valve/i.test(text)) return "water";
  if (/electrical fixture/i.test(p.category) || /socket|outlet|power/i.test(text)) return "socket";
  if (/plumbing fixture/i.test(p.category)) return "water";
  return "other";
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * The room as a run's walls (W1, W2, … in boundary order, each with its place in the model and its doors and windows)
 * and the services points. Modules, the corner, the sink and appliances are the person's to add: nothing is assumed.
 */
export function runFromRoom(read: RoomRead): { walls: RunWall[]; services: Service[]; sills: Array<{ wall: string; offset: number; width: number; sill: number }>; notes: string[] } {
  const notes: string[] = [];
  const walls: RunWall[] = read.walls.map((w, i) => ({ name: `W${i + 1}`, length: Math.round(dist(w.start, w.end)), start: w.start, end: w.end,
    ...(w.wall_id !== undefined ? { wall_id: w.wall_id } : {}), openings: [] }));
  const sills: Array<{ wall: string; offset: number; width: number; sill: number }> = [];
  for (const o of read.openings) {
    // the face this opening sits in: its own wall's face where the point projects inside it, else the nearest face
    let best: { w: RunWall; t: number; d: number } | null = null;
    for (const w of walls) {
      if (o.wall_id !== undefined && w.wall_id !== undefined && w.wall_id !== o.wall_id) continue;
      const L = w.length, dx = (w.end![0] - w.start![0]) / L, dy = (w.end![1] - w.start![1]) / L;
      const t = (o.at[0] - w.start![0]) * dx + (o.at[1] - w.start![1]) * dy;
      const d = Math.abs(-(o.at[0] - w.start![0]) * dy + (o.at[1] - w.start![1]) * dx);
      if (t < 0 || t > L) continue;
      if (!best || d < best.d) best = { w, t, d };
    }
    if (!best) { notes.push(`A ${o.kind} at ${o.at.map(Math.round).join(", ")} isn't on the room's boundary`); continue; }
    const offset = Math.round(best.t - o.width / 2);
    best.w.openings!.push({ kind: o.kind, offset, width: Math.round(o.width) });
    if (o.kind === "window" && typeof o.sill === "number") sills.push({ wall: best.w.name, offset, width: Math.round(o.width), sill: Math.round(o.sill) });
  }
  for (const w of walls) if (!w.openings!.length) delete w.openings;
  const services = read.points.map((p) => ({ kind: serviceKind(p), label: `${p.family} : ${p.type}`, at: p.at }));
  if (!services.some((x) => x.kind === "water" || x.kind === "waste")) notes.push("No water or waste point is modelled in the room");
  return { walls, services, sills, notes };
}

/** The run's name for each wall the room reading named (W1, W2, …), matched by where the wall face runs (within 5 mm). */
export function matchWalls(roomWalls: RunWall[], runWalls: RunWall[]): Map<string, string> {
  const near = (a?: [number, number], b?: [number, number]) => !!a && !!b && dist(a, b) <= 5;
  const out = new Map<string, string>();
  for (const r of roomWalls) {
    const w = runWalls.find((x) => near(x.start, r.start) && near(x.end, r.end));
    if (w) out.set(r.name, w.name);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Coordination checks (board CW_Pane step 3): they flag with the rule, and never move a service or a unit

export interface CheckFlag { check: string; mark: string; state: "ok" | "flag" | "info"; detail: string; rule: string }

export const NO_KIT_RULE = "No kit rule yet (kit change request: casework coordination rules in FMC_Casework_Standards.json)";
const R5 = "rule 5: the professional decides";

/** Services on a wall within the casework depth, with how far along the wall they are. */
function onWall(services: Service[], w: RunWall, depth: number): Array<Service & { t: number }> {
  const f = wallFrame(w);
  if (typeof f === "string") return [];
  return services.flatMap((sv) => {
    const rx = sv.at[0] - f.origin[0], ry = sv.at[1] - f.origin[1];
    const t = rx * f.dir[0] + ry * f.dir[1];
    const d = rx * f.normal[0] + ry * f.normal[1];
    return t >= 0 && t <= f.length && d >= -depth && d <= depth ? [{ ...sv, t }] : [];
  });
}

export function coordinationChecks(units: Unit[], walls: RunWall[], services: Service[], sills: Array<{ wall: string; offset: number; width: number; sill: number }>, s: Standards): CheckFlag[] {
  const out: CheckFlag[] = [];
  const byWall = new Map(walls.map((w) => [w.name, onWall(services, w, s.base.depth)]));
  const within = (list: Array<Service & { t: number }>, u: Unit, kind: ServiceKind) => list.filter((x) => x.kind === kind && x.t >= u.offset && x.t <= u.offset + u.width);
  const span = (u: Unit) => `${u.wall} ${u.offset}–${u.offset + u.width}`;
  const anyGas = services.some((x) => x.kind === "gas");

  for (const u of units) {
    const list = byWall.get(u.wall) ?? [];
    if (u.kind === "sink") {
      for (const kind of ["waste", "water"] as const) {
        const here = within(list, u, kind);
        out.push(here.length
          ? { check: `${kind} at the sink`, mark: u.mark, state: "ok", detail: `${here.length} ${kind} point(s) behind ${u.mark} (${span(u)})`, rule: NO_KIT_RULE }
          : { check: `${kind} at the sink`, mark: u.mark, state: "flag", detail: `No ${kind} point behind ${u.mark} (${span(u)}): move the sink or route the ${kind}`, rule: `${NO_KIT_RULE}; ${R5}` });
      }
    }
    if (u.kind === "gap" && u.fronts === "cooker") {
      const gas = within(list, u, "gas");
      if (gas.length) out.push({ check: "gas at the cooker", mark: u.mark, state: "info", detail: `A gas point is behind the cooker space ${u.mark} (${span(u)}): its route, valve and clearances are the professional's`, rule: R5 });
      else if (anyGas) out.push({ check: "gas at the cooker", mark: u.mark, state: "flag", detail: `The room has a gas point, but not behind the cooker space ${u.mark} (${span(u)})`, rule: `${NO_KIT_RULE}; ${R5}` });
      else out.push({ check: "gas at the cooker", mark: u.mark, state: "info", detail: `No gas point in the model: whether ${u.mark} is gas or electric, and its supply, are the professional's`, rule: R5 });
      const sockets = within(list, u, "socket");
      if (sockets.length) out.push({ check: "socket over the cooker", mark: u.mark, state: "flag", detail: `${sockets.length} socket(s) within the cooker space ${u.mark} (${span(u)})`, rule: `${NO_KIT_RULE}; ${R5} (electrical)` });
    }
    if (u.kind === "tall") {
      const sockets = within(list, u, "socket");
      if (sockets.length) out.push({ check: "socket behind a tall unit", mark: u.mark, state: "flag", detail: `${sockets.length} socket(s) would be hidden behind tall unit ${u.mark} (${span(u)})`, rule: `${NO_KIT_RULE}; ${R5} (electrical)` });
    }
  }
  // windows whose sill is below the worktop line (carcass on its legs)
  const top = s.base.height + s.plinth;
  for (const w of sills) {
    const under = units.filter((u) => u.wall === w.wall && u.layer === "base" && u.kind !== "gap" && u.offset < w.offset + w.width && u.offset + u.width > w.offset);
    if (under.length && w.sill < top)
      out.push({ check: "window sill", mark: under.map((u) => u.mark).join(", "), state: "flag",
        detail: `The window on ${w.wall} at ${w.offset}–${w.offset + w.width} has its sill at ${w.sill}, below the carcass top at ${top} (base ${s.base.height} + plinth ${s.plinth}) before the worktop`, rule: NO_KIT_RULE });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Shop drawings: one front elevation per unit, laid out on the kit's A3 sheets

export interface SheetRow { number: string; name: string; scale: number; placed: string }

/** A sheet in FMC_Sheet_Register.csv (Role,Discipline,SheetNumber,SheetName,Series,Scale,Core,IssueSet,Placed). */
export function registerSheet(rows: string[][], number: string): SheetRow | null {
  const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const c = (k: string) => head.indexOf(k);
  for (const r of rows.slice(1)) {
    if ((r[c("sheetnumber")] ?? "").trim() !== number) continue;
    const m = /^1\s*:\s*(\d+)$/.exec((r[c("scale")] ?? "").trim());
    return { number, name: (r[c("sheetname")] ?? "").trim(), scale: m ? Number(m[1]) : 0, placed: (r[c("placed")] ?? "").trim() };
  }
  return null;
}

/** The register's sheet that holds this schedule or view template (its Placed column). */
export function registerSheetFor(rows: string[][], placed: string): SheetRow | null {
  const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const cP = head.indexOf("placed"), cN = head.indexOf("sheetnumber");
  const row = rows.slice(1).find((r) => (r[cP] ?? "").split(";").map((x) => x.trim()).includes(placed));
  return row ? registerSheet(rows, (row[cN] ?? "").trim()) : null;
}

export interface SheetFrame { title_block: { family: string; type: string }; origin: [number, number]; area: [number, number] }

/**
 * The A3 drawing area from the sheets rulebook: SHT-011 (FMC_TitleBlock, type A3), SHT-013 (margins), SHT-014 (the A1
 * drawing area) and SHT-017's a3_scale (A3 is the half-size set). Null with the reason when the rulebook lacks one.
 */
export function a3Frame(rulebook: unknown): { frame: SheetFrame | null; problem: string } {
  const rules = (rulebook && typeof rulebook === "object" ? (rulebook as Record<string, unknown>).rules : null) as Array<Record<string, any>> | null;
  const p = (id: string) => rules?.find((r) => r.id === id)?.check?.params as Record<string, any> | undefined;
  const tb = p("SHT-011"), margin = p("SHT-013"), area = p("SHT-014"), text = p("SHT-017");
  const family = typeof tb?.family === "string" ? tb.family : "";
  const types: string[] = Array.isArray(tb?.types) ? tb.types : [];
  if (!family || !types.includes("A3")) return { frame: null, problem: "The sheets rulebook (SHT-011) names no A3 title block type" };
  const a = area?.drawing_area_mm, k = text?.a3_scale;
  if (!Array.isArray(a) || a.length !== 2 || typeof k !== "number" || typeof margin?.margin_left_mm !== "number" || typeof margin?.margin_other_mm !== "number")
    return { frame: null, problem: "The sheets rulebook lacks the drawing area (SHT-014), the margins (SHT-013) or the A3 scale (SHT-017)" };
  return { frame: { title_block: { family, type: "A3" }, origin: [margin.margin_left_mm * k, margin.margin_other_mm * k], area: [a[0] * k, a[1] * k] }, problem: "" };
}

export interface ShopView { mark: string; sheet: string; centre: [number, number]; size: [number, number] }

/** Model size of a unit's front elevation with its margin, mm: width × height (base and tall units on their legs). */
export function elevationSize(u: Unit, s: Standards, margin: number): [number, number] {
  const box = u.kind === "wall" ? s.wall : u.kind === "tall" ? s.tall : s.base;
  const h = box.height + (u.kind === "wall" ? 0 : s.plinth);
  return [u.width + 2 * margin, h + 2 * margin];
}

/**
 * Rows of elevations, left to right and top down, on as many of the given sheets as they need; what doesn't fit on the
 * last sheet is named. Centres are mm on the sheet from its lower-left corner.
 */
export function shopLayout(units: Unit[], s: Standards, scale: number, frame: SheetFrame, sheets: string[], margin: number, gap = 8): { views: ShopView[]; overflow: string[] } {
  const views: ShopView[] = [];
  const overflow: string[] = [];
  const [ox, oy] = frame.origin, [aw, ah] = frame.area;
  let si = 0, x = 0, rowTop = 0, rowH = 0;
  for (const u of units.filter((x) => x.kind !== "gap")) {
    const [mw, mh] = elevationSize(u, s, margin);
    const w = mw / scale, h = mh / scale;
    if (w > aw || h > ah) { overflow.push(`${u.mark} (${Math.round(w)} × ${Math.round(h)} mm at 1:${scale})`); continue; }
    if (x > 0 && x + w > aw) { x = 0; rowTop += rowH + gap; rowH = 0; }
    if (rowTop + h > ah) { si++; x = 0; rowTop = 0; rowH = 0; }
    if (si >= sheets.length) { overflow.push(u.mark); continue; }
    views.push({ mark: u.mark, sheet: sheets[si], centre: [Math.round((ox + x + w / 2) * 10) / 10, Math.round((oy + ah - rowTop - h / 2) * 10) / 10], size: [Math.round(w * 10) / 10, Math.round(h * 10) / 10] });
    x += w + gap;
    rowH = Math.max(rowH, h);
  }
  return { views, overflow };
}
