import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The add-in cannot be built or run without the Revit API (R25), so these read its source and pin the shape of each fix.
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(repo, "commandset", ...p), "utf8");
const section = (src: string, from: string, to?: string) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `${from} not found`);
  const b = to ? src.indexOf(to, a + from.length) : -1;
  return src.slice(a, b > 0 ? b : undefined);
};

const vision = read("Services", "Fmc", "FmcVision.cs");
const modelEdit = read("Services", "Fmc", "FmcModelEdit.cs");
const material = read("Models", "DataExtraction", "MaterialQuantityModel.cs");

test("(c) model_check duplicates: an unbound curve is keyed without GetEndPoint, and one odd element never fails the check", () => {
  const key = section(vision, "private static string CurveKey(Curve c)", "private JObject Duplicates");
  assert.match(key, /if \(c\.IsBound\)[\s\S]*GetEndPoint/, "ends are read only from a bound curve");
  assert.match(key, /unbound-line/);
  assert.match(key, /unbound-arc/);
  const dup = section(vision, "private JObject Duplicates(List<Element> model)", "private JObject Rooms");
  assert.match(dup, /CurveKey\(lc\.Curve\) \?\? BoxKey\(e\)/, "an unkeyable curve falls back to the box");
  assert.match(dup, /try\s*\{[\s\S]*e\.Location switch[\s\S]*\}\s*catch \(Exception\)\s*\{\s*at = null;/, "a throwing element is skipped");
  assert.doesNotMatch(dup, /lc\.Curve\.GetEndPoint/, "the duplicates check never reads ends of a curve directly");
  assert.match(vision, /void Run\(string name, Func<JObject> check\)[\s\S]*check_failed/, "each check still runs under the catch-all");
});

test("(d) get_element_geometry returns location, level elevation and bounding box in mm", () => {
  const g = section(modelEdit, "private static JObject Geometry(Document doc, Element e)", "if (e is Wall w)");
  for (const f of ["location_mm", "level_elevation_mm", "bbox_mm", "bbox_min_mm", "bbox_max_mm", "point_mm", "start_mm", "end_mm"]) assert.ok(g.includes(`"${f}"`), `${f} is in the payload`);
  assert.match(g, /lvl\.Elevation \* 304\.8/, "elevation is feet to mm");
  assert.match(g, /FAMILY_LEVEL_PARAM/, "an element without a LevelId still gets its level from its parameter");
  assert.match(g, /lc\.Curve\.IsBound/, "an unbound location curve does not throw");
  assert.match(modelEdit, /\["units"\] = "mm"/);
});

test("(e) model_check and get_element_geometry say read_only true; the document's own flag has its own name", () => {
  assert.match(vision, /\["read_only"\] = true, \["document_read_only"\] = doc\.IsDetached/);
  assert.match(modelEdit, /\["read_only"\] = true, \["document_read_only"\] = doc\.IsDetached[^;]*\["units"\] = "mm"/);
  assert.doesNotMatch(vision, /\["read_only"\] = doc\./);
  assert.doesNotMatch(modelEdit, /\["read_only"\] = doc\./);
});

test("(e) audit: no read-only tool in the add-in sets read_only from the document's state", () => {
  // Remaining doc-state uses are documents' own properties (FmcHw document listing, FmcTarget.Resolved), not a tool flag.
  const files = ["Services/Fmc/FmcClashWork.cs", "Services/Fmc/FmcTags.cs", "Services/Fmc/FmcDims.cs", "Services/Fmc/FmcBatchUndo.cs", "Services/Fmc/FmcHeadroom.cs",
    "Services/Fmc/FmcDocsWork.cs", "Services/Fmc/FmcFamilyParams.cs", "Services/Fmc/FmcJoins.cs", "Services/Fmc/FmcPhase.cs", "Services/Fmc/FmcTrace.cs"];
  for (const f of files) {
    const src = read(...f.split("/"));
    assert.doesNotMatch(src, /\["read_only"\]\s*=\s*(?!true\b)(?!false\b)\s*doc/, `${f}: read_only is not the document's state`);
  }
  for (const f of ["Services/Fmc/FmcPhaseApply.cs", "Services/Fmc/FmcJoinsApply.cs", "Services/Fmc/FmcNorthApply.cs", "Services/Fmc/FmcDetailsApply.cs", "Services/Fmc/FmcTraceApply.cs"])
    assert.match(read(...f.split("/")), /read_only"\]\s*=\s*false/, `${f}: a write says false`);
});

test("(f) get_material_quantities carries m² and m³ and names its units", () => {
  assert.match(material, /JsonProperty\("areaM2"\)[\s\S]*Area \* MaterialUnits\.SquareMetresPerSquareFoot/);
  assert.match(material, /JsonProperty\("volumeM3"\)[\s\S]*Volume \* MaterialUnits\.CubicMetresPerCubicFoot/);
  assert.match(material, /JsonProperty\("totalAreaM2"\)/);
  assert.match(material, /JsonProperty\("totalVolumeM3"\)/);
  assert.match(material, /JsonProperty\("units"\)/);
  assert.match(material, /"m²"/);
  assert.match(material, /"m³"/);
});

test("(f) the unit factors are right", () => {
  const sq = Number(/SquareMetresPerSquareFoot = ([\d.]+);/.exec(material)![1]);
  const cu = Number(/CubicMetresPerCubicFoot = ([\d.]+);/.exec(material)![1]);
  assert.equal(sq, 0.3048 * 0.3048);
  assert.ok(Math.abs(cu - 0.3048 ** 3) < 1e-12);
});
