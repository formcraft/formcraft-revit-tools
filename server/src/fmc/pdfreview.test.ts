import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PdfDoc, PdfPage, A4_LANDSCAPE } from "./pdf.js";
import { detectRenderer, inkFromOps, matchPageSize, pastBorder, reviewPages, safeImageDir, textOverlaps, type PageFact } from "./pdfreview.js";
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
