import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import {
  PDF_FIX, detectRenderer, inkFromOps, pngName, renderWith, reviewPages, safeImageDir, selectPages,
  type DrawOp, type PageFact, type Renderer, type RenderRequest,
} from "../fmc/pdfreview.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_PDF_REVIEW_DESCRIPTION =
  "Rasterize an exported PDF and check the pages. PNGs go to %LOCALAPPDATA%\\Formcraft\\images (never D:, never beside the model). " +
  "The renderer is pdftoppm, pdftocairo, Ghostscript, or FMC_PDFIUM. None of those is FMC-PDF-NO-RENDERER and no PNG is written. " +
  "Checks are blank page, page size (A0 to A4), missing title-block text, ink past the border, overlapping text, an empty drawing zone and fill percent. " +
  "Border, overlap, empty zone and fill use pdf.js text boxes and path operators. They do not need a raster renderer. " +
  "dpi defaults to 110. pages is optional and 1-based. " +
  "dry_run defaults to true: the checks run and the PNG paths are named, and nothing is written. dry_run false writes the PNGs. " +
  "This does not change a Revit model, so it does not take a batch lease. " +
  "Example: pdf_path C:\\\\Jobs\\\\_Staging\\\\A-101.pdf, pages [1], dpi 110, dry_run true.";

export const FMC_PDF_REVIEW_SHAPE = {
  pdf_path: z.string(),
  pages: z.array(z.number().int().positive()).optional(),
  dpi: z.number().positive().optional().default(110),
  dry_run: z.boolean().optional().default(true),
};

export type FmcPdfReviewArgs = z.infer<z.ZodObject<typeof FMC_PDF_REVIEW_SHAPE>>;

export interface PdfReviewIo {
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  facts?: PageFact[];
  renderer?: Renderer | null;
  lookup?: (cmd: string) => string | null;
  run?: (request: RenderRequest) => { ok: boolean; files: string[]; error?: string };
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

async function readFacts(file: string): Promise<PageFact[]> {
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
    for (let n = 1; n <= doc.numPages; n++) {
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
    }
    return pages;
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
    try {
      facts = io.facts ?? await readFacts(pdf);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply({ tool: "fmc_pdf_review", refused: true, code: "FMC-PDF-READ", message, paths: [] }, true);
    }
    const pages = selectPages(facts, args.pages);
    const checks = reviewPages(pages).map((row) => ({ ...row, png: path.win32.join(dir, pngName(pdf, row.page)) }));
    const dry = args.dry_run !== false;
    const renderer = io.renderer !== undefined ? io.renderer : detectRenderer(env, io.lookup);
    if (dry) {
      return reply({
        tool: "fmc_pdf_review",
        dry_run: true,
        read_only: true,
        dpi: args.dpi,
        image_dir: dir,
        renderer: renderer?.kind ?? null,
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
    return reply({
      tool: "fmc_pdf_review",
      dry_run: false,
      read_only: false,
      model_changed: false,
      dpi: args.dpi,
      image_dir: dir,
      renderer: renderer.kind,
      paths: rendered.files,
      checks: [...byPage.values()],
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcPdfReviewTool(server: McpServer) {
  server.tool("fmc_pdf_review", FMC_PDF_REVIEW_DESCRIPTION, FMC_PDF_REVIEW_SHAPE, async (args) => runFmcPdfReview(args as FmcPdfReviewArgs));
}
