import { test } from "node:test";
import assert from "node:assert/strict";
import { attrsOf, checkGbxml, countTags, elementsOf, geometryArea, parseGbxml, polygonArea } from "./gbxml.js";

const pt = (x: number, y: number, z: number) => `<CartesianPoint><Coordinate>${x}</Coordinate><Coordinate>${y}</Coordinate><Coordinate>${z}</Coordinate></CartesianPoint>`;
const loop = (pts: number[][]) => `<PlanarGeometry><PolyLoop>${pts.map((p) => pt(p[0], p[1], p[2])).join("")}</PolyLoop></PlanarGeometry>`;
const wallLoop = loop([[0, 0, 0], [4, 0, 0], [4, 0, 3], [0, 0, 3]]);

function file(surfaces: string, extra = "") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- <Surface id="commented-out"/> -->
<gbXML version="0.37" lengthUnit="Meters" areaUnit="SquareMeters" xmlns="http://www.gbxml.org/schema">
  <Campus id="cmps-1">
    <Building id="bldg-1" buildingType="Office">
      <Space id="sp-1"><Name>Office</Name><SpaceBoundary surfaceIdRef="su-1"/></Space>
      <Space id="sp-2"><Name>Store</Name></Space>
    </Building>
    ${surfaces}
  </Campus>
  <Construction id="c-wall"><Name>Wall</Name></Construction>
  <WindowType id="w-1"><Name>Glazing</Name></WindowType>
  ${extra}
</gbXML>`;
}

test("tag scan: attributes, names that are prefixes of others, counts", () => {
  assert.deepEqual(attrsOf(` id="a" surfaceType='ExteriorWall' constructionIdRef="c"`), { id: "a", surfaceType: "ExteriorWall", constructionIdRef: "c" });
  const xml = `<Space id="s"><SpaceBoundary surfaceIdRef="x"/></Space><Space id="t"/>`;
  assert.equal(elementsOf(xml, "Space").length, 2);
  assert.equal(countTags(xml, "Space"), 2);
  assert.equal(countTags(xml, "SpaceBoundary"), 1);
});

test("areas: polygon (Newell), rectangle fallback, unknown", () => {
  assert.equal(polygonArea([[0, 0, 0], [4, 0, 0], [4, 0, 3], [0, 0, 3]]), 12);
  assert.equal(polygonArea([[0, 0, 0], [1, 0, 0]]), 0);
  assert.equal(geometryArea(wallLoop), 12);
  assert.equal(geometryArea("<RectangularGeometry><Width>2</Width><Height>1.5</Height></RectangularGeometry>"), 3);
  assert.equal(geometryArea("<Name>x</Name>"), null);
});

test("a clean file passes, counts Campus, Building, Space, Surface, Opening", () => {
  const good = file(`
    <Surface id="su-1" surfaceType="ExteriorWall" constructionIdRef="c-wall">
      <AdjacentSpaceId spaceIdRef="sp-1"/>
      ${wallLoop}
      <Opening id="op-1" openingType="OperableWindow" windowTypeIdRef="w-1">${loop([[1, 0, 1], [2, 0, 1], [2, 0, 2], [1, 0, 2]])}</Opening>
    </Surface>
    <Surface id="su-2" surfaceType="InteriorWall" constructionIdRef="c-wall">
      <AdjacentSpaceId spaceIdRef="sp-1"/><AdjacentSpaceId spaceIdRef="sp-2"/>${wallLoop}
    </Surface>
    <Surface id="sh-1" surfaceType="Shade">${wallLoop}</Surface>`);
  const r = checkGbxml(good);
  assert.equal(r.status, "PASS");
  assert.equal(r.valid_root, true);
  assert.equal(r.length_unit, "Meters");
  assert.deepEqual(r.counts, { campus: 1, building: 1, space: 2, zone: 0, surface: 3, opening: 1, construction: 1, window_type: 1 });
  assert.equal(r.surface_types.Shade, 1);
  // The opening's own geometry is not the surface's.
  const p = parseGbxml(good);
  assert.equal(p.surfaces[0].area, 12);
  assert.equal(p.openings[0].area, 1);
  assert.deepEqual(p.surfaces[0].adjacent, ["sp-1"]);
});

test("flags no adjacent space, dangling space refs, zero areas and missing or undefined constructions", () => {
  const bad = file(`
    <Surface id="su-1" surfaceType="ExteriorWall">${wallLoop}</Surface>
    <Surface id="su-2" surfaceType="Roof" constructionIdRef="c-roof"><AdjacentSpaceId spaceIdRef="sp-9"/>${wallLoop}</Surface>
    <Surface id="su-3" surfaceType="InteriorWall" constructionIdRef="c-wall"><AdjacentSpaceId spaceIdRef="sp-1"/>${loop([[0, 0, 0], [1, 0, 0], [2, 0, 0]])}
      <Opening id="op-1" openingType="FixedWindow"><RectangularGeometry><Width>0</Width><Height>1</Height></RectangularGeometry></Opening>
    </Surface>
    <Surface id="air-1" surfaceType="Air"><AdjacentSpaceId spaceIdRef="sp-1"/>${wallLoop}</Surface>`);
  const r = checkGbxml(bad);
  assert.equal(r.status, "FAIL");
  assert.deepEqual(r.findings_by_code, {
    SURFACE_NO_ADJACENT_SPACE: 1, CONSTRUCTION_REF_MISSING: 1, ADJACENT_SPACE_MISSING: 1, CONSTRUCTION_NOT_DEFINED: 1, SURFACE_ZERO_AREA: 1, OPENING_ZERO_AREA: 1,
  });
  assert.equal(r.findings.find((f) => f.code === "ADJACENT_SPACE_MISSING")!.ref, "sp-9");
  assert.equal(checkGbxml(bad, 2).findings.length, 2);
  assert.equal(checkGbxml(bad, 2).findings_truncated, true);
});

test("not gbXML, and a gbXML with no surfaces", () => {
  assert.equal(checkGbxml("<html><body/></html>").status, "INVALID");
  assert.equal(checkGbxml("\uFEFF" + file("")).status, "EMPTY");
  assert.equal(checkGbxml(file("")).findings_by_code.NO_SURFACES, 1);
});
