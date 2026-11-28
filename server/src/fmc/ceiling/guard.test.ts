import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { CeilingInput } from "./engine.js";
import { emptyKit } from "./standard.js";
import { readItem, readQueue, setStatus } from "../aiuse_io.js";
import { paneAi } from "../../tools/fmc_ai.js";
import {
  CEILING_APPROVAL, canonical, ceilingApproval, designHash, finishRecord, markUnknown, originCheck, readRecord, recordBlocks, revisionOf,
  rollBackRecord, statusOf, writePending, writeRecordAtomic, PlacedRecord,
} from "./guard.js";
import { CeilingCtx, FMC_CEILING_SHAPE, loadCeilingKit, placedRecordFile, runFmcCeiling } from "../../tools/fmc_ceiling.js";

const NOW = new Date("2026-11-28T08:00:00Z");

// ---------- a temp world: its own APPDATA (queue), its own guard file, a temp "project"; nothing else is touched

interface World { dir: string; project: string; env: NodeJS.ProcessEnv; done: () => void }

function world(): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc_ceiling_guard_"));
  const project = path.join(dir, "P1");
  fs.mkdirSync(project, { recursive: true });
  const guard = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(guard, JSON.stringify({ write_roots: [path.join(dir, "*", "01_WIP")], protected_roots: ["D:\\Fomcraft"] }));
  const old = process.env.FMC_GUARD_CONFIG;
  process.env.FMC_GUARD_CONFIG = guard;
  const env: NodeJS.ProcessEnv = { ...process.env, APPDATA: path.join(dir, "Roaming"), FMC_GUARD_CONFIG: guard };
  delete env.FMC_CALLER;
  return { dir, project, env, done: () => { if (old === undefined) delete process.env.FMC_GUARD_CONFIG; else process.env.FMC_GUARD_CONFIG = old; fs.rmSync(dir, { recursive: true, force: true }); } };
}

const args = (project: string, extra: Record<string, unknown> = {}) => z.object(FMC_CEILING_SHAPE).parse({
  action: "place",
  room: { name: "L-01 Living", width_mm: 6000, depth_mm: 4500, structure_height_mm: 3000 },
  fixtures: { downlights: [{ x: 1500, y: 1500 }] },
  brief: { styles: ["tray"] },
  place: { level: "L00", origin_mm: { x: 10000, y: 20000 } },
  project_folder: project, dry_run: false, confirm: true,
  ...extra,
});

const KIT = { ...emptyKit(), revisions: { materials: "aaa", keynotes: "bbb" } };

interface Calls { list: Array<{ command: string; dry: boolean; recordAtCall: PlacedRecord | null }> }
function mockRevit(w: World, o: { fail?: string | Error; elements?: number } = {}): { ctx: CeilingCtx; calls: Calls } {
  const calls: Calls = { list: [] };
  const ctx: CeilingCtx = {
    env: w.env, now: () => NOW,
    revit: async (command, _params, dry) => {
      const f = placedRecordFile(w.project, "L-01 Living");
      calls.list.push({ command, dry, recordAtCall: fs.existsSync(f) ? readRecord(f) : null });
      if (dry) return { dry: true };
      if (o.fail) throw typeof o.fail === "string" ? new Error(o.fail) : o.fail;
      return { elements: Array.from({ length: o.elements ?? 3 }, (_, i) => ({ unique_id: `uid-${i}`, key: `K${i}` })), removed: 0, ceiling_type: "I.CLG_02" };
    },
  };
  return { ctx, calls };
}

const text = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const approveInPane = (w: World, id: string) => setStatus(id, "approved", "Emlyn", w.env, NOW);

// ---------- hash and kit revisions

test("design hash: stable, key-order free, and it changes with the design or a kit file", () => {
  const base = { kind: "tray", input: { a: 1, b: { x: [1, 2] } }, design: { zones: new Set([1, 2]) }, kit_revisions: { materials: "aaa" } };
  assert.equal(designHash(base), designHash({ ...base, input: { b: { x: [1, 2] }, a: 1 } }));
  assert.notEqual(designHash(base), designHash({ ...base, input: { a: 2, b: { x: [1, 2] } } }));
  assert.notEqual(designHash(base), designHash({ ...base, kit_revisions: { materials: "zzz" } }));
  assert.equal(canonical({ b: undefined, a: 1 }), '{"a":1}');
  assert.equal(revisionOf("x"), revisionOf("x"));
  assert.equal(revisionOf(null), "missing");
});

test("loadCeilingKit records the revision of every kit file it read, and 'missing' for the rest", () => {
  const files: Record<string, string> = {
    "Z:\\k\\07_Materials\\FMC_Materials.json": JSON.stringify({ materials: [] }),
    "Z:\\k\\03_Master_Data\\FMC_Master_Data.json": JSON.stringify({ codes: {} }),
  };
  const kit = loadCeilingKit("Z:\\k", {} as any, (p) => { if (p in files) return files[p]; throw new Error("nope"); });
  assert.equal(kit.revisions!.materials, revisionOf(files["Z:\\k\\07_Materials\\FMC_Materials.json"]));
  assert.equal(kit.revisions!.master_data, revisionOf(files["Z:\\k\\03_Master_Data\\FMC_Master_Data.json"]));
  assert.equal(kit.revisions!.keynotes, "missing");
  assert.equal(kit.revisions!.ceiling_standard, "missing");
});

test("every single-design answer carries design_hash and kit_revisions; the hash follows the design", async () => {
  const w = world();
  try {
    const a = text(await runFmcCeiling(args(w.project, { action: "checks", dry_run: true }) as any, KIT, { env: w.env }));
    const b = text(await runFmcCeiling(args(w.project, { action: "boq", dry_run: true }) as any, KIT, { env: w.env }));
    assert.match(a.design_hash, /^[0-9a-f]{20}$/);
    assert.equal(a.design_hash, b.design_hash);
    assert.deepEqual(a.kit_revisions, KIT.revisions);
    const wider = text(await runFmcCeiling(args(w.project, { action: "checks", dry_run: true, room: { name: "L-01 Living", width_mm: 6600, depth_mm: 4500, structure_height_mm: 3000 } }) as any, KIT, { env: w.env }));
    assert.notEqual(a.design_hash, wider.design_hash);
    const kit2 = { ...KIT, revisions: { ...KIT.revisions, materials: "changed" } };
    const k = text(await runFmcCeiling(args(w.project, { action: "checks", dry_run: true }) as any, kit2, { env: w.env }));
    assert.notEqual(a.design_hash, k.design_hash);
  } finally { w.done(); }
});

test("place refuses a design_hash that is not the design now", async () => {
  const w = world();
  try {
    const { ctx, calls } = mockRevit(w);
    const r = await runFmcCeiling(args(w.project, { design_hash: "0".repeat(20) }) as any, KIT, ctx);
    assert.equal(r.isError, true);
    assert.match(text(r).reasons[0], /is not this design/);
    assert.equal(calls.list.length, 0);
  } finally { w.done(); }
});

// ---------- origin against the model's room

test("origin check: a position that doesn't land the room on the model's room is refused; no bbox is only a warning", () => {
  const room = { name: "r", width_mm: 6000, depth_mm: 4500 } as any;
  const origin = { x: 10000, y: 20000 };
  assert.deepEqual(originCheck(room, origin, { x0: 10000, y0: 20000, x1: 16000, y1: 24500 }), { problems: [], warnings: [] });
  assert.deepEqual(originCheck(room, origin, { x0: 10100, y0: 20050, x1: 16000, y1: 24500 }).problems, []);
  assert.match(originCheck(room, origin, { x0: 0, y0: 0, x1: 6000, y1: 4500 }).problems[0], /off by up to 20000 mm/);
  assert.match(originCheck(room, origin, undefined).warnings[0], /not checked/);
  assert.match(originCheck(room, { x: NaN, y: 0 }, undefined).problems[0], /usable position/);
  assert.match(originCheck(room, origin, { x0: 5, y0: 5, x1: 5, y1: 9 }).problems[0], /x1 > x0/);
});

test("place with a wrong room_bbox_mm is refused before anything else", async () => {
  const w = world();
  try {
    const { ctx, calls } = mockRevit(w);
    const r = await runFmcCeiling(args(w.project, { place: { level: "L00", origin_mm: { x: 10000, y: 20000 }, room_bbox_mm: { x0: 0, y0: 0, x1: 6000, y1: 4500 } } }) as any, KIT, ctx);
    assert.equal(r.isError, true);
    assert.match(text(r).reasons[0], /lands at/);
    assert.equal(calls.list.length, 0);
    assert.equal(readQueue(w.env).length, 0);
  } finally { w.done(); }
});

// ---------- a person's approval

test("confirm=true from an AI is not an approval: it queues for the pane, nothing runs, no record is written", async () => {
  const w = world();
  try {
    const { ctx, calls } = mockRevit(w);
    const r = await runFmcCeiling(args(w.project) as any, KIT, { ...ctx, viaMcp: true });
    assert.equal(r.isError, true);
    const body = text(r);
    assert.equal(body.awaiting_person, true);
    assert.match(body.reasons[0], /person has to approve/);
    assert.equal(calls.list.filter((c) => !c.dry).length, 0);
    assert.equal(fs.existsSync(placedRecordFile(w.project, "L-01 Living")), false);
    const q = readQueue(w.env);
    assert.equal(q.length, 1);
    assert.equal(q[0].command, CEILING_APPROVAL);
    assert.equal(q[0].status, "pending");
    assert.equal(q[0].id, body.approval_id);
    // asking again does not stack another item
    await runFmcCeiling(args(w.project) as any, KIT, { ...ctx, viaMcp: true });
    assert.equal(readQueue(w.env).length, 1);
  } finally { w.done(); }
});

test("an env FMC_CALLER=pane does not make an MCP call a person", async () => {
  const w = world();
  try {
    const { ctx, calls } = mockRevit(w);
    const r = await runFmcCeiling(args(w.project) as any, KIT, { ...ctx, viaMcp: true, env: { ...w.env, FMC_CALLER: "pane" } });
    assert.equal(text(r).awaiting_person, true);
    assert.equal(calls.list.filter((c) => !c.dry).length, 0);
  } finally { w.done(); }
});

test("a person's approval in the pane lets exactly that call run, once", async () => {
  const w = world();
  try {
    const { ctx, calls } = mockRevit(w);
    const first = text(await runFmcCeiling(args(w.project) as any, KIT, { ...ctx, viaMcp: true }));
    assert.ok(approveInPane(w, first.approval_id));
    const r = await runFmcCeiling(args(w.project) as any, KIT, { ...ctx, viaMcp: true });
    const body = text(r);
    assert.equal(r.isError, false, JSON.stringify(body));
    assert.equal(body.done, true);
    assert.equal(body.record_status, "placed");
    assert.equal(readItem(first.approval_id, w.env)!.status, "used");
    const rec = readRecord(placedRecordFile(w.project, "L-01 Living"))!;
    assert.equal(rec.approved_by, "Emlyn");
    assert.equal(rec.approval_id, first.approval_id);
    assert.equal(rec.design_hash, body.design_hash);
    assert.deepEqual(rec.kit_revisions, KIT.revisions);
    assert.deepEqual(rec.made, ["uid-0", "uid-1", "uid-2"]);
    // the approval is spent: an edit with the same words needs its own
    const again = text(await runFmcCeiling(args(w.project, { action: "edit" }) as any, KIT, { ...ctx, viaMcp: true }));
    assert.equal(again.awaiting_person, true);
    assert.notEqual(again.approval_id, first.approval_id);
    assert.equal(calls.list.filter((c) => !c.dry).length, 1);
  } finally { w.done(); }
});

test("an approval is bound to its batch: a different origin or level needs its own", async () => {
  const w = world();
  try {
    const { ctx, calls } = mockRevit(w);
    const a = text(await runFmcCeiling(args(w.project) as any, KIT, { ...ctx, viaMcp: true }));
    approveInPane(w, a.approval_id);
    const other = await runFmcCeiling(args(w.project, { place: { level: "L00", origin_mm: { x: 10500, y: 20000 } } }) as any, KIT, { ...ctx, viaMcp: true });
    assert.equal(text(other).awaiting_person, true);
    assert.notEqual(text(other).approval_id, a.approval_id);
    assert.equal(calls.list.filter((c) => !c.dry).length, 0);
    assert.equal(readItem(a.approval_id, w.env)!.status, "approved", "the first approval is untouched");
  } finally { w.done(); }
});

test("an approval whose stored parameters were altered is not honoured", () => {
  const w = world();
  try {
    const ask = { person: false, env: w.env, binding: { tool: "fmc_ceiling", action: "place", design_hash: "h1" }, docPath: "P1", elements: 3, details: [], now: NOW };
    const first = ceilingApproval(ask);
    assert.equal(first.ok, false);
    const id = (first as { id: string }).id;
    approveInPane(w, id);
    const file = path.join(w.env.APPDATA!, "Formcraft", "ai_queue", id + ".json");
    const item = JSON.parse(fs.readFileSync(file, "utf8"));
    item.params = { ...item.params, design_hash: "other" };
    fs.writeFileSync(file, JSON.stringify(item));
    assert.equal(ceilingApproval(ask).ok, false);
  } finally { w.done(); }
});

test("a person's own click in the pane (FMC_CALLER=pane, not MCP) is itself the approval", async () => {
  const w = world();
  try {
    const { ctx } = mockRevit(w);
    const r = await runFmcCeiling(args(w.project) as any, KIT, { ...ctx, env: { ...w.env, FMC_CALLER: "pane" } });
    const body = text(r);
    assert.equal(body.done, true, JSON.stringify(body));
    assert.equal(readRecord(placedRecordFile(w.project, "L-01 Living"))!.approved_by, "person (pane)");
    assert.equal(readQueue(w.env).length, 0);
  } finally { w.done(); }
});

test("the pane's Approve on an fmc_ceiling item only records the yes: nothing is sent to Revit", async () => {
  const w = world();
  const keep = process.env.APPDATA;
  try {
    // paneAi reads the default state dir, which the test runner points at a temp folder
    const first = ceilingApproval({ person: false, env: process.env, binding: { tool: "fmc_ceiling", action: "place", design_hash: "h2" }, docPath: "P1", elements: 2, details: ["place Tray"], now: NOW });
    assert.equal(first.ok, false);
    const id = (first as { id: string }).id;
    const out = await paneAi("ai_approve", { id }, "Emlyn") as { approved: boolean; ran: boolean; message: string };
    assert.equal(out.approved, true);
    assert.equal(out.ran, false);
    assert.match(out.message, /same fmc_ceiling call again/);
    const again = ceilingApproval({ person: false, env: process.env, binding: { tool: "fmc_ceiling", action: "place", design_hash: "h2" }, docPath: "P1", elements: 2, details: [], now: NOW });
    assert.equal(again.ok, true);
    assert.equal((again as { by: string }).by, "Emlyn");
    assert.equal((again as { claim: () => boolean }).claim(), true);
    assert.equal((again as { claim: () => boolean }).claim(), false, "one run per approval");
  } finally { process.env.APPDATA = keep; w.done(); }
});

// ---------- the record is written before Revit

test("the record exists as pending when Revit is called, and is finished after", async () => {
  const w = world();
  try {
    const { ctx, calls } = mockRevit(w);
    const r = await runFmcCeiling(args(w.project) as any, KIT, { ...ctx, env: { ...w.env, FMC_CALLER: "pane" } });
    assert.equal(r.isError, false);
    const real = calls.list.find((c) => !c.dry)!;
    assert.equal(real.recordAtCall?.status, "pending");
    assert.equal(real.recordAtCall?.action, "place");
    assert.equal(real.recordAtCall?.started_at, NOW.toISOString());
    assert.equal(statusOf(readRecord(placedRecordFile(w.project, "L-01 Living"))!), "placed");
  } finally { w.done(); }
});

test("a failed place marks the record failed and a new place may follow; a failed edit restores the previous record", async () => {
  const w = world();
  try {
    const pane = { ...w.env, FMC_CALLER: "pane" };
    const bad = mockRevit(w, { fail: "Revit said no" });
    const r = await runFmcCeiling(args(w.project) as any, KIT, { ...bad.ctx, env: pane });
    assert.equal(r.isError, true);
    const failed = readRecord(placedRecordFile(w.project, "L-01 Living"))!;
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /Revit said no/);
    assert.equal(recordBlocks(failed, "place", "r"), null);
    assert.match(recordBlocks(failed, "edit", "r")!, /last place failed/);

    const good = mockRevit(w);
    assert.equal((await runFmcCeiling(args(w.project) as any, KIT, { ...good.ctx, env: pane })).isError, false);
    const placed = readRecord(placedRecordFile(w.project, "L-01 Living"))!;
    assert.equal(placed.status, "placed");

    const bad2 = mockRevit(w, { fail: "edit broke" });
    const e = await runFmcCeiling(args(w.project, { action: "edit" }) as any, KIT, { ...bad2.ctx, env: pane });
    assert.equal(e.isError, true);
    assert.equal(bad2.calls.list.find((c) => !c.dry)!.recordAtCall?.status, "pending");
    assert.deepEqual(bad2.calls.list.find((c) => !c.dry)!.recordAtCall?.made, ["uid-0", "uid-1", "uid-2"], "an edit in flight still names what it replaces");
    const after = readRecord(placedRecordFile(w.project, "L-01 Living"))!;
    assert.equal(after.status, "placed");
    assert.deepEqual(after.made, placed.made);
    assert.match(after.last_failed_attempt!.error, /edit broke/);
  } finally { w.done(); }
});

test("a Revit call still running leaves the record pending, and a pending place blocks the next place and edit", async () => {
  const w = world();
  try {
    const pane = { ...w.env, FMC_CALLER: "pane" };
    const err = Object.assign(new Error("still placing"), { code: "FMC-JOB-RUNNING" });
    const r = await runFmcCeiling(args(w.project) as any, KIT, { ...mockRevit(w, { fail: err }).ctx, env: pane });
    assert.equal(text(r).record_status, "pending");
    const rec = readRecord(placedRecordFile(w.project, "L-01 Living"))!;
    assert.equal(rec.status, "pending");
    assert.match(rec.error!, /unconfirmed/);
    for (const action of ["place", "edit"]) {
      const next = await runFmcCeiling(args(w.project, { action }) as any, KIT, { ...mockRevit(w).ctx, env: pane });
      assert.equal(next.isError, true);
      assert.match(text(next).reasons[0], /never finished/);
    }
  } finally { w.done(); }
});

test("if the record can't be written first, nothing is changed in the model", async () => {
  const w = world();
  try {
    // a directory where the record file must go
    fs.mkdirSync(placedRecordFile(w.project, "L-01 Living"), { recursive: true });
    const { ctx, calls } = mockRevit(w);
    const r = await runFmcCeiling(args(w.project) as any, KIT, { ...ctx, env: { ...w.env, FMC_CALLER: "pane" } });
    assert.equal(r.isError, true);
    assert.equal(calls.list.filter((c) => !c.dry).length, 0);
  } finally { w.done(); }
});

test("record unit: pending keeps an edit's elements; finish retries then falls back to a side file; markUnknown keeps it pending", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc_rec_"));
  try {
    const file = path.join(dir, "x", "FMC_Ceiling_a.json");
    const before: PlacedRecord = { room: "a", design: "tray", level: "L0", placed_at: "t0", made: ["u1", "u2"], elements: [{ unique_id: "u1", key: "k1" }, { unique_id: "u2", key: "k2" }] };
    const i = { action: "edit" as const, room: "a", design: "flat", level: "L0", design_hash: "h", placement_hash: "p", kit_revisions: {}, origin_mm: { x: 0, y: 0 }, approved_by: "E", approval_id: "id", now: NOW };
    const pending = writePending(file, before, i);
    assert.deepEqual(readRecord(file)!.made, ["u1", "u2"]);
    assert.equal(readRecord(file)!.previous!.placed_at, "t0");
    markUnknown(file, pending, "timeout");
    assert.match(readRecord(file)!.error!, /unconfirmed: timeout/);
    let n = 0;
    const flaky = (f: string, r: PlacedRecord) => { if (++n < 3) throw new Error("locked"); writeRecordAtomic(f, r); };
    assert.equal(finishRecord(file, pending, [{ unique_id: "u9", key: "k9" }], NOW, flaky).ok, true);
    assert.deepEqual(readRecord(file)!.made, ["u9"]);
    assert.equal(readRecord(file)!.previous, undefined);
    const dead = finishRecord(file, pending, [{ unique_id: "u7", key: "k7" }], NOW, () => { throw new Error("disk full"); });
    assert.equal(dead.ok, false);
    assert.ok(dead.side_file && fs.existsSync(dead.side_file));
    assert.deepEqual(JSON.parse(fs.readFileSync(dead.side_file!, "utf8")).made, ["u7"]);
    const rb = rollBackRecord(file, pending, "boom", NOW);
    assert.equal(statusOf(rb), "placed");
    assert.equal(rb.last_failed_attempt!.error, "boom");
    assert.deepEqual(rb.made, ["u1", "u2"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("old records with no status count as placed", () => {
  const old: PlacedRecord = { room: "a", design: "tray", level: "L0", placed_at: "t0", made: ["u1"], elements: [{ unique_id: "u1", key: "k" }] };
  assert.equal(statusOf(old), "placed");
  assert.match(recordBlocks(old, "place", "a")!, /use edit/);
  assert.equal(recordBlocks(old, "edit", "a"), null);
  assert.equal(recordBlocks(null, "place", "a"), null);
});

// ---------- pack and drawings need a person too

test("pack and drawings: dry runs need nobody; the real run waits for a person (AI) and runs for the approved call", async () => {
  const w = world();
  try {
    const { ctx, calls } = mockRevit(w);
    const mcp = { ...ctx, viaMcp: true };
    const packArgs = args(w.project, { action: "pack", design: "tray" });
    const dryOut = text(await runFmcCeiling({ ...packArgs, dry_run: true } as any, KIT, mcp));
    assert.equal(dryOut.dry_run, true);
    const wait = text(await runFmcCeiling(packArgs as any, KIT, mcp));
    assert.equal(wait.awaiting_person, true);
    assert.equal(fs.existsSync(path.join(w.project, "01_WIP", "_Ceilings")), false);
    approveInPane(w, wait.approval_id);
    const done = text(await runFmcCeiling(packArgs as any, KIT, mcp));
    assert.equal(done.done, true, JSON.stringify(done));
    assert.ok(fs.existsSync(done.files.setout));

    const dr = args(w.project, { action: "drawings", drawings: { sheet_number: "I-1201", sheet_name: "", title_block: "" } });
    const dwait = text(await runFmcCeiling(dr as any, KIT, mcp));
    assert.equal(dwait.awaiting_person, true);
    assert.equal(calls.list.filter((c) => !c.dry).length, 0);
    approveInPane(w, dwait.approval_id);
    const ddone = text(await runFmcCeiling(dr as any, KIT, mcp));
    assert.equal(ddone.done, true, JSON.stringify(ddone));
    assert.equal(calls.list.filter((c) => !c.dry && c.command === "fmc_ceiling_sheet").length, 1);
  } finally { w.done(); }
});
