import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FIX, ROOM, call, done, fakeRevit, kit } from "./casework_testkit.js";

/** options (three layouts of one run, each saved) and bulk (many rooms and runs, read only). */

test("options: three layouts of the run, each saved under <run_id>-A/-B/-C with its scores; the choice is left to the person", async () => {
  const k = kit();
  try {
    const r = await call(k, { action: "options", run: FIX.run });
    assert.equal(r.isError, false, JSON.stringify(r.body));
    const [a, b, c] = r.body.options;
    assert.deepEqual(r.body.options.map((o: { run_id: string }) => o.run_id), ["A", "B", "C"].map((x) => `${r.body.run_id}-${x}`));
    assert.equal(a.sheets, 15, "A is the run as given: the example kitchen's 15 sheets");
    assert.equal(a.units, 12);
    assert.match(b.how, /every unit \d+ wide/);
    assert.ok(c.drawers > a.drawers, "C has more drawers");
    for (const o of r.body.options) for (const key of ["units", "fillers", "filler_mm", "sheets", "edge_m", "worktop_m", "units_hash"]) assert.ok(key in o, key);
    assert.ok(r.body.compare.fewest_sheets);
    assert.match(r.body.next, /the choice is theirs/);
    // option B carries on by its id: the same units hash as the option reported
    const again = await call(k, { action: "summary", run_id: b.run_id });
    assert.equal(again.isError, false);
    assert.equal(again.body.units_hash, b.units_hash);
    assert.equal(again.body.inputs_from, b.run_id);
  } finally { done(k); }
});

test("options writes no pack files and needs a run (not a unit list)", async () => {
  const k = kit();
  try {
    await call(k, { action: "options", run: FIX.run });
    assert.equal(fs.existsSync(k.folder), false);
    const u = await call(k, { action: "options", units: [{ mark: "K01", kind: "base", width: 600, wall: "", offset: 0, fronts: "door" }] });
    assert.equal(u.isError, true);
    assert.match(u.body.reasons[0], /give a run/);
  } finally { done(k); }
});

test("options for a wardrobe: C uses the narrow doors", async () => {
  const robe = { wardrobe: { height: 2100, depth: 600 }, shelves: { ...FIX.standards.shelves, wardrobe: 1 } };
  const k = kit({ revision: "r7", ...FIX.standards, ...robe });
  try {
    const r = await call(k, { action: "options", run: { kind: "wardrobe", modules: [1000, 500], walls: [{ name: "B1", length: 3000 }] } });
    assert.equal(r.isError, false, JSON.stringify(r.body));
    const c = r.body.options[2];
    assert.equal(c.title, "Narrow doors");
    assert.equal(c.units, 6);
    assert.equal(r.body.options[0].units, 3);
  } finally { done(k); }
});

test("bulk: rooms are read through the read-only path, each gets its own saved run id, laid out when modules are given", async () => {
  const k = kit();
  try {
    const rv = fakeRevit({ fmc_casework_room: (p: { room: string }) => ({ ...ROOM, room: { ...ROOM.room, number: p.room } }) });
    const r = await call(k, { action: "bulk", rooms: ["G05", "G06"], runs: [{ label: "K-09 Kitchen", run: FIX.run }], modules: [600, 450, 300] }, rv.send);
    assert.equal(r.isError, false, JSON.stringify(r.body));
    assert.equal(r.body.items.length, 3);
    assert.ok(rv.calls.every((c) => c.dry === true && c.command === "fmc_casework_room"), "only room reads, all read-only");
    assert.deepEqual(rv.calls.map((c) => c.payload.room), ["G05", "G06"]);
    const ids = r.body.items.map((i: { run_id: string }) => i.run_id);
    assert.equal(new Set(ids).size, 3);
    for (const i of r.body.items) { assert.equal(i.saved, true); assert.equal(typeof i.sheets, "number"); }
    assert.equal(r.body.totals.laid_out, 3);
    assert.equal(r.body.totals.sheets, r.body.items.reduce((a: number, i: { sheets: number }) => a + i.sheets, 0));
    assert.equal(fs.existsSync(k.folder), false, "nothing written to the pack folder");
    // a room's saved run carries on: units for G06 by its id
    const g06 = await call(k, { action: "units", run_id: ids[1] });
    assert.equal(g06.isError, false);
    assert.equal(g06.body.inputs_from, ids[1]);
  } finally { done(k); }
});

test("bulk: without modules the rooms are read and saved but not laid out; a failed room doesn't stop the others", async () => {
  const k = kit();
  try {
    const rv = fakeRevit({ fmc_casework_room: (p: { room: string }) => { if (p.room === "X") throw new Error("No room X"); return ROOM; } });
    const r = await call(k, { action: "bulk", rooms: ["X", "G05"] }, rv.send);
    assert.equal(r.isError, false);
    assert.match(r.body.items[0].error, /No room X/);
    assert.match(r.body.items[1].next, /Give modules/);
    assert.equal(r.body.totals.laid_out, 0);
  } finally { done(k); }
});

test("bulk refuses an empty call and more than 50 items", async () => {
  const k = kit();
  try {
    const none = await call(k, { action: "bulk" });
    assert.equal(none.isError, true);
    await assert.rejects(call(k, { action: "bulk", rooms: Array.from({ length: 51 }, (_, i) => `R${i}`) }), /50/, "the schema caps rooms at 50");
    const many = await call(k, { action: "bulk", rooms: Array.from({ length: 30 }, (_, i) => `R${i}`), runs: Array.from({ length: 21 }, (_, i) => ({ label: `L${i}`, run: FIX.run })) });
    assert.equal(many.isError, true);
    assert.match(many.body.reasons[0], /At most 50/);
  } finally { done(k); }
});
