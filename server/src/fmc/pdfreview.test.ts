import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PdfDoc, PdfPage, A4_LANDSCAPE } from "./pdf.js";
import { detectRenderer, matchPageSize, reviewPages, safeImageDir, type PageFact } from "./pdfreview.js";
import { FMC_PDF_REVIEW_SHAPE, runFmcPdfReview, type FmcPdfReviewArgs } from "../tools/fmc_pdf_review.js";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";

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
