/**
 * One keynote legend, filtered by sheet, placed on each plan sheet.
 * The point comes from a title-block parameter when the read has one,
 * otherwise from the kit zone (inset from the title block's lower right).
 * A missing kit file uses the sample, which is PROVISIONAL and cannot PASS.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEGEND_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_keynote_legend needs document, a title or a full path. The active document is not a guess.",
  "FMC-BATCH-LOCKED": "A write needs batch_lease from fmc_batch request.",
  "FMC-KEYNOTE-LEGEND-REFERENCES": "A write needs references.kit, references.standards and references.rulebook.",
  "FMC-KEYNOTE-LEGEND-SPEC": "The keynote legend spec is missing or is not JSON.",
  "FMC-KEYNOTE-LEGEND-ZONE": "The sheet has no title-block legend point and no title-block outline to place the fixed zone on.",
  "FMC-KEYNOTE-LEGEND-SHEET": "That sheet was not found.",
  "FMC-KEYNOTE-LEGEND-ROLE": "No sheet has that role.",
  "FMC-KEYNOTE-LEGEND-ALREADY": "That sheet already has this keynote legend.",
  "FMC-KEYNOTE-LEGEND-SAME-POINT": "Every planned sheet got the same point from the spec, not from a title-block parameter. Check the zone on one sheet before applying to all.",
  "FMC-KEYNOTE-LEGEND-FILTER": "This keynote legend cannot be filtered by sheet (IsValidCategoryForFilterBySheet is false). Nothing was placed.",
};

export interface LegendZoneSpec {
  parameter?: string;
  inset_right_mm?: number;
  inset_bottom_mm?: number;
}

export interface LegendSpec {
  status?: string;
  /** Research 52: the legend's expected size for the zone check (top-left at the point, as ScheduleSheetInstance.Create places it). */
  size_mm?: { width?: number; height?: number };
  name?: string;
  filter_by_sheet?: boolean;
  zone?: LegendZoneSpec;
}

export interface LoadedLegendSpec {
  spec: LegendSpec;
  path: string;
  source: "kit" | "sample" | "file";
  provisional: boolean;
}

export interface LegendFrame {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

export interface LegendSheet {
  id: string;
  number?: string;
  name?: string;
  role?: string;
  titleblock_mm?: LegendFrame;
  legend_x_mm?: number;
  legend_y_mm?: number;
  legend_source?: string;
  has_legend?: boolean;
  /** Viewports and schedules already on the sheet, millimetres (add-in read, research 52). */
  taken_mm?: Array<LegendFrame & { id?: string; kind?: string }>;
}

export interface LegendPoint {
  x: number;
  y: number;
  source: "param" | "spec";
}

const here = path.dirname(fileURLToPath(import.meta.url));
const r1 = (n: number) => Math.round(n * 10) / 10;

function joinUnder(root: string, ...parts: string[]): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root) || (root.includes("\\") && !root.includes("/"));
  return (windows ? path.win32 : path).join(root, ...parts);
}

export function sampleLegendPaths(): string[] {
  return [
    path.resolve(here, "..", "..", "data", "FMC_KeynoteLegend.json"),
    path.resolve(here, "..", "data", "FMC_KeynoteLegend.json"),
  ];
}

export function parseLegendSpec(raw: string): LegendSpec {
  const body = JSON.parse(raw.replace(/^\uFEFF/, "")) as LegendSpec;
  if (!body || typeof body !== "object") throw new Error(LEGEND_FIX["FMC-KEYNOTE-LEGEND-SPEC"]);
  return body;
}

export function loadLegendSpec(opts: {
  file?: string;
  kitRoot?: string;
  env?: NodeJS.ProcessEnv;
  read?: (file: string) => string;
}): LoadedLegendSpec {
  const read = opts.read ?? ((file) => fs.readFileSync(file, "utf8"));
  const exists = (file: string) => {
    try { read(file); return true; } catch { return false; }
  };
  const named = (opts.file ?? opts.env?.FMC_KEYNOTE_LEGEND_FILE ?? "").trim();
  const kit = (opts.kitRoot ?? "").replace(/[\\/]+$/, "");
  const kitFile = kit ? joinUnder(kit, "03_Master_Data", "FMC_KeynoteLegend.json") : "";
  const candidates: Array<{ file: string; source: LoadedLegendSpec["source"] }> = [];
  if (named) candidates.push({ file: named, source: "file" });
  if (kitFile) candidates.push({ file: kitFile, source: "kit" });
  for (const file of sampleLegendPaths()) candidates.push({ file, source: "sample" });
  for (const item of candidates) {
    if (!exists(item.file)) continue;
    const spec = parseLegendSpec(read(item.file));
    const provisional = item.source !== "kit" || String(spec.status ?? "").toUpperCase() === "PROVISIONAL";
    return { spec, path: item.file, source: item.source, provisional };
  }
  throw new Error(LEGEND_FIX["FMC-KEYNOTE-LEGEND-SPEC"]);
}

/** Title-block parameter first. Otherwise the spec inset from the lower right of the title block. */
export function legendPoint(sheet: LegendSheet, spec: LegendSpec): { ok: true; point: LegendPoint } | { ok: false; code: string; reason: string } {
  if (typeof sheet.legend_x_mm === "number" && typeof sheet.legend_y_mm === "number") {
    return { ok: true, point: { x: r1(sheet.legend_x_mm), y: r1(sheet.legend_y_mm), source: "param" } };
  }
  const box = sheet.titleblock_mm;
  const zone = spec.zone ?? {};
  const right = zone.inset_right_mm ?? 30;
  const bottom = zone.inset_bottom_mm ?? 30;
  if (!box) return { ok: false, code: "FMC-KEYNOTE-LEGEND-ZONE", reason: LEGEND_FIX["FMC-KEYNOTE-LEGEND-ZONE"] };
  return {
    ok: true,
    point: { x: r1(box.max_x - right), y: r1(box.min_y + bottom), source: "spec" },
  };
}

export function chooseLegendSheets(sheets: LegendSheet[], request: { sheets?: string[]; role: string }): { found: LegendSheet[]; skipped: Array<{ sheet: string; code: string; reason: string }> } {
  const skipped: Array<{ sheet: string; code: string; reason: string }> = [];
  if (request.sheets && request.sheets.length) {
    const found: LegendSheet[] = [];
    for (const key of request.sheets) {
      const name = key.trim().toLowerCase();
      const hit = sheets.find((sheet) => sheet.id.toLowerCase() === name || (sheet.number ?? "").toLowerCase() === name || (sheet.name ?? "").toLowerCase() === name);
      if (!hit) skipped.push({ sheet: key, code: "FMC-KEYNOTE-LEGEND-SHEET", reason: LEGEND_FIX["FMC-KEYNOTE-LEGEND-SHEET"] });
      else found.push(hit);
    }
    return { found, skipped };
  }
  const role = request.role.trim().toLowerCase();
  const found = sheets.filter((sheet) => (sheet.role ?? "").trim().toLowerCase() === role);
  if (!found.length) skipped.push({ sheet: request.role, code: "FMC-KEYNOTE-LEGEND-ROLE", reason: LEGEND_FIX["FMC-KEYNOTE-LEGEND-ROLE"] });
  return { found, skipped };
}

export interface LegendPlacement {
  sheet: string;
  sheet_id: string;
  number: string;
  x: number;
  y: number;
  source: "param" | "spec";
  /** clear, overlaps, off_titleblock or not_checked (no outlines from the add-in). */
  zone_check?: ZoneCheck;
  overlaps?: string[];
  legend_id?: string;
  fit_point?: { x: number; y: number };
}

export type ZoneCheck = "clear" | "overlaps" | "off_titleblock" | "not_checked";

export function legendBox(x: number, y: number, spec: LegendSpec): LegendFrame {
  const w = spec.size_mm?.width ?? 150;
  const h = spec.size_mm?.height ?? 100;
  return { min_x: x, max_x: x + w, min_y: y - h, max_y: y };
}

function hits(a: LegendFrame, b: LegendFrame): boolean {
  return a.min_x < b.max_x && b.min_x < a.max_x && a.min_y < b.max_y && b.min_y < a.max_y;
}

/** Research 52: does the legend box at the point stay on the title block and clear of viewports and other schedules? */
export function zoneCheck(sheet: LegendSheet, x: number, y: number, spec: LegendSpec): { zone_check: ZoneCheck; overlaps: string[]; fit_point?: { x: number; y: number } } {
  if (!Array.isArray(sheet.taken_mm)) return { zone_check: "not_checked", overlaps: [] };
  const box = legendBox(x, y, spec);
  const tb = sheet.titleblock_mm;
  const overlaps = sheet.taken_mm.filter((r) => r.kind !== "this_legend" && hits(box, r)).map((r) => `${r.kind ?? "item"} ${r.id ?? ""}`.trim());
  if (overlaps.length) return { zone_check: "overlaps", overlaps };
  if (tb && (box.min_x < tb.min_x || box.max_x > tb.max_x || box.min_y < tb.min_y || box.max_y > tb.max_y)) {
    // The point is the legend's top-left (ScheduleSheetInstance.Create); the spec inset is from the lower right, so a point at the inset hangs off the frame.
    const zone = spec.zone ?? {};
    const fit = { x: r1(tb.max_x - (zone.inset_right_mm ?? 30) - (box.max_x - box.min_x)), y: r1(tb.min_y + (zone.inset_bottom_mm ?? 30) + (box.max_y - box.min_y)) };
    return { zone_check: "off_titleblock", overlaps: [], fit_point: fit };
  }
  return { zone_check: "clear", overlaps: [] };
}

export function planLegend(sheets: LegendSheet[], spec: LegendSpec, request: { sheets?: string[]; role: string; filter_by_sheet: boolean }): {
  name: string;
  filter_by_sheet: boolean;
  placements: LegendPlacement[];
  skipped: Array<{ sheet: string; code: string; reason: string }>;
} {
  const name = (spec.name ?? "").trim() || "FMC Keynotes";
  const chosen = chooseLegendSheets(sheets, request);
  const placements: LegendPlacement[] = [];
  const skipped = [...chosen.skipped];
  for (const sheet of chosen.found) {
    if (sheet.has_legend) {
      skipped.push({ sheet: sheet.number || sheet.name || sheet.id, code: "FMC-KEYNOTE-LEGEND-ALREADY", reason: LEGEND_FIX["FMC-KEYNOTE-LEGEND-ALREADY"] });
      continue;
    }
    const point = legendPoint(sheet, spec);
    if (!point.ok) {
      skipped.push({ sheet: sheet.number || sheet.name || sheet.id, code: point.code, reason: point.reason });
      continue;
    }
    placements.push({
      sheet: sheet.name || sheet.number || sheet.id,
      sheet_id: sheet.id,
      number: sheet.number ?? "",
      x: point.point.x,
      y: point.point.y,
      source: point.point.source,
      ...zoneCheck(sheet, point.point.x, point.point.y, spec),
    });
  }
  return { name, filter_by_sheet: request.filter_by_sheet, placements, skipped };
}

export function referenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return LEGEND_FIX["FMC-KEYNOTE-LEGEND-REFERENCES"];
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) return LEGEND_FIX["FMC-KEYNOTE-LEGEND-REFERENCES"];
  }
  return null;
}

export function legendDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_KEYNOTE_LEGEND_DIR ?? "").trim()) return env.FMC_KEYNOTE_LEGEND_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(os.tmpdir(), "FormcraftLocal");
  return path.join(local, "Formcraft", "keynote-legend");
}

export function writeLegendReport(env: NodeJS.ProcessEnv, body: unknown, dir = legendDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `keynote-legend-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

/** P-fmc_keynote_legend-01: why a plan is PROVISIONAL and cannot PASS, in one line the bot can repeat. */
export function legendSpecNote(source: "kit" | "sample" | "file", provisional: boolean): string {
  if (source === "sample") return "The spec is the provisional sample: the kit file 03_Master_Data/FMC_KeynoteLegend.json is not on disk (K-14). The plan is usable for a look, but it cannot PASS (can_pass false) until the kit file exists.";
  if (provisional) return `The ${source} spec is still marked provisional, so the plan cannot PASS (can_pass false) until the spec is approved.`;
  return `The spec is the ${source} file; the plan can PASS.`;
}
