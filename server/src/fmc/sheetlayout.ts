/**
 * Sheet placement. Views are packed inside the title block drawing area.
 * Margins come from the standards bank. A missing key is provisional and cannot PASS.
 * Park writes a sheet parameter (browser organization when that parameter exists, otherwise FMC_Sheet_Status).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHEET_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "pair, arrange and park need document, a title or a full path. The active document is not a guess.",
  "FMC-BATCH-LOCKED": "A write needs batch_lease from fmc_batch request.",
  "FMC-SHEETS-REFERENCES": "A write needs references.kit, references.standards and references.rulebook.",
  "FMC-SHEETS-NO-FRAME": "The sheet has no title block outline to pack into.",
  "FMC-SHEETS-NO-FIT": "The view is larger than the drawing area.",
  "FMC-SHEETS-VIEW-TAKEN": "The view is already on another sheet.",
  "FMC-SHEETS-VIEW": "That view was not found, or it cannot be placed on a sheet.",
  "FMC-SHEETS-SHEET": "That sheet was not found.",
  "FMC-SHEETS-PARK-PARAM": "No browser-organization parameter and no FMC_Sheet_Status parameter to set to Parked.",
  "FMC-SHEETS-LAYOUT": "layout is grid, pair or stack.",
  "FMC-SHEETS-OVERFLOW": "A view does not fit the drawing area. Nothing was moved.",
};

export type SheetLayoutName = "grid" | "pair" | "stack";

export interface Box {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

export interface SheetViewBox {
  id: string;
  name: string;
  width_mm: number;
  height_mm: number;
  on_sheet?: string;
}

export interface SheetRead {
  id: string;
  number: string;
  name?: string;
  outline_mm?: Box;
  titleblock_mm?: Box;
  placed?: SheetViewBox[];
  parameters?: Record<string, string | null>;
  views?: SheetViewBox[];
}

export interface MarginCite {
  left_mm: number;
  other_mm: number;
  gap_mm: number;
  source: "standards" | "provisional";
  status: "approved" | "draft" | "provisional";
  can_pass: boolean;
}

export interface Frame {
  origin_x: number;
  origin_y: number;
  width: number;
  height: number;
  source: "titleblock" | "outline";
}

export interface Placement {
  view_id: string;
  name: string;
  center_x_mm: number;
  center_y_mm: number;
  width_mm: number;
  height_mm: number;
}

export interface LayoutSkip {
  view_id?: string;
  name?: string;
  code: string;
  reason: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function numOf(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw === "object" && typeof (raw as { value?: unknown }).value === "number") return (raw as { value: number }).value;
  return null;
}

function statusOf(raw: unknown): string {
  if (raw && typeof raw === "object" && typeof (raw as { status?: unknown }).status === "string") return (raw as { status: string }).status.toLowerCase();
  return "approved";
}

/** sheets.margin_left_mm, sheets.margin_other_mm and sheets.gap_mm. Missing keys stay provisional. */
export function resolveMargins(standards: Record<string, unknown> | null | undefined): MarginCite {
  const pick = (keys: string[], fallback: number) => {
    for (const key of keys) {
      if (!standards || !(key in standards)) continue;
      const value = numOf(standards[key]);
      if (value == null) continue;
      const status = statusOf(standards[key]);
      const ok = status === "approved" || status === "draft";
      return { value, source: ok ? "standards" as const : "provisional" as const, status: ok ? status as "approved" | "draft" : "provisional" as const };
    }
    return { value: fallback, source: "provisional" as const, status: "provisional" as const };
  };
  const left = pick(["sheets.margin_left_mm", "sheet.margin_left_mm"], 20);
  const other = pick(["sheets.margin_other_mm", "sheet.margin_other_mm"], 10);
  const gap = pick(["sheets.gap_mm", "sheet.gap_mm"], 8);
  const parts = [left, other, gap];
  const provisional = parts.some((part) => part.source === "provisional");
  return {
    left_mm: left.value,
    other_mm: other.value,
    gap_mm: gap.value,
    source: provisional ? "provisional" : "standards",
    status: provisional ? "provisional" : (parts.every((part) => part.status === "approved") ? "approved" : "draft"),
    can_pass: !provisional,
  };
}

export function drawingFrame(sheet: SheetRead, margins: MarginCite): { ok: true; frame: Frame } | { ok: false; code: string; reason: string } {
  const box = sheet.titleblock_mm ?? sheet.outline_mm;
  if (!box) return { ok: false, code: "FMC-SHEETS-NO-FRAME", reason: SHEET_FIX["FMC-SHEETS-NO-FRAME"] };
  const originX = box.min_x + margins.left_mm;
  const originY = box.min_y + margins.other_mm;
  const width = box.max_x - margins.other_mm - originX;
  const height = box.max_y - margins.other_mm - originY;
  if (!(width > 1) || !(height > 1)) return { ok: false, code: "FMC-SHEETS-NO-FRAME", reason: SHEET_FIX["FMC-SHEETS-NO-FRAME"] };
  return {
    ok: true,
    frame: {
      origin_x: r1(originX),
      origin_y: r1(originY),
      width: r1(width),
      height: r1(height),
      source: sheet.titleblock_mm ? "titleblock" : "outline",
    },
  };
}

function placeAt(view: SheetViewBox, x: number, y: number): Placement {
  return {
    view_id: view.id,
    name: view.name,
    center_x_mm: r1(x),
    center_y_mm: r1(y),
    width_mm: r1(view.width_mm),
    height_mm: r1(view.height_mm),
  };
}

/** Grid, pair or stack. Coordinates are millimetres on the sheet, origin at the lower left, Y up. */
export function packViews(views: SheetViewBox[], frame: Frame, layout: SheetLayoutName, gap: number): { placed: Placement[]; skipped: LayoutSkip[] } {
  const placed: Placement[] = [];
  const skipped: LayoutSkip[] = [];
  const fit = views.filter((view) => {
    if (!(view.width_mm > 0) || !(view.height_mm > 0) || view.width_mm > frame.width + 0.1 || view.height_mm > frame.height + 0.1) {
      skipped.push({ view_id: view.id, name: view.name, code: "FMC-SHEETS-NO-FIT", reason: SHEET_FIX["FMC-SHEETS-NO-FIT"] });
      return false;
    }
    return true;
  });
  if (layout === "stack") {
    let yTop = frame.origin_y + frame.height;
    const x = frame.origin_x + frame.width / 2;
    for (const view of fit) {
      placed.push(placeAt(view, x, yTop - view.height_mm / 2));
      yTop -= view.height_mm + gap;
    }
    return { placed, skipped };
  }
  if (layout === "pair" && fit.length <= 2) {
    const col = frame.width / Math.max(fit.length, 1);
    const y = frame.origin_y + frame.height / 2;
    fit.forEach((view, i) => placed.push(placeAt(view, frame.origin_x + col * (i + 0.5), y)));
    return { placed, skipped };
  }
  const columns = layout === "pair" ? 2 : Math.max(1, Math.ceil(Math.sqrt(fit.length)));
  const colW = frame.width / columns;
  let col = 0;
  let yTop = frame.origin_y + frame.height;
  let rowH = 0;
  for (const view of fit) {
    if (col > 0 && view.height_mm > rowH) rowH = view.height_mm;
    if (col === 0) rowH = view.height_mm;
    else rowH = Math.max(rowH, view.height_mm);
    placed.push(placeAt(view, frame.origin_x + colW * (col + 0.5), yTop - view.height_mm / 2));
    col += 1;
    if (col >= columns) {
      col = 0;
      yTop -= rowH + gap;
      rowH = 0;
    }
  }
  return { placed, skipped };
}

export function parkParameter(keys: string[] | undefined): { parameter: string; code?: string; reason?: string } {
  if (!keys) return { parameter: "FMC_Sheet_Status" };
  const browser = keys.find((key) => /browser|organi[sz]ation/i.test(key));
  if (browser) return { parameter: browser };
  if (keys.some((key) => key.toLowerCase() === "fmc_sheet_status")) return { parameter: "FMC_Sheet_Status" };
  return { parameter: "FMC_Sheet_Status", code: "FMC-SHEETS-PARK-PARAM", reason: SHEET_FIX["FMC-SHEETS-PARK-PARAM"] };
}

export function referenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return SHEET_FIX["FMC-SHEETS-REFERENCES"];
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) return SHEET_FIX["FMC-SHEETS-REFERENCES"];
  }
  return null;
}

export function sheetLayoutDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_SHEETS_DIR ?? "").trim()) return env.FMC_SHEETS_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(os.tmpdir(), "FormcraftLocal");
  return path.join(local, "Formcraft", "sheets");
}

export function writeSheetReport(env: NodeJS.ProcessEnv, action: string, body: unknown, dir = sheetLayoutDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `sheets-${action}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}
