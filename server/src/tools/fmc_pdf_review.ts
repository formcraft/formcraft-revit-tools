import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkWritePath, configPath, csvLine, expandEnv, loadConfig, type GuardConfig } from "../fmc/policy.js";
import {
  PDF_FIX, SHEET_CHECKS_HEADER, detectRenderer, inkFromOps, pagesNotFound, pngName, renderWith, reviewPages, safeImageDir, selectPages,
  sheetCheckRows, summarisePdf,
  type DrawOp, type PageCheck, type PageFact, type Renderer, type RenderRequest,
} from "../fmc/pdfreview.js";
import { fingerprint } from "../fmc/pdfread.js";
import { exchangeRoot } from "../hub/exchange.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_PDF_REVIEW_DESCRIPTION =
  "Rasterize an exported PDF and check the pages. PNGs go to %LOCALAPPDATA%\\Formcraft\\images (never D:, never beside the model). " +
  "The renderer is pdftoppm, pdftocairo, Ghostscript, or FMC_PDFIUM. None of those is FMC-PDF-NO-RENDERER and no PNG is written. " +
  "Checks are blank page, page size (A0 to A4), missing title-block text, ink past the border, overlapping text, an empty drawing zone and fill percent. " +
  "Border, overlap, empty zone and fill use pdf.js text boxes and path operators. They do not need a raster renderer. " +
  "dpi defaults to 110. pages is optional and 1-based; only those pages are parsed, and pages the PDF does not have are listed in pages_not_found. " +
  "Every reply has summary {verdict OK|CHECK|NO_PAGES, line}. A page with linework or an image but no text is not blank (has_ink). " +
  "return_images true (with dry_run false) also returns the first max_images PNGs (default 3) as images. " +
  "record true (with dry_run false) appends one row per page to <Exchange>\\Tables\\FMC_SheetChecks.csv (project_folder's 01_WIP\\_Exchange, else the reports folder's Exchange) for fmc_powerbi. " +
  "Parsed pages are cached by the file's sha256, so a repeat call on an unchanged PDF is fast. " +
  "dry_run defaults to true: the checks run and the PNG paths are named, and nothing is written. dry_run false writes the PNGs. " +
  "This does not change a Revit model, so it does not take a batch lease. " +
  "Example: pdf_path C:\\\\Jobs\\\\_Staging\\\\A-101.pdf, pages [1], dpi 110, dry_run true.";

export const FMC_PDF_REVIEW_SHAPE = {
  pdf_path: z.string(),
  pages: z.array(z.number().int().positive()).optional(),
  dpi: z.number().positive().optional().default(110),
  dry_run: z.boolean().optional().default(true),
  return_images: z.boolean().optional().default(false),
  max_images: z.number().int().min(1).max(6).optional().default(3),
  record: z.boolean().optional().default(false),
  project_folder: z.string().optional(),
};

export type FmcPdfReviewArgs = z.infer<z.ZodObject<typeof FMC_PDF_REVIEW_SHAPE>>;

export interface PdfReviewIo {
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  facts?: PageFact[];
  renderer?: Renderer | null;
  lookup?: (cmd: string) => string | null;
  run?: (request: RenderRequest) => { ok: boolean; files: string[]; error?: string };
  /** Now, for the SheetChecks rows (tests). */
  now?: () => Date;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-PDF";
  return reply({ tool: "fmc_pdf_review", refused: true, code, message, paths: [] }, true);
}

async function inkOfPage(pdfjs: { OPS?: Record<string, number> }, page: { getOperatorList: () => Promise<{ fnArray: ArrayLike<number>; argsArray: unknown[] }> }): Promise<PageFact["ink"]> {
  try {
    const list = await page.getOperatorList();
    const names = new Map(Object.entries(pdfjs.OPS ?? {}).map(([name, code]) => [code, name]));
    const draw: DrawOp[] = [];
    const push = (op: string, args: number[]) => {
      const name = op === "curveTo2" || op === "curveTo3" ? "curveTo" : op;
      if (name === "save" || name === "restore" || name === "transform" || name === "moveTo" || name === "lineTo" || name === "curveTo" || name === "rectangle") {
        draw.push({ op: name, args });
      }
    };
    for (let i = 0; i < list.fnArray.length; i++) {
      const name = names.get(list.fnArray[i]) ?? "";
      const raw = list.argsArray[i];
      if (name === "constructPath" && Array.isArray(raw) && raw.length >= 3 && typeof raw[0] === "number") {
        // pdf.js 6.x: [paint op, [path data], min/max box]. The old reader expected an op list in raw[0] and saw no ink,
        // so a vector-only page read as blank with fill 0 (PR-21, checked against 6.4.299 on 28 Nov 2026).
        const box = Array.from((raw[2] ?? []) as ArrayLike<number>).map((value) => Number(value));
        if (box.length >= 4 && box.every((n) => Number.isFinite(n))) draw.push({ op: "bounds", args: box.slice(0, 4) });
        continue;
      }
      if (name === "paintImageXObject" || name === "paintInlineImageXObject" || name === "paintImageMaskXObject" || name === "paintImageXObjectRepeat") {
        draw.push({ op: "bounds", args: [0, 0, 1, 1] });   // an image fills the unit square of the current matrix; a scan is not blank
        continue;
      }
      if (name === "constructPath" && Array.isArray(raw) && raw.length >= 2) {
        const pathOps = Array.from(raw[0] as ArrayLike<number>);
        const nums = Array.from(raw[1] as ArrayLike<number>).map((value) => Number(value));
        let cursor = 0;
        for (const code of pathOps) {
          const pathName = names.get(code) ?? "";
          const count = pathName === "rectangle" ? 4 : pathName === "curveTo" ? 6 : pathName === "curveTo2" || pathName === "curveTo3" ? 4 : pathName === "moveTo" || pathName === "lineTo" ? 2 : 0;
          if (!count) continue;
          push(pathName, nums.slice(cursor, cursor + count));
          cursor += count;
        }
        continue;
      }
      if (Array.isArray(raw)) push(name, raw.map((value) => Number(value)));
    }
    return inkFromOps(draw);
  } catch {
    return [];
  }
}

const factCache = new Map<string, PageFact>();
const MAX_CACHED_PAGES = 300;
const pageCounts = new Map<string, number>();

async function readFacts(file: string, wanted?: number[]): Promise<{ pages: PageFact[]; page_count: number; cached: number }> {
  let sha = "";
  try { sha = fingerprint(file); } catch { sha = ""; }
  const count = sha ? pageCounts.get(sha) : undefined;
  if (sha && count !== undefined) {
    const want = wanted?.length ? [...new Set(wanted)].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b) : Array.from({ length: count }, (_, i) => i + 1);
    const hits = want.map((n) => factCache.get(`${sha}|${n}`));
    if (hits.every(Boolean)) return { pages: hits as PageFact[], page_count: count, cached: hits.length };
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "vendor", "pdfjs"),
    path.resolve(here, "..", "..", "node_modules", "pdfjs-dist", "legacy", "build"),
  ];
  const dir = candidates.find((item) => fs.existsSync(path.join(item, "pdf.mjs")));
  if (!dir) throw new Error(PDF_FIX["FMC-PDF-READ"]);
  const pdfjs: any = await import(pathToFileURL(path.join(dir, "pdf.mjs")).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(dir, "pdf.worker.mjs")).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages: PageFact[] = [];
    if (sha) pageCounts.set(sha, doc.numPages);
    const want = wanted?.length ? [...new Set(wanted)].filter((n) => n >= 1 && n <= doc.numPages).sort((a, b) => a - b) : Array.from({ length: doc.numPages }, (_, i) => i + 1);
    let cached = 0;
    for (const n of want) {
      const hit = sha ? factCache.get(`${sha}|${n}`) : undefined;
      if (hit) { pages.push(hit); cached += 1; continue; }
      const page = await doc.getPage(n);
      const view = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const boxes = content.items.filter((item: any) => typeof item.str === "string").map((item: any) => ({
        x: Number(item.transform?.[4] ?? 0),
        y: Number(item.transform?.[5] ?? 0),
        w: Number(item.width ?? 0),
        h: Number(item.height ?? 0),
        text: String(item.str),
      }));
      pages.push({
        page: n,
        width_pt: view.width,
        height_pt: view.height,
        text: boxes.map((box: { text: string }) => box.text).join(" "),
        boxes,
        ink: await inkOfPage(pdfjs, page),
      });
      page.cleanup();
      if (sha) {
        factCache.set(`${sha}|${n}`, pages[pages.length - 1]);
        while (factCache.size > MAX_CACHED_PAGES) factCache.delete(factCache.keys().next().value as string);
      }
    }
    return { pages, page_count: doc.numPages, cached };
  } finally {
    await task.destroy();
  }
}

export async function runFmcPdfReview(args: FmcPdfReviewArgs, io: PdfReviewIo = {}) {
  const env = io.env ?? process.env;
  try {
    const pdf = args.pdf_path.trim();
    if (!pdf || !fs.existsSync(pdf)) return reply({ tool: "fmc_pdf_review", refused: true, code: "FMC-PDF-READ", message: PDF_FIX["FMC-PDF-READ"], path: pdf, paths: [] }, true);
    let dir: string;
    try {
      const cfg = io.guard ?? loadConfig(configPath(env)).config;
      dir = safeImageDir(cfg, pdf, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply({ tool: "fmc_pdf_review", refused: true, code: "FMC-PDF-PATH", message, paths: [] }, true);
    }
    let facts: PageFact[];
    let pageCount = 0;
    let cachedPages = 0;
    try {
      if (io.facts) {
        facts = io.facts;
        pageCount = facts.reduce((max, page) => Math.max(max, page.page), 0);
      } else {
        const read = await readFacts(pdf, args.pages);
        facts = read.pages;
        pageCount = read.page_count;
        cachedPages = read.cached;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply({ tool: "fmc_pdf_review", refused: true, code: "FMC-PDF-READ", message, paths: [] }, true);
    }
    const pages = selectPages(facts, args.pages);
    const checks = reviewPages(pages).map((row) => ({ ...row, png: path.win32.join(dir, pngName(pdf, row.page)) }));
    const notFound = pagesNotFound(pageCount, args.pages);
    const summary = summarisePdf(checks, notFound);
    const extra = { page_count: pageCount, pages_not_found: notFound, cached_pages: cachedPages, summary };
    const dry = args.dry_run !== false;
    let tableFile = "";
    let tableReasons: string[] = [];
    if (args.record) {
      const cfg = io.guard ?? loadConfig(configPath(env)).config;
      const reports = expandEnv(cfg.reports_dir ?? "", env);
      const project = args.project_folder ? expandEnv(args.project_folder, env) : undefined;
      if (!project && !reports) tableReasons = ["No project_folder and no reports_dir: nowhere to record."];
      else {
        tableFile = path.win32.join(exchangeRoot(project, reports), "Tables", "FMC_SheetChecks.csv");
        tableReasons = checkWritePath(tableFile, cfg, { checkName: false }).reasons;
      }
    }
    const record = (rows: PageCheck[]) => {
      if (!args.record) return undefined;
      if (tableReasons.length) return { written: false, file: tableFile, reasons: tableReasons };
      if (dry) return { written: false, file: tableFile, note: "dry_run true: the rows are not written." };
      try {
        fs.mkdirSync(path.win32.dirname(tableFile), { recursive: true });
        const head = fs.existsSync(tableFile) ? "" : csvLine(SHEET_CHECKS_HEADER) + "\r\n";
        const at = (io.now ?? (() => new Date()))().toISOString();
        fs.appendFileSync(tableFile, head + sheetCheckRows(pdf, rows, at).map((row) => csvLine(row)).join("\r\n") + "\r\n");
        return { written: true, file: tableFile, rows: rows.length };
      } catch (error) {
        return { written: false, file: tableFile, reasons: [error instanceof Error ? error.message : String(error)] };
      }
    };
    const renderer = io.renderer !== undefined ? io.renderer : detectRenderer(env, io.lookup);
    if (dry) {
      return reply({
        tool: "fmc_pdf_review",
        dry_run: true,
        read_only: true,
        dpi: args.dpi,
        image_dir: dir,
        renderer: renderer?.kind ?? null,
        ...extra,
        ...(args.record ? { table: record(checks) } : {}),
        paths: checks.map((row) => row.png),
        checks,
        next: "dry_run false writes the PNGs. A missing renderer is FMC-PDF-NO-RENDERER.",
      });
    }
    if (!renderer) {
      return reply({
        tool: "fmc_pdf_review",
        refused: true,
        code: "FMC-PDF-NO-RENDERER",
        message: PDF_FIX["FMC-PDF-NO-RENDERER"],
        dpi: args.dpi,
        image_dir: dir,
        ...extra,
        paths: [],
        checks,
      }, true);
    }
    const run = io.run ?? renderWith;
    const rendered = run({ renderer, pdf, pages: pages.map((page) => page.page), dpi: args.dpi, dir });
    if (!rendered.ok) {
      return reply({
        tool: "fmc_pdf_review",
        refused: true,
        code: "FMC-PDF-RENDER",
        message: rendered.error || PDF_FIX["FMC-PDF-RENDER"],
        renderer: renderer.kind,
        ...extra,
        paths: [],
        checks,
      }, true);
    }
    const byPage = new Map(checks.map((row) => [row.page, row]));
    for (const file of rendered.files) {
      const match = /-p(\d+)\.png$/i.exec(file);
      const page = match ? Number(match[1]) : 0;
      const row = byPage.get(page);
      if (row) row.png = file;
    }
    const done = [...byPage.values()];
    const result = reply({
      tool: "fmc_pdf_review",
      dry_run: false,
      read_only: false,
      model_changed: false,
      dpi: args.dpi,
      image_dir: dir,
      renderer: renderer.kind,
      ...extra,
      ...(args.record ? { table: record(done) } : {}),
      paths: rendered.files,
      checks: done,
    });
    if (!args.return_images) return result;
    // PR-1: the first max_images PNGs as MCP image content (a PNG over 4 MB is skipped; lower dpi for big sheets).
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const file of rendered.files.slice(0, args.max_images ?? 3)) {
      try {
        const size = fs.statSync(file).size;
        if (size > 4 * 1024 * 1024) continue;
        images.push({ type: "image", data: fs.readFileSync(file).toString("base64"), mimeType: "image/png" });
      } catch { /* a missing PNG is already in paths */ }
    }
    return { content: [...result.content, ...images], isError: false };
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcPdfReviewTool(server: McpServer) {
  server.tool("fmc_pdf_review", FMC_PDF_REVIEW_DESCRIPTION, FMC_PDF_REVIEW_SHAPE, async (args) => runFmcPdfReview(args as FmcPdfReviewArgs));
}
