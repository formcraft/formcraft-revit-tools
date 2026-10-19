import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Run, Standards, compute, costs, layoutRun, readLibrary } from "./casework.js";
import { workshopPackPdf, wrap } from "./casework_pdf.js";
import { PdfDoc, fit, textWidth, winAnsi } from "./pdf.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../src/fmc/fixtures/cw_kitchen.json"), "utf8"));
const S = FIX.standards as Standards;
const RUN = FIX.run as Run;

/** Checks a PDF's skeleton: header, every xref offset lands on its object, the trailer points at the xref. */
function checkPdf(buf: Buffer): { pages: number; text: string } {
  const s = buf.toString("latin1");
  assert.ok(s.startsWith("%PDF-1.4\n"));
  assert.ok(s.endsWith("%%EOF\n"));
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)![1]);
  assert.equal(s.slice(startxref, startxref + 4), "xref");
  const head = /xref\n0 (\d+)\n/.exec(s.slice(startxref))!;
  const count = Number(head[1]);
  const entries = s.slice(startxref + head[0].length).split("\n").slice(1, count);
  entries.forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1} is where the xref says`);
  });
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length, len = Number(m[1]);
    assert.equal(s.slice(start + len, start + len + 10), "\nendstream", "stream lengths are exact");
  }
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)![1]);
  assert.equal((s.match(/\/Type \/Page /g) ?? []).length, pages);
  return { pages, text: s };
}

test("pdf writer: a valid file, exact offsets, escaped text in WinAnsi, the same bytes every time", () => {
  const make = () => {
    const d = new PdfDoc("Test (1)");
    d.page().text(40, 500, "Side (2) 720 × 560 — ok \\ 75 %").rect(40, 40, 100, 50, 0.9).line(0, 0, 10, 10);
    d.page([595, 842]).text(40, 40, "Second", { bold: true, align: "right" });
    return d.bytes();
  };
  const a = make();
  assert.ok(a.equals(make()));
  const { pages, text } = checkPdf(a);
  assert.equal(pages, 2);
  assert.ok(text.includes("(Side \\(2\\) 720 \\327 560 \\227 ok \\\\ 75 %) Tj"));
  assert.ok(text.includes("/MediaBox [0 0 595 842]"));
  assert.ok(text.includes("/BaseFont /Helvetica-Bold"));
});

test("pdf text: Helvetica widths, fitting and WinAnsi", () => {
  assert.equal(Math.round(textWidth("Hello", 10) * 100) / 100, 22.78);
  assert.ok(textWidth("Hello", 10, true) > textWidth("Hello", 10));
  assert.equal(fit("short", 9, 100), "short");
  const cut = fit("FMC_Board_Plywood_Marine18 and more", 9, 60);
  assert.ok(cut.endsWith("…") && textWidth(cut, 9) <= 60);
  assert.deepEqual(winAnsi("€≥✓☃"), [0x80, 62, 61, 118, 63]);
  assert.deepEqual(wrap("one two three four five", 9, 40), ["one two", "three four", "five"]);
});

test("workshop pack PDF: summary, elevations, the cut list per mark, a nesting page per sheet, hardware and cost with sources", () => {
  const l = layoutRun(RUN, S);
  const c = compute(l.units, l, S);
  const lib = readLibrary({ materials: [
    { name: "FMC_Board_Plywood_Marine18", price: { ugx: "60,000-90,000", unit: "per 8x4 ft sheet, 18 mm", date: "2026-10", source: "https://jiji.ug/building-materials?query=plywood", status: "secondary" } },
    { name: "FMC_Board_MDF_Raw", price: null }, { name: "FMC_Stone_Granite_Black_Polished", price: null }] });
  const cost = costs({ boards: c.nests.map((n) => ({ material: n.material, sheets: n.sheets.length })), edge_m: c.edge_m, worktop_m: c.worktop_m, hardware: c.hardware }, S, lib);
  const input = { code: "HA", label: "K-01 Kitchen", casework: c, cost, standards: S, standards_from: "the call (the kit has none)" };
  const pdf = workshopPackPdf(input);
  assert.ok(pdf.equals(workshopPackPdf(input)), "the same pack gives the same bytes");
  const { pages, text } = checkPdf(pdf);
  // 15 nesting pages, one per sheet, plus summary, elevations, cut list and hardware/cost
  const nestPages = (text.match(/\(Nesting\) Tj/g) ?? []).length;
  assert.equal(nestPages, 15);
  assert.ok(pages >= 19 && pages <= 30, `${pages} pages`);
  for (const sheet of ["FMC_Board_Plywood_Marine18 \\227 sheet 9 of 9", "FMC_Board_MDF_Back6 \\227 sheet 3 of 3", "FMC_Board_MDF_Raw \\227 sheet 1 of 3"])
    assert.ok(text.includes(`(${sheet})`), sheet);
  // every nested piece is drawn as a filled rectangle on its sheet's page (120 pieces)
  const nestSection = text.slice(text.indexOf("(Nesting) Tj"), text.indexOf("(Hardware and cost) Tj"));
  assert.equal((nestSection.match(/ re B 0 g/g) ?? []).length, 120);
  // the cut list names each assembly mark; cost keeps its source and says price needed
  for (const mark of ["K01", "K02", "K05", "W06"]) assert.ok(new RegExp(`\\(${mark}  `).test(text), mark);
  assert.ok(text.includes("(price needed)"));
  assert.ok(text.includes("(UGX 540,000\\226810,000)"));
  assert.ok(text.includes("(secondary)"));
  assert.ok(text.includes("Kit change requests"));
  assert.ok(text.includes("aren't"), "no Revit sheets yet: the summary says so");
  const withShop = checkPdf(workshopPackPdf({ ...input, shop_drawings: "HA_Casework_K-01-Kitchen_ShopDrawings.pdf" })).text;
  assert.ok(withShop.includes("HA_Casework_K-01-Kitchen_ShopDrawings.pdf"));
});
