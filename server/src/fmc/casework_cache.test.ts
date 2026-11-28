import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOM, call, done, fakeRevit, kit } from "./casework_testkit.js";

/** The room read is reused along a chain of calls (room → check → place) while it is young, and read again when asked. */

const MODULES = [600, 450, 300];
const answers = () => fakeRevit({ fmc_casework_room: ROOM, fmc_casework_place: (p: { dry_run: boolean }) => ({ dry_run: p.dry_run, placed: [], removed: 0 }) });
const reads = (calls: Array<{ command: string }>) => calls.filter((c) => c.command === "fmc_casework_room").length;

test("check reuses the room read by the run it names; place's dry run reuses it again: one Revit read for the chain", async () => {
  const k = kit();
  try {
    const rv = answers();
    const room = await call(k, { action: "room", room: "G05" }, rv.send);
    const check = await call(k, { action: "check", room: "G05", run_id: room.body.run_id, modules: MODULES }, rv.send);
    assert.equal(check.isError, false, JSON.stringify(check.body));
    assert.match(check.body.room_read.from, new RegExp(`saved run ${room.body.run_id}`));
    assert.ok(check.body.room_read.age_s >= 0);
    const place = await call(k, { action: "place", room: "G05", run_id: check.body.run_id, label: "K-01 Kitchen", level: "Ground", wall_unit_bottom: 1450 }, rv.send);
    assert.equal(place.isError, false, JSON.stringify(place.body));
    assert.match(place.body.checks.room_read.from, /saved run/);
    assert.equal(reads(rv.calls), 1, "the room was read once, by room");
    assert.equal(rv.calls.filter((c) => c.command === "fmc_casework_place").length, 1);
  } finally { done(k); }
});

test("fresh_room, another room, or a read older than 10 minutes all read Revit again", async () => {
  const k = kit();
  try {
    const rv = answers();
    const room = await call(k, { action: "room", room: "G05" }, rv.send);
    const fresh = await call(k, { action: "check", room: "G05", run_id: room.body.run_id, modules: MODULES, fresh_room: true }, rv.send);
    assert.equal(fresh.body.room_read.from, "Revit, now");
    assert.equal(reads(rv.calls), 2);
    const other = await call(k, { action: "check", room: "Kitchen", run_id: room.body.run_id, modules: MODULES }, rv.send);
    assert.equal(other.body.room_read.from, "Revit, now", "the cache is by room name; another name is another read");
    assert.equal(reads(rv.calls), 3);
    // age the saved read past 10 minutes
    const file = path.join(k.store, `${room.body.run_id}.json`);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.room_read.at = new Date(Date.now() - 11 * 60000).toISOString();
    fs.writeFileSync(file, JSON.stringify(saved));
    const stale = await call(k, { action: "check", room: "G05", run_id: room.body.run_id, modules: MODULES }, rv.send);
    assert.equal(stale.body.room_read.from, "Revit, now");
    assert.equal(reads(rv.calls), 4);
  } finally { done(k); }
});

test("without a run_id every check reads the room (no hidden cache between unrelated calls)", async () => {
  const k = kit();
  try {
    const rv = answers();
    const room = await call(k, { action: "room", room: "G05" }, rv.send);
    const run = { ...room.body.run, modules: MODULES };
    await call(k, { action: "check", room: "G05", run }, rv.send);
    await call(k, { action: "check", room: "G05", run }, rv.send);
    assert.equal(reads(rv.calls), 3);
  } finally { done(k); }
});

test("the cache is carried along calls that don't read the room (room → summary → check)", async () => {
  const k = kit();
  try {
    const rv = answers();
    const room = await call(k, { action: "room", room: "G05" }, rv.send);
    const sum = await call(k, { action: "summary", run_id: room.body.run_id, modules: MODULES }, rv.send);
    const check = await call(k, { action: "check", room: "g05", run_id: sum.body.run_id }, rv.send);
    assert.match(check.body.room_read.from, /saved run/);
    assert.equal(reads(rv.calls), 1);
  } finally { done(k); }
});
