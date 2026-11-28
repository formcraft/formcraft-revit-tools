/**
 * fmc_avf: Analysis Visualization Framework display. Point results (x, y, z, value) shown in one view through a
 * SpatialFieldManager, one result schema and one analysis display style. AVF results are transient: Revit does not
 * save them with the model. The display style and the view's style setting are model changes (fmc_avf_apply).
 * Pure functions: parsing, checks, statistics and the legend bands.
 */
import fs from "node:fs";
import { UNIT_TO_MM, roundTo, sharedToInternalMm, siteReportDir, sniffSeparator, splitCsvLine, writeSiteReport } from "./sitecommon.js";

export const AVF_MAX_POINTS = 20000;

export const AVF_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_avf needs document, a title or a full path. The active document is not a guess.",
  "FMC-BATCH-LOCKED": "A write needs batch_lease from fmc_batch request.",
  "FMC-AVF-REFERENCES": "A write needs references.kit, references.standards and references.rulebook.",
  "FMC-AVF-VIEW": "view is not a graphical, non-template view in the document. AVF needs a plan, section, elevation or 3D view.",
  "FMC-AVF-POINTS": "Pass points [{x, y, z, value}] or csv (a file with columns x, y, z, value).",
  "FMC-AVF-VALUE": "Every point needs finite x, y, z and value numbers.",
  "FMC-AVF-TOO-MANY": `More than ${AVF_MAX_POINTS} points. Thin the grid or split it across views.`,
  "FMC-AVF-CSV": "The CSV could not be read, or it has no x, y, z and value columns.",
  "FMC-AVF-NOTHING": "The view has no Formcraft analysis results to clear.",
};

export interface AvfPoint { x: number; y: number; z: number; value: number }

export interface AvfStats { count: number; min: number; max: number; mean: number }

export function parseAvfCsv(text: string): AvfPoint[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (lines.length < 2) throw new Error(`[FMC-AVF-CSV] ${AVF_FIX["FMC-AVF-CSV"]}`);
  const sep = sniffSeparator(lines[0]);
  const header = splitCsvLine(lines[0], sep).map((cell) => cell.toLowerCase());
  const col = (...names: string[]) => header.findIndex((cell) => names.includes(cell));
  const ix = col("x", "x_mm", "east", "easting", "e");
  const iy = col("y", "y_mm", "north", "northing", "n");
  const iz = col("z", "z_mm", "elevation", "elev", "rl", "h");
  const iv = col("value", "v", "result", "val");
  if (ix < 0 || iy < 0 || iv < 0) throw new Error(`[FMC-AVF-CSV] ${AVF_FIX["FMC-AVF-CSV"]}`);
  return lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line, sep);
    const row = { x: Number(cells[ix]), y: Number(cells[iy]), z: iz >= 0 ? Number(cells[iz]) : 0, value: Number(cells[iv]) };
    if (![row.x, row.y, row.z, row.value].every(Number.isFinite)) throw new Error(`[FMC-AVF-VALUE] CSV line ${i + 2}: ${AVF_FIX["FMC-AVF-VALUE"]}`);
    return row;
  });
}

export function checkAvfPoints(points: unknown): AvfPoint[] {
  if (!Array.isArray(points) || !points.length) throw new Error(`[FMC-AVF-POINTS] ${AVF_FIX["FMC-AVF-POINTS"]}`);
  if (points.length > AVF_MAX_POINTS) throw new Error(`[FMC-AVF-TOO-MANY] ${AVF_FIX["FMC-AVF-TOO-MANY"]}`);
  return points.map((p, i) => {
    const r = (p ?? {}) as Record<string, unknown>;
    const row = { x: Number(r.x), y: Number(r.y), z: r.z == null ? 0 : Number(r.z), value: Number(r.value) };
    if (![row.x, row.y, row.z, row.value].every(Number.isFinite)) throw new Error(`[FMC-AVF-VALUE] point ${i}: ${AVF_FIX["FMC-AVF-VALUE"]}`);
    return row;
  });
}

export function avfStats(points: AvfPoint[]): AvfStats {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const p of points) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
    sum += p.value;
  }
  return { count: points.length, min: roundTo(min, 6), max: roundTo(max, 6), mean: roundTo(sum / points.length, 6) };
}

/** Equal legend bands between min and max (steps 2 to 20). A flat field is one band. */
export function legendBands(stats: AvfStats, steps: number): Array<{ from: number; to: number }> {
  const n = Math.max(2, Math.min(20, Math.round(steps)));
  if (stats.max === stats.min) return [{ from: stats.min, to: stats.max }];
  const width = (stats.max - stats.min) / n;
  return Array.from({ length: n }, (_, i) => ({ from: roundTo(stats.min + i * width, 6), to: roundTo(i === n - 1 ? stats.max : stats.min + (i + 1) * width, 6) }));
}

export interface AvfPlanArgs { units: string; coordinates: "internal" | "shared"; value_scale: number }

/** Points in internal millimetres, ready for the add-in, and the value multiplier applied. */
export function planAvfPoints(points: AvfPoint[], args: AvfPlanArgs, internalToShared?: number[][]): { xyz_mm: Array<[number, number, number]>; values: number[] } {
  const k = UNIT_TO_MM[args.units] ?? NaN;
  if (!Number.isFinite(k)) throw new Error(`[FMC-AVF-VALUE] units must be one of ${Object.keys(UNIT_TO_MM).join(", ")}.`);
  let xyz = points.map((p) => [p.x * k, p.y * k, p.z * k] as [number, number, number]);
  if (args.coordinates === "shared") xyz = sharedToInternalMm(xyz, internalToShared ?? []);
  return { xyz_mm: xyz.map(([x, y, z]) => [roundTo(x, 3), roundTo(y, 3), roundTo(z, 3)]), values: points.map((p) => p.value * args.value_scale) };
}

export function readAvfCsvFile(file: string, read: (f: string) => string = (f) => fs.readFileSync(f, "utf8")): AvfPoint[] {
  let text: string;
  try { text = read(file); } catch (error) { throw new Error(`[FMC-AVF-CSV] ${file}: ${error instanceof Error ? error.message : String(error)}`); }
  return parseAvfCsv(text);
}

export function avfDir(env: NodeJS.ProcessEnv = process.env): string {
  return siteReportDir(env, "FMC_AVF_DIR", "avf");
}

export function writeAvfReport(env: NodeJS.ProcessEnv, body: unknown, dir = avfDir(env)): string {
  return writeSiteReport(dir, "avf", body);
}
