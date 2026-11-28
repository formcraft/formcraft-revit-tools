import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { detectFormat, parseXml, readCloud } from "./cloudread.js";
import {
  TriangleGrid, applyRigid, buildModel, checkReportFolder, closestOnTriangle, deviation, fitRigid, icp, loadPointCloudSpec, rigidFromOffset,
  type MeshElement,
} from "./pointcloud.js";
import { FMC_POINTCLOUD_SHAPE, runFmcPointCloud, type FmcPointCloudArgs } from "../tools/fmc_pointcloud.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CUBE = path.resolve(here, "..", "..", "..", "tests", "data", "pointcloud", "ColouredCubeFloat.e57");

function args(partial: Record<string, unknown>): FmcPointCloudArgs {
  return z.object(FMC_POINTCLOUD_SHAPE).parse(partial);
}
function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

/** A 1 m cube centred on c, one element per face, outward normals. move shifts one face along its normal. */
function cubeFaces(c: [number, number, number] = [0, 0, 0], move: Record<string, number> = {}): MeshElement[] {
  const faces: MeshElement[] = [];
  const names = ["-x", "+x", "-y", "+y", "-z", "+z"];
  names.forEach((name, i) => {
    const d = Math.floor(i / 2);
    const s = i % 2 ? 1 : -1;
    const at = s * 0.5 + (move[name] ?? 0) * s;
    const u = (d + 1) % 3, w = (d + 2) % 3;
    const v: number[] = [];
    for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      const p = [0, 0, 0];
      p[d] = at; p[u] = a; p[w] = b;
      v.push(p[0] + c[0], p[1] + c[1], p[2] + c[2]);
    }
    // (u x w) = +d, so this winding faces +d; flip it for the - faces
    const t = s > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    faces.push({ id: String(100 + i), unique_id: `u-${i}`, category: "Walls", name: `Cube: ${name}`, level: "L1", v, t });
  });
  return faces;
}

function writeLas(file: string, pts: Float64Array, opts: { format?: number; scale?: number } = {}) {
  const scale = opts.scale ?? 0.0001;
  const n = pts.length / 3;
  const h = Buffer.alloc(227);
  h.write("LASF", 0, "latin1");
  h.writeUInt8(1, 24); h.writeUInt8(2, 25);
  h.writeUInt16LE(227, 94); h.writeUInt32LE(227, 96); h.writeUInt32LE(0, 100);
  h.writeUInt8(opts.format ?? 0, 104); h.writeUInt16LE(20, 105); h.writeUInt32LE(n, 107);
  for (let d = 0; d < 3; d++) { h.writeDoubleLE(scale, 131 + d * 8); h.writeDoubleLE(100, 155 + d * 8); }
  const body = Buffer.alloc(n * 20);
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) body.writeInt32LE(Math.round((pts[i * 3 + d] - 100) / scale), i * 20 + d * 4);
  fs.writeFileSync(file, Buffer.concat([h, body]));
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-pointcloud-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [path.join(dir, "WIP")], reports_dir: path.join(dir, "Reports") };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, USERPROFILE: dir } as NodeJS.ProcessEnv;
  return { dir, guard, env };
}

test("the E57 reader reads the CC0 cube: 7680 points on a 1 m cube", () => {
  assert.equal(detectFormat(CUBE), "e57");
  const r = readCloud(CUBE, { maxPoints: 1e9 });
  assert.equal(r.format, "e57");
  assert.equal(r.total, 7680);
  assert.equal(r.sampled, 7680);
  assert.deepEqual(r.bounds?.min.map((v) => Math.round(v * 1000)), [-500, -500, -500]);
  assert.deepEqual(r.bounds?.max.map((v) => Math.round(v * 1000)), [500, 500, 500]);
  const s = readCloud(CUBE, { maxPoints: 1000 });
  assert.ok(s.sampled <= 1000 && s.sampled >= 900, String(s.sampled));
  assert.equal(s.stride, 8);
});

test("LAS is read with its scale and offset; LAZ is refused with its own code", () => {
  const { dir } = sandbox();
  const pts = readCloud(CUBE, { maxPoints: 1e9 }).points;
  const las = path.join(dir, "cube.las");
  writeLas(las, pts);
  const r = readCloud(las, { maxPoints: 1e9 });
  assert.equal(r.format, "las");
  assert.equal(r.total, 7680);
  assert.ok(Math.abs(r.points[0] - pts[0]) < 1e-4 && Math.abs(r.points[5] - pts[5]) < 1e-4);
  const laz = path.join(dir, "cube.laz");
  writeLas(laz, pts.subarray(0, 30), { format: 0x80 });
  assert.equal(detectFormat(laz), "laz");
  assert.throws(() => readCloud(laz, { maxPoints: 10 }), /FMC-POINTCLOUD-LAZ/);
  const junk = path.join(dir, "junk.e57");
  fs.writeFileSync(junk, "not a cloud");
  assert.throws(() => readCloud(junk, { maxPoints: 10 }), /FMC-POINTCLOUD-FORMAT/);
});

test("the XML parser keeps attributes, CDATA and nesting", () => {
  const x = parseXml(`<?xml version="1.0"?><e57Root type="Structure"><!-- c --><name type="String"><![CDATA[Scan <1>]]></name><points type="CompressedVector" fileOffset="48" recordCount="3"/></e57Root>`);
  const root = x.children[0];
  assert.equal(root.name, "e57Root");
  assert.equal(root.children[0].text, "Scan <1>");
  assert.equal(root.children[1].attrs.recordCount, "3");
});

test("closest point on a triangle: inside, edge and corner", () => {
  const t = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const out = new Float64Array(3);
  // compared to 1e-12: the barycentric maths gives 0.19999999999999998 for 0.2
  const near = (want: number[]) => want.forEach((v, k) => assert.ok(Math.abs(out[k] - v) < 1e-12, `${Array.from(out)} vs ${want}`));
  closestOnTriangle(0.2, 0.2, 5, t, 0, out); near([0.2, 0.2, 0]);
  closestOnTriangle(-1, -1, 0, t, 0, out); near([0, 0, 0]);
  closestOnTriangle(0.5, -1, 0, t, 0, out); near([0.5, 0, 0]);
});

test("the cube scan against the cube model: every face WITHIN; a face built 40 mm out is OFF by about -40 mm", () => {
  const pts = readCloud(CUBE, { maxPoints: 1e9 }).points;
  const good = new TriangleGrid(buildModel(cubeFaces()), 0.25);
  const dev = deviation(pts, good, { radius: 0.15, minPoints: 30, tolerance: () => 25 });
  assert.equal(dev.summary.WITHIN, 6);
  assert.ok(dev.elements.every((e) => e.p95_mm < 1), JSON.stringify(dev.elements.map((e) => e.p95_mm)));
  const moved = new TriangleGrid(buildModel(cubeFaces([0, 0, 0], { "+x": 0.04 })), 0.25);
  const dev2 = deviation(pts, moved, { radius: 0.15, minPoints: 30, tolerance: () => 25 });
  const east = dev2.elements.find((e) => e.name === "Cube: +x");
  assert.equal(east?.status, "OFF");
  assert.ok(Math.abs((east?.mean_mm ?? 0) + 40) < 2, String(east?.mean_mm));
  assert.ok(Math.abs((east?.shift_mm[0] ?? 0) + 40) < 2, "the scan sits 40 mm inside the modelled face");
  const none = deviation(pts, new TriangleGrid(buildModel(cubeFaces([5, 0, 0])), 0.25), { radius: 0.15, minPoints: 30, tolerance: () => 25 });
  assert.equal(none.summary["NO-COVERAGE"], 6);
  assert.equal(none.outside, 7680);
});

test("fitRigid recovers a known yaw and move; ICP aligns a shifted scan and refuses a move past max_shift", () => {
  const src = [0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 1, 1, 1];
  const m = rigidFromOffset({ x: 0.3, y: -0.2, z: 0.1, rotation_deg: 10 });
  const dst = Array.from(applyRigid(m, Float64Array.from(src)));
  for (const zOnly of [true, false]) {
    const fit = fitRigid(src, dst, zOnly);
    fit.r.forEach((v, i) => assert.ok(Math.abs(v - m.r[i]) < 1e-9, `r${i} zOnly=${zOnly}`));
    fit.t.forEach((v, i) => assert.ok(Math.abs(v - m.t[i]) < 1e-9, `t${i}`));
  }
  const pts = readCloud(CUBE, { maxPoints: 1e9 }).points;
  const off = applyRigid(rigidFromOffset({ x: 0.06, y: -0.04, z: 0.02, rotation_deg: 1 }), pts);
  const grid = new TriangleGrid(buildModel(cubeFaces()), 0.5);
  const res = icp(off, grid, { radius: 0.3, zOnly: true, maxIter: 50, sample: 5000, maxShift: 0.5, maxRotDeg: 3, minPairs: 100 });
  assert.equal(res.used, true);
  assert.ok(res.rms_after_mm < 2, String(res.rms_after_mm));
  assert.ok(res.rms_before_mm > 20);
  const tight = icp(off, grid, { radius: 0.3, zOnly: true, maxIter: 50, sample: 5000, maxShift: 0.01, maxRotDeg: 3, minPairs: 100 });
  assert.equal(tight.used, false);
  assert.equal(tight.code, "FMC-POINTCLOUD-ALIGN-REJECTED");
});

test("report folder: inside write_roots or reports_dir only", () => {
  const { dir, guard, env } = sandbox();
  assert.equal(checkReportFolder(path.join(dir, "WIP", "PC"), guard, [], env).ok, true);
  assert.equal(checkReportFolder(path.join(dir, "WIP", "02_Shared"), guard, [], env).ok, false);
  assert.equal(checkReportFolder(path.join(dir, "x"), guard, [], env).ok, false);
  assert.equal(checkReportFolder(path.join(dir, "WIP", "orig"), guard, [path.join(dir, "WIP", "orig")], env).ok, false);
});

test("the tool: dry run measures and writes nothing; a write puts a CSV and a JSON in the allowed folder", async () => {
  const { dir, guard, env } = sandbox();
  const out = path.join(dir, "WIP", "PointCloud");
  // the scan is 25 mm east of the model and turned 0.5 degrees; ICP takes it back
  const shifted = applyRigid(rigidFromOffset({ x: 0.025, rotation_deg: 0.5 }), readCloud(CUBE, { maxPoints: 1e9 }).points);
  const las = path.join(dir, "site.las");
  writeLas(las, shifted);
  let reads = 0;
  const read = async (body: Record<string, unknown>) => {
    reads++;
    assert.equal(body.coordinates, "shared");
    return { title: "SAMPLE-FMC-ZZ-ZZ-M3-A-0001", path: "", units: "m", coordinates: "shared", elements: cubeFaces(), truncated: false, point_clouds: [] };
  };
  const base = { document: "SAMPLE", cloud: las, output_folder: out };
  const dry = textOf(await runFmcPointCloud(args(base), { read, env, guard, kitRoot: "", now: () => new Date(2026, 10, 28, 12, 0) }));
  assert.equal(dry.isError, false, JSON.stringify(dry));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.model_changed, false);
  assert.equal(dry.status, "PROVISIONAL");
  assert.equal(dry.alignment.icp.used, true);
  assert.equal(dry.summary.WITHIN, 6, JSON.stringify(dry.worst));
  assert.equal(fs.existsSync(out), false);
  const none = textOf(await runFmcPointCloud(args({ ...base, alignment: "none" }), { read, env, guard, kitRoot: "" }));
  assert.ok(none.summary.OFF >= 1, "without alignment the east and west faces are 25 mm off");
  const done = textOf(await runFmcPointCloud(args({ ...base, dry_run: false }), { read, env, guard, kitRoot: "", now: () => new Date(2026, 10, 28, 12, 0) }));
  assert.equal(done.written, true, JSON.stringify(done));
  assert.ok(fs.existsSync(done.report.csv) && fs.existsSync(done.report.json));
  const json = JSON.parse(fs.readFileSync(done.report.json, "utf8"));
  assert.equal(json.schema, "fmc.pointcloud/1");
  assert.equal(json.elements.length, 6);
  assert.match(fs.readFileSync(done.report.csv, "utf8"), /Cube: \+x/);
  const again = textOf(await runFmcPointCloud(args({ ...base, dry_run: false }), { read, env, guard, kitRoot: "", now: () => new Date(2026, 10, 28, 12, 0) }));
  assert.equal(again.code, "FMC-POINTCLOUD-EXISTS");
  assert.ok(reads >= 3);
});

test("the tool refuses: no document, no cloud, LAZ, no overlap, no mesh, a folder outside the roots", async () => {
  const { dir, guard, env } = sandbox();
  const read = async () => ({ title: "A", elements: cubeFaces() });
  assert.equal(textOf(await runFmcPointCloud(args({ cloud: CUBE }), { read, env, guard, kitRoot: "" })).code, "FMC-DOC-REQUIRED");
  assert.equal(textOf(await runFmcPointCloud(args({ document: "A", cloud: path.join(dir, "none.e57") }), { read, env, guard, kitRoot: "" })).code, "FMC-POINTCLOUD-FILE");
  const laz = path.join(dir, "a.laz");
  writeLas(laz, Float64Array.from([0, 0, 0]), { format: 0x83 });
  let asked = 0;
  assert.equal(textOf(await runFmcPointCloud(args({ document: "A", cloud: laz }), { read: async () => { asked++; return {}; }, env, guard, kitRoot: "" })).code, "FMC-POINTCLOUD-LAZ");
  assert.equal(asked, 0, "Revit is not asked when the cloud cannot be read");
  const far = async () => ({ title: "A", elements: cubeFaces([500, 500, 0]) });
  assert.equal(textOf(await runFmcPointCloud(args({ document: "A", cloud: CUBE }), { read: far, env, guard, kitRoot: "" })).code, "FMC-POINTCLOUD-NO-OVERLAP");
  assert.equal(textOf(await runFmcPointCloud(args({ document: "A", cloud: CUBE }), { read: async () => ({ title: "A", elements: [] }), env, guard, kitRoot: "" })).code, "FMC-POINTCLOUD-NO-MESH");
  const outside = textOf(await runFmcPointCloud(args({ document: "A", cloud: CUBE, output_folder: path.join(dir, "Elsewhere"), dry_run: false }), { read, env, guard, kitRoot: "" }));
  assert.equal(outside.code, "FMC-POINTCLOUD-FOLDER");
  assert.equal(fs.existsSync(path.join(dir, "Elsewhere")), false);
  const refused = textOf(await runFmcPointCloud(args({ document: "A", cloud: CUBE }), { read: async () => ({ refused: true, code: "FMC-DOC-NOT-FOUND", message: "no" }), env, guard, kitRoot: "" }));
  assert.equal(refused.code, "FMC-DOC-NOT-FOUND");
});

test("the sample spec is provisional, and the point cloud read is a read in command.json", () => {
  const loaded = loadPointCloudSpec({ kitRoot: "", env: {} as NodeJS.ProcessEnv });
  assert.equal(loaded.source, "sample");
  assert.equal(loaded.provisional, true);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_pointcloud_read"));
  assert.ok(!WRITE_COMMANDS.has("fmc_pointcloud_read"));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.ok(manifest.commands.some((row) => row.commandName === "fmc_pointcloud_read"));
});
