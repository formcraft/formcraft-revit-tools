import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { FMC_FABRICATION_SHAPE, runFmcFabrication } from "../tools/fmc_fabrication.js";
import { ancillarySummary, auditParts, cleanPart, countBy, filterByLevel } from "./fabrication.js";
import { LOADED, NONE, NONE_WITH_PARTS } from "./fabrication_testkit.js";
import type { FabRead } from "./fabrication.js";

/** fmc_fabrication: the stand-in add-in answers; the config check, audit, ancillaries and export are the server's. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface Kit { root: string; project: string; own: string; log: string; config: { config: GuardConfig; problem: string } }
function kit(): Kit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-fabkit-"));
  const project = path.join(dir, "Projects", "F26901", "01_WIP");
  fs.mkdirSync(project, { recursive: true });
  const config: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [path.join(dir, "Projects", "*", "01_WIP")], reports_dir: path.join(dir, "reports") };
  return { root: dir, project, own: path.join(dir, "own"), log: path.join(dir, "reports", "FMC_MCP_FileLog.csv"), config: { config, problem: "" } };
}
const done = (k: Kit) => fs.rmSync(k.root, { recursive: true, force: true });

function standIn(answer: FabRead) {
  const calls: Array<Record<string, unknown>> = [];
  return { calls, read: async (body: Record<string, unknown>) => { calls.push(body); return answer; } };
}
async function call(k: Kit, args: Record<string, unknown>, answer: FabRead = LOADED) {
  const rv = standIn(answer);
  const r = await runFmcFabrication(z.object(FMC_FABRICATION_SHAPE).parse(args), { read: rv.read, config: k.config, dir: k.own, env: {} });
  return { body: JSON.parse(r.content[0].text), isError: r.isError, calls: rv.calls };
}
const RUN_ID = /^FB-\d{8}T\d{6}-[0-9a-f]{6}$/;

test("no fabrication configuration: ok, configured:false and a message, for every action, and nothing is written", async () => {
  const k = kit();
  try {
    for (const action of ["config", "audit", "ancillaries", "export"]) {
      const r = await call(k, { action, document: "M.rvt" }, NONE_WITH_PARTS);
      assert.equal(r.isError, false, action);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.configured, false);
      assert.match(r.body.message, /No fabrication configuration is loaded/);
      assert.equal(r.body.fabrication_parts_in_model, 12);
      assert.match(r.body.run_id, RUN_ID);
      assert.equal(r.body.read_only, true);
      assert.equal(r.body.exported, false);
    }
    assert.equal(fs.existsSync(k.own), false, "no report for a model with no configuration");
    const withPath = await call(k, { action: "export", output_path: k.project, dry_run: false, confirm: true }, NONE);
    assert.equal(withPath.isError, false);
    assert.equal(withPath.body.configured, false);
    assert.deepEqual(fs.readdirSync(k.project), []);
  } finally { done(k); }
});

test("config: the name and version, the services loaded and not loaded; the read asks for no parts", async () => {
  const k = kit();
  try {
    const r = await call(k, { action: "config", document: "M.rvt" });
    assert.equal(r.isError, false);
    assert.equal(r.body.configured, true);
    assert.equal(r.body.config.name, "FMC MEP Metric");
    assert.equal(r.body.config.version, "7");
    assert.equal(r.body.services.total, 4);
    assert.deepEqual(r.body.services.loaded.map((s: { name: string }) => s.name), ["Supply Air", "Extract Air"]);
    assert.deepEqual(r.body.services.unloaded.map((s: { name: string }) => s.name), ["Chilled Water", "Heating Water"]);
    assert.equal(r.body.fabrication_parts_in_model, 7);
    assert.equal(r.calls[0].parts, false);
    assert.equal(r.calls[0].document, "M.rvt");
  } finally { done(k); }
});

test("audit: counts by service, category and level; each problem is found with its sample ids", async () => {
  const k = kit();
  try {
    const r = await call(k, { action: "audit" });
    const a = r.body.audit;
    assert.equal(a.parts, 7);
    assert.deepEqual(a.by_service, { "Supply Air": 3, "(none)": 1, "Chilled Water": 1, "Extract Air": 1, "Old Service": 1 });
    assert.deepEqual(a.by_level, { "Level 1": 5, "Level 2": 2 });
    assert.deepEqual(a.by_category, { "MEP Fabrication Ductwork": 6, "MEP Fabrication Pipework": 1 });
    const ids = (k2: string) => a.issues[k2].sample_ids;
    assert.deepEqual(ids("missing_service"), [105]);
    assert.deepEqual(ids("service_not_in_config"), [104]);
    assert.deepEqual(ids("service_not_loaded"), [103]);
    assert.deepEqual(ids("missing_specification"), [103]);
    assert.deepEqual(ids("missing_material"), [104]);
    assert.deepEqual(ids("disconnected_ends"), [105, 107], "a hanger's open ends don't count");
    assert.deepEqual(ids("invalid"), [104, 107]);
    assert.deepEqual(ids("iso_drawing_out_of_date"), [107]);
    assert.equal(a.issues.missing_insulation.count, 0, "off unless require_insulation");
    assert.equal(a.parts_with_issues, 4);
    assert.equal(a.hangers, 1);
    assert.match(a.not_exposed, /NeedToUpdateIsoDrawing/);
    assert.equal(r.calls[0].parts, true);
    assert.equal(r.calls[0].ancillaries, false);
    const strict = await call(k, { action: "audit", require_insulation: true, sample_limit: 2 });
    assert.equal(strict.body.audit.issues.missing_insulation.count, 4, "hangers are never asked for insulation");
    assert.deepEqual(strict.body.audit.issues.missing_insulation.sample_ids, [101, 104], "sample_limit");
    assert.equal(strict.body.audit.parts_with_issues, 5);
  } finally { done(k); }
});

test("levels limits the audit and the ancillaries", async () => {
  const k = kit();
  try {
    const r = await call(k, { action: "audit", levels: ["level 2"] });
    assert.equal(r.body.audit.parts, 2);
    assert.deepEqual(r.body.audit.by_level, { "Level 2": 2 });
    const a = await call(k, { action: "ancillaries", levels: ["Level 2"] });
    assert.equal(a.body.ancillaries.ancillary_quantity, 6);
    assert.deepEqual(filterByLevel(LOADED.parts!.map(cleanPart), []).length, 7);
  } finally { done(k); }
});

test("ancillaries: per part, and the totals by usage, type and name", async () => {
  const k = kit();
  try {
    const r = await call(k, { action: "ancillaries" });
    const s = r.body.ancillaries;
    assert.equal(r.calls[0].ancillaries, true);
    assert.equal(s.parts, 7);
    assert.equal(s.parts_with_ancillaries, 4);
    assert.equal(s.parts_without_ancillaries, 3);
    assert.equal(s.ancillary_rows, 5);
    assert.equal(s.ancillary_quantity, 10);
    assert.equal(s.hanger_parts, 1);
    assert.deepEqual(s.hanger_usage, { rows: 4, qty: 9 });
    assert.deepEqual(s.by_usage.Stiffener, { rows: 1, qty: 1 });
    assert.deepEqual(s.by_name["Rod M10"], { rows: 3, qty: 8 });
    assert.deepEqual(s.per_part[0], { id: 107, product: "Straight", service: "Supply Air", level: "Level 2", ancillaries: 1, quantity: 4, usages: ["Hanger"] });
    assert.deepEqual(s.per_part.map((p: { id: number }) => p.id), [107, 101, 102, 106]);
    const small = await call(k, { action: "ancillaries", sample_limit: 1 });
    assert.equal(small.body.ancillaries.per_part.length, 1);
    assert.equal(small.body.ancillaries.per_part_truncated, true);
  } finally { done(k); }
});

test("export with no output_path writes the CSV and JSON to the tool's own folder, and logs it", async () => {
  const k = kit();
  try {
    const r = await call(k, { action: "export", document: "M.rvt" });
    assert.equal(r.isError, false);
    assert.equal(r.body.exported, true);
    assert.equal(r.body.destination, "tool folder");
    assert.equal(r.body.parts_exported, 7);
    const names = fs.readdirSync(k.own).sort();
    assert.deepEqual(names, [`FMC_Fabrication_${r.body.run_id}.csv`, `FMC_Fabrication_${r.body.run_id}.json`]);
    const csv = fs.readFileSync(path.join(k.own, names[0]), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    assert.equal(csv.length, 8);
    assert.match(csv[0], /^id,category,level,service,specification,material,insulation,/);
    assert.match(csv.find((l) => l.startsWith("107,"))!, /iso_drawing_out_of_date/);
    assert.match(csv.find((l) => l.startsWith("101,"))!, /,2,0,2,3,$/, "two ancillaries, three of them in all");
    const json = JSON.parse(fs.readFileSync(path.join(k.own, names[1]), "utf8"));
    assert.equal(json.run_id, r.body.run_id);
    assert.equal(json.parts.length, 7);
    assert.equal(json.config.config.name, "FMC MEP Metric");
    assert.equal(json.ancillaries.ancillary_rows, 5);
    assert.match(fs.readFileSync(k.log, "utf8"), new RegExp(`fabrication_export,false,.*done,.*run ${r.body.run_id}:`));
    const csvOnly = await call(k, { action: "export", format: "csv" });
    assert.equal(csvOnly.body.files.length, 1);
    assert.match(csvOnly.body.files[0], /\.csv$/);
  } finally { done(k); }
});

test("export to a project folder: a dry run by default, confirm needed, then the two files; every step logged with the run id", async () => {
  const k = kit();
  try {
    const folder = path.join(k.project, "Mechanical", "_Fabrication");
    const dry = await call(k, { action: "export", output_path: folder });
    assert.equal(dry.isError, false);
    assert.equal(dry.body.dry_run, true);
    assert.equal(dry.body.exported, false);
    assert.equal(dry.body.would_write.length, 2);
    assert.equal(fs.existsSync(folder), false);
    const noConfirm = await call(k, { action: "export", output_path: folder, dry_run: false });
    assert.equal(noConfirm.isError, true);
    assert.match(noConfirm.body.reasons.join(" "), /confirm=true/);
    assert.equal(fs.existsSync(folder), false);
    k.config.problem = "The guard config isn't readable";
    const bad = await call(k, { action: "export", output_path: folder, dry_run: false, confirm: true });
    assert.equal(bad.isError, true);
    assert.ok(bad.body.reasons.includes("The guard config isn't readable"));
    k.config.problem = "";
    const real = await call(k, { action: "export", output_path: folder, dry_run: false, confirm: true });
    assert.equal(real.isError, false);
    assert.equal(real.body.exported, true);
    assert.equal(real.body.destination, "project folder");
    assert.deepEqual(fs.readdirSync(folder).sort(), [`FMC_Fabrication_${real.body.run_id}.csv`, `FMC_Fabrication_${real.body.run_id}.json`]);
    assert.equal(fs.existsSync(k.own), false, "a project export doesn't also write the tool folder");
    const rows = fs.readFileSync(k.log, "utf8");
    assert.match(rows, new RegExp(`fabrication_export,true,.*dry run,"?run ${dry.body.run_id}:`));
    assert.match(rows, new RegExp(`fabrication_export,false,.*refused,"?run ${noConfirm.body.run_id}:`));
    assert.match(rows, new RegExp(`fabrication_export,false,.*done,"?run ${real.body.run_id}:`));
  } finally { done(k); }
});

test("export path guard: outside the write roots, a blocked folder, a file path and a Revit file are all refused", async () => {
  const k = kit();
  try {
    const outside = await call(k, { action: "export", output_path: path.join(k.root, "elsewhere") });
    assert.equal(outside.isError, true);
    assert.match(outside.body.reasons[0], /Not inside an allowed write folder/);
    const blocked = await call(k, { action: "export", output_path: path.join(k.project, "02_Shared", "x") });
    assert.equal(blocked.isError, true);
    assert.match(blocked.body.reasons.join(" "), /CDE gate/);
    const rvt = await call(k, { action: "export", output_path: path.join(k.project, "Model_A-0001.rvt"), dry_run: false, confirm: true });
    assert.equal(rvt.isError, true);
    assert.match(rvt.body.reasons[0], /never writes one/);
    const file = await call(k, { action: "export", output_path: path.join(k.project, "report.csv") });
    assert.match(file.body.reasons[0], /must be a folder/);
    const relative = await call(k, { action: "export", output_path: "Projects\\F26901\\01_WIP" });
    assert.equal(relative.isError, true);
    assert.deepEqual(fs.readdirSync(k.project), []);
    assert.match(fs.readFileSync(k.log, "utf8"), /fabrication_export,true,.*refused/);
  } finally { done(k); }
});

test("a refusal or a failure from the add-in comes back as an error that carries the run id", async () => {
  const k = kit();
  try {
    const refused = await runFmcFabrication(z.object(FMC_FABRICATION_SHAPE).parse({ action: "audit" }), {
      read: async () => ({ refused: true, code: "FMC-DOC-AMBIGUOUS", message: "[FMC-DOC-AMBIGUOUS] two open" }), config: k.config, dir: k.own, env: {},
    });
    const body = JSON.parse(refused.content[0].text);
    assert.equal(refused.isError, true);
    assert.equal(body.code, "FMC-DOC-AMBIGUOUS");
    assert.match(body.run_id, RUN_ID);
    const thrown = await runFmcFabrication(z.object(FMC_FABRICATION_SHAPE).parse({ action: "config" }), {
      read: async () => { throw new Error("[FMC-DOC-NOT-FOUND] No open document"); }, config: k.config, dir: k.own, env: {},
    });
    assert.equal(JSON.parse(thrown.content[0].text).code, "FMC-DOC-NOT-FOUND");
    assert.equal(thrown.isError, true);
  } finally { done(k); }
});

test("pure helpers: rows the add-in couldn't fill become empty fields; counts sort by size then name", () => {
  const p = cleanPart({ id: 5, service: null, anc: [{ qty: "2" }], length_mm: "x" });
  assert.equal(p.service, "");
  assert.equal(p.length_mm, 0);
  assert.equal(p.anc[0].usage, "Undefined");
  assert.equal(p.anc[0].qty, 2);
  assert.deepEqual(countBy([{ s: "b" }, { s: "a" }, { s: "b" }, { s: " " }], (x) => x.s), { b: 2, "(none)": 1, a: 1 });
  assert.equal(auditParts([], undefined, { require_insulation: false, sample_limit: 5 }).parts_with_issues, 0);
  assert.equal(ancillarySummary([], 5).ancillary_rows, 0);
});

test("fmc_fabrication is a read command: not a write, in the read list, in command.json, and its add-in side never opens a transaction", () => {
  assert.equal(WRITE_COMMANDS.has("fmc_fabrication"), false);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_fabrication"));
  const names = (JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> }).commands.map((c) => c.commandName);
  assert.ok(names.includes("fmc_fabrication"));
  const svc = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcFabrication.cs"), "utf8");
  assert.equal(svc.includes("new Transaction"), false);
  assert.equal(svc.includes("TransactionGroup"), false);
  assert.equal(svc.includes("SubTransaction"), false);
  assert.match(svc, /FabricationConfiguration\.GetFabricationConfiguration\(doc\)/);
  assert.match(svc, /GetPartAncillaryUsage/);
  for (const forbidden of [/\.SetConfiguration\(/, /\.ReloadConfiguration\(/, /FabricationPart\.Create/, /\.Delete\(/, /SaveAs/]) assert.doesNotMatch(svc, forbidden);
  const cmd = fs.readFileSync(path.join(root, "commandset", "Commands", "Fmc", "FmcFabricationCommand.cs"), "utf8");
  assert.match(cmd, /"fmc_fabrication"/);
  const tool = fs.readFileSync(path.join(root, "server", "src", "tools", "fmc_fabrication.ts"), "utf8");
  assert.match(tool, /sendCommand\("fmc_fabrication"/);
});
