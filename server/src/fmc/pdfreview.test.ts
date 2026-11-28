import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PdfDoc, PdfPage, A4_LANDSCAPE } from "./pdf.js";
import { detectRenderer, inkFromOps, matchPageSize, pageRuns, pagesNotFound, pastBorder, reviewPages, safeImageDir, sheetCheckRows, summarisePdf, textOverlaps, type PageFact } from "./pdfreview.js";
import { FMC_PDF_REVIEW_SHAPE, runFmcPdfReview, type FmcPdfReviewArgs } from "../tools/fmc_pdf_review.js";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import { runFmcPdfReview as runPdfReviewLive } from "../tools/fmc_pdf_review.js";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";

function args(partial: Record<string, unknown>): FmcPdfReviewArgs {
  return z.object(FMC_PDF_REVIEW_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

const pages: PageFact[] = [
  { page: 1, width_pt: 1190.55, height_pt: 841.89, text: "", boxes: [] },
  {
    page: 2,
    width_pt: 1190.55,
    height_pt: 841.89,
    text: "Plan A-101 Ground floor",
    boxes: [
      { x: 40, y: 700, w: 80, h: 10, text: "Plan" },
      { x: 980, y: 30, w: 80, h: 10, text: "A-101" },
    ],
  },
  {
    page: 3,
    width_pt: 1190.55,
    height_pt: 841.89,
    text: "just a note in the middle",
    boxes: [{ x: 400, y: 400, w: 100, h: 12, text: "just a note in the middle" }],
  },
];

test("layout flags ink past the border, overlapping text, an empty zone and fill without a renderer", () => {
  const ink = inkFromOps([
    { op: "rectangle", args: [2, 2, 20, 20] },
    { op: "transform", args: [1, 0, 0, 1, 100, 100] },
    { op: "rectangle", args: [0, 0, 30, 10] },
  ]);
  assert.equal(ink.length, 2);
  assert.ok(ink[0].x < 10);
  const page: PageFact = {
    page: 1,
    width_pt: 1190.55,
    height_pt: 841.89,
    text: "A A",
    boxes: [
      { x: 40, y: 400, w: 30, h: 12, text: "A" },
      { x: 50, y: 400, w: 30, h: 12, text: "A" },
    ],
    ink,
  };
  assert.equal(pastBorder(page), true);
  assert.equal(textOverlaps(page), 1);
  const checks = reviewPages([page]);
  assert.equal(checks[0].past_border, true);
  assert.equal(checks[0].text_overlaps, 1);
  assert.equal(checks[0].empty_drawing_zone, false);
  assert.ok(checks[0].fill_pct > 0);
  const empty = reviewPages([{ page: 2, width_pt: 1190.55, height_pt: 841.89, text: "", boxes: [], ink: [] }]);
  assert.equal(empty[0].empty_drawing_zone, true);
  assert.equal(empty[0].fill_pct, 0);
});

test("checks name a blank page, an A3 sheet and a missing title block", () => {
  assert.deepEqual(matchPageSize(1190.55, 841.89), { name: "A3", orientation: "landscape" });
  assert.equal(matchPageSize(100, 100), null);
  const checks = reviewPages(pages);
  assert.equal(checks[0]?.blank, true);
  assert.equal(checks[0]?.missing_titleblock_text, true);
  assert.equal(checks[1]?.blank, false);
  assert.equal(checks[1]?.page_size?.name, "A3");
  assert.equal(checks[1]?.missing_titleblock_text, false);
  assert.equal(checks[2]?.missing_titleblock_text, true);
});

test("a missing renderer is FMC-PDF-NO-RENDERER and a dry run writes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-pdf-"));
  const local = path.join(dir, "Local");
  fs.mkdirSync(local, { recursive: true });
  const pdf = path.join(dir, "A-101.pdf");
  const doc = new PdfDoc("A-101");
  const page: PdfPage = doc.page(A4_LANDSCAPE);
  page.text(700, 20, "A-101");
  fs.writeFileSync(pdf, doc.bytes());
  const env = { ...process.env, LOCALAPPDATA: local, APPDATA: path.join(dir, "Roaming"), USERPROFILE: dir } as NodeJS.ProcessEnv;
  const guard: GuardConfig = { ...DEFAULT_CONFIG, image_dir: "" };
  const dry = textOf(await runFmcPdfReview(args({ pdf_path: pdf, dpi: 110 }), { env, guard, facts: pages, renderer: null }));
  assert.equal(dry.dry_run, true);
  assert.equal(fs.existsSync(path.join(local, "Formcraft", "images")), false);
  assert.ok(String(dry.image_dir).includes("Formcraft"));
  assert.ok(!String(dry.image_dir).toLowerCase().startsWith("d:"));
  const live = textOf(await runFmcPdfReview(args({ pdf_path: pdf, pages: [2], dry_run: false }), { env, guard, facts: pages, renderer: null, lookup: () => null }));
  assert.equal(live.code, "FMC-PDF-NO-RENDERER");
  assert.deepEqual(live.paths, []);
  assert.equal((live.checks as unknown[]).length, 1);
  const rendered = textOf(await runFmcPdfReview(args({ pdf_path: pdf, pages: [2], dry_run: false }), {
    env, guard, facts: [pages[1]], renderer: { kind: "pdftoppm", command: "pdftoppm" },
    run: (request) => {
      fs.mkdirSync(request.dir, { recursive: true });
      const file = path.join(request.dir, "A-101-p2.png");
      fs.writeFileSync(file, Buffer.from([137, 80, 78, 71]));
      assert.notEqual(path.resolve(request.dir), path.resolve(path.dirname(pdf)));
      return { ok: true, files: [file] };
    },
  }));
  assert.equal(rendered.isError, false);
  assert.equal(path.basename(String(rendered.paths[0]).replace(/\\/g, "/")), "A-101-p2.png");
  assert.ok(!String(rendered.paths[0]).toLowerCase().startsWith("d:"));
  assert.equal(fs.existsSync(String(rendered.paths[0])), true);
  assert.equal(detectRenderer(env, () => null), null);
  const image = safeImageDir({ image_dir: "D:\\shots" }, pdf, env);
  assert.ok(!image.toLowerCase().startsWith("d:"));
});

function tinyPdf(): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 12 Tf 500 40 Td (A-101 TEST) Tj ET";
  objs[3] = "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream";
  let out = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + " 0 obj\n" + o + "\nendobj\n"; });
  const xref = out.length;
  out += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n" + offs.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("");
  out += "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(out, "latin1");
}

test("fmc_pdf_review reads a real PDF with the shipped pdfjs (Windows path of import.meta.url, live test 23 Nov 2026)", async () => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "fmc-pdf-"));
  const file = nodePath.join(dir, "A-101.pdf");
  nodeFs.writeFileSync(file, tinyPdf());
  const env = { ...process.env, LOCALAPPDATA: dir };
  const res = await runPdfReviewLive({ pdf_path: file, pages: [1], dpi: 110, dry_run: true }, { env, guard: {} as never, renderer: null });
  const body = JSON.parse(res.content[0].text);
  assert.notEqual(body.code, "FMC-PDF-READ", body.message);
  assert.equal(body.dry_run, true);
  assert.equal(body.checks.length, 1);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

function vectorPdf(): Buffer {
  const stream = "0 0 1 rg 100 100 m 400 100 l 400 300 l 100 300 l h f 1 0 0 1 5 5 cm 200 200 100 50 re S";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.89 595.28] /Contents 4 0 R >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
  ];
  let out = "%PDF-1.4\n"; const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + " 0 obj\n" + o + "\nendobj\n"; });
  const xref = out.length;
  out += "xref\n0 " + (objs.length + 1) + "\n0000000000 65535 f \n" + offs.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("");
  out += "trailer\n<< /Size " + (objs.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(out, "latin1");
}

test("PR-21/PR-6: a vector-only page read with pdf.js 6 has ink and is not blank; pages not in the PDF are listed", async () => {
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "fmc-pdf-"));
  const file = nodePath.join(dir, "Logo.pdf");
  nodeFs.writeFileSync(file, vectorPdf());
  const env = { ...process.env, LOCALAPPDATA: dir };
  const res = await runPdfReviewLive(args({ pdf_path: file, pages: [1, 7] }), { env, guard: {} as never, renderer: null });
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.checks.length, 1);
  assert.equal(body.checks[0].has_ink, true);
  assert.equal(body.checks[0].blank, false);
  assert.ok(body.checks[0].fill_pct > 0);
  assert.deepEqual(body.pages_not_found, [7]);
  assert.equal(body.page_count, 1);
  assert.equal(body.summary.verdict, "CHECK");
  const again = JSON.parse((await runPdfReviewLive(args({ pdf_path: file, pages: [1] }), { env, guard: {} as never, renderer: null })).content[0].text);
  assert.equal(again.cached_pages, 1);
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

test("PR-15/PR-20/PR-18: page runs, the overlap sweep and the summary line", () => {
  assert.deepEqual(pageRuns([50, 1, 2, 3, 2]), [[1, 3], [50, 50]]);
  assert.deepEqual(pagesNotFound(3, [0, 2, 4]), [0, 4]);
  const boxes = Array.from({ length: 60 }, (_, i) => ({ x: (i % 10) * 30, y: Math.floor(i / 10) * 8, w: 40, h: 10, text: "t" + i }));
  const page: PageFact = { page: 1, width_pt: 1190.55, height_pt: 841.89, text: "x", boxes };
  let brute = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]; const b = boxes[j];
    if (a.x < b.x + b.w - 0.2 && b.x < a.x + a.w - 0.2 && a.y < b.y + b.h - 0.2 && b.y < a.y + a.h - 0.2) brute += 1;
  }
  assert.equal(textOverlaps(page), brute);
  const ink = inkFromOps([{ op: "transform", args: [1, 0, 0, 1, 10, 20] }, { op: "bounds", args: [0, 0, 5, 5] }]);
  assert.deepEqual(ink, [{ x: 10, y: 20, w: 5, h: 5 }]);
  const checks = reviewPages(pages);
  const summary = summarisePdf(checks, []);
  assert.equal(summary.verdict, "CHECK");
  assert.deepEqual(summary.blank, [1]);
  assert.ok(summary.line.startsWith("CHECK: 3 page(s) checked"));
  assert.equal(summarisePdf([], []).verdict, "NO_PAGES");
  const rows = sheetCheckRows("C:\\x\\A-101.pdf", checks, "2026-11-28T09:00:00.000Z");
  assert.equal(rows.length, 3);
  assert.equal(rows[0][1], "A-101.pdf");
});

test("PR-23/PR-1: record appends SheetChecks rows to the Exchange folder and return_images returns PNG content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-pdf-"));
  const local = path.join(dir, "Local");
  const reports = path.join(dir, "Reports");
  const pdf = path.join(dir, "A-101.pdf");
  fs.writeFileSync(pdf, tinyPdf());
  const env = { ...process.env, LOCALAPPDATA: local, APPDATA: path.join(dir, "Roaming"), USERPROFILE: dir } as NodeJS.ProcessEnv;
  const guard: GuardConfig = { ...DEFAULT_CONFIG, image_dir: "", reports_dir: reports } as GuardConfig;
  const io = {
    env, guard, facts: [pages[1]], renderer: { kind: "pdftoppm" as const, command: "pdftoppm" }, now: () => new Date("2026-11-28T09:00:00Z"),
    run: (request: { dir: string }) => {
      fs.mkdirSync(request.dir, { recursive: true });
      const file = path.join(request.dir, "A-101-p2.png");
      fs.writeFileSync(file, Buffer.from([137, 80, 78, 71]));
      return { ok: true, files: [file] };
    },
  };
  const dry = textOf(await runFmcPdfReview(args({ pdf_path: pdf, pages: [2], record: true }), io));
  assert.equal(dry.table.written, false);
  const table = path.join(reports, "Exchange", "Tables", "FMC_SheetChecks.csv");
  assert.equal(fs.existsSync(table), false);
  const live = await runFmcPdfReview(args({ pdf_path: pdf, pages: [2], dry_run: false, record: true, return_images: true }), io);
  const body = textOf(live);
  assert.equal(body.table.written, true, JSON.stringify(body.table));
  const lines = fs.readFileSync(table, "utf8").trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("reviewed_at,pdf,page"));
  const content = live.content as Array<{ type: string; mimeType?: string }>;
  assert.equal(content.length, 2);
  assert.equal(content[1].type, "image");
  assert.equal(content[1].mimeType, "image/png");
  fs.rmSync(dir, { recursive: true, force: true });
});
