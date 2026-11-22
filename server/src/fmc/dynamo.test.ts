import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { approvedScriptPath, offlineDecision, outsideRootMessage, parseDyn, scriptRoots } from "./dynamo.js";

const win = path.win32;

function graph(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Uuid: "abc",
    Name: "Place rooms",
    Inputs: [{ Id: "in-top", Name: "Level", Type: "string" }],
    Outputs: [],
    Nodes: [
      { Id: "n1", Name: "Rooms", NodeType: "StringInput", ConcreteType: "StringInput, CoreNodeModels", IsSetAsInput: true },
      { Id: "n2", Name: "Watch", NodeType: "Watch", ConcreteType: "Watch, CoreNodeModels" },
      { Id: "n3", Name: "Py", NodeType: "PythonScriptNode", ConcreteType: "PythonNode, Dynamo.Graph.Nodes", Engine: "CPython3" },
    ],
    NodeLibraryDependencies: [{ Name: "DynamoCore", Version: "3.0", ReferenceType: "Package" }],
    ...extra,
  });
}

test("inspect reads inputs, outputs, packages, nodes and Python nodes from the .dyn JSON", () => {
  const parsed = parseDyn("K:\\05_Scripts\\Dynamo\\Rooms.dyn", graph());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.inspect.name, "Place rooms");
  assert.ok(parsed.inspect.inputs.some((item) => item.name === "Rooms"));
  assert.ok(parsed.inspect.inputs.some((item) => item.name === "Level"));
  assert.ok(parsed.inspect.outputs.some((item) => item.name === "Watch"));
  assert.equal(parsed.inspect.packages[0].name, "DynamoCore");
  assert.equal(parsed.inspect.nodes.count, 3);
  assert.equal(parsed.inspect.python_nodes.length, 1);
  assert.equal(parsed.inspect.python_nodes[0].engine, "CPython3");
  assert.equal(parsed.inspect.revit_nodes, false);
});

test("a Revit package blocks offline mode and does not launch Revit", () => {
  const parsed = parseDyn("G.dyn", graph({
    Nodes: [{ Id: "r", ConcreteType: "Wall.ByCurveAndHeight, Revit.Elements", NodeType: "FunctionNode" }],
    NodeLibraryDependencies: [{ Name: "Revit", Version: "2025", ReferenceType: "Package" }],
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.inspect.revit_nodes, true);
  assert.deepEqual(parsed.inspect.revit_packages, ["Revit"]);
  const decision = offlineDecision(parsed.inspect);
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.code, "FMC-DYNAMO-NEEDS-REVIT");
  assert.match(decision.message, /was not launched/);
});

test("a graph with no Revit nodes may run offline", () => {
  const parsed = parseDyn("G.dyn", graph());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(offlineDecision(parsed.inspect), { ok: true });
});

test("only 05_Scripts/library and 05_Scripts/Dynamo are approved", () => {
  const kit = "Z:\\Kit";
  assert.deepEqual(scriptRoots(kit), [win.join(kit, "05_Scripts", "library"), win.join(kit, "05_Scripts", "Dynamo")]);
  assert.equal(approvedScriptPath(win.join(kit, "05_Scripts", "Dynamo", "Rooms.dyn"), kit), true);
  assert.equal(approvedScriptPath(win.join(kit, "05_Scripts", "library", "sheets", "Run.cs"), kit), true);
  assert.equal(approvedScriptPath(win.join(kit, "05_Scripts", "tools", "other.py"), kit), false);
  assert.equal(approvedScriptPath("C:\\Temp\\Rooms.dyn", kit), false);
  assert.match(outsideRootMessage("C:\\Temp\\Rooms.dyn", kit), /FMC-SCRIPT-ROOT/);
});

test("a .dyn that is not JSON is refused", () => {
  const parsed = parseDyn("Bad.dyn", "not json");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.message, /FMC-DYNAMO-PARSE/);
});

test("preview, dry-run and apply of these tools skip autosave", async () => {
  const { scriptCallSkipsAutoSave } = await import("./aigate.js");
  assert.equal(scriptCallSkipsAutoSave("fmc_dynamo", { mode: "preview" }), true);
  assert.equal(scriptCallSkipsAutoSave("fmc_dynamo", { mode: "apply" }), true);
  assert.equal(scriptCallSkipsAutoSave("send_code_to_revit", { fmc_caller: "fmc_script_run", mode: "preview", transactionMode: "read_only" }), true);
  assert.equal(scriptCallSkipsAutoSave("send_code_to_revit", { fmc_caller: "fmc_script_run", mode: "apply" }), true);
  assert.equal(scriptCallSkipsAutoSave("fmc_model_edit", { dry_run: false }), false);
});

test("graph_run inspect no longer returns the old runner refusal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dyn-"));
  const kit = path.join(root, "kit");
  const dynDir = path.join(kit, "05_Scripts", "Dynamo");
  fs.mkdirSync(dynDir, { recursive: true });
  const dyn = path.join(dynDir, "Rooms.dyn");
  fs.writeFileSync(dyn, graph());
  const guard = path.join(root, "guard.json");
  fs.writeFileSync(guard, JSON.stringify({
    specs_path: path.join(kit, "03_Master_Data", "FMC_Family_Specs.json"),
    reports_dir: path.join(root, "reports"),
    live_model_lock: false,
  }));
  const prevGuard = process.env.FMC_GUARD_CONFIG;
  const prevKit = process.env.FMC_KIT;
  process.env.FMC_GUARD_CONFIG = guard;
  process.env.FMC_KIT = kit;
  try {
    const { z } = await import("zod");
    const { FMC_SCRIPTS_SHAPE, runFmcScripts } = await import("../tools/fmc_scripts.js");
    const args = z.object(FMC_SCRIPTS_SHAPE).parse({ action: "graph_run", dynamo_action: "inspect", graph: dyn });
    const reply = await runFmcScripts(args);
    const body = JSON.parse(reply.content[0].text) as { name?: string; refused?: boolean; reason?: string; inputs?: unknown[] };
    assert.equal(body.refused, undefined);
    assert.equal(body.name, "Place rooms");
    assert.ok(Array.isArray(body.inputs));
    assert.equal(JSON.stringify(body).includes("not an in-Revit Dynamo runner"), false);
  } finally {
    if (prevGuard === undefined) delete process.env.FMC_GUARD_CONFIG; else process.env.FMC_GUARD_CONFIG = prevGuard;
    if (prevKit === undefined) delete process.env.FMC_KIT; else process.env.FMC_KIT = prevKit;
  }
});
