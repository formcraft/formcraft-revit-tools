import { test } from "node:test";
import assert from "node:assert/strict";
import { AnnotationFacts, checkAnnotation, parseStandard } from "./annotation.js";

const standard = parseStandard({
  version: "1.0", source: "STD 6, MAN 9.14",
  pens: [{ pen: 1, width_mm: 0.1, used_for: "Hatch, hidden" }, { pen: 6, width: 0.5, use: "Heavy cut, sheet frame" }],
  line_patterns: ["FMC_Dash", { name: "FMC_CentreLine" }],
  text_types: [{ name: "FMC_Arial_2.5", font: "Arial", size_mm: 2.5 }],
  text_pattern: "^FMC_Arial_\\d",
  dimension_styles: [{ name: "FMC_Linear_2.5", status: "proposed" }],
  colours: [{ name: "Formcraft Orange", hex: "#E8742A" }],
});

const facts: AnnotationFacts = {
  model: "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt",
  text_types: [{ id: 1, name: "FMC_Arial_2.5", font: "Arial", size_mm: 2.5 }, { id: 2, name: "FMC_Arial_3.5", font: "Arial", size_mm: 3.5 },
               { id: 3, name: "Generic 2.5", font: "Arial", size_mm: 2.5 }],
  line_patterns: [{ id: 10, name: "Solid" }, { id: 11, name: "FMC_Dash" }, { id: 12, name: "Dash 1/8\"" }],
  dimension_types: [{ id: 20, name: "Linear - 2.5mm Arial" }],
  tag_families: [{ id: 30, name: "FMC_TAG_A_Door", category: "Door Tags" }, { id: 31, name: "M_Window Tag", category: "Window Tags" }],
};

test("the standard reads tolerantly (width/use, names as strings or objects)", () => {
  assert.equal(standard.pens[1].width_mm, 0.5);
  assert.equal(standard.pens[1].used_for, "Heavy cut, sheet frame");
  assert.deepEqual(standard.line_patterns, ["FMC_Dash", "FMC_CentreLine"]);
  assert.equal(standard.tag_pattern, "^FMC_TAG_[A-Z]{1,2}_[A-Za-z0-9]+$");
});

test("the check finds text, patterns, dimensions and tags outside the standard", () => {
  const c = checkAnnotation(facts, standard);
  assert.deepEqual(c.map((x) => `${x.found} ${x.state}`), ["1 Fail", "1 Fail", "1 Proposed", "1 Fail"]);
  assert.deepEqual(c[0].items, ["Generic 2.5"]);
  assert.deepEqual(c[1].ids, [12]);
  assert.deepEqual(c[3].items, ["M_Window Tag"]);
});

test("without the standard every line says Not checked", () => {
  assert.ok(checkAnnotation(facts, null).every((c) => c.state === "Not checked"));
});
