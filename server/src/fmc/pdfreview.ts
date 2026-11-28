/**
 * PDF self-check. Pages are rasterized to PNG under the Formcraft image folder
 * (%LOCALAPPDATA%\Formcraft\images, never D:, never beside the model).
 * A missing renderer is FMC-PDF-NO-RENDERER. Checks still run from the page text.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { imageDir, onDriveD } from "./images.js";
import type { GuardConfig } from "./policy.js";

export const PDF_FIX: Record<string, string> = {
  "FMC-PDF-NO-RENDERER": "No pdftoppm, pdfium or Ghostscript renderer was found. No PNG was written.",
  "FMC-PDF-READ": "The PDF could not be read.",
  "FMC-PDF-RENDER": "The renderer failed. No PNG was kept.",
  "FMC-PDF-PATH": "Pictures are not written on D: or beside the model.",
};

export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface InkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageFact {
  page: number;
  width_pt: number;
  height_pt: number;
  text: string;
  boxes?: TextBox[];
  /** Path bounds from pdf.js operators, in PDF points, origin at the lower left. */
  ink?: InkBox[];
}

export interface PageCheck {
  page: number;
  blank: boolean;
  page_size: { name: string; orientation: "portrait" | "landscape" } | null;
  width_pt: number;
  height_pt: number;
  missing_titleblock_text: boolean;
  past_border: boolean;
  text_overlaps: number;
  empty_drawing_zone: boolean;
  fill_pct: number;
  /** Path or image ink was found (pdf.js operators). A page with ink and no text is not blank (PR-6). */
  has_ink?: boolean;
  png?: string;
}

export interface Renderer {
  kind: "pdftoppm" | "pdftocairo" | "ghostscript" | "pdfium";
  command: string;
}

const SIZES: Array<{ name: string; w: number; h: number }> = [
  { name: "A4", w: 595.28, h: 841.89 },
  { name: "A3", w: 841.89, h: 1190.55 },
  { name: "A2", w: 1190.55, h: 1683.78 },
  { name: "A1", w: 1683.78, h: 2383.94 },
  { name: "A0", w: 2383.94, h: 3370.39 },
];

const SHEET_NO = /\b[A-Z]{1,3}-[A-Z0-9]{2,}\b/;

export function matchPageSize(width: number, height: number): PageCheck["page_size"] {
  for (const size of SIZES) {
    const portrait = near(width, size.w) && near(height, size.h);
    const landscape = near(width, size.h) && near(height, size.w);
    if (portrait) return { name: size.name, orientation: "portrait" };
    if (landscape) return { name: size.name, orientation: "landscape" };
  }
  return null;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(6, b * 0.02);
}

export function titleblockMissing(page: PageFact): boolean {
  const boxes = page.boxes ?? [];
  if (boxes.length) {
    const band = boxes.some((box) => {
      const text = box.text.trim();
      if (!text) return false;
      const inBottom = box.y <= page.height_pt * 0.18;
      const inRight = box.x >= page.width_pt * 0.78;
      return inBottom || inRight;
    });
    return !band;
  }
  return !SHEET_NO.test(page.text);
}

const BORDER_PT = 10;

function intersects(a: TextBox, b: TextBox): boolean {
  return a.x < b.x + b.w - 0.2 && b.x < a.x + a.w - 0.2 && a.y < b.y + b.h - 0.2 && b.y < a.y + a.h - 0.2;
}

/** Ink or text closer to the media edge than the border, outside the drawing frame. */
export function pastBorder(page: PageFact): boolean {
  const boxes = [...(page.boxes ?? []), ...(page.ink ?? [])];
  return boxes.some((box) => {
    if (box.w <= 0 && box.h <= 0) return false;
    const x1 = box.x + Math.max(box.w, 0);
    const y1 = box.y + Math.max(box.h, 0);
    return box.x < BORDER_PT - 0.1 || box.y < BORDER_PT - 0.1 || x1 > page.width_pt - BORDER_PT + 0.1 || y1 > page.height_pt - BORDER_PT + 0.1;
  });
}

/** Pairs of overlapping text boxes. Sort by x and sweep, so a dense sheet is not n squared (PR-20). */
export function textOverlaps(page: PageFact): number {
  const boxes = (page.boxes ?? []).filter((box) => box.text.trim() && box.w > 0 && box.h > 0).sort((a, b) => a.x - b.x);
  let count = 0;
  for (let i = 0; i < boxes.length; i++) {
    const right = boxes[i].x + boxes[i].w - 0.2;
    for (let j = i + 1; j < boxes.length && boxes[j].x < right; j++) if (intersects(boxes[i], boxes[j])) count += 1;
  }
  return count;
}

/** The drawing zone is inside the border and outside the title-block band (bottom 18% or right 22%). */
export function emptyDrawingZone(page: PageFact): boolean {
  const x0 = BORDER_PT;
  const y0 = Math.max(BORDER_PT, page.height_pt * 0.18);
  const x1 = page.width_pt * 0.78;
  const y1 = page.height_pt - BORDER_PT;
  if (x1 <= x0 || y1 <= y0) return true;
  const boxes = [...(page.boxes ?? []), ...(page.ink ?? [])];
  return !boxes.some((box) => {
    if (!("text" in box) || (box as TextBox).text === undefined || (box as TextBox).text.trim()) {
      const cx = box.x + Math.max(box.w, 0) / 2;
      const cy = box.y + Math.max(box.h, 0) / 2;
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    }
    return false;
  });
}

/** Share of the page covered by text or ink, on a 20 by 20 grid. */
export function fillPct(page: PageFact): number {
  const cols = 20;
  const rows = 20;
  const boxes = [...(page.boxes ?? []), ...(page.ink ?? [])].filter((box) => box.w > 0 && box.h > 0);
  if (!page.width_pt || !page.height_pt || !boxes.length) return 0;
  let hit = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = (col / cols) * page.width_pt;
      const x1 = ((col + 1) / cols) * page.width_pt;
      const y0 = (row / rows) * page.height_pt;
      const y1 = ((row + 1) / rows) * page.height_pt;
      if (boxes.some((box) => box.x < x1 && box.x + box.w > x0 && box.y < y1 && box.y + box.h > y0)) hit += 1;
    }
  }
  return Math.round((hit / (cols * rows)) * 1000) / 10;
}

export interface DrawOp { op: string; args: number[] }

/** Bounds of PDF path operators. save, restore and transform keep the current matrix. No raster is required. */
export function inkFromOps(ops: DrawOp[]): InkBox[] {
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const boxes: InkBox[] = [];
  const apply = (x: number, y: number) => ({ x: ctm[0] * x + ctm[2] * y + ctm[4], y: ctm[1] * x + ctm[3] * y + ctm[5] });
  const addBox = (x0: number, y0: number, x1: number, y1: number) => {
    if (![x0, y0, x1, y1].every((n) => Number.isFinite(n))) return;
    const minX = Math.min(x0, x1);
    const minY = Math.min(y0, y1);
    boxes.push({ x: minX, y: minY, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
  };
  for (const item of ops) {
    const op = item.op;
    const args = item.args;
    if (op === "bounds" && args.length >= 4) {
      // pdf.js 6 constructPath carries the path's own min/max box; images are the unit square. Transform all four corners.
      const corners = [apply(args[0], args[1]), apply(args[2], args[1]), apply(args[0], args[3]), apply(args[2], args[3])];
      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      addBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    } else if (op === "save") stack.push([...ctm]);
    else if (op === "restore") ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (op === "transform" && args.length >= 6) {
      const [a, b, c, d, e, f] = args;
      const [A, B, C, D, E, F] = ctm;
      ctm = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
    } else if (op === "rectangle" && args.length >= 4) {
      const p = apply(args[0], args[1]);
      const q = apply(args[0] + args[2], args[1] + args[3]);
      addBox(p.x, p.y, q.x, q.y);
    } else if ((op === "moveTo" || op === "lineTo" || op === "curveTo") && args.length >= 2) {
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i + 1 < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
      const pts = pairs.map(([x, y]) => apply(x, y));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      addBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    }
  }
  return boxes.filter((box) => box.w > 0 || box.h > 0);
}

export function reviewPages(pages: PageFact[]): PageCheck[] {
  return pages.map((page) => ({
    page: page.page,
    blank: page.text.trim().length === 0 && !(page.ink ?? []).length,
    has_ink: (page.ink ?? []).length > 0,
    page_size: matchPageSize(page.width_pt, page.height_pt),
    width_pt: page.width_pt,
    height_pt: page.height_pt,
    missing_titleblock_text: titleblockMissing(page),
    past_border: pastBorder(page),
    text_overlaps: textOverlaps(page),
    empty_drawing_zone: emptyDrawingZone(page),
    fill_pct: fillPct(page),
  }));
}

export function whichCommand(name: string, lookup: (cmd: string) => string | null = defaultLookup): string | null {
  return lookup(name);
}

function defaultLookup(cmd: string): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [cmd], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const line = (result.stdout || "").split(/\r?\n/).map((row) => row.trim()).find(Boolean);
  return line || null;
}

export function detectRenderer(env: NodeJS.ProcessEnv = process.env, lookup: (cmd: string) => string | null = defaultLookup): Renderer | null {
  const forced = (env.FMC_PDFIUM ?? "").trim();
  if (forced && fs.existsSync(forced)) return { kind: "pdfium", command: forced };
  const order: Array<[string, Renderer["kind"]]> = [
    ["pdftoppm", "pdftoppm"],
    ["pdftocairo", "pdftocairo"],
    ["gswin64c", "ghostscript"],
    ["gswin32c", "ghostscript"],
    ["gs", "ghostscript"],
  ];
  for (const [cmd, kind] of order) {
    const found = lookup(cmd);
    if (found) return { kind, command: found };
  }
  return null;
}

export function safeImageDir(cfg: Pick<GuardConfig, "image_dir"> | undefined, pdfPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = imageDir(cfg, env);
  if (onDriveD(dir)) throw new Error(PDF_FIX["FMC-PDF-PATH"]);
  const pdfDir = path.win32.dirname(pdfPath);
  if (sameDir(dir, pdfDir)) throw new Error(PDF_FIX["FMC-PDF-PATH"]);
  if (/\.rvt([\\/]|$)/i.test(dir)) throw new Error(PDF_FIX["FMC-PDF-PATH"]);
  return dir;
}

function sameDir(a: string, b: string): boolean {
  return path.win32.resolve(a).replace(/[\\/]+$/, "").toLowerCase() === path.win32.resolve(b).replace(/[\\/]+$/, "").toLowerCase();
}

export function pngName(pdfPath: string, page: number): string {
  const base = path.win32.basename(pdfPath, path.win32.extname(pdfPath)).replace(/[<>:"|?*]/g, "_") || "sheet";
  return `${base}-p${page}.png`;
}

export interface RenderRequest {
  renderer: Renderer;
  pdf: string;
  pages: number[];
  dpi: number;
  dir: string;
}

export type RenderRun = (request: RenderRequest) => { ok: boolean; files: string[]; error?: string };

export function renderWith(request: RenderRequest): { ok: boolean; files: string[]; error?: string } {
  fs.mkdirSync(request.dir, { recursive: true });
  const files: string[] = [];
  if (request.renderer.kind === "pdftoppm" || request.renderer.kind === "pdftocairo") {
    const prefix = path.win32.join(request.dir, `.fmc-pdf-${process.pid}`);
    // One call per run of consecutive pages, so pages [1, 50] renders two pages, not fifty (PR-15).
    const runs = request.pages.length ? pageRuns(request.pages) : [null];
    for (const run of runs) {
      const args = ["-png", "-r", String(request.dpi)];
      if (run) args.push("-f", String(run[0]), "-l", String(run[1]));
      args.push(request.pdf, prefix);
      const result = spawnSync(request.renderer.command, args, { encoding: "utf8" });
      if (result.status !== 0) return { ok: false, files: [], error: (result.stderr || result.stdout || "renderer failed").slice(0, 500) };
    }
    const want = new Set(request.pages);
    const produced = fs.readdirSync(request.dir).filter((name) => name.startsWith(path.win32.basename(prefix)) && name.endsWith(".png"));
    for (const name of produced) {
      const match = /-(\d+)\.png$/.exec(name);
      const page = match ? Number(match[1]) : 0;
      const from = path.win32.join(request.dir, name);
      if (!want.has(page)) { fs.rmSync(from, { force: true }); continue; }
      const dest = path.win32.join(request.dir, pngName(request.pdf, page));
      fs.renameSync(from, dest);
      files.push(dest);
    }
    return files.length ? { ok: true, files } : { ok: false, files: [], error: "The renderer wrote no PNG." };
  }
  if (request.renderer.kind === "ghostscript") {
    for (const page of request.pages) {
      const dest = path.win32.join(request.dir, pngName(request.pdf, page));
      const args = ["-dSAFER", "-dBATCH", "-dNOPAUSE", "-sDEVICE=png16m", `-r${request.dpi}`, `-dFirstPage=${page}`, `-dLastPage=${page}`, `-sOutputFile=${dest}`, request.pdf];
      const result = spawnSync(request.renderer.command, args, { encoding: "utf8" });
      if (result.status !== 0 || !fs.existsSync(dest)) return { ok: false, files, error: (result.stderr || result.stdout || "ghostscript failed").slice(0, 500) };
      files.push(dest);
    }
    return { ok: true, files };
  }
  for (const page of request.pages) {
    const dest = path.win32.join(request.dir, pngName(request.pdf, page));
    const args = ["--png", "--dpi", String(request.dpi), "--page", String(page), "--out", dest, request.pdf];
    const result = spawnSync(request.renderer.command, args, { encoding: "utf8" });
    if (result.status !== 0 || !fs.existsSync(dest)) return { ok: false, files, error: (result.stderr || result.stdout || "pdfium failed").slice(0, 500) };
    files.push(dest);
  }
  return { ok: true, files };
}

/** Consecutive runs of page numbers, e.g. [1, 2, 3, 50] gives [[1, 3], [50, 50]]. */
export function pageRuns(pages: number[]): Array<[number, number]> {
  const sorted = [...new Set(pages)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

/** Requested pages that the PDF does not have (PR-13). */
export function pagesNotFound(pageCount: number, requested?: number[]): number[] {
  return [...new Set(requested ?? [])].filter((n) => n < 1 || n > pageCount).sort((a, b) => a - b);
}

export interface PdfSummary {
  verdict: "OK" | "CHECK" | "NO_PAGES";
  line: string;
  pages: number;
  blank: number[];
  past_border: number[];
  text_overlaps: number[];
  missing_titleblock_text: number[];
  empty_drawing_zone: number[];
  unknown_size: number[];
  pages_not_found: number[];
}

/** One line and a verdict for the whole review (PR-18). CHECK means at least one page needs a look. */
export function summarisePdf(checks: PageCheck[], notFound: number[] = []): PdfSummary {
  const pick = (test: (row: PageCheck) => boolean) => checks.filter(test).map((row) => row.page);
  const s = {
    pages: checks.length,
    blank: pick((row) => row.blank),
    past_border: pick((row) => row.past_border),
    text_overlaps: pick((row) => row.text_overlaps > 0),
    missing_titleblock_text: pick((row) => row.missing_titleblock_text),
    empty_drawing_zone: pick((row) => !row.blank && row.empty_drawing_zone),
    unknown_size: pick((row) => !row.page_size),
    pages_not_found: [...notFound],
  };
  const flagged = new Set([...s.blank, ...s.past_border, ...s.text_overlaps, ...s.missing_titleblock_text, ...s.empty_drawing_zone, ...s.unknown_size]);
  const verdict: PdfSummary["verdict"] = !checks.length ? "NO_PAGES" : flagged.size || notFound.length ? "CHECK" : "OK";
  const parts = [
    `${checks.length} page(s) checked`,
    s.blank.length ? `blank ${s.blank.join(",")}` : "",
    s.past_border.length ? `past border ${s.past_border.join(",")}` : "",
    s.text_overlaps.length ? `text overlaps ${s.text_overlaps.join(",")}` : "",
    s.missing_titleblock_text.length ? `no title-block text ${s.missing_titleblock_text.join(",")}` : "",
    s.empty_drawing_zone.length ? `empty drawing zone ${s.empty_drawing_zone.join(",")}` : "",
    s.unknown_size.length ? `not A0-A4 ${s.unknown_size.join(",")}` : "",
    notFound.length ? `not in the PDF ${notFound.join(",")}` : "",
  ].filter(Boolean);
  return { verdict, line: `${verdict}: ${parts.join("; ")}.`, ...s };
}

export const SHEET_CHECKS_HEADER = ["reviewed_at", "pdf", "page", "verdict", "blank", "page_size", "missing_titleblock_text", "past_border", "text_overlaps", "empty_drawing_zone", "fill_pct"];

/** Rows for the SheetChecks table (one per page) that fmc_powerbi can read from the Exchange folder (PR-23). */
export function sheetCheckRows(pdf: string, checks: PageCheck[], at: string): Array<Array<string | number | boolean>> {
  return checks.map((row) => {
    const flagged = row.blank || row.past_border || row.text_overlaps > 0 || row.missing_titleblock_text || (!row.blank && row.empty_drawing_zone) || !row.page_size;
    return [at, path.win32.basename(pdf), row.page, flagged ? "CHECK" : "OK", row.blank, row.page_size ? `${row.page_size.name} ${row.page_size.orientation}` : "", row.missing_titleblock_text, row.past_border, row.text_overlaps, row.empty_drawing_zone, row.fill_pct];
  });
}

export function selectPages(all: PageFact[], requested?: number[]): PageFact[] {
  if (!requested?.length) return all;
  const want = new Set(requested);
  return all.filter((page) => want.has(page.page));
}
