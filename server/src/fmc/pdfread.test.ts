import { test } from "node:test";
import assert from "node:assert/strict";
import { findIn, indexPages, isShifted, paragraph, unshiftChar } from "./pdfread.js";

test("PDF reader (owner 27 Oct): shifted gazette fonts decode, spaces stay spaces, small capitals and ligatures too", () => {
  const dec = (s: string) => [...s].map(unshiftChar).join("");
  assert.equal(dec("7LWOH"), "Title");
  assert.equal(dec(String.fromCharCode(21, 19, 19) + "PP"), "200mm");     // digits sit on control codes
  assert.equal(dec("a b"), "a b".replace("a", unshiftChar("a")).replace("b", unshiftChar("b")));
  assert.equal(unshiftChar(" "), " ");
  assert.equal(dec("3\u0d7a\u0d8b\u0d8d"), "Part");                       // small capitals
  assert.equal(unshiftChar("\u00bf"), "fi");
  assert.ok(isShifted({ chars: 1000, ctrl: 190 }));
  assert.ok(!isShifted({ chars: 1000, ctrl: 0 }));
});

test("PDF reader: one index per document, words to pages and paragraph numbers to their body copy", () => {
  const pages = ["Contents\n41. Stairs.\n43. Bannisters.", "41. Stairs.\nminimum width of 900mm\nmaximum rise 175mm\n42. Dimensional requirements.", "43. Bannisters.\nnot less than 900mm at landings"];
  const doc = { pages, ...indexPages(pages) };
  assert.deepEqual(doc.words["900mm"] ?? doc.words["900"], [2, 3]);
  assert.equal(paragraph(doc, "41")!.page, 2);
  assert.match(paragraph(doc, "41")!.text, /900mm[\s\S]*175mm/);
  assert.doesNotMatch(paragraph(doc, "41")!.text, /Dimensional/);
  const hits = findIn(doc, "landings 900mm");
  assert.equal(hits[0].page, 3); assert.equal(hits[0].hits, 2);
});
