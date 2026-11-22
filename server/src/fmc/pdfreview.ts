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

export interface PageFact {
  page: number;
  width_pt: number;
  height_pt: number;
  text: string;
  boxes?: TextBox[];
}

export interface PageCheck {
  page: number;
  blank: boolean;
  page_size: { name: string; orientation: "portrait" | "landscape" } | null;
  width_pt: number;
  height_pt: number;
  missing_titleblock_text: boolean;
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

export function reviewPages(pages: PageFact[]): PageCheck[] {
  return pages.map((page) => ({
    page: page.page,
    blank: page.text.trim().length === 0,
    page_size: matchPageSize(page.width_pt, page.height_pt),
    width_pt: page.width_pt,
    height_pt: page.height_pt,
    missing_titleblock_text: titleblockMissing(page),
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
    const args = ["-png", "-r", String(request.dpi)];
    if (request.pages.length) {
      args.push("-f", String(Math.min(...request.pages)), "-l", String(Math.max(...request.pages)));
    }
    args.push(request.pdf, prefix);
    const result = spawnSync(request.renderer.command, args, { encoding: "utf8" });
    if (result.status !== 0) return { ok: false, files: [], error: (result.stderr || result.stdout || "renderer failed").slice(0, 500) };
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

export function selectPages(all: PageFact[], requested?: number[]): PageFact[] {
  if (!requested?.length) return all;
  const want = new Set(requested);
  return all.filter((page) => want.has(page.page));
}
