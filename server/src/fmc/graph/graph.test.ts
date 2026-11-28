import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GRAPH_DECISIONS_DEFAULT, graphDecisions, PYTHON_ALWAYS_NEEDS_PERSON } from "./decisions.js";
import { stableJson, sha256Text } from "./hash.js";
import { approvalsDir, claimGraphApproval, decideGraphApproval, listGraphApprovals, paneUser, readGraphApproval, requestGraphApproval, requesterFor } from "./approvals.js";
import { FMC_GRAPH_GUARD_SHAPE } from "../../tools/fmc_graph_guard.js";
import { z } from "zod";

/** server/src, from build/fmc/graph (tests read source to prove which surfaces pass what). */
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");
import { bindInputsByName, buildPlan, runNeedsApproval } from "./plan.js";
import { graphRunGate } from "./rungate.js";
import { scanGraphText, scanPythonCode } from "./scan.js";
import { checkPackages, compareVersions, installedPackages } from "./packages.js";
import { jailCheck, pathInputsOutsideJail, projectRootOf, graphsDir } from "./jail.js";
import { listGraphs, lockCheck, proposeLock, versionDraft } from "./lib.js";
import { graphStepProblem } from "../../hub/flows.js";
import { executeDynamo, planSummary } from "../scriptexec.js";
import type { GuardConfig } from "../policy.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function dyn(opts: { python?: string; pythonFromString?: boolean; inputs?: Array<{ id: string; name: string }>; packages?: Array<{ name: string; version: string }> } = {}): string {
  const inputs = opts.inputs ?? [{ id: "11111111-1111-4111-a111-111111111111", name: "Level" }, { id: "22222222-2222-4222-a222-222222222222", name: "Count" }];
  const nodes: Record<string, unknown>[] = inputs.map((i) => ({ Id: i.id, ConcreteType: "CoreNodeModels.Input.StringInput, CoreNodeModels", NodeType: "StringInputNode", InputValue: "", Inputs: [], Outputs: [] }));
  nodes.push({ Id: "w1", ConcreteType: "CoreNodeModels.Watch, CoreNodeModels", NodeType: "ExtensionNode", Inputs: [], Outputs: [] });
  if (opts.python !== undefined) nodes.push({ Id: "py1", ConcreteType: "PythonNodeModels.PythonNode, PythonNodeModels", NodeType: "PythonScriptNode", Code: opts.python, Engine: "PythonNet3" });
  if (opts.pythonFromString) nodes.push({ Id: "pys", ConcreteType: "PythonNodeModels.PythonStringNode, PythonNodeModels", NodeType: "ExtensionNode" });
  return JSON.stringify({
    Uuid: "g", Name: "G", Nodes: nodes, Connectors: [],
    Inputs: inputs.map((i) => ({ Id: i.id, Name: i.name, Type: "string" })), Outputs: [],
    NodeLibraryDependencies: (opts.packages ?? []).map((p) => ({ Name: p.name, Version: p.version, ReferenceType: "Package" })),
    View: { NodeViews: inputs.map((i) => ({ Id: i.id, Name: i.name, IsSetAsInput: true })) },
  });
}

function kitWith(files: Record<string, string>): string {
  const kit = tmp("b6kit-");
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(kit, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return kit;
}

const cfg = {} as GuardConfig;

function envFor(): NodeJS.ProcessEnv {
  return { ...process.env, FMC_GRAPH_APPROVALS: tmp("b6appr-"), FMC_DYNAMO_PACKAGE_DIRS: tmp("b6pkgs-"), FMC_GRAPH_ALLOWLIST: path.join(tmp("b6al-"), "none.json") };
}

// ---------- decisions ----------
test("decisions: defaults are Tool Research's recommendations and hard rules cannot be configured off", () => {
  assert.equal(PYTHON_ALWAYS_NEEDS_PERSON, true);
  const d = graphDecisions({ graph_tools: { decisions: { python_policy: "nonsense", scheduled_apply: true, apply_needs_person: false, approval_ttl_minutes: 999, drafts_folder: "..\\..\\evil" } } } as unknown as GuardConfig);
  assert.equal(d.python_policy, "person_approves_each_hash");
  assert.equal(d.scheduled_apply, false);
  assert.equal(d.apply_needs_person, true);
  assert.equal(d.approval_ttl_minutes, 30);
  assert.ok(!d.drafts_folder.includes(".."));
  assert.equal(graphDecisions(null).study_limits.max_runs, 200);
  assert.equal(GRAPH_DECISIONS_DEFAULT.drafts_folder, "00_Formcraft\\Graphs");
});

test("stableJson sorts keys at every level", () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } }), '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
});

// ---------- approvals ----------
function fakePlan(hash = "p".repeat(64)) {
  return { plan_hash: hash, graph: "K:\\g.dyn", graph_sha256: "s", inputs_hash: "i", scan_hash: "c", allowlist_version: "none", mode: "apply", document: { title: "M", path: "", state: "" }, python: false };
}

test("approval: request is pending; only a named person decides; claim is single use and bound to plan_hash", () => {
  const env = envFor();
  const a = requestGraphApproval({ kind: "graph_run", plan: fakePlan() }, env);
  assert.equal(a.status, "pending");
  assert.match(a.id, /^[0-9a-f]{16}$/);
  assert.equal(requestGraphApproval({ kind: "graph_run", plan: fakePlan() }, env).id, a.id, "same pending plan, same record");
  assert.equal(claimGraphApproval(a.id, a.plan_hash, env).ok, false);
  const auto = decideGraphApproval(a.id, "approved", "auto-approved (testing)", env);
  assert.equal(auto.ok, false);
  assert.equal(decideGraphApproval(a.id, "approved", "", env).ok, false);
  assert.equal(decideGraphApproval(a.id, "approved", "emlyn", env).ok, true);
  const wrong = claimGraphApproval(a.id, "q".repeat(64), env);
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.code, "FMC-GRAPH-APPROVAL-MISMATCH");
  const first = claimGraphApproval(a.id, a.plan_hash, env);
  assert.equal(first.ok, true);
  const second = claimGraphApproval(a.id, a.plan_hash, env);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "FMC-GRAPH-APPROVAL-USED");
  assert.equal(readGraphApproval(a.id, env)?.status, "used");
});

test("approval: refused and expired approvals never run", () => {
  const env = envFor();
  const t0 = new Date("2026-11-28T10:00:00Z");
  const a = requestGraphApproval({ kind: "graph_python", plan: fakePlan("a".repeat(64)) }, env, t0);
  decideGraphApproval(a.id, "refused", "emlyn", env, t0);
  const r = claimGraphApproval(a.id, a.plan_hash, env, t0);
  assert.equal(r.ok ? "" : r.code, "FMC-GRAPH-APPROVAL-REFUSED");
  const b = requestGraphApproval({ kind: "graph_python", plan: fakePlan("b".repeat(64)) }, env, t0);
  decideGraphApproval(b.id, "approved", "emlyn", env, t0);
  const late = claimGraphApproval(b.id, b.plan_hash, env, new Date(t0.getTime() + 31 * 60_000));
  assert.equal(late.ok ? "" : late.code, "FMC-GRAPH-APPROVAL-EXPIRED");
  assert.equal(decideGraphApproval("../../etc", "approved", "x", env).ok, false);
  assert.ok(listGraphApprovals({}, env, t0).length >= 2);
});

// ---------- named inputs (R-1) ----------
test("inputs bind by name to node ids; unknown and ambiguous names refuse; ids pass through", () => {
  const inspect = { inputs: [{ id: "A", name: "Level", type: "", default_value: null }, { id: "B", name: "Count", type: "", default_value: null }, { id: "C", name: "Dup", type: "", default_value: null }, { id: "D", name: "dup", type: "", default_value: null }] };
  const ok = bindInputsByName(inspect, { level: "L1", B: 3 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.by_id, { A: "L1", B: 3 });
  const bad = bindInputsByName(inspect, { Nope: 1, Dup: 2 });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknown, ["Nope"]);
  assert.deepEqual(bad.ambiguous, ["Dup"]);
});

test("v1.3 binder metadata: is_path, needs_revit and value_kind from the node type, default and value", () => {
  const inspect = { inputs: [
    { id: "I", name: "Count", type: "IntegerSlider", default_value: 3 },
    { id: "N", name: "Offset", type: "Number", default_value: 1.5 },
    { id: "B", name: "Flag", type: "Boolean", default_value: true },
    { id: "F", name: "Csv", type: "Filename", default_value: "" },
    { id: "D", name: "Out", type: "Directory", default_value: null },
    { id: "S", name: "Walls", type: "DSModelElementSelection", default_value: null },
    { id: "C", name: "Cat", type: "Categories", default_value: null },
    { id: "T", name: "Note", type: "String", default_value: "x" },
    { id: "U", name: "Raw", type: "", default_value: 7 },
    { id: "IS", name: "Steps", type: "number", node_type: "IntegerSlider", default_value: 2 },
    { id: "FP", name: "Pick", type: "string", node_type: "Filename", default_value: "" },
    { id: "P", name: "Where", type: "", default_value: "C:\\P\\a.csv" },
  ] };
  const r = bindInputsByName(inspect, { count: 4, Offset: 2, Flag: false, Csv: "D:\\Proj\\x.csv", Walls: "123", Note: "hi", Raw: 2.5 });
  assert.equal(r.ok, true);
  const m = r.meta;
  assert.deepEqual([m.I.value_kind, m.N.value_kind, m.B.value_kind, m.T.value_kind, m.U.value_kind], ["integer", "decimal", "bool", "string", "integer"]);
  assert.deepEqual([m.F.is_path, m.D.is_path, m.P.is_path, m.T.is_path, m.I.is_path], [true, true, true, false, false]);
  assert.deepEqual([m.S.needs_revit, m.C.needs_revit, m.I.needs_revit, m.F.needs_revit], [true, true, false, false]);
  assert.equal(m.S.value_kind, "string");
  // Dynamo's own Inputs Type is "number" for an integer slider and "string" for a file picker; the node type decides.
  assert.equal(m.IS.value_kind, "integer");
  assert.deepEqual([m.FP.is_path, m.FP.value_kind], [true, "string"]);
  assert.equal(Object.keys(m).length, inspect.inputs.length, "every marked input has metadata, set or not");
  const csv = r.binding.find((b) => b.id === "F");
  assert.deepEqual(csv, { given: "Csv", id: "F", name: "Csv", is_path: true, needs_revit: false, value_kind: "string" });
});

// ---------- plan and gate (R-7, X-05) ----------
test("plan: preview of a plain graph needs no approval; apply and offline do; plan_hash follows inputs, mode and bytes", () => {
  const env = envFor();
  const kit = kitWith({ "05_Scripts/Dynamo/G.dyn": dyn() });
  const file = path.join(kit, "05_Scripts", "Dynamo", "G.dyn");
  const base = { file, kit, cfg, env, document: null };
  const pv = buildPlan({ ...base, mode: "preview", inputs: { Level: "L1" } });
  assert.equal(pv.ok, true);
  if (!pv.ok) return;
  assert.equal(pv.plan.needs_approval, false);
  assert.deepEqual(pv.plan.inputs_by_id, { "11111111-1111-4111-a111-111111111111": "L1" });
  const ap = buildPlan({ ...base, mode: "apply", inputs: { Level: "L1" } });
  const off = buildPlan({ ...base, mode: "offline", inputs: { Level: "L1" } });
  const other = buildPlan({ ...base, mode: "preview", inputs: { Level: "L2" } });
  assert.ok(ap.ok && off.ok && other.ok);
  if (!ap.ok || !off.ok || !other.ok) return;
  assert.equal(ap.plan.needs_approval, true);
  assert.equal(off.plan.needs_approval, true);
  assert.notEqual(ap.plan.plan_hash, pv.plan.plan_hash);
  assert.notEqual(other.plan.plan_hash, pv.plan.plan_hash);
  fs.appendFileSync(file, " ");
  const changed = buildPlan({ ...base, mode: "preview", inputs: { Level: "L1" } });
  assert.ok(changed.ok && changed.plan.plan_hash !== pv.plan.plan_hash);
  const unknown = buildPlan({ ...base, mode: "preview", inputs: { Levle: "L1" } });
  assert.equal(unknown.ok ? "" : unknown.code, "FMC-DYNAMO-INPUT");
  // v1.3: the summary fmc_dynamo plan returns names the graph (id, path, hash) and the inputs by node id.
  const sum = planSummary(pv.plan) as { graph: { id: string; path: string; sha256: string }; inputs_by_id: Record<string, unknown> };
  assert.deepEqual(sum.graph, { id: "05_scripts\\dynamo\\g.dyn", path: file, sha256: pv.plan.graph_sha256 });
  assert.deepEqual(sum.inputs_by_id, { "11111111-1111-4111-a111-111111111111": "L1" });
});

test("Python graphs always need a person: preview too, under any config; python_policy off refuses them", () => {
  const env = envFor();
  const kit = kitWith({ "05_Scripts/Dynamo/P.dyn": dyn({ python: "import os\nOUT = 1" }), "05_Scripts/Dynamo/S.dyn": dyn({ pythonFromString: true }) });
  for (const name of ["P.dyn", "S.dyn"]) {
    const file = path.join(kit, "05_Scripts", "Dynamo", name);
    const looseCfg = { graph_tools: { decisions: { python_policy: "person_approves_each_hash", apply_needs_person: false } }, ai_modeller: { access: "full", auto_approve: true, allow_code: true } } as unknown as GuardConfig;
    const p = buildPlan({ file, kit, cfg: looseCfg, env, document: null, mode: "preview" });
    assert.equal(p.ok, true);
    if (!p.ok) return;
    assert.equal(p.plan.python, true);
    assert.equal(p.plan.needs_approval, true);
    const gate = graphRunGate(p.plan, undefined, env);
    assert.equal(gate.ok ? "" : gate.code, "FMC-GRAPH-APPROVAL-NEEDED");
  }
  const off = buildPlan({ file: path.join(kit, "05_Scripts", "Dynamo", "P.dyn"), kit, cfg: { graph_tools: { decisions: { python_policy: "off" } } } as unknown as GuardConfig, env, document: null, mode: "preview" });
  assert.equal(off.ok ? "" : off.code, "FMC-GRAPH-PYTHON-OFF");
  assert.deepEqual(runNeedsApproval({ python: true, mode: "preview" }).needed, true);
});

test("gate: an approved plan runs once; a changed kit graph (lock mismatch) never runs", () => {
  const env = envFor();
  const kit = kitWith({ "05_Scripts/Dynamo/G.dyn": dyn() });
  const file = path.join(kit, "05_Scripts", "Dynamo", "G.dyn");
  const p = buildPlan({ file, kit, cfg, env, document: null, mode: "apply" });
  assert.ok(p.ok);
  if (!p.ok) return;
  const a = requestGraphApproval({ kind: p.plan.approval_kind, plan: p.plan }, env);
  decideGraphApproval(a.id, "approved", "emlyn", env);
  assert.equal(graphRunGate(p.plan, a.id, env).ok, true);
  const again = graphRunGate(p.plan, a.id, env);
  assert.equal(again.ok ? "" : again.code, "FMC-GRAPH-APPROVAL-USED");
  fs.writeFileSync(path.join(kit, "05_Scripts", "graphs.lock.json"), JSON.stringify({ v: 1, graphs: { "05_scripts\\dynamo\\g.dyn": { sha256: "0".repeat(64) } } }));
  const locked = buildPlan({ file, kit, cfg, env, document: null, mode: "preview" });
  assert.ok(locked.ok);
  if (!locked.ok) return;
  assert.equal(locked.plan.lock, "mismatch");
  const g = graphRunGate(locked.plan, undefined, env);
  assert.equal(g.ok ? "" : g.code, "FMC-GRAPH-LOCK");
});

test("executeDynamo: offline (R-3) and Python previews stop at the gate before anything starts; an approved offline run passes the gate", async () => {
  const env = envFor();
  delete env.DYNAMO_CLI; delete env.FMC_DYNAMO_CLI;
  const kit = kitWith({ "05_Scripts/Dynamo/G.dyn": dyn(), "05_Scripts/Dynamo/P.dyn": dyn({ python: "OUT = 1" }) });
  const g = path.join(kit, "05_Scripts", "Dynamo", "G.dyn");
  const off = await executeDynamo({ file: g, mode: "offline", inputs: { Level: "L1" }, cfg, kit }, { env });
  assert.equal(off.code, "FMC-GRAPH-APPROVAL-NEEDED");
  const py = await executeDynamo({ file: path.join(kit, "05_Scripts", "Dynamo", "P.dyn"), mode: "preview", inputs: {}, cfg, kit }, { env });
  assert.equal(py.code, "FMC-GRAPH-APPROVAL-NEEDED");
  const bad = await executeDynamo({ file: g, mode: "preview", inputs: { Nope: 1 }, cfg, kit }, { env });
  assert.equal(bad.code, "FMC-DYNAMO-INPUT");
  const plan = buildPlan({ file: g, kit, cfg, env, document: null, mode: "offline", inputs: { Level: "L1" } });
  assert.ok(plan.ok);
  if (!plan.ok) return;
  const a = requestGraphApproval({ kind: plan.plan.approval_kind, plan: plan.plan }, env);
  decideGraphApproval(a.id, "approved", "emlyn", env);
  const ran = await executeDynamo({ file: g, mode: "offline", inputs: { Level: "L1" }, cfg, kit, approvalId: a.id }, { env });
  assert.equal(ran.code, "FMC-DYNAMO-UNAVAILABLE", "passed the gate, then DynamoCLI is not configured in the test");
  assert.equal(readGraphApproval(a.id, env)?.status, "used");
});

// ---------- scan ----------
test("scan: flags risky Python, Python from a wire and file-writing nodes; comments are skipped; scan_hash is stable", () => {
  const f = scanPythonCode("# import os\nimport subprocess\nf = open('x.txt', 'w')\nclr.AddReference('RevitAPI')\nexec(code)\nt = Transaction(doc)\ndoc.Delete(ids)");
  const rules = f.map((x) => x.rule);
  assert.ok(!rules.includes("import os"));
  for (const r of ["import subprocess", "open() for writing", "clr.AddReference", "eval/exec/compile", "Revit Transaction", "Revit Delete"]) assert.ok(rules.includes(r), r);
  const text = dyn({ python: "import socket", pythonFromString: true });
  const s1 = scanGraphText("g.dyn", text);
  const s2 = scanGraphText("g.dyn", text);
  assert.equal(s1.python, true);
  assert.equal(s1.python_from_string.length, 1);
  assert.equal(s1.scan_hash, s2.scan_hash);
  assert.ok(s1.counts.high >= 2);
  const io = JSON.stringify({ Nodes: [{ Id: "x", ConcreteType: "Dynamo.Graph.Nodes.ZeroTouch.DSFunction, DynamoCore", FunctionSignature: "DSCore.IO.FileSystem.WriteText@string,string" }] });
  assert.equal(scanGraphText("io.dyn", io).findings[0]?.kind, "file_io");
});

// ---------- packages ----------
test("packages: missing, older, newer and ok against pkg.json; a package with a DLL is a finding", () => {
  const dir = tmp("b6p-");
  const mk = (name: string, version: string, dll = false) => {
    const f = path.join(dir, name);
    fs.mkdirSync(path.join(f, "bin"), { recursive: true });
    fs.writeFileSync(path.join(f, "pkg.json"), JSON.stringify({ name, version }));
    if (dll) fs.writeFileSync(path.join(f, "bin", "x.dll"), "MZ");
  };
  mk("GenerativeDesign", "8.2.1.0"); mk("Old", "1.0.0"); mk("New", "3.0.0", true);
  const inspect = { packages: [
    { name: "GenerativeDesign", version: "8.2.1.0", reference: "Package" }, { name: "Old", version: "2.0.0", reference: "Package" },
    { name: "New", version: "2.0.0", reference: "Package" }, { name: "Gone", version: "1.0", reference: "Package" },
  ] };
  const r = checkPackages(inspect, installedPackages([dir]), [dir], graphDecisions(null));
  const by = Object.fromEntries(r.packages.map((p) => [p.name, p]));
  assert.equal(by.GenerativeDesign.status, "ok");
  assert.equal(by.GenerativeDesign.allowed, true);
  assert.equal(by.Old.status, "older");
  assert.equal(by.New.status, "newer");
  assert.equal(by.Gone.status, "missing");
  assert.equal(r.ok, false);
  assert.equal(r.dll_findings.length, 1);
  assert.ok(by.Old.folder_sha256 && by.Old.folder_sha256.length === 64);
  assert.equal(compareVersions("1.10", "1.9"), 1);
});

// ---------- jail ----------
test("jail: inside passes; '..', outside and a link that leaves the project are refused", () => {
  const root = tmp("b6proj-");
  fs.mkdirSync(path.join(root, "00_Formcraft"), { recursive: true });
  fs.writeFileSync(path.join(root, "00_Formcraft", "a.dyn"), "{}");
  assert.equal(jailCheck(path.join(root, "00_Formcraft", "a.dyn"), root).ok, true);
  assert.equal(jailCheck(path.join(root, "..", "x.dyn"), root).ok, false);
  assert.equal(jailCheck(path.join(os.tmpdir(), "elsewhere.dyn"), root).ok, false);
  const outside = tmp("b6out-");
  fs.symlinkSync(outside, path.join(root, "escape"), "dir");
  assert.equal(jailCheck(path.join(root, "escape", "x.dyn"), root).ok, false);
  assert.equal(pathInputsOutsideJail({ a: path.join(outside, "f.csv"), b: "plain text" }, root).length, 1);
  assert.equal(projectRootOf("/p/Proj/01_WIP/M/a.rvt"), "/p/Proj");
  assert.equal(projectRootOf("D:\\P\\Proj\\01_WIP\\M\\a.rvt"), "D:\\P\\Proj");
  assert.equal(projectRootOf("/no/wip/a.rvt"), "");
});

// ---------- library ----------
test("lib: list covers both kit places and project drafts; version never overwrites; lock proposal stays out of the kit", () => {
  const kit = kitWith({ "05_Scripts/Dynamo/A.dyn": dyn(), "05_Scripts/library/x/B.dyn": dyn({ python: "OUT=1" }) });
  const root = tmp("b6proj-");
  const drafts = graphsDir(root);
  fs.mkdirSync(drafts, { recursive: true });
  fs.writeFileSync(path.join(drafts, "D.dyn"), dyn());
  const listed = listGraphs({ kit, projectRoot: root });
  assert.equal(listed.graphs.length, 3);
  assert.equal(listed.graphs.find((g) => g.id === "B")?.python, true);
  assert.equal(listed.graphs.find((g) => g.id === "D")?.tier, "P");
  const v1 = versionDraft({ projectRoot: root, draft: path.join(drafts, "D.dyn"), id: "D", reason: "first", author: "ai" });
  const v2 = versionDraft({ projectRoot: root, draft: path.join(drafts, "D.dyn"), id: "D", reason: "second", author: "ai" });
  assert.ok(v1.ok && v2.ok);
  if (!v1.ok || !v2.ok) return;
  assert.equal(v1.version.version, 1);
  assert.equal(v2.version.version, 2);
  assert.equal(v2.version.parent_sha256, v1.version.sha256);
  assert.equal(versionDraft({ projectRoot: root, draft: path.join(kit, "05_Scripts", "Dynamo", "A.dyn"), id: "A", reason: "r", author: "ai" }).ok, false, "a kit file is not a draft");
  assert.equal(versionDraft({ projectRoot: root, draft: path.join(drafts, "D.dyn"), id: "../x", reason: "r", author: "ai" }).ok, false);
  const lock = proposeLock({ kit, projectRoot: root });
  assert.ok(lock.ok);
  if (!lock.ok) return;
  assert.ok(lock.file.startsWith(root));
  assert.equal(fs.existsSync(path.join(kit, "05_Scripts", "graphs.lock.json")), false);
  assert.equal(Object.keys(lock.lock.graphs).length, 2);
  const again = proposeLock({ kit, projectRoot: root });
  assert.ok(again.ok);
  assert.ok(fs.readdirSync(drafts).some((f) => /^graphs\.lock\.proposed\..+\.json$/.test(f)), "the older proposal is archived");
  fs.copyFileSync(lock.file, path.join(kit, "05_Scripts", "graphs.lock.json"));
  const a = path.join(kit, "05_Scripts", "Dynamo", "A.dyn");
  assert.equal(lockCheck(kit, a, sha256Text(fs.readFileSync(a))), "match");
});

// ---------- flows (R-8) ----------
test("flows: a graph apply, offline or library script step without approval_id is refused; reads and previews pass", () => {
  assert.equal(graphStepProblem("fmc_dynamo", { action: "inspect" }), null);
  assert.equal(graphStepProblem("fmc_dynamo", { action: "run", mode: "preview" }), null);
  assert.match(String(graphStepProblem("fmc_dynamo", { action: "run", dry_run: false })), /approval_id/);
  assert.match(String(graphStepProblem("fmc_dynamo", { action: "submit", mode: "offline" })), /approval_id/);
  assert.match(String(graphStepProblem("fmc_script_run", { action: "run", id: "x" })), /approval_id/);
  assert.match(String(graphStepProblem("fmc_scripts", { action: "graph_run", mode: "apply" })), /approval_id/);
  assert.equal(graphStepProblem("fmc_dynamo", { action: "run", mode: "apply", approval_id: "0123456789abcdef" }), null);
  assert.equal(graphStepProblem("fmc_selftest", {}), null);
});

// ---------- jail v1.2: every refusal is the jail's own job ----------
test("jail v1.2: device, UNC, '..', relative-without-base, missing and link refusals; mustExist:false confines the parent", () => {
  const root = tmp("b6proj12-");
  const drafts = path.join(root, "00_Formcraft", "Graphs", "drafts");
  fs.mkdirSync(drafts, { recursive: true });
  fs.writeFileSync(path.join(drafts, "a.dyn"), "{}");
  const reason = (r: ReturnType<typeof jailCheck>) => (r.ok ? "ok" : r.reason);
  // device paths
  assert.equal(reason(jailCheck("\\\\.\\C:\\P\\a.dyn", root)), "device");
  assert.equal(reason(jailCheck("\\\\?\\C:\\P\\a.dyn", root)), "device");
  assert.equal(reason(jailCheck("//./C:/P/a.dyn", root)), "device");
  assert.equal(reason(jailCheck("//?/C:/P/a.dyn", root)), "device");
  // UNC, even when the root itself looks like a share
  assert.equal(reason(jailCheck("\\\\server\\share\\a.dyn", root)), "unc");
  assert.equal(reason(jailCheck("//server/share/a.dyn", "//server/share")), "unc");
  // any '..' segment, raw (not normalised away), in the file or the base
  assert.equal(reason(jailCheck(`${drafts}/../drafts/a.dyn`, root)), "dotdot");
  assert.equal(reason(jailCheck("..\\x.dyn", root, { base: drafts })), "dotdot");
  assert.equal(reason(jailCheck("a.dyn", root, { base: `${drafts}/..` })), "dotdot");
  // relative paths need an explicit absolute base
  assert.equal(reason(jailCheck("a.dyn", root)), "relative");
  assert.equal(reason(jailCheck("a.dyn", root, { base: "relative/base" })), "relative");
  assert.equal(reason(jailCheck("a.dyn", root, { base: drafts })), "ok");
  assert.equal(reason(jailCheck("a.dyn", root, { base: tmp("b6other-") })), "outside");
  // mustExist defaults to true
  assert.equal(reason(jailCheck(path.join(drafts, "new.dyn"), root)), "missing");
  assert.equal(reason(jailCheck(path.join(drafts, "new.dyn"), root, { mustExist: false })), "ok");
  assert.equal(reason(jailCheck(path.join(drafts, "deeper", "new.dyn"), root, { mustExist: false })), "ok");
  // the root itself and outside paths
  assert.equal(reason(jailCheck(root, root, { mustExist: false })), "outside");
  assert.equal(reason(jailCheck(path.join(tmp("b6out12-"), "x.dyn"), root, { mustExist: false })), "outside");
  // mustExist:false still confines the resolved parent: a link under the project that points out is refused
  const outside = tmp("b6out12b-");
  fs.symlinkSync(outside, path.join(root, "00_Formcraft", "Graphs", "esc"), "junction");
  assert.equal(reason(jailCheck(path.join(root, "00_Formcraft", "Graphs", "esc", "new.dyn"), root, { mustExist: false })), "link");
  assert.equal(reason(jailCheck(path.join(root, "00_Formcraft", "Graphs", "esc", "sub", "new.dyn"), root, { mustExist: false })), "link");
  fs.writeFileSync(path.join(outside, "there.dyn"), "{}");
  assert.equal(reason(jailCheck(path.join(root, "00_Formcraft", "Graphs", "esc", "there.dyn"), root)), "link");
  // no root, empty
  assert.equal(reason(jailCheck(path.join(drafts, "a.dyn"), "")), "no_root");
  assert.equal(reason(jailCheck("  ", root)), "empty");
  // path inputs: device and UNC values are refused like any other escape
  assert.equal(pathInputsOutsideJail({ a: "\\\\?\\C:\\x.csv", b: "\\\\srv\\s\\x.csv", c: "/", d: "note" }, root).length, 2);
});

// ---------- requested_by is safe (v1.3) ----------
test("approval requested_by: an AI or MCP caller is always \"ai\" and cannot spoof person:; only the pane surface records the OS user; the ledger names both", () => {
  const env = envFor();
  // A caller-supplied requested_by is ignored, whatever it says.
  for (const spoof of ["person:mallory", "person:" + (paneUser(env) || "someone"), "Person:Admin", "pane"]) {
    const a = requestGraphApproval({ kind: "graph_run", plan: fakePlan(sha256Text(spoof)), requested_by: spoof }, env);
    assert.equal(a.requested_by, "ai", spoof);
  }
  // surface "mcp" (the MCP tool and the fmc_graph_guard CLI case) is "ai" too.
  assert.equal(requestGraphApproval({ kind: "graph_run", plan: fakePlan(sha256Text("mcp")), surface: "mcp", requested_by: "person:x" }, env).requested_by, "ai");
  assert.equal(requesterFor(undefined, env), "ai");
  // The MCP tool's schema accepts requested_by but it never reaches the record: the tool passes no surface.
  const parsed = z.object(FMC_GRAPH_GUARD_SHAPE).parse({ action: "request_approval", path: "K:\\g.dyn", requested_by: "person:mallory" });
  assert.equal(parsed.requested_by, "person:mallory");
  const guardSrc = fs.readFileSync(path.join(SRC_DIR, "tools", "fmc_graph_guard.ts"), "utf8");
  assert.doesNotMatch(guardSrc, /requested_by:\s*args\.requested_by|requested_by:\s*\(?args/);
  assert.match(guardSrc, /server\.tool\("fmc_graph_guard"[^\n]*\(args\) => runFmcGraphGuard\(args\)\)/);
  // Only the pane CLI's graph_request passes the "pane" surface.
  const cliSrc = fs.readFileSync(path.join(SRC_DIR, "fmc", "cli.ts"), "utf8");
  const paneCalls = [...cliSrc.matchAll(/runFmcGraphGuard\([^\n]*"pane"\)/g)];
  assert.equal(paneCalls.length, 1);
  assert.match(cliSrc, /case "graph_request":\s*\n\s*return printReply\(await runFmcGraphGuard\([^\n]*"pane"\)\)/);
  // The pane surface records person:<OS user> (never a caller string), and the ledger names who asked and who approved.
  const user = paneUser(env);
  const p = requestGraphApproval({ kind: "graph_run", plan: fakePlan(sha256Text("pane-surface")), surface: "pane", requested_by: "person:mallory" }, env);
  assert.equal(p.requested_by, user ? `person:${user}` : "ai");
  assert.notEqual(p.requested_by, "person:mallory");
  const d = decideGraphApproval(p.id, "approved", "alice", env);
  assert.ok(d.ok);
  const log = fs.readFileSync(path.join(path.dirname(approvalsDir(env)), "graph_runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.id === p.id);
  assert.ok(log.some((r) => r.event === "approval_requested" && r.requested_by === p.requested_by));
  assert.ok(log.some((r) => r.event === "approval_approved" && r.requested_by === p.requested_by && r.decided_by === "alice"));
});

test("v1.3 plan: an is_path input with a relative value is refused by the jail; a full path inside the project passes", () => {
  const env = envFor();
  const g = JSON.parse(dyn({ inputs: [{ id: "33333333-3333-4333-a333-333333333333", name: "Csv" }] }));
  for (const n of g.Nodes) if (n.Id === "33333333-3333-4333-a333-333333333333") { n.ConcreteType = "CoreNodeModels.Input.Filename, CoreNodeModels"; n.NodeType = "ExtensionNode"; }
  const kit = kitWith({ "05_Scripts/Dynamo/P.dyn": JSON.stringify(g) });
  const file = path.join(kit, "05_Scripts", "Dynamo", "P.dyn");
  const root = tmp("b6projp-");
  fs.mkdirSync(path.join(root, "01_WIP"), { recursive: true });
  fs.writeFileSync(path.join(root, "in.csv"), "a");
  const document = { title: "M", path: path.join(root, "01_WIP", "M.rvt") };
  const rel = buildPlan({ file, kit, cfg, env, document, mode: "preview", inputs: { Csv: "in.csv" } });
  assert.equal(rel.ok ? "" : rel.code, "FMC-GRAPH-JAIL");
  const full = buildPlan({ file, kit, cfg, env, document, mode: "preview", inputs: { Csv: path.join(root, "in.csv") } });
  assert.equal(full.ok, true, full.ok ? "" : full.message);
  if (full.ok) assert.equal(full.plan.input_meta["33333333-3333-4333-a333-333333333333"].is_path, true);
});
