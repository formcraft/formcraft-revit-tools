import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { counterpart, exchangeRoot, findFmc, identityStats, link, listPackages, loadIdentity, saveIdentity, verifyPackage, writePackage } from "./exchange.js";
import { BUILTIN_FLOWS, FLOW, fill, runFlow } from "./flows.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fmc-exchange-"));

test("X0: the exchange lives in the project's 01_WIP\\_Exchange, or the reports folder without a project", () => {
  assert.equal(exchangeRoot("D:\\Projects\\F26001", "C:\\R"), "D:\\Projects\\F26001\\01_WIP\\_Exchange");
  assert.equal(exchangeRoot("", "C:\\R"), "C:\\R\\Exchange");
});

test("X0: one Formcraft id per element, found from any app; linking twice adds nothing", () => {
  const root = tmp();
  const map = loadIdentity(root);
  const fmc = link(map, "revit", "a1b2-uid", { kind: "column", name: "C1" });
  assert.equal(link(map, "robot", "FEA-20261018-0930#17", { fmc }), fmc);
  assert.equal(link(map, "revit", "a1b2-uid"), fmc, "the same element again: the same id");
  assert.equal(findFmc(map, "robot", "FEA-20261018-0930#17"), fmc);
  assert.deepEqual(counterpart(map, "robot", "FEA-20261018-0930#17", "revit")?.id, "a1b2-uid");
  assert.equal(counterpart(map, "revit", "a1b2-uid", "navisworks"), null);
  saveIdentity(root, map);
  const back = loadIdentity(root);
  assert.deepEqual(identityStats(back), { elements: 1, in_two_or_more_apps: 1, by_app: { revit: 1, robot: 1 } });
  // an app's element that turns out to be another Formcraft element moves to it
  const other = link(back, "revit", "zz-uid");
  link(back, "robot", "FEA-20261018-0930#17", { fmc: other });
  assert.equal(findFmc(back, "robot", "FEA-20261018-0930#17"), other);
  assert.equal(back.entries[fmc].apps.robot, undefined);
});

test("X0: an exchange package is a new folder with checksums; nothing is overwritten; a changed file is found", () => {
  const root = tmp();
  const now = new Date(2026, 9, 18, 9, 30, 0);
  const a = writePackage(root, { from: "revit", to: "robot", what: "analytical model FEA-1", files: [{ name: "FEA-1.json", text: "{\"bars\":3}" }], now });
  const b = writePackage(root, { from: "revit", to: "robot", what: "analytical model FEA-1", files: [{ name: "FEA-1.json", text: "{\"bars\":4}" }], now });
  assert.notEqual(a.dir, b.dir, "the same second: a second folder, never the first one again");
  assert.match(a.manifest.id, /^20261018-093000_revit-robot_analytical_model_FEA_1$/);
  assert.match(b.manifest.id, /_2$/);
  assert.equal(a.manifest.files[0].sha256.length, 64);
  assert.deepEqual(listPackages(root).map((m) => m.id), [b.manifest.id, a.manifest.id]);
  assert.deepEqual(listPackages(root, { app: "navisworks" }), []);
  assert.deepEqual(verifyPackage(root, a.manifest.id), { ok: true, changed: [] });
  fs.writeFileSync(path.join(a.dir, "FEA-1.json"), "edited");
  assert.deepEqual(verifyPackage(root, a.manifest.id), { ok: false, changed: ["FEA-1.json"] });
});

test("X0: a flow fills ${var.…} and ${step.…}, keeps a lone reference's type, and refuses a missing value", () => {
  const steps = { build: { batch: "B-20261018-0930", count: 3 } };
  assert.equal(fill("${step.build.batch}", {}, steps), "B-20261018-0930");
  assert.equal(fill("${step.build.count}", {}, steps), 3);
  assert.deepEqual(fill({ cases: "${var.cases}" }, { cases: [{ name: "G" }] }, {}), { cases: [{ name: "G" }] });
  assert.equal(fill("role ${var.role}, batch ${step.build.batch}", { role: "A" }, steps), "role A, batch B-20261018-0930");
  assert.throws(() => fill("${var.nope}", {}, {}), /\$\{var.nope\} has no value/);
});

test("X0: a dry-run flow passes dry_run to every step that has one, skips real-only steps, and a failure stops it", async () => {
  const calls: Array<[string, any]> = [];
  const call = async (tool: string, args: any) => {
    calls.push([tool, args]);
    return args.action === "batch_gate" ? { ok: false, body: { error: "no results" } } : { ok: true, body: { batch: "B-1" } };
  };
  const flow = BUILTIN_FLOWS.find((f) => f.name === "pack_rebuild")!;
  const dry = await runFlow(flow, { dryRun: true, vars: { batch_file: "D:\\K\\batch_A.json" }, call, acceptsDryRun: () => true });
  assert.equal(dry.ok, true);
  assert.deepEqual(calls[0], ["fmc_recipe", { action: "batch", recipe_files: ["D:\\K\\batch_A.json"], dry_run: true }]);
  assert.equal(dry.steps[1].skipped, "real run only");
  calls.length = 0;
  const real = await runFlow(flow, { dryRun: false, vars: { batch_file: "x.json" }, call, acceptsDryRun: () => true });
  assert.equal(real.ok, false);
  assert.equal(real.stopped_at, "gate");
  assert.deepEqual(calls[1], ["fmc_recipe", { action: "batch_gate", batch: "B-1", dry_run: false }], "the gate gets the build's batch");
  const missing = await runFlow(flow, { dryRun: true, vars: {}, call, acceptsDryRun: () => true });
  assert.match(missing.steps[0].error!, /the run needs batch_file/);
});

test("X0: a flow may only run Formcraft tools, never fmc_flow itself", async () => {
  assert.throws(() => FLOW.parse({ name: "bad", steps: [{ name: "x", tool: "rm_rf", args: {} }] }));
  const loop = FLOW.parse({ name: "loop", steps: [{ name: "again", tool: "fmc_flow", args: {} }] });
  const r = await runFlow(loop, { dryRun: true, call: async () => ({ ok: true, body: {} }), acceptsDryRun: () => false });
  assert.match(r.steps[0].error!, /can't run inside a flow/);
  for (const f of BUILTIN_FLOWS) assert.ok(f.steps.every((s) => s.tool.startsWith("fmc_")), f.name);
});
