import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { unitsHash } from "./casework_run.js";
import { loadRun, saveRun } from "./casework_store.js";
import { FIX, ROOM, call, done, fakeRevit, kit } from "./casework_testkit.js";

/** run_id handle (saved inputs), the unit-list hash, and room's ready run. */

const PACK = { action: "pack", label: "K-01 Kitchen", project_code: "F26901" };

test("a saved run stands in for the run: the same units, the same hash, and the reply names where its inputs came from", async () => {
  const k = kit();
  try {
    const first = await call(k, { action: "summary", run: FIX.run });
    assert.equal(first.isError, false);
    assert.match(first.body.units_hash, /^[0-9a-f]{12}$/);
    const again = await call(k, { action: "summary", run_id: first.body.run_id });
    assert.equal(again.isError, false);
    assert.equal(again.body.inputs_from, first.body.run_id);
    assert.notEqual(again.body.run_id, first.body.run_id, "each call still gets its own run id");
    assert.equal(again.body.units_hash, first.body.units_hash);
    assert.equal(again.body.sheets, first.body.sheets);
    // chains: the second call's id works too
    const third = await call(k, { action: "units", run_id: again.body.run_id });
    assert.equal(third.body.units_hash, first.body.units_hash);
    assert.equal(first.body.inputs_from, undefined, "a call that sent its run names no saved run");
  } finally { done(k); }
});

test("what the call sends wins over the saved run: modules, the run itself, the standards", async () => {
  const k = kit();
  try {
    const first = await call(k, { action: "units", run: FIX.run });
    const fewer = await call(k, { action: "units", run_id: first.body.run_id, modules: [600, 300] });
    assert.notEqual(fewer.body.units_hash, first.body.units_hash);
    assert.ok(fewer.body.units.filter((u: { kind: string }) => u.kind === "base").every((u: { width: number }) => [600, 300].includes(u.width)));
    const std = await call(k, { action: "summary", run_id: first.body.run_id, standards: { kerf: FIX.standards.kerf + 1 } });
    assert.equal(std.body.standards_revision.call_overrides, true);
    const saved = await call(k, { action: "summary", run_id: std.body.run_id });
    assert.equal(saved.body.standards_revision.call_overrides, true, "the standards the call sent are saved with its run");
  } finally { done(k); }
});

test("a unit list is saved and reused like a run", async () => {
  const k = kit();
  try {
    const units = [{ mark: "K01", kind: "base", width: 600, fronts: "door" }, { mark: "K02", kind: "base", width: 400, fronts: "3drawer" }];
    const a = await call(k, { action: "parts", units });
    const b = await call(k, { action: "parts", run_id: a.body.run_id });
    assert.equal(b.body.pieces, a.body.pieces);
    assert.equal(b.body.units_hash, a.body.units_hash);
  } finally { done(k); }
});

test("a run id that isn't saved, or isn't a run id, is refused before anything is read or written", async () => {
  const k = kit();
  try {
    const none = await call(k, { action: "summary", run_id: "CW-20200101T000000-abcdef" });
    assert.equal(none.isError, true);
    assert.match(none.body.reasons[0], /No saved run/);
    for (const bad of ["../../etc/passwd", "CW-1", "cw-20261128T104500-a1b2c3", "CW-20261128T104500-a1b2c3/../x"]) {
      const r = await call(k, { action: "summary", run_id: bad });
      assert.equal(r.isError, true);
      assert.match(r.body.reasons[0], /isn't a casework run id/);
    }
    assert.deepEqual(fs.existsSync(k.store) ? fs.readdirSync(k.store) : [], [], "a refused call saves nothing");
  } finally { done(k); }
});

test("saved runs stay out of the pack folder, so a pack through run_id is still byte-for-byte unchanged", async () => {
  const k = kit();
  try {
    const first = await call(k, { ...PACK, run: FIX.run, project_folder: k.project, dry_run: false, confirm: true });
    assert.equal(first.body.done, true, JSON.stringify(first.body));
    const second = await call(k, { ...PACK, run_id: first.body.run_id, project_folder: k.project, dry_run: false, confirm: true });
    assert.deepEqual(second.body.files.map((f: { action: string }) => f.action), ["unchanged", "unchanged", "unchanged", "unchanged", "unchanged"]);
    const inPack = fs.readdirSync(k.folder);
    assert.ok(inPack.every((f) => !/^CW-/.test(f) && !f.endsWith(".json")), `pack folder: ${inPack.join(", ")}`);
    assert.ok(!fs.readFileSync(path.join(k.folder, inPack.find((f) => f.endsWith("_CutList.csv"))!), "utf8").includes("CW-"), "no run id inside the pack files");
    assert.ok(fs.readdirSync(k.store).includes(`${second.body.run_id}.json`));
  } finally { done(k); }
});

test("units_hash: the same units give the same hash, any change gives another; none when the standards are missing", async () => {
  const u = [{ mark: "K01", kind: "base", width: 600, wall: "A", offset: 0, fronts: "door", layer: "base" }];
  assert.equal(unitsHash(u), unitsHash([{ ...u[0] }]));
  assert.notEqual(unitsHash(u), unitsHash([{ ...u[0], fronts: "2door" }]));
  assert.notEqual(unitsHash(u), unitsHash([{ ...u[0], offset: 1 }]));
  const k = kit(null);
  try {
    const r = await call(k, { action: "summary", run: FIX.run });
    assert.ok(r.body.refused);
    assert.equal(r.body.units_hash, undefined);
    const fronts = await call(k, { action: "units", run: FIX.run, standards: FIX.standards });
    const changed = await call(k, { action: "units", run: { ...FIX.run, fronts: { ...FIX.run.fronts, K02: "2door" } }, standards: FIX.standards });
    assert.notEqual(fronts.body.units_hash, changed.body.units_hash);
  } finally { done(k); }
});

test("room returns a ready run with modules blank, saved, so the next call needs only run_id and modules", async () => {
  const k = kit();
  try {
    const revit = fakeRevit({ fmc_casework_room: ROOM });
    const room = await call(k, { action: "room", room: "G05" }, revit.send);
    assert.equal(room.isError, false);
    assert.deepEqual(room.body.run.modules, []);
    assert.deepEqual(room.body.run.walls.map((w: { name: string }) => w.name), ["W1", "W2", "W3", "W4"]);
    assert.match(room.body.next, new RegExp(room.body.run_id));
    assert.equal(revit.calls[0].dry, true, "the room is read through the read-only path");
    const blank = await call(k, { action: "units", run_id: room.body.run_id });
    assert.ok(blank.body.problems.some((p: string) => /Name the unit widths/.test(p)), "nothing is filled in for the modules");
    const filled = await call(k, { action: "units", run_id: room.body.run_id, modules: [600, 450, 300] });
    assert.deepEqual(filled.body.problems, []);
    assert.ok(filled.body.units.length > 0);
    assert.equal(revit.calls.length, 1, "laying out reads nothing more from Revit");
  } finally { done(k); }
});

test("the store prunes runs older than 30 days and never follows a bad id", () => {
  const k = kit();
  try {
    fs.mkdirSync(k.store, { recursive: true });
    const old = path.join(k.store, "CW-20200101T000000-000000.json");
    fs.writeFileSync(old, JSON.stringify({ id: "CW-20200101T000000-000000" }));
    const t = new Date(Date.now() - 40 * 86400000);
    fs.utimesSync(old, t, t);
    fs.writeFileSync(path.join(k.store, "notes.txt"), "not a run");
    assert.equal(saveRun({ id: "CW-20261128T104500-a1b2c3", at: new Date().toISOString(), action: "units", run: FIX.run }, k.store), true);
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.existsSync(path.join(k.store, "notes.txt")), "other files are left alone");
    assert.equal(saveRun({ id: "../x", at: "", action: "units" }, k.store), false);
    assert.ok("run" in loadRun("CW-20261128T104500-a1b2c3", k.store));
  } finally { done(k); }
});
