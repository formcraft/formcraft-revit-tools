/**
 * Envelope energy facts for fmc_energy: area-weighted U-values, fabric heat loss (UA), window-to-wall ratio by
 * orientation, and U-value, SHGC and WWR checks against limits from the call or the standards bank. No Revit
 * dependency, unit tested in energy.test.ts. Thermal values are never guessed: a type without a U-value is listed as
 * unknown and is left out of the averages, and a check without a limit is NO_LIMIT, not PASS.
 */

export type EnvelopeKind = "wall" | "curtain_wall" | "roof" | "floor" | "window" | "skylight" | "door";
export type EnvelopeClass = "wall" | "roof" | "floor" | "glazing" | "door";
export type Sector = "N" | "E" | "S" | "W" | "H";

export interface EnergyFact {
  id: string;
  kind: EnvelopeKind;
  type_id?: string;
  type_name?: string;
  category?: string;
  area_m2?: number | null;
  u_value?: number | null;
  r_value?: number | null;
  shgc?: number | null;
  vlt?: number | null;
  u_source?: string;
  /** Outward normal in project coordinates (x east, y project north). */
  normal?: number[] | null;
  host_id?: string;
  host_kind?: string;
  level?: string;
  level_elevation_mm?: number | null;
  layers_without_thermal?: number;
}

export interface CitedLimit {
  key: string;
  value: number | null;
  source: "call" | "standards" | "provisional" | "none";
  clause: string;
  can_pass: boolean;
}

export const LIMIT_KEYS = {
  wall: "energy.max_u_wall_w_m2k",
  roof: "energy.max_u_roof_w_m2k",
  floor: "energy.max_u_floor_w_m2k",
  glazing: "energy.max_u_window_w_m2k",
  door: "energy.max_u_door_w_m2k",
  shgc: "energy.max_shgc",
  wwr: "energy.max_wwr",
} as const;

export const TYPE_COLUMNS = ["Class", "Type", "Type id", "Elements", "Area m2", "U W/m2K", "R m2K/W", "SHGC", "U x A W/K", "Limit U", "Status"];

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function classOf(kind: EnvelopeKind): EnvelopeClass {
  if (kind === "curtain_wall" || kind === "window" || kind === "skylight") return "glazing";
  if (kind === "door") return "door";
  return kind;
}

/** A U-value is known when it is a positive finite number; else R > 0 gives 1/R. 0 or blank is unknown. */
export function knownU(f: Pick<EnergyFact, "u_value" | "r_value">): number | null {
  const u = num(f.u_value);
  if (u != null && u > 0) return u;
  const r = num(f.r_value);
  if (r != null && r > 0) return 1 / r;
  return null;
}

/**
 * Compass bearing (degrees clockwise from true north) of a horizontal direction in project coordinates.
 * angleRad is ProjectPosition.Angle: project to shared coordinates is a rotation by angleRad about Z.
 * A normal that is mostly vertical has no bearing (null).
 */
export function bearingDeg(normal: number[] | null | undefined, angleRad = 0): number | null {
  if (!Array.isArray(normal) || normal.length < 2) return null;
  const [x, y] = normal.map(Number);
  const z = Number(normal[2] ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const h = Math.hypot(x, y);
  if (h < 1e-6 || Math.abs(z) > h) return null;
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  const tx = x * c - y * s;
  const ty = x * s + y * c;
  const deg = (Math.atan2(tx, ty) * 180) / Math.PI;
  return r2(((deg % 360) + 360) % 360);
}

export function sectorOf(bearing: number | null): Sector {
  if (bearing == null) return "H";
  const b = ((bearing % 360) + 360) % 360;
  if (b >= 315 || b < 45) return "N";
  if (b < 135) return "E";
  if (b < 225) return "S";
  return "W";
}

/** Floors on the lowest level that has floors (ground floors), unless scope is "all". */
export function envelopeFacts(facts: EnergyFact[], floorScope: "lowest" | "all" = "lowest"): { kept: EnergyFact[]; floors_dropped: number } {
  const floors = facts.filter((f) => f.kind === "floor");
  if (floorScope === "all" || floors.length === 0) return { kept: facts, floors_dropped: 0 };
  const elevations = floors.map((f) => num(f.level_elevation_mm)).filter((v): v is number => v != null);
  if (!elevations.length) return { kept: facts, floors_dropped: 0 };
  const lowest = Math.min(...elevations);
  const kept = facts.filter((f) => f.kind !== "floor" || num(f.level_elevation_mm) == null || Math.abs(Number(f.level_elevation_mm) - lowest) < 1);
  return { kept, floors_dropped: facts.length - kept.length };
}

export interface TypeRow {
  class: EnvelopeClass;
  type_id: string;
  type_name: string;
  elements: number;
  element_ids: string[];
  area_m2: number;
  unknown_area: number;
  u_value: number | null;
  r_value: number | null;
  shgc: number | null;
  ua_w_k: number | null;
  u_source: string;
  layers_without_thermal: number;
}

export function typeRows(facts: EnergyFact[]): TypeRow[] {
  const map = new Map<string, TypeRow>();
  for (const f of facts) {
    const cls = classOf(f.kind);
    const key = `${cls}|${f.type_id ?? ""}|${f.type_name ?? ""}`;
    let row = map.get(key);
    if (!row) {
      const u = knownU(f);
      row = {
        class: cls, type_id: String(f.type_id ?? ""), type_name: String(f.type_name ?? ""), elements: 0, element_ids: [], area_m2: 0,
        unknown_area: 0, u_value: u == null ? null : r3(u), r_value: num(f.r_value), shgc: num(f.shgc), ua_w_k: null,
        u_source: u == null ? "unknown" : String(f.u_source || "type"), layers_without_thermal: Number(f.layers_without_thermal ?? 0) || 0,
      };
      map.set(key, row);
    }
    row.elements++;
    if (row.element_ids.length < 50) row.element_ids.push(String(f.id));
    const a = num(f.area_m2);
    if (a != null && a > 0) row.area_m2 += a; else row.unknown_area++;
  }
  const order: EnvelopeClass[] = ["wall", "glazing", "door", "roof", "floor"];
  return [...map.values()]
    .map((r) => ({ ...r, area_m2: r2(r.area_m2), ua_w_k: r.u_value == null ? null : r2(r.u_value * r.area_m2) }))
    .sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class) || b.area_m2 - a.area_m2 || a.type_name.localeCompare(b.type_name));
}

export interface ClassSummary {
  class: EnvelopeClass;
  area_m2: number;
  area_known_u_m2: number;
  area_unknown_u_m2: number;
  mean_u_w_m2k: number | null;
  ua_w_k: number;
}

/** Area-weighted mean U per class over the area with a known U. UA sums only known U. */
export function classSummary(rows: TypeRow[]): { classes: ClassSummary[]; ua_total_w_k: number; area_total_m2: number; area_unknown_u_m2: number } {
  const classes: ClassSummary[] = [];
  for (const cls of ["wall", "glazing", "door", "roof", "floor"] as EnvelopeClass[]) {
    const mine = rows.filter((r) => r.class === cls);
    if (!mine.length) continue;
    const area = mine.reduce((s, r) => s + r.area_m2, 0);
    const known = mine.filter((r) => r.u_value != null);
    const knownArea = known.reduce((s, r) => s + r.area_m2, 0);
    const ua = known.reduce((s, r) => s + (r.ua_w_k ?? 0), 0);
    classes.push({
      class: cls, area_m2: r2(area), area_known_u_m2: r2(knownArea), area_unknown_u_m2: r2(area - knownArea),
      mean_u_w_m2k: knownArea > 0 ? r3(ua / knownArea) : null, ua_w_k: r2(ua),
    });
  }
  return {
    classes,
    ua_total_w_k: r2(classes.reduce((s, c) => s + c.ua_w_k, 0)),
    area_total_m2: r2(classes.reduce((s, c) => s + c.area_m2, 0)),
    area_unknown_u_m2: r2(classes.reduce((s, c) => s + c.area_unknown_u_m2, 0)),
  };
}

export interface SectorRatio { sector: Sector; wall_m2: number; glazing_m2: number; door_m2: number; wwr: number | null }

/**
 * Window-to-wall ratio by orientation: glazing / (opaque wall + glazing + doors) on vertical faces.
 * Wall areas are Revit's net areas (openings cut), so the gross facade is net wall + inserts.
 * Skylights and roofs are not in the ratio. Windows in curtain walls are not added again.
 */
export function wwrBySector(facts: EnergyFact[], angleRad = 0): { sectors: SectorRatio[]; overall: SectorRatio; no_orientation: number } {
  const acc = new Map<Sector, SectorRatio>();
  let noOrientation = 0;
  const get = (s: Sector) => {
    let v = acc.get(s);
    if (!v) { v = { sector: s, wall_m2: 0, glazing_m2: 0, door_m2: 0, wwr: null }; acc.set(s, v); }
    return v;
  };
  for (const f of facts) {
    if (f.kind === "roof" || f.kind === "floor" || f.kind === "skylight") continue;
    if ((f.kind === "window" || f.kind === "door") && f.host_kind === "curtain_wall") continue;
    const a = num(f.area_m2);
    if (a == null || a <= 0) continue;
    const s = sectorOf(bearingDeg(f.normal, angleRad));
    if (s === "H") { noOrientation++; continue; }
    const v = get(s);
    if (f.kind === "wall") v.wall_m2 += a;
    else if (f.kind === "door") v.door_m2 += a;
    else v.glazing_m2 += a;
  }
  const ratio = (v: SectorRatio): SectorRatio => {
    const gross = v.wall_m2 + v.glazing_m2 + v.door_m2;
    return { sector: v.sector, wall_m2: r2(v.wall_m2), glazing_m2: r2(v.glazing_m2), door_m2: r2(v.door_m2), wwr: gross > 0 ? r3(v.glazing_m2 / gross) : null };
  };
  const sectors = (["N", "E", "S", "W"] as Sector[]).filter((s) => acc.has(s)).map((s) => ratio(acc.get(s)!));
  const total = [...acc.values()].reduce((t, v) => ({ ...t, wall_m2: t.wall_m2 + v.wall_m2, glazing_m2: t.glazing_m2 + v.glazing_m2, door_m2: t.door_m2 + v.door_m2 }),
    { sector: "H" as Sector, wall_m2: 0, glazing_m2: 0, door_m2: 0, wwr: null as number | null });
  return { sectors, overall: ratio(total), no_orientation: noOrientation };
}

export interface EnergyFailure {
  check: "u_value" | "shgc" | "wwr" | "unknown_u";
  code: "U_ABOVE_MAX" | "SHGC_ABOVE_MAX" | "WWR_ABOVE_MAX" | "U_UNKNOWN";
  class?: EnvelopeClass;
  type_id?: string;
  type_name?: string;
  sector?: Sector | "overall";
  element_ids?: string[];
  value: number | null;
  required: number | null;
  area_m2?: number;
  message: string;
}

/** checked counts items with a known value. UNKNOWN: the class is there but no value is known. NOT_APPLICABLE is set by the caller when the class is absent. */
export type Verdict = "PASS" | "FAIL" | "PROVISIONAL" | "NO_LIMIT" | "UNKNOWN" | "NOT_APPLICABLE";

export function verdictOf(failures: number, checked: number, limit: CitedLimit): Verdict {
  if (failures > 0) return "FAIL";
  if (checked === 0) return "UNKNOWN";
  if (limit.value == null) return "NO_LIMIT";
  return limit.can_pass ? "PASS" : "PROVISIONAL";
}

/** U-value of each type against the limit for its class. Unknown U is a separate U_UNKNOWN finding, never a PASS. */
export function uChecks(rows: TypeRow[], limits: Record<EnvelopeClass, CitedLimit>) {
  const failures: EnergyFailure[] = [];
  const unknown: EnergyFailure[] = [];
  const checked: Record<EnvelopeClass, number> = { wall: 0, roof: 0, floor: 0, glazing: 0, door: 0 };
  const failed: Record<EnvelopeClass, number> = { wall: 0, roof: 0, floor: 0, glazing: 0, door: 0 };
  for (const r of rows) {
    if (r.u_value == null) {
      unknown.push({
        check: "unknown_u", code: "U_UNKNOWN", class: r.class, type_id: r.type_id, type_name: r.type_name, element_ids: r.element_ids,
        value: null, required: limits[r.class].value, area_m2: r.area_m2,
        message: `${r.type_name || r.type_id} has no U-value in the model (no thermal properties${r.layers_without_thermal ? `, ${r.layers_without_thermal} layers without a thermal asset` : ""}). Not guessed.`,
      });
      continue;
    }
    const limit = limits[r.class];
    checked[r.class]++;
    if (limit.value == null) continue;
    if (r.u_value > limit.value + 1e-9) {
      failed[r.class]++;
      failures.push({
        check: "u_value", code: "U_ABOVE_MAX", class: r.class, type_id: r.type_id, type_name: r.type_name, element_ids: r.element_ids,
        value: r.u_value, required: limit.value, area_m2: r.area_m2,
        message: `${r.type_name} U ${r.u_value} W/m2K is above ${limit.value} (${limit.key}).`,
      });
    }
  }
  return { failures, unknown, checked, failed };
}

export function shgcChecks(rows: TypeRow[], limit: CitedLimit) {
  const failures: EnergyFailure[] = [];
  let checked = 0, unknown = 0;
  for (const r of rows) {
    if (r.class !== "glazing") continue;
    if (r.shgc == null || !(r.shgc > 0)) { unknown++; continue; }
    checked++;
    if (limit.value == null) continue;
    if (r.shgc > limit.value + 1e-9) {
      failures.push({
        check: "shgc", code: "SHGC_ABOVE_MAX", class: "glazing", type_id: r.type_id, type_name: r.type_name, element_ids: r.element_ids,
        value: r.shgc, required: limit.value, area_m2: r.area_m2, message: `${r.type_name} SHGC ${r.shgc} is above ${limit.value} (${limit.key}).`,
      });
    }
  }
  return { failures, checked, unknown };
}

export function wwrChecks(ratios: { sectors: SectorRatio[]; overall: SectorRatio }, limit: CitedLimit, perSector: boolean) {
  const failures: EnergyFailure[] = [];
  let checked = 0;
  const list: Array<SectorRatio & { label: Sector | "overall" }> = [{ ...ratios.overall, label: "overall" }];
  if (perSector) for (const s of ratios.sectors) list.push({ ...s, label: s.sector });
  for (const v of list) {
    if (v.wwr == null) continue;
    checked++;
    if (limit.value == null) continue;
    if (v.wwr > limit.value + 1e-9) {
      failures.push({
        check: "wwr", code: "WWR_ABOVE_MAX", sector: v.label, value: v.wwr, required: limit.value,
        message: `Window-to-wall ratio ${v.label} ${v.wwr} is above ${limit.value} (${limit.key}).`,
      });
    }
  }
  return { failures, checked };
}

/** call > standards entry with a clause (draft, approved or no status) > none. A bank value without a clause cannot PASS. No fallback values. */
export function citeLimit(standards: Record<string, unknown> | null | undefined, key: string, callValue: number | undefined): CitedLimit {
  if (typeof callValue === "number" && Number.isFinite(callValue)) return { key, value: callValue, source: "call", clause: "Given in the call.", can_pass: true };
  const bag = standards && typeof standards.standards === "object" && standards.standards && !Array.isArray(standards.standards)
    ? standards.standards as Record<string, unknown>
    : (standards ?? {});
  const entry = bag[key] as { value?: unknown; status?: string; clause?: string } | undefined;
  if (entry && typeof entry === "object" && entry.value != null && entry.value !== "") {
    const value = Number(entry.value);
    const status = String(entry.status ?? "").trim().toLowerCase();
    const clause = String(entry.clause || "").trim();
    if (Number.isFinite(value) && clause && (status === "" || status === "draft" || status === "approved")) return { key, value, source: "standards", clause, can_pass: true };
    if (Number.isFinite(value)) return { key, value, source: "provisional", clause: clause || "PROVISIONAL bank entry without a clause. It cannot PASS.", can_pass: false };
  }
  return { key, value: null, source: "none", clause: "Not in the call or the standards bank. Not checked.", can_pass: false };
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function typesCsv(rows: TypeRow[], limits: Record<EnvelopeClass, CitedLimit>): string {
  const lines = [TYPE_COLUMNS.join(",")];
  for (const r of rows) {
    const limit = limits[r.class].value;
    const status = r.u_value == null ? "U unknown" : limit == null ? "No limit" : r.u_value > limit + 1e-9 ? "FAIL" : limits[r.class].can_pass ? "PASS" : "PROVISIONAL";
    lines.push([r.class, r.type_name, r.type_id, r.elements, r.area_m2, r.u_value, r.r_value, r.shgc, r.ua_w_k, limit, status].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
