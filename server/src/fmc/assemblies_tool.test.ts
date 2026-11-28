import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { FMC_ASSEMBLIES_SHAPE, runFmcAssemblies } from "../tools/fmc_assemblies.js";
import { EMPTY_MODEL, SAMPLE } from "./assemblies_testkit.js";

/** The fmc_assemblies tool: kit or call designs, run ids, dry runs by default, confirm before any write. */

interface Kit { root: string; project: string; log: string; config: { config: GuardConfig; problem: string } }
function kit(designs: unknown = SAMPLE): Kit {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-askit-"));
  fs.mkdirSync(path.join(root, "03_Master_Data"), { recursive: true });
  fs.mkdirSync(path.join(root, "07_Materials"), { recursive: true });
  fs.writeFileSync(path.join(root, "07_Materials", "FMC_Materials.json"), "{}");
  if (designs) fs.writeFileSync(path.join(root, "03_Master_Data", "FMC_Assemblies.json"), JSON.stringify(designs));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const config: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [project], reports_dir: path.join(root, "reports"), materials_file: path.join(root, "07_Materials", "FMC_Materials.json") };
  return { root, project, log: path.join(root, "reports", "FMC_MCP_FileLog.csv"), config: { config, problem: "" } };
}
const done = (k: Kit) => fs.rmSync(k.root, { recursive: true, force: true });
function fakeRevit(model = EMPTY_MODEL) {
  const calls: Array<{ command: string; payload: any; dry: boolean }> = [];
  return { calls, send: async (command: string, payload: any, dry: boolean) => {
    calls.push({ command, payload, dry });
    if (command === "fmc_assemblies_read") return model;
    if (command === "fmc_assemblies_apply") return { dry_run: payload.dry_run, rolled_back: payload.dry_run, results: [] };
    throw new Error(`no answer for ${command}`);
  } };
}
async function call(k: Kit, args: Record<string, unknown>, revit = fakeRevit().send) {
  const r = await runFmcAssemblies(z.object(FMC_ASSEMBLIES_SHAPE).parse(args), { config: k.config, revit });
  return { body: JSON.parse(r.content[0].text), isError: r.isError };
}

test("no designs in the kit and none in the call: refused with a kit request, nothing defaulted", async () => {
  const k = kit(null);
  try {
    const r = await call(k, { action: "check" });
    assert.equal(r.isError, true);
    assert.match(r.body.reasons[0], /nothing is defaulted/);
    assert.match(r.body.kit_requests[0].request, /FMC_Assemblies\.json/);
    assert.match(r.body.run_id, /^AS-\d{8}T\d{6}-[0-9a-f]{6}$/);
    const withSpec = await call(k, { action: "check", spec: SAMPLE });
    assert.equal(withSpec.isError, false);
    assert.equal(withSpec.body.designs_from, "the call");
    assert.deepEqual([withSpec.body.patterns, withSpec.body.curtain_walls, withSpec.body.railings], [3, 1, 1]);
  } finally { done(k); }
});

test("check: the kit's designs, their hash, and no Revit call", async () => {
  const k = kit();
  try {
    const rv = fakeRevit();
    const r = await call(k, { action: "check" }, rv.send);
    assert.equal(r.isError, false);
    assert.match(r.body.designs_hash, /^[0-9a-f]{12}$/);
    assert.match(r.body.designs_from, /FMC_Assemblies\.json$/);
    assert.equal(rv.calls.length, 0);
  } finally { done(k); }
});

test("pat: the dry run writes nothing; dry_run=false needs confirm; then the files land in 01_WIP\\_Assemblies; a re-run is unchanged", async () => {
  const k = kit();
  try {
    const folder = path.join(k.project, "01_WIP", "_Assemblies");
    const dry = await call(k, { action: "pat", project_folder: k.project });
    assert.equal(dry.isError, false);
    assert.deepEqual(dry.body.files.map((f: { file: string; action: string }) => [f.file, f.action]), [["FMC_Patterns_Drafting.pat", "new"], ["FMC_Patterns_Model.pat", "new"]]);
    assert.equal(fs.existsSync(folder), false);
    const noConfirm = await call(k, { action: "pat", project_folder: k.project, dry_run: false });
    assert.equal(noConfirm.isError, true);
    assert.match(noConfirm.body.reasons.join(" "), /confirm=true/);
    assert.equal(fs.existsSync(folder), false);
    const real = await call(k, { action: "pat", project_folder: k.project, dry_run: false, confirm: true });
    assert.equal(real.isError, false);
    assert.match(fs.readFileSync(path.join(folder, "FMC_Patterns_Drafting.pat"), "utf8"), /\*FMC_FP_Hatch45_3/);
    const again = await call(k, { action: "pat", project_folder: k.project });
    assert.deepEqual(again.body.files.map((f: { action: string }) => f.action), ["unchanged", "unchanged"]);
    const changed = { ...SAMPLE, patterns: SAMPLE.patterns.map((p: { name: string }) => p.name === "FMC_FP_Hatch45_3" ? { ...p, grids: [{ angle: 45, spacing: 4 }] } : p) };
    const repl = await call(k, { action: "pat", project_folder: k.project, spec: changed, dry_run: false, confirm: true });
    assert.equal(repl.body.files[0].action, "replace (the old one moves to _Archive)");
    assert.equal(fs.readdirSync(path.join(folder, "_Archive")).length, 1);
    const rows = fs.readFileSync(k.log, "utf8");
    assert.ok(rows.includes(`run ${real.body.run_id}:`));
  } finally { done(k); }
});

test("pat outside the write roots is refused", async () => {
  const k = kit();
  try {
    const r = await call(k, { action: "pat", project_folder: path.join(k.root, "elsewhere") });
    assert.equal(r.isError, true);
    assert.match(r.body.reasons[0], /Not inside an allowed write folder/);
  } finally { done(k); }
});

test("read and plan go through the read path only", async () => {
  const k = kit();
  try {
    const rv = fakeRevit();
    const plan = await call(k, { action: "plan" }, rv.send);
    assert.equal(plan.isError, false);
    assert.deepEqual(plan.body.counts, { create: 5, update: 0, unchanged: 0, blocked: 0 });
    const read = await call(k, { action: "read" }, rv.send);
    assert.deepEqual(read.body.model.legend_views, []);
    assert.ok(rv.calls.every((c) => c.command === "fmc_assemblies_read" && c.dry === true));
  } finally { done(k); }
});

test("apply: the dry run is sent through the read path as a dry run (the add-in rolls it back)", async () => {
  const k = kit();
  try {
    const rv = fakeRevit();
    const r = await call(k, { action: "apply" }, rv.send);
    assert.equal(r.isError, false);
    const sent = rv.calls.find((c) => c.command === "fmc_assemblies_apply")!;
    assert.equal(sent.dry, true);
    assert.equal(sent.payload.dry_run, true);
    assert.deepEqual([sent.payload.patterns.length, sent.payload.curtain_walls.length, sent.payload.railings.length], [3, 1, 1]);
    assert.match(fs.readFileSync(k.log, "utf8"), /assemblies_apply,true,model,dry run/);
  } finally { done(k); }
});

test("apply: dry_run=false without confirm, or with a guard problem, is refused before the add-in is called", async () => {
  const k = kit();
  try {
    const rv = fakeRevit();
    const r = await call(k, { action: "apply", dry_run: false }, rv.send);
    assert.equal(r.isError, true);
    assert.match(r.body.reasons[0], /confirm=true/);
    k.config.problem = "The guard config isn't readable";
    const g = await call(k, { action: "apply", dry_run: false, confirm: true }, rv.send);
    assert.ok(g.body.reasons.includes("The guard config isn't readable"));
    assert.equal(rv.calls.filter((c) => c.command === "fmc_assemblies_apply").length, 0);
  } finally { done(k); }
});

test("apply with confirm goes through the write path; only, and nothing to do, are honoured", async () => {
  const k = kit();
  try {
    const rv = fakeRevit();
    const r = await call(k, { action: "apply", dry_run: false, confirm: true, only: ["FMC_RL_Steel_1100"] }, rv.send);
    assert.equal(r.isError, false);
    const sent = rv.calls.find((c) => c.command === "fmc_assemblies_apply")!;
    assert.equal(sent.dry, false);
    assert.deepEqual([sent.payload.patterns.length, sent.payload.curtain_walls.length, sent.payload.railings.length], [0, 0, 1]);
    const none = await call(k, { action: "apply", only: ["FMC_NOT_THERE"] }, rv.send);
    assert.equal(none.body.nothing_to_do, true);
  } finally { done(k); }
});

test("legend gives the fmc_legend calls; the apply command is a write command and both commands are in the manifest", async () => {
  const k = kit();
  try {
    const r = await call(k, { action: "legend" });
    assert.equal(r.body.legend.place.tool, "fmc_legend");
  } finally { done(k); }
  assert.ok(WRITE_COMMANDS.has("fmc_assemblies_apply"));
  assert.ok(!WRITE_COMMANDS.has("fmc_assemblies_read"));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const names = (JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> }).commands.map((c) => c.commandName);
  assert.ok(names.includes("fmc_assemblies_read") && names.includes("fmc_assemblies_apply"));
  const svc = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcAssemblies.cs"), "utf8");
  assert.match(svc, /if \(dry \|\| anyError\) t\.RollBack\(\); else t\.Commit\(\);/, "the dry run (and a failed step) rolls back");
});
