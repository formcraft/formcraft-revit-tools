import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { JOINS_BANK_SHAPES, JOINS_DEFAULTS, JOINS_KEYS, citeJoins, verdictFor } from "./joins_bank.js";
import {
  auditFindings, auditKeys, classifyPair, hostingFindings, joinsDir, normalizeSnapshot, overallVerdict,
  planFixes, pressureResult, resolveJoinsLimits, roomFindings, standardsFor, writeJoinsReport,
  type PairRow,
} from "./joins.js";
import { FMC_JOINS_DESCRIPTION, FMC_JOINS_SHAPE, runFmcJoins, type FmcJoinsArgs } from "../tools/fmc_joins.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function args(partial: Record<string, unknown>): FmcJoinsArgs {
  return z.object(FMC_JOINS_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, unknown> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-joins-"));
  const guard = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(guard, JSON.stringify({
    save_exclude: ["HEBERT HOSTELS"],
    sync_exclude: ["QUIET"],
    protected_paths: ["D:\\Live"],
  }));
  const env = {
    ...process.env,
    APPDATA: dir,
    LOCALAPPDATA: dir,
    FMC_GUARD_CONFIG: guard,
    FMC_JOINS_DIR: path.join(dir, "joins"),
    FMC_STANDARDS_FILE: path.join(dir, "missing-standards.json"),
  } as NodeJS.ProcessEnv;
  return { dir, env, reportDir: path.join(dir, "joins") };
}

const approved = Object.fromEntries(JOINS_KEYS.map((key) => [key, {
  value: JOINS_DEFAULTS[key], status: "approved", clause: "STD joins",
}]));

function limits(bank?: Record<string, unknown>) {
  return resolveJoinsLimits({}, bank as never);
}

function pair(partial: Record<string, unknown>): PairRow {
  return normalizeSnapshot({ pairs: [{
    relation: "wall_end", a: "1", b: "2", end: 0, gap_mm: 0, overlap_mm: 0,
    joined: false, open_end: false, attached: false, xyz: { x: 1, y: 2, z: 3 }, pinned: false,
    ...partial,
  }] }).pairs[0];
}

function model(partial: Record<string, unknown> = {}) {
  return normalizeSnapshot({
    resolved_document: { title: "A-0003", path: "D:\\Jobs\\_Staging\\A-0003.rvt" },
    scoped: true,
    pairs: [], hosts: [], rooms: [], room_walls: [], leaks: [],
    envelope: { built: true, incomplete: false, capped: false, exterior_walls: 4, roofs: 1, floors: 1, curtain: 0, doors: 1, windows: 1, rays: 48, voxels: 20, booleans: 4, reason: "" },
    ...partial,
  });
}

test("provisional defaults are labelled and never PASS, and a null status is UNKNOWN", () => {
  const missing = citeJoins("joins.gap_mm", {});
  assert.equal(missing.source, "provisional");
  assert.equal(missing.value, 10);
  assert.match(missing.clause, /PROVISIONAL default/);
  assert.equal(verdictFor(true, missing), "PROVISIONAL");
  assert.equal(verdictFor(false, missing), "FAIL");

  const nulled = citeJoins("joins.gap_mm", { "joins.gap_mm": { value: null, status: "approved", clause: "STD joins" } });
  assert.equal(nulled.source, "provisional");
  assert.equal(nulled.value, 10);
  assert.match(nulled.clause, /PROVISIONAL default used/);

  const nullStatus = citeJoins("joins.leak_min_mm", { "joins.leak_min_mm": { value: 10, status: null, clause: "STD joins" } });
  assert.equal(nullStatus.source, "unknown");
  assert.equal(verdictFor(true, nullStatus), "UNKNOWN");
  assert.equal(verdictFor(false, nullStatus), "UNKNOWN");

  const draft = citeJoins("joins.gap_mm", { "joins.gap_mm": { value: 10, status: "draft", clause: "STD joins" } });
  assert.equal(verdictFor(true, draft), "PASS");
  const bare = citeJoins("joins.gap_mm", { "joins.gap_mm": { value: 10, status: "approved" } });
  assert.equal(bare.source, "provisional");
  assert.equal(verdictFor(true, bare), "PROVISIONAL");
  for (const key of JOINS_KEYS) assert.ok(JOINS_BANK_SHAPES[key]?.value != null, key);
});

test("join findings carry a code, a size and the element ids", () => {
  const cited = limits().cited;
  const values = limits().values;
  const code = (partial: Record<string, unknown>) => classifyPair(pair(partial), values, cited)?.code ?? "";
  assert.equal(code({ open_end: true, gap_mm: null, b: "" }), "JOIN-WALL-END-OPEN");
  assert.equal(code({ open_end: true, gap_mm: 80 }), "JOIN-WALL-END-OPEN");
  assert.equal(code({ open_end: true, gap_mm: 30 }), "JOIN-NEAR-MISS");
  assert.equal(code({ open_end: true, gap_mm: 4 }), "JOIN-WALL-END-OPEN");
  assert.equal(code({ joined: true, open_end: false, gap_mm: 30 }), "JOIN-NEAR-MISS");
  assert.equal(code({ joined: true, open_end: false, gap_mm: 80 }), "JOIN-GAP");
  assert.equal(code({ joined: true, open_end: false, gap_mm: 4 }), "");
  assert.equal(code({ joined: true, overlap_mm: 12, gap_mm: 0 }), "JOIN-OVERLAP");
  assert.equal(code({ relation: "wall_roof", attached: false, gap_mm: 0, open_end: false }), "JOIN-TOP-UNATTACHED");
  assert.equal(code({ relation: "wall_roof", attached: true, gap_mm: 40, open_end: false }), "JOIN-TOP-UNATTACHED");
  assert.equal(code({ relation: "wall_roof", attached: true, gap_mm: 4, open_end: false }), "");
  assert.equal(code({ relation: "wall_floor", attached: false, gap_mm: 40, open_end: false }), "JOIN-BASE-OFFSET");
  assert.equal(code({ relation: "wall_floor", attached: true, gap_mm: 15, open_end: false }), "");
  assert.equal(code({ relation: "wall_column", open_end: false, gap_mm: 80 }), "JOIN-COLUMN");
  assert.equal(code({ relation: "wall_column", open_end: false, gap_mm: 30 }), "JOIN-NEAR-MISS");
  assert.equal(code({ relation: "wall_framing", open_end: false, gap_mm: 80 }), "JOIN-FRAMING");
  assert.equal(code({ relation: "curtain_wall", open_end: true, gap_mm: 80 }), "JOIN-CURTAIN-OPEN");
  assert.equal(code({ relation: "slab_edge", open_end: false, gap_mm: 80 }), "JOIN-SLAB-EDGE");
  assert.equal(code({ relation: "floor_edge", open_end: false, gap_mm: 80 }), "JOIN-SLAB-EDGE");
  assert.equal(code({ relation: "stair_floor", open_end: false, gap_mm: 80 }), "JOIN-STAIR-FLOOR");
  assert.equal(code({ relation: "railing_floor", open_end: false, gap_mm: 80 }), "JOIN-RAILING-FLOOR");
  const hit = classifyPair(pair({ open_end: true, gap_mm: 80 }), values, cited);
  assert.deepEqual(hit?.xyz, { x: 1, y: 2, z: 3 });
  assert.equal(hit?.size_mm, 80);
  assert.deepEqual(hit?.ids, ["1", "2"]);
});

test("a clean audit PASSes only against an approved clause", () => {
  const clean = model();
  const held = auditFindings(clean, limits(approved));
  assert.equal(held.length, 0);
  assert.equal(overallVerdict(held, standardsFor(auditKeys(), limits(approved).cited)), "PASS");
  const provisional = auditFindings(clean, limits());
  assert.equal(provisional.length, 0);
  assert.equal(overallVerdict(provisional, standardsFor(auditKeys(), limits().cited)), "PROVISIONAL");
  const bad = auditFindings(model({ pairs: [{ relation: "wall_end", a: "9", b: "", end: 1, open_end: true, gap_mm: 80, overlap_mm: 0, xyz: { x: 0, y: 0, z: 0 } }] }), limits(approved));
  assert.equal(bad[0].code, "JOIN-WALL-END-OPEN");
  assert.equal(bad[0].verdict, "FAIL");
});

test("hosting covers doors, windows, floating families and fixtures, with a category filter", () => {
  const hosts = [
    { id: "10", category: "Doors", kind: "door", outside: true, host_id: "1", should_host: true, cuts: true, offset_mm: 0 },
    { id: "11", category: "Doors", kind: "door", should_host: true, host_id: "", outside: false },
    { id: "12", category: "Windows", kind: "window", host_id: "1", cuts: false, outside: false, should_host: true },
    { id: "13", category: "Furniture", kind: "family", float: "level", offset_mm: 100, should_host: false, host_id: "" },
    { id: "14", category: "Lighting Fixtures", kind: "family", float: "host", offset_mm: 40, host_id: "2", should_host: true },
    { id: "15", category: "Plumbing Fixtures", kind: "fixture", touching: false, should_host: false, host_id: "", offset_mm: 0 },
    { id: "16", category: "Doors", kind: "door", host_id: "1", cuts: true, outside: false, offset_mm: 0, should_host: true },
  ];
  const found = hostingFindings(model({ hosts }), limits(approved));
  const byId = Object.fromEntries(found.map((item) => [item.ids[0], item.code]));
  assert.equal(byId["10"], "HOST-OUTSIDE");
  assert.equal(byId["11"], "HOST-UNHOSTED");
  assert.equal(byId["12"], "HOST-NOT-CUTTING");
  assert.equal(byId["13"], "HOST-FLOAT-LEVEL");
  assert.equal(byId["14"], "HOST-OFFSET");
  assert.equal(byId["15"], "HOST-NOT-TOUCHING");
  assert.equal(byId["16"], undefined);
  const doors = hostingFindings(model({ hosts }), limits(approved), "Doors");
  assert.deepEqual(doors.map((item) => item.ids[0]).sort(), ["10", "11"]);
});

test("the pressure test seals only a finished sample against an approved clause", () => {
  const leak = { code: "LEAK-GAP", xyz: { x: 1, y: 2, z: 3 }, size_mm: 25, ids: ["1", "2"], relation: "gap", closed: false };
  const open = pressureResult(model({ leaks: [leak] }), limits(approved), "envelope");
  assert.equal(open.verdict, "LEAKS");
  assert.equal(open.leaks[0].size_mm, 25);
  assert.deepEqual(open.leaks[0].ids, ["1", "2"]);

  const tiny = pressureResult(model({ leaks: [{ ...leak, size_mm: 4 }] }), limits(approved), "envelope");
  assert.equal(tiny.verdict, "SEALED");
  const shut = pressureResult(model({ leaks: [{ ...leak, closed: true }] }), limits(approved), "envelope");
  assert.equal(shut.verdict, "SEALED");
  const clean = pressureResult(model(), limits(approved), "envelope");
  assert.equal(clean.verdict, "SEALED");
  assert.equal(clean.standard_verdict, "PASS");
  const provisional = pressureResult(model(), limits(), "envelope");
  assert.equal(provisional.verdict, "UNKNOWN");
  assert.equal(provisional.standard_verdict, "PROVISIONAL");
  assert.match(provisional.reason, /provisional/);
  const capped = pressureResult(model({ envelope: { ...model().envelope, capped: true } }), limits(approved), "envelope");
  assert.equal(capped.verdict, "UNKNOWN");
  const incomplete = pressureResult(model({ envelope: { ...model().envelope, incomplete: true, built: false } }), limits(approved), "envelope");
  assert.equal(incomplete.verdict, "UNKNOWN");
  const foundAnyway = pressureResult(model({ leaks: [leak], envelope: { ...model().envelope, incomplete: true } }), limits(approved), "envelope");
  assert.equal(foundAnyway.verdict, "LEAKS");
  const unknownTol = pressureResult(model({ leaks: [leak] }), limits({ "joins.leak_min_mm": { value: 10, status: null } }), "envelope");
  assert.equal(unknownTol.verdict, "UNKNOWN");
});

test("rooms mode reports closure, unbounded and redundant rooms, and boundary gaps", () => {
  const rooms = [
    { id: "r1", kind: "room", number: "101", enclosed: false, unbounded: false, redundant: false, boundary_gap_mm: 0, xyz: { x: 0, y: 0, z: 0 } },
    { id: "r2", kind: "space", number: "S1", unbounded: true, enclosed: null },
    { id: "r3", kind: "room", number: "102", redundant: true, enclosed: true, unbounded: false },
    { id: "r4", kind: "room", number: "103", enclosed: true, unbounded: false, redundant: false, boundary_gap_mm: 40 },
    { id: "r5", kind: "room", number: "104", enclosed: true, unbounded: false, redundant: false, boundary_gap_mm: 2 },
  ];
  const walls = [{ id: "w1", room_bounding: false }, { id: "w2", room_bounding: true }];
  const found = roomFindings(model({ rooms, room_walls: walls }), limits(approved));
  const codes = Object.fromEntries(found.map((item) => [item.ids[0] + item.code, item.code]));
  assert.equal(codes.r1ROOM_NOT_ENCLOSED ?? found.find((item) => item.ids[0] === "r1" && item.code === "ROOM-NOT-ENCLOSED")?.code, "ROOM-NOT-ENCLOSED");
  assert.ok(found.some((item) => item.code === "ROOM-UNBOUNDED" && item.ids[0] === "r2"));
  assert.ok(found.some((item) => item.code === "ROOM-REDUNDANT" && item.ids[0] === "r3"));
  assert.ok(found.some((item) => item.code === "ROOM-BOUNDARY-GAP" && item.ids[0] === "r4" && item.size_mm === 40));
  assert.equal(found.some((item) => item.ids[0] === "r5" && item.code === "ROOM-BOUNDARY-GAP"), false);
  assert.ok(found.some((item) => item.code === "ROOM-WALL-NOT-BOUNDING" && item.ids[0] === "w1"));
  const closure = pressureResult(model({ rooms: [{ id: "r5", kind: "room", enclosed: true, unbounded: false, redundant: false, boundary_gap_mm: 2 }], room_walls: walls }), limits(approved), "rooms");
  assert.equal(closure.verdict, "SEALED");
  const hole = pressureResult(model({ rooms: rooms.slice(0, 1) }), limits(approved), "rooms");
  assert.equal(hole.verdict, "LEAKS");
  const none = pressureResult(model({ rooms: [] }), limits(approved), "rooms");
  assert.equal(none.verdict, "UNKNOWN");
});

test("the fix plan snaps near misses, joins close ends, and leaves pinned or owned elements", () => {
  const resolved = limits(approved);
  const snapshot = model({
    pairs: [
      { relation: "wall_end", a: "1", b: "2", end: 0, open_end: true, gap_mm: 30, overlap_mm: 0, xyz: { x: 10, y: 0, z: 0 } },
      { relation: "wall_end", a: "3", b: "4", end: 1, open_end: true, gap_mm: 4, overlap_mm: 0, xyz: { x: 1, y: 0, z: 0 } },
      { relation: "wall_end", a: "5", b: "", end: 0, open_end: true, gap_mm: 80, overlap_mm: 0, xyz: { x: 0, y: 0, z: 0 } },
      { relation: "wall_roof", a: "6", b: "7", attached: false, gap_mm: 40, overlap_mm: 0, open_end: false, xyz: { x: 0, y: 0, z: 3 } },
      { relation: "wall_end", a: "8", b: "9", end: 0, open_end: true, gap_mm: 4, overlap_mm: 0, pinned: true, xyz: { x: 0, y: 0, z: 0 } },
      { relation: "wall_end", a: "10", b: "11", end: 0, open_end: true, gap_mm: 4, overlap_mm: 0, checkout_a: "FMC-ELEM-OWNED-BY-OTHER", owner_a: "Ada", xyz: { x: 0, y: 0, z: 0 } },
      { relation: "wall_wall", a: "12", b: "13", end: 0, overlap_mm: 12, gap_mm: 0, open_end: false, xyz: { x: 2, y: 2, z: 0 } },
      { relation: "wall_wall", a: "14", b: "15", end: 0, overlap_mm: 200, gap_mm: 0, open_end: false, xyz: { x: 0, y: 0, z: 0 } },
    ],
    hosts: [
      { id: "20", kind: "family", category: "Furniture", should_host: true, host_id: "", candidates: ["30"], offset_mm: 15, float: "level" },
      { id: "21", kind: "family", category: "Furniture", should_host: true, host_id: "", candidates: ["31", "32"], offset_mm: 15 },
    ],
  });
  const findings = [...auditFindings(snapshot, resolved), ...hostingFindings(snapshot, resolved)];
  const plan = planFixes(findings, snapshot, resolved);
  const ops = plan.ops.map((op) => op.op + ":" + op.ids.join(","));
  assert.ok(ops.includes("snap:1"));
  assert.ok(ops.includes("allow_join:3"));
  assert.ok(ops.includes("join:3,4"));
  assert.ok(ops.includes("attach_top:6"));
  assert.ok(ops.includes("trim:12"));
  assert.ok(ops.includes("rehost:20"));
  assert.equal(ops.some((op) => op.startsWith("snap:8") || op.includes(":8")), false);
  assert.equal(ops.some((op) => op.includes("10")), false);
  assert.equal(ops.some((op) => op.startsWith("rehost:21")), false);
  assert.ok(plan.skipped.some((row) => row.code === "JOIN-PINNED"));
  assert.ok(plan.skipped.some((row) => row.code === "FMC-ELEM-OWNED-BY-OTHER"));
  assert.ok(plan.warnings.some((line) => line.includes("21")));
  assert.ok(plan.warnings.some((line) => line.includes("14") || line.includes("overlap")));
  const many = model({
    pairs: Array.from({ length: 40 }, (_, index) => ({
      relation: "wall_end", a: String(100 + index), b: String(200 + index), end: 0, open_end: true, gap_mm: 30, overlap_mm: 0, xyz: { x: index, y: 0, z: 0 },
    })),
  });
  const crowded = planFixes(auditFindings(many, resolved), many, resolved);
  assert.ok(crowded.ops.length <= 50);
  assert.equal(crowded.capped, true);
});

test("checks and limits do not call Revit, and a model call needs an exact document", async () => {
  let reads = 0;
  const checks = textOf(await runFmcJoins(args({ action: "checks" }), { readSnapshot: async () => { reads++; return {}; } }));
  assert.equal(reads, 0);
  assert.equal(checks.isError, false);
  assert.ok((checks.codes as string[]).includes("JOIN-WALL-END-OPEN"));
  assert.ok((checks.codes as string[]).includes("LEAK-WALL-BASE"));
  const bankLimits = textOf(await runFmcJoins(args({ action: "limits" }), { bank: approved, readSnapshot: async () => { reads++; return {}; } }));
  assert.equal(reads, 0);
  const gap = (bankLimits.limits as Array<{ key: string; source: string; clause: string }>).find((field) => field.key === "joins.gap_mm");
  assert.equal(gap?.source, "standards");
  assert.match(FMC_JOINS_DESCRIPTION, /FMC-DOC-REQUIRED/);
  const missing = textOf(await runFmcJoins(args({ action: "audit", document: "" }), { readSnapshot: async () => { reads++; return {}; } }));
  assert.equal(missing.code, "FMC-DOC-REQUIRED");
  assert.equal(reads, 0);
  assert.match(String(missing.message), /active document/);
});

test("audit is one read, images stay off unless asked, and the report is not the live AppData", async () => {
  const { env, reportDir } = tempEnv();
  let reads = 0;
  const body = textOf(await runFmcJoins(args({ action: "audit", document: "A-0003", level: "Level 1" }), {
    env, reportDir, bank: approved,
    readSnapshot: async (sent) => {
      reads++;
      assert.equal(sent.document, "A-0003");
      assert.equal(sent.images, false);
      assert.equal(sent.level, "Level 1");
      return model({
        pairs: [{ relation: "wall_end", a: "1", b: "", end: 0, open_end: true, gap_mm: 80, overlap_mm: 0, xyz: { x: 4, y: 5, z: 6 } }],
        images: [{ path: "C:\\should\\not\\appear.png" }],
      });
    },
  }));
  assert.equal(reads, 1);
  assert.equal(body.isError, false);
  assert.deepEqual(body.images, []);
  assert.equal((body.resolved_document as { title: string }).title, "A-0003");
  const summary = (body.findings as Array<{ code: string; count: number; ids: string[] }>).find((item) => item.code === "JOIN-WALL-END-OPEN");
  assert.equal(summary?.count, 1);
  assert.deepEqual(summary?.ids, ["1"]);
  assert.equal(String(body.report).startsWith(reportDir), true);
  const saved = JSON.parse(fs.readFileSync(String(body.report), "utf8")) as { items: Array<{ xyz: { x: number }; size_mm: number }> };
  assert.equal(saved.items[0].xyz.x, 4);
  assert.equal(saved.items[0].size_mm, 80);
  assert.equal(body.verdict, "FAIL");

  const pictured = textOf(await runFmcJoins(args({ action: "audit", document: "A-0003", level: "Level 1", images: true }), {
    env, reportDir, bank: approved,
    readSnapshot: async (sent) => {
      assert.equal(sent.images, true);
      return model({ images: [{ path: path.join(reportDir, "joins.png") }] });
    },
  }));
  assert.equal((pictured.images as { path: string }[])[0].path, path.join(reportDir, "joins.png"));
});

test("an unscoped model over the cap is refused, and document errors keep their codes", async () => {
  const refused = textOf(await runFmcJoins(args({ action: "audit", document: "A-0003" }), {
    bank: {},
    readSnapshot: async () => ({ refused: true, code: "FMC-JOINS-SCOPE", message: "[FMC-JOINS-SCOPE] Name a level.", element_count: 5000, resolved_document: { title: "A-0003", path: "" } }),
  }));
  assert.equal(refused.code, "FMC-JOINS-SCOPE");
  assert.equal(refused.element_count, 5000);
  assert.equal(refused.isError, true);
  const missing = textOf(await runFmcJoins(args({ action: "hosting", document: "Missing" }), {
    readSnapshot: async () => { throw new Error("[FMC-DOC-NOT-FOUND] No open document has title or path \"Missing\". Refusing to use the active document."); },
  }));
  assert.equal(missing.code, "FMC-DOC-NOT-FOUND");
  const ambiguous = textOf(await runFmcJoins(args({ action: "rooms", document: "A-0003" }), {
    readSnapshot: async () => { throw new Error("[FMC-DOC-AMBIGUOUS] \"A-0003\" matches 2 open documents."); },
  }));
  assert.equal(ambiguous.code, "FMC-DOC-AMBIGUOUS");
});

test("a fix dry run does not apply, and apply is one leased call with the plan", async () => {
  const { env, reportDir } = tempEnv();
  const guard = JSON.parse(fs.readFileSync(path.join(path.dirname(reportDir), "fmc_guard.json"), "utf8"));
  let reads = 0;
  let applies = 0;
  const planned = textOf(await runFmcJoins(args({ action: "fix", document: "A-0003", level: "Level 1" }), {
    env, reportDir, bank: approved, guard,
    readSnapshot: async () => {
      reads++;
      return model({ pairs: [{ relation: "wall_end", a: "3", b: "4", end: 1, open_end: true, gap_mm: 4, overlap_mm: 0, xyz: { x: 1, y: 0, z: 0 } }] });
    },
    apply: async () => { applies++; return {}; },
  }));
  assert.equal(reads, 1);
  assert.equal(applies, 0);
  assert.equal(planned.dry_run, true);
  const ops = planned.ops as Array<{ op: string }>;
  assert.ok(ops.some((op) => op.op === "join"));

  const needsPlan = textOf(await runFmcJoins(args({ action: "fix", document: "A-0003", dry_run: false, batch_lease: "lease-1" }), {
    env, reportDir, bank: approved, guard,
    readSnapshot: async () => { reads++; return model(); },
    apply: async () => { applies++; return {}; },
  }));
  assert.equal(needsPlan.code, "FMC-JOINS-PLAN");
  assert.equal(applies, 0);

  const locked = textOf(await runFmcJoins(args({ action: "fix", document: "A-0003", dry_run: false, ops: [{ op: "join", ids: ["3", "4"] }] }), {
    env, reportDir, guard,
    apply: async () => { applies++; return {}; },
  }));
  assert.equal(locked.code, "FMC-BATCH-LOCKED");
  assert.equal(applies, 0);

  const hebert = textOf(await runFmcJoins(args({ action: "fix", document: "HEBERT HOSTELS_USER", level: "Level 1" }), {
    env, reportDir, guard,
    readSnapshot: async () => { reads++; return model(); },
  }));
  assert.equal(hebert.code, "FMC-JOINS-GUARD");
  assert.match(String(hebert.message), /HEBERT HOSTELS/);

  const live = textOf(await runFmcJoins(args({ action: "fix", document: "D:\\Live\\A.rvt", dry_run: false, batch_lease: "lease-1", ops: [{ op: "join", ids: ["3", "4"] }] }), {
    env, reportDir, guard,
    apply: async () => { applies++; return {}; },
  }));
  assert.equal(live.code, "FMC-JOINS-GUARD");
  assert.equal(applies, 0);

  const applied = textOf(await runFmcJoins(args({
    action: "fix", document: "A-0003", dry_run: false, batch_lease: "lease-1",
    ops: planned.ops as never[],
  }), {
    env, reportDir, guard,
    readSnapshot: async () => { reads++; return model(); },
    apply: async (body) => {
      applies++;
      assert.ok((body.ops as unknown[]).length <= 50);
      assert.equal(body.max_ops, 50);
      assert.ok((body.protected_roots as string[]).includes("D:\\Live"));
      assert.equal(body.document, "A-0003");
      return { ok: true, applied: true, saved: false, synced: false, resolved_document: { title: "A-0003", path: "D:\\Jobs\\_Staging\\A-0003.rvt" } };
    },
  }));
  assert.equal(reads, 1);
  assert.equal(applies, 1);
  assert.equal(applied.dry_run, false);
  assert.equal(applied.saved, false);
  assert.equal((applied.resolved_document as { title: string }).title, "A-0003");
});

test("the add-in commands are registered, reads and writes are listed, and ownership is never taken", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((command) => command.commandName));
  assert.ok(names.has("fmc_joins"));
  assert.ok(names.has("fmc_joins_apply"));
  const tool = fs.readFileSync(path.join(root, "server", "src", "tools", "fmc_joins.ts"), "utf8");
  assert.match(tool, /sendCommand\(\s*"fmc_joins"/);
  assert.match(tool, /sendCommand\(\s*"fmc_joins_apply"/);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_joins"));
  assert.ok(WRITE_COMMANDS.has("fmc_joins_apply"));
  assert.ok(!WRITE_COMMANDS.has("fmc_joins"));
  const read = fs.readFileSync(path.join(root, "commandset", "Commands", "Fmc", "FmcJoinsCommand.cs"), "utf8");
  assert.match(read, /CommandName => "fmc_joins"/);
  assert.match(read, /CommandName => "fmc_joins_apply"/);
  const collector = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcJoins.cs"), "utf8");
  const apply = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcJoinsApply.cs"), "utf8");
  assert.match(collector, /get_ElementsAtJoin/);
  assert.match(collector, /FMC-DOC-REQUIRED/);
  assert.match(collector, /FMC-JOINS-SCOPE/);
  assert.match(collector, /BooleanOperationsUtils/);
  assert.match(apply, /JoinGeometryUtils\.JoinGeometry/);
  assert.match(apply, /WallUtils\.AllowWallJoinAtEnd/);
  assert.match(apply, /FmcCheckout\.Partition/);
  assert.match(apply, /Pinned/);
  assert.doesNotMatch(collector + apply, /CheckoutElements\s*\(/);
  assert.doesNotMatch(collector + apply, /\.Save\s*\(|SynchronizeWithCentral\s*\(/);
  assert.doesNotMatch(collector, /Cast<FamilyInstance>|Cast<MEPCurve>|Cast<Pipe>/);
  assert.match(collector, /skipped_non_family/);
  const override = path.join(os.tmpdir(), "fmc-joins-unit");
  const dir = joinsDir({ FMC_JOINS_DIR: override } as NodeJS.ProcessEnv);
  assert.equal(dir, override);
  const file = writeJoinsReport(dir, "unit", { ok: true });
  assert.equal(file.startsWith(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a DirectShape in a collected category stays on the joins snapshot", () => {
  const snapshot = normalizeSnapshot({
    pairs: [], hosts: [], rooms: [], room_walls: [], leaks: [],
    skipped_non_family: {
      count: 1,
      ids: [1822136],
      items: [{ id: 1822136, class: "DirectShape", category: "Plumbing Fixtures" }],
    },
  });
  assert.equal(snapshot.skipped_non_family?.count, 1);
  assert.deepEqual(snapshot.skipped_non_family?.ids, [1822136]);
  assert.equal(snapshot.skipped_non_family?.items[0]?.class, "DirectShape");
  assert.equal(snapshot.skipped_non_family?.items[0]?.category, "Plumbing Fixtures");
  assert.equal(snapshot.hosts.some((row) => row.id === "1822136"), false);
});
