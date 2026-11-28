import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boxesOverlap, cacheStatus, linkMatches, modelRole, readCacheLines, resolveLinkRequest, scanChunks, summariseHits, transformAabb, transformPoint, writeClashCache, type Aabb, type CacheHeader } from "./clashscan.js";
import { DEFAULT_CLASH_CATEGORIES, centrelineHitsBox, classifyHit, defaultClashPairs, importLegacy, sleevesNear } from "./clashfilter.js";
import { runFmcClash } from "../tools/fmc_clash.js";

function box(id: number, min: number[], max: number[], category: string): Aabb {
  return { id, category, min, max };
}

test("chunks still find a hit that sits on a chunk boundary, and an element is not paired with itself", () => {
  const left = [
    box(1, [0, 0, 0], [10, 10, 10], "OST_Walls"),
    box(2, [100, 0, 0], [110, 10, 10], "OST_Walls"),
  ];
  const right = [
    box(3, [9, 0, 0], [12, 2, 2], "OST_DuctCurves"),
    box(4, [500, 0, 0], [510, 10, 10], "OST_DuctCurves"),
  ];
  assert.equal(boxesOverlap(left[0], right[0], 0), true);
  assert.equal(boxesOverlap(left[1], right[1], 0), false);
  const scan = scanChunks(left, right, 1, 0);
  assert.equal(scan.hits.length, 1);
  assert.equal(scan.hits[0].a, 1);
  assert.equal(scan.hits[0].b, 3);
  assert.ok(scan.chunks >= 2);
  const self = scanChunks(left, left, 1, 0, true);
  assert.equal(self.hits.some((hit) => hit.a === hit.b), false);
  const summary = summariseHits(scan.hits, 10);
  assert.equal(summary.count, 1);
});

test("the clash tool is read-only and keeps the host report", async () => {
  const result = await runFmcClash({
    action: "scan", document: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
    pairs: [{ a: "OST_Walls", b: "OST_DuctCurves" }],
    categories: [], link: "", source: "", meshes: false, mesh_cap: 24,
    centreline: false, clearance_mm: 0, radius_mm: 300,
    chunk: 250, tolerance_mm: 0, exact: false, include_links: true, max_hits: 100, sample_limit: 10,
  }, {
    read: async () => ({
      count: 2, chunks: 4, compared: 80, truncated: false, peak_working_set_mb: 410.5,
      report: "C:\\Temp\\Formcraft\\clash\\clash.jsonl",
      sample: [{ a: 1, b: 2, category_a: "OST_Walls", category_b: "OST_DuctCurves", overlap: true }],
      resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", path: "" },
    }),
  });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.read_only, true);
  assert.equal(body.applied, false);
  assert.equal(body.hits, 2);
  assert.equal(body.peak_working_set_mb, 410.5);
  assert.match(body.report, /clash.jsonl/);
});

const c = Math.SQRT1_2;

test("a rotated link box uses every corner, not only the min and max", () => {
  const xform = { origin: [0, 0, 0], x: [c, c, 0], y: [-c, c, 0], z: [0, 0, 1] };
  assert.deepEqual(transformPoint([1, 0, 0], xform).map((n) => Math.round(n * 1000) / 1000), [Math.round(c * 1000) / 1000, Math.round(c * 1000) / 1000, 0]);
  const box = transformAabb([0, 0, 0], [1, 1, 0], xform);
  assert.ok(box.min[0] < -0.5, "the rotated corner is left of the origin");
  assert.ok(box.max[0] > 0.5);
  const shifted = transformAabb([0, 0, 0], [1, 0, 0], { origin: [10, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
  assert.deepEqual(shifted.min, [10, 0, 0]);
  assert.deepEqual(shifted.max, [11, 0, 0]);
  assert.ok(Math.abs(box.max[1] - (c * 2)) < 1e-9);
  const twoCornersOnly = transformAabb([0, 0, 0], [1, 1, 0], { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
  assert.deepEqual(twoCornersOnly.min, [0, 0, 0]);
  assert.equal(modelRole("F26901-FMC-ZZ-ZZ-M3-S-0001_USER"), "S");
  assert.equal(linkMatches("S", { name: "F26901-FMC-ZZ-ZZ-M3-S-0001.rvt", title: "" }), true);
  assert.equal(linkMatches("S", { name: "F26901-FMC-ZZ-ZZ-M3-A-0002.rvt" }), false);
  const unloaded = resolveLinkRequest("S", [{ name: "F26901-FMC-ZZ-ZZ-M3-S-0001.rvt", loaded: false }]);
  assert.equal(unloaded.ok, false);
  if (!unloaded.ok) assert.equal(unloaded.code, "FMC-LINK-NOT-LOADED");
});

test("a clash cache records age and goes STALE when the source file is newer, and it is not written on D:", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-clash-cache-"));
  const header: CacheHeader = {
    kind: "fmc_clash_cache",
    doc_title: "F26901-FMC-ZZ-ZZ-M3-S-0001",
    path: path.join(dir, "S-0001.rvt"),
    saved_at: "2026-11-01T00:00:00.000Z",
    written_at: "2026-11-02T00:00:00.000Z",
    categories: ["OST_StructuralColumns"],
    mesh_cap: 2,
  };
  fs.writeFileSync(header.path, "rvt");
  const stamped = new Date(header.written_at);
  fs.utimesSync(header.path, stamped, new Date(header.saved_at));
  const file = writeClashCache(dir, header, [{
    id: 7, unique_id: "abc", category: "OST_StructuralColumns", min: [0, 0, 0], max: [100, 100, 100], version: "v1",
    mesh: [[[0, 0, 0], [1, 0, 0], [0, 1, 0]]],
  }]);
  const read = readCacheLines(file);
  assert.equal(read.header.doc_title, header.doc_title);
  assert.equal(read.elements[0].unique_id, "abc");
  assert.equal(read.elements[0].mesh?.length, 1);
  const fresh = cacheStatus(read.header, Date.parse("2026-11-03T00:00:00.000Z"), fs.statSync(header.path).mtimeMs);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.age_ms, 86400000);
  fs.utimesSync(header.path, stamped, new Date("2026-11-04T00:00:00.000Z"));
  const stale = cacheStatus(read.header, Date.parse("2026-11-05T00:00:00.000Z"), fs.statSync(header.path).mtimeMs);
  assert.equal(stale.stale, true);
  assert.match(stale.warning ?? "", /STALE/);
  assert.throws(() => writeClashCache("D:\\Formcraft\\clash\\cache", header, []), /D:/);
});

test("the default categories include plumbing equipment, site, generic model and speciality equipment", () => {
  for (const name of ["OST_PlumbingEquipment", "OST_Site", "OST_GenericModel", "OST_SpecialityEquipment", "OST_DuctCurves", "OST_StructuralColumns"]) {
    assert.ok(DEFAULT_CLASH_CATEGORIES.includes(name as typeof DEFAULT_CLASH_CATEGORIES[number]), name);
  }
  assert.ok(defaultClashPairs().some((pair) => pair.a === "OST_Walls" && pair.b === "OST_PlumbingEquipment"));
});

test("openings, joins, hosts and centrelines change the hit status", () => {
  const wall = { min: [0, 0, 0], max: [200, 3000, 3000] };
  const pipe = { min: [50, 1000, 1000], max: [150, 1100, 1100] };
  const cleared = classifyHit({
    a: 1, b: 2, category_a: "OST_Walls", category_b: "OST_PipeCurves", box_a: wall, box_b: pipe,
  }, [{ id: 9, host_id: 1, min: [0, 900, 900], max: [250, 1300, 1300] }]);
  assert.equal(cleared.status, "cleared_by_opening");
  assert.equal(cleared.opening_id, 9);
  assert.equal(classifyHit({ a: 3, b: 4, category_a: "OST_PipeCurves", category_b: "OST_PipeFitting", box_a: pipe, box_b: pipe, joined: true }).status, "join");
  assert.equal(classifyHit({ a: 5, b: 1, category_a: "OST_ElectricalFixtures", category_b: "OST_Walls", box_a: pipe, box_b: wall, host_of_a: 1 }).status, "hosted");
  assert.equal(classifyHit({ a: 8, b: 1, category_a: "OST_DuctCurves", category_b: "OST_Walls", box_a: pipe, box_b: wall, centreline_miss: true }).status, "clearance");
  assert.equal(centrelineHitsBox([0, 0, 0], [1000, 0, 0], { min: [400, -10, -10], max: [500, 10, 10] }, 0), true);
  assert.equal(centrelineHitsBox([0, 0, 0], [1000, 0, 0], { min: [400, 500, 0], max: [500, 600, 100] }, 20), false);
  const near = sleevesNear([
    { id: 9, host_id: 1, kind: "opening", min: [0, 0, 0], max: [100, 100, 100] },
    { id: 12, host_id: 4, kind: "sleeve", name: "pipe sleeve", min: [5000, 0, 0], max: [5100, 100, 100] },
  ], { point: [40, 40, 40], radius_mm: 200, a: 1 });
  assert.deepEqual(near.map((item) => item.id), [9]);
});

test("a legacy millimetre export becomes a cache without scaling", () => {
  const imported = importLegacy({
    doc: "F26901-FMC-ZZ-ZZ-M3-S-0001",
    captured_at: "2026-11-01T00:00:00.000Z",
    elements: [{ id: 4, category: "OST_StructuralColumns", bbox_mm: { min: [0, 0, 0], max: [400, 400, 3000] } }],
    openings: [{ id: 8, host_id: 4, bbox_mm: { min: [100, 0, 0], max: [200, 200, 2100] } }],
  }, "2026-11-02T00:00:00.000Z");
  assert.equal(imported.elements[0].max[2], 3000);
  assert.equal(imported.elements[1].category, "opening");
  assert.equal(imported.elements[1].host_id, 4);
  assert.equal(imported.header.doc_title, "F26901-FMC-ZZ-ZZ-M3-S-0001");
});
