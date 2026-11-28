import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { EXTSTORE_SCHEMA_GUID, OTHER_FMC_SCHEMA_GUIDS, auditRows, planWrites, recordProblems, type ExtRow } from "./extstore.js";
import { FMC_EXTSTORE_SHAPE, runFmcExtstore, type FmcExtstoreArgs } from "../tools/fmc_extstore.js";

const root = new URL("../../../", import.meta.url);
const args = (p: Record<string, unknown>): FmcExtstoreArgs => z.object(FMC_EXTSTORE_SHAPE).parse(p);
const out = (r: { content: Array<{ text: string }>; isError?: boolean }) => ({ ...JSON.parse(r.content[0].text), isError: r.isError === true });
const HASH = "a".repeat(64);
const rec = (id: string, fmc: string, extra: Record<string, string> = {}) => ({ id, fmc_id: fmc, batch_id: "B-20261128-01", recipe_hash: HASH, source: "recipe", ...extra });

test("extstore: the schema GUID is fixed, well formed, and not another Formcraft schema's", () => {
  assert.match(EXTSTORE_SCHEMA_GUID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(!OTHER_FMC_SCHEMA_GUIDS.includes(EXTSTORE_SCHEMA_GUID));
  assert.equal(EXTSTORE_SCHEMA_GUID, "cf567a49-572e-4e9a-afd1-f827205bd249", "never change the GUID: stamped elements are found by it");
});

test("extstore: the Revit side uses the same GUID, name, vendor and fields", () => {
  const cs = fs.readFileSync(new URL("commandset/Services/Fmc/FmcExtStore.cs", root), "utf8");
  assert.ok(cs.includes(`new Guid("${EXTSTORE_SCHEMA_GUID}")`));
  assert.ok(cs.includes(`SetSchemaName("FMC_ExtStore")`));
  assert.ok(cs.includes(`SetVendorId("Formcraft")`));
  for (const f of ["FmcId", "BatchId", "RecipeHash", "Source"]) assert.ok(cs.includes(`"${f}"`), f);
  for (const g of OTHER_FMC_SCHEMA_GUIDS) assert.ok(!cs.includes(g));
});

test("extstore: command.json lists the read and write commands, and the lock lists know them", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("command.json", root), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = manifest.commands.map((c) => c.commandName);
  assert.ok(names.includes("fmc_extstore_read") && names.includes("fmc_extstore_write"));
  assert.ok(WRITE_COMMANDS.has("fmc_extstore_write"));
  assert.ok(!WRITE_COMMANDS.has("fmc_extstore_read") && !READ_VIA_SEND_COMMAND.has("fmc_extstore_write"));
});

test("extstore: record checks", () => {
  assert.deepEqual(recordProblems(rec("101", "FMC-A-DOOR-0001")), []);
  assert.deepEqual(recordProblems(rec("101", "FMC-A-DOOR-0001", { recipe_hash: "" })), [], "a hash is optional");
  const bad = recordProblems({ id: "x", fmc_id: "door1", batch_id: "", recipe_hash: "XYZ", source: "magic" });
  assert.equal(bad.length, 5);
  assert.match(bad.join("|"), /isn't an element id/);
  assert.match(bad.join("|"), /isn't an FMC id/);
  assert.match(bad.join("|"), /sha256/);
  assert.match(bad.join("|"), /Source "magic"/);
});

test("extstore: the plan creates, updates, keeps, and skips owned, taken and existing ids", () => {
  const existing: ExtRow[] = [
    { id: "2", fmc_id: "FMC-A-0002", batch_id: "B-OLD", recipe_hash: HASH, source: "recipe" },
    { id: "3", fmc_id: "FMC-A-0003", batch_id: "B-20261128-01", recipe_hash: HASH, source: "recipe" },
    { id: "4", fmc_id: "", batch_id: "", recipe_hash: "", source: "", checkout: "owned_by_other", owner: "jane" },
    { id: "5", fmc_id: "FMC-A-0005", batch_id: "B", recipe_hash: "", source: "kit" },
    { id: "9", fmc_id: "FMC-A-0099", batch_id: "B", recipe_hash: "", source: "kit" },
  ];
  const { rows, problems } = planWrites([
    rec("1", "FMC-A-0001"), rec("2", "FMC-A-0002"), rec("3", "FMC-A-0003"), rec("4", "FMC-A-0004"), rec("5", "FMC-A-0555"), rec("6", "FMC-A-0099"),
  ], existing);
  assert.deepEqual(problems, []);
  const act = Object.fromEntries(rows.map((r) => [r.id, r.action]));
  assert.deepEqual(act, { "1": "create", "2": "update", "3": "same", "4": "skip", "5": "skip", "6": "skip" });
  assert.deepEqual(rows.find((r) => r.id === "2")!.changes, [{ field: "BatchId", from: "B-OLD", to: "B-20261128-01" }]);
  assert.match(rows.find((r) => r.id === "4")!.reason!, /owned by jane/);
  assert.match(rows.find((r) => r.id === "6")!.reason!, /already on element 9/);
  const re = planWrites([rec("5", "FMC-A-0555")], existing, { reassign: true });
  assert.equal(re.rows[0].action, "update");
});

test("extstore: duplicate elements and a shared FmcId in one write are problems", () => {
  const { problems } = planWrites([rec("1", "FMC-A-1"), rec("1", "FMC-A-1"), rec("2", "FMC-A-1")], []);
  assert.ok(problems.some((p) => /in the write 2 times/.test(p)));
  assert.ok(problems.some((p) => /given to elements 1 and 2/.test(p)));
});

test("extstore: audit finds duplicates, invalid values and owned elements", () => {
  const a = auditRows([
    { id: "1", fmc_id: "FMC-A-1", batch_id: "B1", recipe_hash: "", source: "recipe" },
    { id: "2", fmc_id: "FMC-A-1", batch_id: "B1", recipe_hash: "", source: "recipe", checkout: "owned_by_other" },
    { id: "3", fmc_id: "nope", batch_id: "B2", recipe_hash: "", source: "kit" },
  ]);
  assert.equal(a.stamped, 3);
  assert.deepEqual(a.duplicate_fmc_ids, [{ fmc_id: "FMC-A-1", ids: ["1", "2"] }]);
  assert.equal(a.invalid.length, 1);
  assert.deepEqual(a.batches, { B1: 2, B2: 1 });
  assert.deepEqual(a.owned_by_other, ["2"]);
});

const doc = { title: "P-F-V-00-M3-A-0001", path: "C:\\Jobs\\P\\01_WIP\\P-F-V-00-M3-A-0001.rvt" };

test("extstore tool: document is required, and read needs ids or all", async () => {
  assert.equal(out(await runFmcExtstore(args({ action: "read" }))).code, "FMC-DOC-REQUIRED");
  assert.equal(out(await runFmcExtstore(args({ action: "read", document: "A" }), { read: async () => ({}) })).code, "FMC-EXTSTORE-IDS");
});

test("extstore tool: a write is a dry run by default and never calls the apply", async () => {
  let applied = 0;
  const io = { read: async () => ({ ...doc, rows: [], missing: [] }), apply: async () => { applied++; return {}; }, guard: DEFAULT_CONFIG };
  const r = out(await runFmcExtstore(args({ action: "write", document: "A", records: [rec("1", "FMC-A-1")] }), io));
  assert.equal(r.dry_run, true);
  assert.deepEqual(r.counts, { create: 1 });
  assert.equal(applied, 0);
});

test("extstore tool: a real write needs a batch lease, then sends only create and update rows", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const io = {
    read: async () => ({ ...doc, rows: [{ id: "2", fmc_id: "FMC-A-2", batch_id: "B-20261128-01", recipe_hash: HASH, source: "recipe" }], missing: ["7"] }),
    apply: async (b: Record<string, unknown>) => { sent.push(b); return { written: (b.records as unknown[]).length }; },
    guard: DEFAULT_CONFIG,
  };
  const records = [rec("1", "FMC-A-1"), rec("2", "FMC-A-2"), rec("7", "FMC-A-7")];
  const locked = out(await runFmcExtstore(args({ action: "write", document: "A", records, dry_run: false }), io));
  assert.equal(locked.code, "FMC-BATCH-LOCKED");
  assert.equal(sent.length, 0);
  const done = out(await runFmcExtstore(args({ action: "write", document: "A", records, dry_run: false, batch_lease: "lease-1" }), io));
  assert.equal(done.dry_run, false);
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0].records as Array<{ id: string }>).map((r) => r.id), ["1"]);
  assert.equal(sent[0].schema_guid, EXTSTORE_SCHEMA_GUID);
  assert.equal(done.plan.find((r: { id: string }) => r.id === "7").reason, "no such element in the document");
});

test("extstore tool: invalid records are refused before any write", async () => {
  let applied = 0;
  const io = { read: async () => ({ ...doc, rows: [] }), apply: async () => { applied++; return {}; }, guard: DEFAULT_CONFIG };
  const r = out(await runFmcExtstore(args({ action: "write", document: "A", records: [rec("1", "bad id")], dry_run: false, batch_lease: "l" }), io));
  assert.equal(r.code, "FMC-EXTSTORE-INVALID");
  assert.equal(applied, 0);
});

test("extstore tool: audit reports clean or not", async () => {
  const r = out(await runFmcExtstore(args({ action: "audit", document: "A" }), {
    read: async (b) => { assert.equal(b.all, true); return { ...doc, schema_present: true, rows: [{ id: "1", fmc_id: "FMC-A-1", batch_id: "B", source: "kit" }] }; },
  }));
  assert.equal(r.clean, true);
  assert.equal(r.stamped, 1);
  assert.equal(r.read_only, true);
});
