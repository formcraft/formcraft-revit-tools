/**
 * fmc_survey: a toposolid from a survey CSV. Parsing, unit and coordinate conversion (shared to internal with the
 * fmc_coord matrix), duplicate checks, a Delaunay TIN in plan, and cut and fill against a flat design level.
 * Pure functions: no Revit and no file system except reading the CSV and the report.
 */
import fs from "node:fs";
import path from "node:path";
import { UNIT_TO_MM, roundTo, sharedToInternalMm, siteReportDir, sniffSeparator, splitCsvLine, writeSiteReport } from "./sitecommon.js";

export const SURVEY_MAX_POINTS = 10000;

export const SURVEY_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_survey needs document, a title or a full path. The active document is not a guess.",
  "FMC-BATCH-LOCKED": "A write needs batch_lease from fmc_batch request.",
  "FMC-SURVEY-REFERENCES": "A write needs references.kit, references.standards and references.rulebook.",
  "FMC-SURVEY-CSV": "Pass csv (a file) or csv_text. Columns: a header with easting/x, northing/y and elevation/z (point and code optional), or set format for a file with no header.",
  "FMC-SURVEY-VALUE": "A survey row has a coordinate that is not a number.",
  "FMC-SURVEY-FEW": "A toposolid needs at least 3 distinct points that are not all on one line.",
  "FMC-SURVEY-TOO-MANY": `More than ${SURVEY_MAX_POINTS} points. Thin the survey first.`,
  "FMC-SURVEY-TYPE": "toposolid_type is not a toposolid type in the document.",
  "FMC-SURVEY-LEVEL": "level is not a level in the document.",
  "FMC-SURVEY-NO-TYPE": "The document has no toposolid type.",
  "FMC-SURVEY-READBACK": "The toposolid's height range after the write differs from the survey by more than 5 mm. Check whether Revit placed the points relative to the level.",
};

export type SurveyFormat = "auto" | "PENZ" | "PNEZ" | "ENZ" | "NEZ" | "XYZ";

export interface SurveyPoint { id: string; e: number; n: number; z: number; code?: string; line: number }

export interface SurveyParse { points: SurveyPoint[]; format: string; skipped: Array<{ line: number; reason: string }> }

const HEADER = {
  id: ["point", "pt", "id", "name", "pointid", "point_id", "pnt", "p"],
  e: ["easting", "east", "e", "x", "x_mm", "eastings"],
  n: ["northing", "north", "n", "y", "y_mm", "northings"],
  z: ["elevation", "elev", "z", "rl", "height", "h", "level", "z_mm"],
  code: ["code", "desc", "description", "d", "feature"],
};

const ORDERS: Record<Exclude<SurveyFormat, "auto">, string[]> = {
  PENZ: ["id", "e", "n", "z", "code"],
  PNEZ: ["id", "n", "e", "z", "code"],
  ENZ: ["e", "n", "z", "code"],
  NEZ: ["n", "e", "z", "code"],
  XYZ: ["e", "n", "z", "code"],
};

/** Reads a survey CSV. A header names the columns; with no header, format gives the order (auto guesses PENZ when the first cell is not a number). */
export function parseSurveyCsv(text: string, format: SurveyFormat = "auto"): SurveyParse {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim() && !line.trim().startsWith("#"));
  if (firstIndex < 0) throw new Error(`[FMC-SURVEY-CSV] ${SURVEY_FIX["FMC-SURVEY-CSV"]}`);
  const sep = sniffSeparator(lines[firstIndex]);
  const first = splitCsvLine(lines[firstIndex], sep);
  const lower = first.map((cell) => cell.toLowerCase().replace(/\s+/g, ""));
  const looksHeader = first.some((cell) => cell && !Number.isFinite(Number(cell))) && lower.some((cell) => HEADER.e.includes(cell) || HEADER.n.includes(cell));
  let cols: Record<string, number>;
  let used: string;
  let start = firstIndex;
  if (looksHeader) {
    const find = (names: string[]) => lower.findIndex((cell) => names.includes(cell));
    cols = { id: find(HEADER.id), e: find(HEADER.e), n: find(HEADER.n), z: find(HEADER.z), code: find(HEADER.code) };
    if (cols.e < 0 || cols.n < 0 || cols.z < 0) throw new Error(`[FMC-SURVEY-CSV] ${SURVEY_FIX["FMC-SURVEY-CSV"]}`);
    used = "header";
    start = firstIndex + 1;
  } else {
    if (first.slice(1, 4).some((cell) => cell && !Number.isFinite(Number(cell)))) throw new Error(`[FMC-SURVEY-CSV] The first row is not a header this tool knows and not numbers. ${SURVEY_FIX["FMC-SURVEY-CSV"]}`);
    let order: Exclude<SurveyFormat, "auto">;
    if (format !== "auto") order = format;
    else order = first.length >= 4 ? "PENZ" : "ENZ";
    cols = { id: -1, e: -1, n: -1, z: -1, code: -1 };
    ORDERS[order].forEach((key, i) => { cols[key] = i; });
    used = order;
  }
  const points: SurveyPoint[] = [];
  const skipped: Array<{ line: number; reason: string }> = [];
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const cells = splitCsvLine(raw, sep);
    const num = (key: string) => (cols[key] >= 0 ? Number(cells[cols[key]]) : NaN);
    const e = num("e");
    const n = num("n");
    const z = num("z");
    if (![e, n, z].every(Number.isFinite)) {
      skipped.push({ line: i + 1, reason: SURVEY_FIX["FMC-SURVEY-VALUE"] });
      continue;
    }
    const id = cols.id >= 0 ? (cells[cols.id] ?? "") : String(points.length + 1);
    const code = cols.code >= 0 ? (cells[cols.code] ?? "") : "";
    points.push({ id: id || String(points.length + 1), e, n, z, ...(code ? { code } : {}), line: i + 1 });
  }
  return { points, format: used, skipped };
}

export interface SurveyPlanArgs {
  units: string;
  coordinates: "internal" | "shared";
  duplicate_tol_mm: number;
  design_elevation?: number;
  codes?: string[];
}

export interface PlanPoint { id: string; xyz_mm: [number, number, number]; line: number }

export interface CutFill { design_internal_mm: number; cut_m3: number; fill_m3: number; net_m3: number; area_m2: number }

export interface SurveyPlan {
  points: PlanPoint[];
  duplicates: Array<{ id: string; kept: string; line: number }>;
  conflicts: Array<{ id: string; kept: string; line: number; dz_mm: number }>;
  filtered_out: number;
  extent_mm: { min_x: number; min_y: number; min_z: number; max_x: number; max_y: number; max_z: number };
  triangles: number;
  plan_area_m2: number;
  cut_fill: CutFill | null;
}

/** Units to millimetres, shared to internal, duplicates in plan dropped (same XY within the tolerance), a TIN, and cut and fill. */
export function planSurvey(parsed: SurveyParse, args: SurveyPlanArgs, internalToShared?: number[][]): SurveyPlan {
  const k = UNIT_TO_MM[args.units];
  if (!Number.isFinite(k)) throw new Error(`[FMC-SURVEY-VALUE] units must be one of ${Object.keys(UNIT_TO_MM).join(", ")}.`);
  const codes = (args.codes ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  const kept = codes.length ? parsed.points.filter((p) => codes.includes(String(p.code ?? "").toLowerCase())) : parsed.points;
  if (kept.length > SURVEY_MAX_POINTS) throw new Error(`[FMC-SURVEY-TOO-MANY] ${SURVEY_FIX["FMC-SURVEY-TOO-MANY"]}`);
  let xyz = kept.map((p) => [p.e * k, p.n * k, p.z * k] as [number, number, number]);
  if (args.coordinates === "shared") xyz = sharedToInternalMm(xyz, internalToShared ?? []);
  const tol = Math.max(0, args.duplicate_tol_mm);
  const cell = Math.max(tol, 1);
  const grid = new Map<string, number[]>();
  const points: PlanPoint[] = [];
  const duplicates: SurveyPlan["duplicates"] = [];
  const conflicts: SurveyPlan["conflicts"] = [];
  xyz.forEach((p, i) => {
    const gx = Math.floor(p[0] / cell);
    const gy = Math.floor(p[1] / cell);
    let hit = -1;
    for (let dx = -1; dx <= 1 && hit < 0; dx++) {
      for (let dy = -1; dy <= 1 && hit < 0; dy++) {
        for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          const q = points[j].xyz_mm;
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol) { hit = j; break; }
        }
      }
    }
    if (hit >= 0) {
      const dz = Math.abs(points[hit].xyz_mm[2] - p[2]);
      const row = { id: kept[i].id, kept: points[hit].id, line: kept[i].line };
      if (dz > tol) conflicts.push({ ...row, dz_mm: roundTo(dz, 3) });
      else duplicates.push(row);
      return;
    }
    const key = `${gx},${gy}`;
    grid.set(key, [...(grid.get(key) ?? []), points.length]);
    points.push({ id: kept[i].id, xyz_mm: [roundTo(p[0], 3), roundTo(p[1], 3), roundTo(p[2], 3)], line: kept[i].line });
  });
  if (points.length < 3) throw new Error(`[FMC-SURVEY-FEW] ${SURVEY_FIX["FMC-SURVEY-FEW"]}`);
  const tris = delaunay(points.map((p) => p.xyz_mm));
  if (!tris.length) throw new Error(`[FMC-SURVEY-FEW] ${SURVEY_FIX["FMC-SURVEY-FEW"]}`);
  const ext = { min_x: Infinity, min_y: Infinity, min_z: Infinity, max_x: -Infinity, max_y: -Infinity, max_z: -Infinity };
  for (const { xyz_mm: [x, y, z] } of points) {
    ext.min_x = Math.min(ext.min_x, x); ext.max_x = Math.max(ext.max_x, x);
    ext.min_y = Math.min(ext.min_y, y); ext.max_y = Math.max(ext.max_y, y);
    ext.min_z = Math.min(ext.min_z, z); ext.max_z = Math.max(ext.max_z, z);
  }
  let area = 0;
  for (const [a, b, c] of tris) area += triArea(points[a].xyz_mm, points[b].xyz_mm, points[c].xyz_mm);
  let cutFill: CutFill | null = null;
  if (args.design_elevation != null && Number.isFinite(args.design_elevation)) {
    let design = args.design_elevation * k;
    if (args.coordinates === "shared") design = sharedToInternalMm([[0, 0, design]], internalToShared ?? [])[0][2];
    let cut = 0;
    let fill = 0;
    for (const [a, b, c] of tris) {
      const v = cutFillOfTriangle(points[a].xyz_mm, points[b].xyz_mm, points[c].xyz_mm, design);
      cut += v.cut;
      fill += v.fill;
    }
    cutFill = {
      design_internal_mm: roundTo(design, 3),
      cut_m3: roundTo(cut / 1e9, 3),
      fill_m3: roundTo(fill / 1e9, 3),
      net_m3: roundTo((cut - fill) / 1e9, 3),
      area_m2: roundTo(area / 1e6, 3),
    };
  }
  return {
    points,
    duplicates,
    conflicts,
    filtered_out: parsed.points.length - kept.length,
    extent_mm: Object.fromEntries(Object.entries(ext).map(([key, v]) => [key, roundTo(v, 3)])) as SurveyPlan["extent_mm"],
    triangles: tris.length,
    plan_area_m2: roundTo(area / 1e6, 3),
    cut_fill: cutFill,
  };
}

type P3 = [number, number, number];

export function triArea(a: P3 | number[], b: P3 | number[], c: P3 | number[]): number {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

/** Polygon area in plan (shoelace). */
function polyArea(poly: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** Volume between a linear height field over a convex polygon and zero: area times the mean of the vertex heights, by fan. */
function polyVolume(poly: Array<[number, number, number]>): number {
  let v = 0;
  for (let i = 1; i + 1 < poly.length; i++) {
    const a = poly[0];
    const b = poly[i];
    const c = poly[i + 1];
    v += polyArea([[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]]) * (a[2] + b[2] + c[2]) / 3;
  }
  return v;
}

/** Clips a triangle (x, y, h) to h >= 0 (sign 1) or h <= 0 (sign -1). Exact for a plane. */
function clip(poly: Array<[number, number, number]>, sign: 1 | -1): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const pin = sign * p[2] >= 0;
    const qin = sign * q[2] >= 0;
    if (pin) out.push(p);
    if (pin !== qin) {
      const t = p[2] / (p[2] - q[2]);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), 0]);
    }
  }
  return out;
}

/** Cut (ground above the design level) and fill (below), mm³, for one TIN triangle. */
export function cutFillOfTriangle(a: number[], b: number[], c: number[], design: number): { cut: number; fill: number } {
  const tri: Array<[number, number, number]> = [[a[0], a[1], a[2] - design], [b[0], b[1], b[2] - design], [c[0], c[1], c[2] - design]];
  const up = clip(tri, 1);
  const down = clip(tri, -1);
  return { cut: up.length >= 3 ? polyVolume(up) : 0, fill: down.length >= 3 ? -polyVolume(down) : 0 };
}

/** Bowyer-Watson Delaunay triangulation in plan. Returns index triples. Collinear input gives no triangles. */
export function delaunay(pts: number[][]): Array<[number, number, number]> {
  const n = pts.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const d = Math.max(maxX - minX, maxY - minY, 1) * 20;
  // Shift to the centre for numerical stability with survey-sized coordinates.
  const xy: Array<[number, number]> = pts.map((p) => [p[0] - cx, p[1] - cy]);
  xy.push([-d, -d], [d, -d], [0, d]);
  type Tri = { a: number; b: number; c: number; x: number; y: number; r2: number };
  const make = (a: number, b: number, c: number): Tri | null => {
    const [ax, ay] = xy[a]; const [bx, by] = xy[b]; const [cx2, cy2] = xy[c];
    const den = 2 * (ax * (by - cy2) + bx * (cy2 - ay) + cx2 * (ay - by));
    if (Math.abs(den) < 1e-12) return null;
    const a2 = ax * ax + ay * ay; const b2 = bx * bx + by * by; const c2 = cx2 * cx2 + cy2 * cy2;
    const ux = (a2 * (by - cy2) + b2 * (cy2 - ay) + c2 * (ay - by)) / den;
    const uy = (a2 * (cx2 - bx) + b2 * (ax - cx2) + c2 * (bx - ax)) / den;
    return { a, b, c, x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris: Tri[] = [make(n, n + 1, n + 2)!];
  for (let i = 0; i < n; i++) {
    const [px, py] = xy[i];
    const bad: Tri[] = [];
    const good: Tri[] = [];
    for (const t of tris) ((px - t.x) ** 2 + (py - t.y) ** 2 <= t.r2 * (1 + 1e-12) ? bad : good).push(t);
    const edges = new Map<string, [number, number]>();
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as Array<[number, number]>) {
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [u, v]);
      }
    }
    tris = good;
    for (const [u, v] of edges.values()) {
      const t = make(u, v, i);
      if (t) tris.push(t);
    }
  }
  const out: Array<[number, number, number]> = [];
  for (const t of tris) {
    if (t.a >= n || t.b >= n || t.c >= n) continue;
    if (triArea(xy[t.a] as unknown as number[], xy[t.b] as unknown as number[], xy[t.c] as unknown as number[]) < 1e-9) continue;
    out.push([t.a, t.b, t.c]);
  }
  return out;
}

export function readSurveyFile(file: string, read: (f: string) => string = (f) => fs.readFileSync(f, "utf8")): string {
  try { return read(file); } catch (error) { throw new Error(`[FMC-SURVEY-CSV] ${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function surveyTag(file: string): string {
  const base = file ? path.win32.basename(file) : "inline";
  return `FMC_SURVEY ${base}`.slice(0, 120);
}

export function surveyDir(env: NodeJS.ProcessEnv = process.env): string {
  return siteReportDir(env, "FMC_SURVEY_DIR", "survey");
}

export function writeSurveyReport(env: NodeJS.ProcessEnv, body: unknown, dir = surveyDir(env)): string {
  return writeSiteReport(dir, "survey", body);
}
