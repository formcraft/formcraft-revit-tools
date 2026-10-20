import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIKENESS_CHECK, Likeness, Reference, likenessLine, referenceLine } from "./likeness.js";
import { parseRhinoRulebook } from "../hub/rhino.js";

const PROPOSALS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "kit-proposals");
const BOOK = parseRhinoRulebook(fs.readFileSync(path.join(PROPOSALS, "FMC_Rulebook_Rhino.json"), "utf8")).book!;
const src = (kind: string, n: number) => ({ url: `https://example.com/${kind}${n}`, kind, fetched: true });
const ref: Reference = {
  family: "FMC_I_Furniture_Sofa_MidCentury",
  sources: [src("listing", 1), src("listing", 2)],
  views: [{ view: "front", image: "f.png" }, { view: "side", image: "s.png" }, { view: "iso", image: "i.jpg" }, { view: "top", image: "t.png", kind: "generated" }],
  dimensions: { Width: { value: 2100, source_status: "verified", source: "listing1" }, Height: { value: 813, source_status: "verified", source: "listing2" },
    "Seat height": { value: 489, source_status: "verified", source: "listing2" } },
  materials: [{ part: "Frame", material: "walnut", evidence: "listing1" }],
  features: ["Bent-wood side panel", "Paddle arm", "Front rail", "Splayed legs", "Tufted back"].map((name) => ({ name })),
};
const round = (over: Partial<Likeness["rounds"][0]> = {}): Likeness => ({ family: ref.family, rounds: [{
  round: 1, from: "revit", reviewer: { who: "reviewer agent", blind: true },
  views: ["front", "side", "iso"].map((view) => ({ view, iou: 0.86, aspect_diff: 0.03 })),
  features: ref.features!.map((f) => ({ name: f.name, present: true })), ...over }] });

test("owner 20 Oct: a family from a picture needs real-life evidence; generated views don't count", () => {
  assert.equal(referenceLine(null, BOOK).state, "Not checked");
  assert.equal(referenceLine(ref, BOOK).state, "Pass");
  const thin = referenceLine({ ...ref, views: ref.views!.slice(2), sources: [src("photo", 1)], materials: [{ part: "Seat", material: "velvet" }] }, BOOK);
  assert.equal(thin.state, "Fail");
  assert.match(thin.detail, /1 real views of 3/);
  assert.match(thin.detail, /0 fetched/);
  assert.match(thin.detail, /no evidence for Seat \(velvet\)/);
  assert.equal(referenceLine(ref, null).state, "Fail");
});

test("owner 20 Oct: before release the Revit family matches every view and every feature, by a blind reviewer", () => {
  assert.equal(likenessLine(ref, round(), BOOK).state, "Pass");
  assert.match(likenessLine(ref, null, BOOK).detail, /Not compared from revit/);
  const off = likenessLine(ref, round({ views: [{ view: "front", iou: 0.6, aspect_diff: 0.2 }, { view: "side", iou: 0.9 }, { view: "iso", iou: null, note: "room photo" }] }), BOOK);
  assert.equal(off.check, LIKENESS_CHECK);
  assert.match(off.detail, /front outline overlap 0\.60 < 0\.8/);
  assert.match(off.detail, /proportions off by 20%/);
  assert.match(off.detail, /iso: outline not measurable \(room photo\), judged by the reviewer/);
  const missing = likenessLine(ref, round({ features: [{ name: "Paddle arm", present: true }], reviewer: { who: "builder", blind: false } }), BOOK);
  assert.match(missing.detail, /features missing or not reviewed: Bent-wood side panel/);
  assert.match(missing.detail, /no blind review/);
  const rhinoOnly = likenessLine(ref, { family: ref.family, rounds: [{ ...round().rounds[0], from: "rhino" }] }, BOOK);
  assert.match(rhinoOnly.detail, /Not compared from revit/);
  const many = { family: ref.family, rounds: Array.from({ length: 6 }, (_, i) => ({ ...round({ features: [] }).rounds[0], round: i + 1 })) };
  assert.match(likenessLine(ref, many, BOOK).detail, /6 rounds without a match: stop and give it to a person/);
});
