import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { AVF_MAX_POINTS, avfStats, checkAvfPoints, legendBands, parseAvfCsv, planAvfPoints } from "./avf.js";
import { internalToSharedMm, sharedToInternalMm } from "./sitecommon.js";
import { fromAngleMm } from "./coordmath.js";
import { FMC_AVF_SHAPE, runFmcAvf, type FmcAvfArgs } from "../tools/fmc_avf.js";

function args(partial: Record<string, unknown>): FmcAvfArgs {
  return z.object(FMC_AVF_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

test("CSV of x, y, z, value with any separator; bad numbers are refused", () => {
  const rows = parseAvfCsv("X;Y;Z;Value\n0;0;0;1.5\n1000;0;0;3\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].value, 3);
  const tabs = parseAvfCsv("easting\tnorthing\tvalue\n1\t2\t9\n");
  assert.equal(tabs[0].z, 0);
  assert.throws(() => parseAvfCsv("x,y,z,value\n1,2,3,abc\n"), /FMC-AVF-VALUE/);
  assert.throws(() => parseAvfCsv("a,b\n1,2\n"), /FMC-AVF-CSV/);
  assert.throws(() => checkAvfPoints([]), /FMC-AVF-POINTS/);
  assert.throws(() => checkAvfPoints(Array.from({ length: AVF_MAX_POINTS + 1 }, () => ({ x: 0, y: 0, z: 0, value: 0 }))), /FMC-AVF-TOO-MANY/);
});

test("stats, legend bands, units and the shared-to-internal transform (fmc_coord's matrix)", () => {
  const pts = [{ x: 0, y: 0, z: 0, value: 2 }, { x: 1, y: 0, z: 0, value: 10 }, { x: 2, y: 0, z: 0, value: 6 }];
  assert.deepEqual(avfStats(pts), { count: 3, min: 2, max: 10, mean: 6 });
  const bands = legendBands(avfStats(pts), 4);
  assert.equal(bands.length, 4);
  assert.equal(bands[0].from, 2);
  assert.equal(bands[3].to, 10);
  assert.equal(legendBands({ count: 1, min: 5, max: 5, mean: 5 }, 8).length, 1);
  const m = planAvfPoints(pts, { units: "m", coordinates: "internal", value_scale: 2 });
  assert.deepEqual(m.xyz_mm[1], [1000, 0, 0]);
  assert.deepEqual(m.values, [4, 20, 12]);
  // Internal to shared: rotate 90 degrees and move 500 m east, 200 m north, 10 m up.
  const its = fromAngleMm(500000, 200000, 10000, 90);
  const shared = internalToSharedMm([[1000, 0, 0]], its);
  assert.deepEqual(shared[0].map((v) => Math.round(v)), [500000, 201000, 10000]);
  const back = sharedToInternalMm(shared, its);
  assert.deepEqual(back[0].map((v) => Math.round(v)), [1000, 0, 0]);
  const viaPlan = planAvfPoints([{ x: 500, y: 201, z: 10, value: 1 }], { units: "m", coordinates: "shared", value_scale: 1 }, its);
  assert.deepEqual(viaPlan.xyz_mm[0], [1000, 0, 0]);
  assert.throws(() => planAvfPoints(pts, { units: "m", coordinates: "shared", value_scale: 1 }, []), /FMC-SITE-TRANSFORM/);
});

const readBody = {
  title: "A", path: "D:\\Jobs\\_Staging\\A.rvt", is_central: false,
  internal_to_shared: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  views: [
    { id: "10", name: "{3D}", type: "ThreeD", is_template: false, can_show: true, results: [] },
    { id: "11", name: "Level 1", type: "FloorPlan", is_template: false, can_show: true, results: ["FMC Analysis", "Energy"] },
    { id: "12", name: "Sheet A101", type: "DrawingSheet", is_template: false, can_show: false, results: [] },
  ],
  styles: [{ id: "77", name: "FMC AVF Markers" }],
};

test("show: the dry run changes nothing; a write needs the lease and references and sends internal millimetres", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-avf-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_AVF_DIR: path.join(dir, "out") } as NodeJS.ProcessEnv;
  let applied = 0;
  const read = async () => readBody;
  const csv = "x,y,z,value\n0,0,0,1\n1,1,0,5\n";
  const base = { action: "show", document: "A", view: "{3D}", csv: "C:\\data\\sun.csv", units: "m" };
  const dry = textOf(await runFmcAvf(args(base), { read, readFile: () => csv, apply: async () => { applied += 1; return {}; }, env, guard }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.stats.count, 2);
  assert.equal(dry.style.exists, true);
  assert.equal(applied, 0);
  assert.equal(textOf(await runFmcAvf(args({ ...base, dry_run: false }), { read, readFile: () => csv, env, guard })).code, "FMC-BATCH-LOCKED");
  assert.equal(textOf(await runFmcAvf(args({ ...base, dry_run: false, batch_lease: "L" }), { read, readFile: () => csv, env, guard })).code, "FMC-AVF-REFERENCES");
  const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] };
  const done = textOf(await runFmcAvf(args({ ...base, dry_run: false, batch_lease: "L", references: refs }), {
    read, readFile: () => csv, env, guard,
    apply: async (body) => {
      applied += 1;
      assert.equal(body.view_id, "10");
      assert.deepEqual((body.xyz_mm as number[][])[1], [1000, 1000, 0]);
      assert.deepEqual(body.values, [1, 5]);
      return { ok: true, primitive_index: 0, style_id: "77" };
    },
  }));
  assert.equal(applied, 1);
  assert.equal(done.applied.ok, true);
});

test("view and clear refusals", async () => {
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-avf-r-"));
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_AVF_DIR: dir } as NodeJS.ProcessEnv;
  const read = async () => readBody;
  assert.equal(textOf(await runFmcAvf(args({ action: "read" }), { env, guard })).code, "FMC-DOC-REQUIRED");
  assert.equal(textOf(await runFmcAvf(args({ action: "show", document: "A", view: "Sheet A101", points: [{ x: 0, y: 0, value: 1 }] }), { read, env, guard })).code, "FMC-AVF-VIEW");
  assert.equal(textOf(await runFmcAvf(args({ action: "show", document: "A", view: "{3D}" }), { read, env, guard })).code, "FMC-AVF-POINTS");
  assert.equal(textOf(await runFmcAvf(args({ action: "clear", document: "A", view: "{3D}" }), { read, env, guard })).code, "FMC-AVF-NOTHING");
  assert.equal(textOf(await runFmcAvf(args({ action: "clear", document: "A", view: "Level 1" }), { read, env, guard })).code, "FMC-AVF-OTHERS");
  const all = textOf(await runFmcAvf(args({ action: "clear", document: "A", view: "11", all: true }), { read, env, guard }));
  assert.deepEqual(all.would_clear, ["FMC Analysis", "Energy"]);
  const central = async () => ({ ...readBody, is_central: true });
  const refs = { kit: ["k"], standards: ["s"], rulebook: ["r"] };
  assert.equal(textOf(await runFmcAvf(args({ action: "clear", document: "A", view: "11", all: true, dry_run: false, batch_lease: "L", references: refs }), { read: central, env, guard })).code, "FMC-AVF-GUARD");
  const listed = textOf(await runFmcAvf(args({ action: "read", document: "A" }), { read, env, guard }));
  assert.equal(listed.views.length, 2);
  assert.equal(listed.views_with_results.length, 1);
});

test("the AVF read is not a write and the apply is, and both are in command.json", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_avf"));
  assert.ok(WRITE_COMMANDS.has("fmc_avf_apply"));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((row) => row.commandName));
  assert.ok(names.has("fmc_avf") && names.has("fmc_avf_apply"));
});
