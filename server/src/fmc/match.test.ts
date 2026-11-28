import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { matchHash, planMatch, sameValue, type ElemSnap } from "./match.js";
import { FMC_MATCH_SHAPE, runFmcMatch, type FmcMatchArgs } from "../tools/fmc_match.js";

const source: ElemSnap = {
  id: "100", category: "OST_Walls", type_id: "7", type_name: "Generic 200", editable: true,
  params: [
    { key: "guid:aaa", name: "Status", storage: "String", value: "Issued" },
    { key: "bip:-1001", name: "Base Offset", storage: "Double", value: 1.5, display: "457 mm" },
  ],
  override: { transparency: 50, projection_line_weight: 4 },
};
const t1: ElemSnap = { id: "101", category: "OST_Walls", type_id: "8", type_name: "Generic 300", editable: true, accepts_source_type: true,
  params: [{ key: "guid:aaa", name: "Status", storage: "String", value: "WIP" }, { key: "bip:-1001", name: "Base Offset", storage: "Double", value: 1.5 }], override: {} };
const t2: ElemSnap = { id: "102", category: "OST_Walls", type_id: "7", type_name: "Generic 200", editable: true,
  params: [{ key: "guid:aaa", name: "Status", storage: "String", value: "Issued" }], override: { projection_line_weight: 4, transparency: 50 } };
const doorT: ElemSnap = { id: "103", category: "OST_Doors", type_id: "9", params: [] };
const owned: ElemSnap = { id: "104", category: "OST_Walls", type_id: "8", editable: false, owner: "Ann", params: [] };

function args(partial: Record<string, unknown>): FmcMatchArgs {
  return z.object(FMC_MATCH_SHAPE).parse(partial);
}
function body(r: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...JSON.parse(r.content?.[0]?.text ?? "{}"), isError: r.isError === true };
}
function io(snapshot: unknown, applied: unknown[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-match-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG, protected_paths: ["D:\\Live"], save_exclude: ["HEBERT HOSTELS"], sync_exclude: [] };
  return {
    reportDir: dir, guard, env: { ...process.env, APPDATA: dir, LOCALAPPDATA: dir } as NodeJS.ProcessEnv,
    read: async () => snapshot, apply: async (b: Record<string, unknown>) => { applied.push(b); return { ok: true, changed: (b.steps as unknown[]).length - 1 }; },
  };
}
const snapshot = { resolved_document: { title: "P1", path: "D:\\Jobs\\_Staging\\P1.rvt" }, is_central: false, source, targets: [t1, t2, doorT, owned] };

test("planMatch diffs type and parameters per target, refuses other categories and owned elements", () => {
  const plan = planMatch({ source, targets: [t1, t2, doorT, owned], what: ["type", "parameters"] });
  assert.equal(plan.ok, true);
  const byId = Object.fromEntries(plan.targets.map((t) => [t.target, t]));
  assert.equal(byId["101"].status, "will_change");
  assert.deepEqual(byId["101"].changes.map((c) => c.kind), ["type", "parameter"]);
  assert.equal(byId["102"].status, "no_change");
  assert.equal(byId["103"].status, "refused");
  assert.match(byId["103"].reasons[0], /Same category only/);
  assert.match(byId["104"].reasons[0], /Ann/);
  assert.equal(plan.totals.steps, 2);
});

test("overrides need a view, and compare regardless of key order", () => {
  assert.equal(planMatch({ source, targets: [t1], what: ["overrides"] }).code, "FMC-MATCH-VIEW");
  const plan = planMatch({ source, targets: [t1, t2], what: ["overrides"], view: "55" });
  assert.equal(plan.targets.find((t) => t.target === "101")!.status, "will_change");
  assert.equal(plan.targets.find((t) => t.target === "102")!.status, "no_change");
});

test("parameter filters, the source as target, duplicates and the 200 cap", () => {
  const only = planMatch({ source, targets: [t1], what: ["parameters"], parameters: ["status"] });
  assert.equal(only.totals.steps, 1);
  const excl = planMatch({ source, targets: [t1], what: ["parameters"], exclude_parameters: ["Status", "Base Offset"] });
  assert.equal(excl.totals.steps, 0);
  const dup = planMatch({ source, targets: [t1, t1, { ...t1, id: "100" }], what: ["type"] });
  assert.deepEqual(dup.targets.map((t) => t.status), ["will_change", "refused", "refused"]);
  const many = Array.from({ length: 201 }, (_, i) => ({ ...t1, id: String(1000 + i) }));
  assert.equal(planMatch({ source, targets: many, what: ["type"] }).code, "FMC-MATCH-CAP");
  assert.equal(planMatch({ source: null, targets: [t1], what: ["type"] }).code, "FMC-MATCH-SOURCE");
});

test("the plan hash ignores wording and changes with the steps", () => {
  const a = planMatch({ source, targets: [t1], what: ["type", "parameters"] });
  const b = planMatch({ source, targets: [t1], what: ["type", "parameters"] });
  assert.equal(a.plan_hash, b.plan_hash);
  assert.equal(matchHash(a.steps.map((s) => ({ ...s, sentence: "x", was: "y" }) as never)), a.plan_hash);
  const c = planMatch({ source: { ...source, type_id: "6" }, targets: [t1], what: ["type"] });
  assert.notEqual(c.plan_hash, a.plan_hash);
  assert.ok(sameValue(0.1 + 0.2, 0.3));
});

test("dry run is the default, writes a report and sends nothing", async () => {
  const applied: unknown[] = [];
  const i = io(snapshot, applied);
  const out = body(await runFmcMatch(args({ document: "P1", source: 100, targets: [101, 102] }), i));
  assert.equal(out.isError, false);
  assert.equal(out.dry_run, true);
  assert.equal(out.read_only, true);
  assert.match(out.plan_hash, /^[0-9a-f]{12}$/);
  assert.ok(fs.existsSync(out.report));
  assert.equal(applied.length, 0);
});

test("apply needs a lease and the dry run's hash, and refuses a changed plan", async () => {
  const applied: unknown[] = [];
  const i = io(snapshot, applied);
  const dry = body(await runFmcMatch(args({ document: "P1", source: "100", targets: ["101"] }), i));
  const noLease = body(await runFmcMatch(args({ document: "P1", source: "100", targets: ["101"], dry_run: false, plan_hash: dry.plan_hash }), i));
  assert.equal(noLease.code, "FMC-BATCH-LOCKED");
  const noHash = body(await runFmcMatch(args({ document: "P1", source: "100", targets: ["101"], dry_run: false, batch_lease: "L1" }), i));
  assert.equal(noHash.code, "FMC-MATCH-HASH");
  const wrong = body(await runFmcMatch(args({ document: "P1", source: "100", targets: ["101"], dry_run: false, batch_lease: "L1", plan_hash: "000000000000" }), i));
  assert.equal(wrong.code, "FMC-MATCH-PLAN-CHANGED");
  assert.equal(applied.length, 0);
  const ok = body(await runFmcMatch(args({ document: "P1", source: "100", targets: ["101"], dry_run: false, batch_lease: "L1", plan_hash: dry.plan_hash }), i));
  assert.equal(ok.isError, false);
  assert.equal(ok.read_only, false);
  assert.equal(applied.length, 1);
  assert.equal((applied[0] as { steps: unknown[] }).steps.length, 3);
  assert.equal(ok.saved, false);
  assert.equal(ok.synced, false);
});

test("guards: no document, bad ids, HEBERT HOSTELS, a central model, a protected path", async () => {
  assert.equal(body(await runFmcMatch(args({ source: 1, targets: [2] }), io(snapshot))).code, "FMC-DOC-REQUIRED");
  assert.equal(body(await runFmcMatch(args({ document: "P1", source: "x", targets: [2] }), io(snapshot))).code, "FMC-MATCH-SOURCE");
  assert.equal(body(await runFmcMatch(args({ document: "P1", source: 1, targets: ["2a"] }), io(snapshot))).code, "FMC-MATCH-TARGETS");
  const hebert = body(await runFmcMatch(args({ document: "P1", source: 100, targets: [101] }), io({ ...snapshot, resolved_document: { title: "HEBERT HOSTELS A", path: "D:\\x.rvt" } })));
  assert.equal(hebert.code, "FMC-MATCH-GUARD");
  const central = body(await runFmcMatch(args({ document: "P1", source: 100, targets: [101] }), io({ ...snapshot, is_central: true })));
  assert.equal(central.code, "FMC-MATCH-GUARD");
  const prot = body(await runFmcMatch(args({ document: "P1", source: 100, targets: [101] }), io({ ...snapshot, resolved_document: { title: "P", path: "D:\\Live\\P.rvt" } })));
  assert.equal(prot.code, "FMC-MATCH-GUARD");
});

test("fmc_match is a read through sendCommand and fmc_match_apply is a write", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_match"));
  assert.ok(WRITE_COMMANDS.has("fmc_match_apply"));
  assert.ok(!WRITE_COMMANDS.has("fmc_match"));
});
