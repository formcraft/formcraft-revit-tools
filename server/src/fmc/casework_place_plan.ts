/** Casework in the model: the kit's family and the placement plan. Part of casework_place.ts. */
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
