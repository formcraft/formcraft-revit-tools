/**
 * Clear headroom under beams, ducts, pipes and soffits.
 * The number is headroom.min_clear_mm. A missing key is the provisional 2100 mm and cannot PASS.
 * Geometry is boxes and optional rays. This module does not start a transaction.
 */
import fs from "node:fs";
import path from "node:path";

export const HEADROOM_KEY = "headroom.min_clear_mm";
export const PROVISIONAL_HEADROOM_MM = 2100;
export const HEADROOM_BANK_SHAPE = {
  value: 2100,
  unit: "mm",
  status: "provisional",
  clause: "",
  note: "Minimum clear headroom over stairs, corridors and rooms, measured to the underside of a beam, duct, pipe or soffit.",
};

const TALL_CROSSING_MM = 1500;
const ABOVE_FLOOR_MM = 50;

export interface Xy {
  x: number;
  y: number;
  z: number;
}

export interface HeadroomSample extends Xy {
  clear_mm?: number | null;
  obstacle_id?: string;
  obstacle_kind?: string;
}

export interface HeadroomZone {
  id: string;
  kind: "stair" | "corridor" | "room" | string;
  name?: string;
  level?: string;
  source?: string;
  link?: string;
  floor_z_mm: number;
  min: number[];
  max: number[];
  samples?: HeadroomSample[];
}

export interface HeadroomObstacle {
  id: string;
  kind: string;
  name?: string;
  source?: string;
  link?: string;
  min: number[];
  max: number[];
}

export interface HeadroomHit {
  zone_id: string;
  zone_kind: string;
  zone_name: string;
  level: string;
  zone_source: string;
  obstacle_id: string;
  obstacle_kind: string;
  obstacle_source: string;
  link: string;
  clear_mm: number;
  location_mm: Xy;
  method: "ray" | "bbox";
}

export interface CitedClear {
  key: string;
  value: number;
  source: "standards" | "provisional" | "call" | "unknown";
  bank_source: "standards" | "provisional" | "unknown";
  clause: string;
  can_pass: boolean;
}

interface BankEntry {
  value: unknown;
  status?: string;
  clause?: string;
  note?: string;
}

function bag(standards: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!standards) return {};
  const inner = standards.standards;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Record<string, unknown>;
  return standards;
}

function asEntry(raw: unknown): BankEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as BankEntry;
}

function clauseOf(entry: BankEntry | null): string {
  return (entry?.clause || entry?.note || "").trim();
}

/** draft or approved with a clause can pass. provisional, a missing key, and a null value cannot. */
export function citeHeadroom(standards: Record<string, unknown> | null | undefined, callMm?: number): CitedClear {
  const source = bag(standards);
  const entry = asEntry(source[HEADROOM_KEY]);
  const fallback: CitedClear = {
    key: HEADROOM_KEY,
    value: PROVISIONAL_HEADROOM_MM,
    source: "provisional",
    bank_source: "unknown",
    clause: "PROVISIONAL default 2100 mm. Not in the standards bank. A provisional clearance cannot PASS.",
    can_pass: false,
  };
  let cited = fallback;
  if (!entry) cited = fallback;
  else if (entry.value == null || entry.value === "") {
    cited = { ...fallback, bank_source: "provisional", clause: "Bank value is null. PROVISIONAL default 2100 mm used. It cannot PASS." };
  } else {
    const value = typeof entry.value === "number" ? entry.value : Number(entry.value);
    const status = (entry.status ?? "").trim().toLowerCase();
    const clause = clauseOf(entry);
    if (!Number.isFinite(value)) cited = fallback;
    else if (status === "provisional" || !clause || (status !== "draft" && status !== "approved" && status !== "")) {
      cited = {
        key: HEADROOM_KEY, value, source: "provisional", bank_source: "provisional",
        clause: clause || "PROVISIONAL. The bank entry has no clause, so it cannot PASS.", can_pass: false,
      };
    } else if (status === "" && clause) {
      cited = { key: HEADROOM_KEY, value, source: "standards", bank_source: "standards", clause, can_pass: true };
    } else if ((status === "draft" || status === "approved") && clause) {
      cited = { key: HEADROOM_KEY, value, source: "standards", bank_source: "standards", clause, can_pass: true };
    } else {
      cited = {
        key: HEADROOM_KEY, value, source: "provisional", bank_source: "provisional",
        clause: clause || "PROVISIONAL bank entry. It cannot PASS.", can_pass: false,
      };
    }
  }
  if (typeof callMm === "number" && Number.isFinite(callMm)) {
    return { ...cited, value: callMm, source: cited.bank_source === "standards" ? "call" : cited.source };
  }
  return cited;
}

export function verdict(hitCount: number, cited: CitedClear): "PASS" | "FAIL" | "PROVISIONAL" {
  if (!cited.can_pass) return "PROVISIONAL";
  return hitCount > 0 ? "FAIL" : "PASS";
}

function num(value: unknown, index: number): number | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const n = value[index];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function overlap(a: HeadroomZone, b: HeadroomObstacle): boolean {
  const ax0 = num(a.min, 0), ay0 = num(a.min, 1), ax1 = num(a.max, 0), ay1 = num(a.max, 1);
  const bx0 = num(b.min, 0), by0 = num(b.min, 1), bx1 = num(b.max, 0), by1 = num(b.max, 1);
  if (ax0 == null || ay0 == null || ax1 == null || ay1 == null || bx0 == null || by0 == null || bx1 == null || by1 == null) return false;
  return ax0 <= bx1 + 1 && ax1 >= bx0 - 1 && ay0 <= by1 + 1 && ay1 >= by0 - 1;
}

/** Underside above the walking surface. A tall element that crosses the floor is a riser and is ignored. */
export function bboxClearMm(zone: HeadroomZone, obstacle: HeadroomObstacle): number | null {
  if (!overlap(zone, obstacle)) return null;
  const underside = num(obstacle.min, 2);
  const top = num(obstacle.max, 2);
  if (underside == null || top == null) return null;
  if (underside < zone.floor_z_mm + ABOVE_FLOOR_MM) {
    if (top - underside > TALL_CROSSING_MM) return null;
    return null;
  }
  return Math.round(underside - zone.floor_z_mm);
}

function centre(zone: HeadroomZone, obstacle: HeadroomObstacle, z: number): Xy {
  const ax0 = num(zone.min, 0) ?? 0, ay0 = num(zone.min, 1) ?? 0, ax1 = num(zone.max, 0) ?? 0, ay1 = num(zone.max, 1) ?? 0;
  const bx0 = num(obstacle.min, 0) ?? 0, by0 = num(obstacle.min, 1) ?? 0, bx1 = num(obstacle.max, 0) ?? 0, by1 = num(obstacle.max, 1) ?? 0;
  return {
    x: Math.round((Math.max(ax0, bx0) + Math.min(ax1, bx1)) / 2),
    y: Math.round((Math.max(ay0, by0) + Math.min(ay1, by1)) / 2),
    z: Math.round(z),
  };
}

function wanted(value: string | undefined, allow: string[]): boolean {
  const source = (value || "host").toLowerCase();
  return allow.includes(source);
}

export function headroomHits(zones: HeadroomZone[], obstacles: HeadroomObstacle[], minClear: number, sources: string[]): HeadroomHit[] {
  const allow = sources.length ? sources.map((item) => item.toLowerCase()) : ["host", "link"];
  const hits: HeadroomHit[] = [];
  for (const zone of zones) {
    if (!wanted(zone.source, allow)) continue;
    const rays = (zone.samples ?? []).filter((sample) => typeof sample.clear_mm === "number" && Number.isFinite(sample.clear_mm as number));
    if (rays.length) {
      for (const sample of rays) {
        const clear = Math.round(sample.clear_mm as number);
        if (clear >= minClear) continue;
        hits.push({
          zone_id: String(zone.id),
          zone_kind: String(zone.kind || "room"),
          zone_name: zone.name ?? "",
          level: zone.level ?? "",
          zone_source: zone.source || "host",
          obstacle_id: sample.obstacle_id ?? "",
          obstacle_kind: sample.obstacle_kind ?? "",
          obstacle_source: zone.source || "host",
          link: zone.link ?? "",
          clear_mm: clear,
          location_mm: { x: Math.round(sample.x), y: Math.round(sample.y), z: Math.round(sample.z + clear) },
          method: "ray",
        });
      }
      continue;
    }
    for (const obstacle of obstacles) {
      if (!wanted(obstacle.source, allow)) continue;
      const clear = bboxClearMm(zone, obstacle);
      if (clear == null || clear >= minClear) continue;
      hits.push({
        zone_id: String(zone.id),
        zone_kind: String(zone.kind || "room"),
        zone_name: zone.name ?? "",
        level: zone.level ?? "",
        zone_source: zone.source || "host",
        obstacle_id: String(obstacle.id),
        obstacle_kind: obstacle.kind,
        obstacle_source: obstacle.source || "host",
        link: obstacle.link || zone.link || "",
        clear_mm: clear,
        location_mm: centre(zone, obstacle, num(obstacle.min, 2) ?? zone.floor_z_mm + clear),
        method: "bbox",
      });
    }
  }
  hits.sort((a, b) => a.clear_mm - b.clear_mm || a.zone_id.localeCompare(b.zone_id));
  return hits;
}

export function filterLevels(zones: HeadroomZone[], levels: string[]): HeadroomZone[] {
  if (!levels.length) return zones;
  const want = new Set(levels.map((item) => item.trim().toLowerCase()).filter(Boolean));
  return zones.filter((zone) => want.has((zone.level ?? "").trim().toLowerCase()) || want.has(String(zone.id).toLowerCase()));
}

export function headroomDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_HEADROOM_DIR ?? "").trim()) return env.FMC_HEADROOM_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(path.sep, "tmp", "FormcraftLocal");
  return path.join(local, "Formcraft", "headroom");
}

export function writeHeadroomReport(env: NodeJS.ProcessEnv, body: unknown, dir = headroomDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `headroom-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}
