import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindFormValues, graphFormSpec } from "./form.js";
import { jailCheck, projectRootOf } from "./jail.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, "../../../src/fmc/fixtures/graph_form");

/** A throwaway kit and project: <tmp>/kit/05_Scripts/{Dynamo,library}, <tmp>/F26001_Test/{01_WIP,00_Formcraft/Graphs}. */
function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fmc-graph-form-")));
  const kit = path.join(base, "kit");
  const dyn = path.join(kit, "05_Scripts", "Dynamo");
  const lib = path.join(kit, "05_Scripts", "library");
  const project = path.join(base, "F26001_Test");
  const drafts = path.join(project, "00_Formcraft", "Graphs");
  for (const dir of [dyn, lib, path.join(project, "01_WIP"), drafts]) fs.mkdirSync(dir, { recursive: true });
  for (const name of ["FMC_ModelHealth.dyn", "form_inputs.dyn", "python_string.dyn", "not_a_graph.dyn", "notes.txt"]) {
    fs.copyFileSync(path.join(FIX, name), path.join(dyn, name));
  }
  fs.copyFileSync(path.join(FIX, "form_inputs.dyn"), path.join(drafts, "draft_form.dyn"));
  const documentPath = path.join(project, "01_WIP", "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt");
  const packages = path.join(base, "packages");
  fs.mkdirSync(packages);
  const env = { FMC_DYNAMO_PACKAGE_DIRS: packages, LOCALAPPDATA: path.join(base, "local") } as NodeJS.ProcessEnv;
  return { packages, env, base, kit, dyn, lib, project, drafts, documentPath, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function sha(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("kit FMC_ModelHealth.dyn: three named string inputs, Python output, hash, Python needs a person in every mode", () => {
  const box = sandbox();
  try {
    const file = path.join(box.dyn, "FMC_ModelHealth.dyn");
    const result = graphFormSpec({ file, kit: box.kit, documentPath: "", env: box.env });
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok) return;
    const spec = result.spec;
    assert.equal(spec.graph.tier, "K");
    assert.equal(spec.graph.sha256, sha(file));
    assert.equal(spec.graph.sha256, "721a9f3dbc8324a44015ce0a1a26a6c38172465dd3ea0a02bb89c053fb6f3c23");
    assert.deepEqual(spec.fields.map((f) => f.name), ["Output folder (C: local, not D:)", "FMC_Master_Data.json path", "Expected survey point E,N,Elev (m) or blank"]);
    assert.ok(spec.fields.every((f) => f.kind === "string" && f.widget === "text"));
    assert.equal(spec.fields[0].path_like, true);
    assert.equal(spec.fields[2].path_like, false);
    assert.equal(spec.has_python, true);
    assert.equal(spec.python_nodes[0].engine, "CPython3");
    assert.deepEqual(spec.approval.person_required_for, ["preview", "apply", "offline"]);
    assert.equal(spec.approval.python_always_needs_person, true);
    assert.deepEqual(spec.outputs.map((o) => o.name), ["FMC_ModelHealth"]);
    assert.deepEqual(spec.packages, []);
    assert.deepEqual(spec.package_check?.packages, []);
    assert.equal(spec.lock, "absent");
    assert.equal(spec.python_policy, "person_approves_each_hash");
    assert.ok(spec.scan.findings > 0);
    assert.match(spec.scan.scan_hash, /^[0-9a-f]{64}$/);
    assert.equal(spec.approval.kind_by_mode.preview, "graph_python");
    assert.match(spec.spec_hash, /^[0-9a-f]{64}$/);
  } finally { box.done(); }
});

test("form fixture: sliders, checkbox, pickers, dropdowns, element selection needs Revit, watch and output, package deps", () => {
  const box = sandbox();
  try {
    const result = graphFormSpec({ file: path.join(box.dyn, "form_inputs.dyn"), kit: box.kit, documentPath: "", env: box.env });
    assert.equal(result.ok, true, result.ok ? "" : result.message);
    if (!result.ok) return;
    const by = Object.fromEntries(result.spec.fields.map((f) => [f.name, f]));
    assert.equal(result.spec.fields.length, 9);
    assert.deepEqual([by["Count"].kind, by["Count"].widget, by["Count"].min, by["Count"].max, by["Count"].step, by["Count"].default], ["integer", "slider", 1, 10, 1, 4]);
    assert.deepEqual([by["Offset (m)"].kind, by["Offset (m)"].min, by["Offset (m)"].max, by["Offset (m)"].step], ["number", 0.5, 3, 0.1]);
    assert.deepEqual([by["Dry run only"].widget, by["Dry run only"].default], ["checkbox", true]);
    assert.deepEqual([by["Room list CSV"].widget, by["Room list CSV"].path_like], ["file_picker", true]);
    assert.equal(by["Output folder"].widget, "folder_picker");
    assert.deepEqual(by["Mode"].options, [{ label: "Fast", value: "fast" }, { label: "Full", value: "full" }]);
    assert.equal(by["Mode"].default, "full");
    assert.deepEqual([by["Category"].options, by["Category"].options_source, by["Category"].needs_revit, by["Category"].default], [null, "revit", true, "OST_Walls"]);
    assert.deepEqual([by["Pick a wall"].kind, by["Pick a wall"].widget, by["Pick a wall"].needs_revit], ["element", "element_picker", true]);
    assert.equal(result.spec.needs_revit, true);
    assert.deepEqual(result.spec.outputs.map((o) => [o.name, o.kind]), [["Result", "watch"], ["Sum", "output"]]);
    assert.equal(result.spec.has_python, false);
    assert.deepEqual(result.spec.approval.person_required_for, ["apply", "offline"]);
    assert.deepEqual(result.spec.packages, [{ name: "Clockwork for Dynamo 2.x", version: "2.5.0", reference_type: "Package", nodes: ["a1000000000000000000000000000012"] }]);
    assert.deepEqual(result.spec.custom_nodes, ["0b5d2d4e-7c1c-4a52-8a2e-5c8f0e8a1111"]);
    assert.deepEqual(result.spec.package_check?.missing, ["Clockwork for Dynamo 2.x"]);
    assert.deepEqual(result.spec.package_check?.not_allowed, ["Clockwork for Dynamo 2.x"]);
  } finally { box.done(); }
});

test("inputs bind by name (any case) or id to node GUIDs; unknown, out-of-range and non-option values are refused, not dropped", () => {
  const box = sandbox();
  try {
    const result = graphFormSpec({ file: path.join(box.dyn, "form_inputs.dyn"), kit: box.kit, documentPath: "", env: box.env });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const good = bindFormValues(result.spec, { count: 7, "Offset (m)": 2.5, Mode: "fast", a1000000000000000000000000000003: false });
    assert.equal(good.ok, true);
    if (good.ok) assert.deepEqual(good.inputs_by_id, {
      a1000000000000000000000000000001: 7, a1000000000000000000000000000002: 2.5, a1000000000000000000000000000006: "fast", a1000000000000000000000000000003: false,
    });
    const bad = bindFormValues(result.spec, { Levle: "x", Count: 11, Mode: "slow" });
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.deepEqual(bad.unknown, ["Levle"]);
    assert.equal(bad.invalid.length, 2);
    assert.equal(bad.code, "FMC-GRAPH-FORM-INPUT");
    const named = graphFormSpec({ file: path.join(box.dyn, "FMC_ModelHealth.dyn"), kit: box.kit, documentPath: "", env: box.env });
    assert.equal(named.ok, true);
    if (!named.ok) return;
    const health = bindFormValues(named.spec, { "fmc_master_data.json path": "D:\\kit\\x.json" });
    assert.equal(health.ok, true);
    if (health.ok) assert.deepEqual(Object.keys(health.inputs_by_id), ["f3154b594e324d859953522e628c747a"]);
  } finally { box.done(); }
});

test("Python-from-string is flagged as Python", () => {
  const box = sandbox();
  try {
    const result = graphFormSpec({ file: path.join(box.dyn, "python_string.dyn"), kit: box.kit, documentPath: "", env: box.env });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.spec.has_python, true);
    assert.equal(result.spec.python_nodes[0].from_string, true);
    assert.deepEqual(result.spec.approval.person_required_for, ["preview", "apply", "offline"]);
  } finally { box.done(); }
});

test("a draft under <project>\\00_Formcraft\\Graphs of the target document is tier P; without a document it is refused", () => {
  const box = sandbox();
  try {
    assert.equal(projectRootOf(box.documentPath), box.project);
    const file = path.join(box.drafts, "draft_form.dyn");
    const ok = graphFormSpec({ file, kit: box.kit, documentPath: box.documentPath, env: box.env });
    assert.equal(ok.ok, true, ok.ok ? "" : ok.message);
    if (ok.ok) assert.equal(ok.spec.graph.tier, "P");
    const none = graphFormSpec({ file, kit: box.kit, documentPath: "", env: box.env });
    assert.equal(none.ok, false);
    if (!none.ok) assert.equal(none.code, "FMC-GRAPH-JAIL");
  } finally { box.done(); }
});

test("path escapes are refused: '..', UNC, device path, relative, junction or link out of the jail", () => {
  const box = sandbox();
  try {
    const sep = path.sep;
    const dotdot = graphFormSpec({ file: `${box.dyn}${sep}..${sep}Dynamo${sep}form_inputs.dyn`, kit: box.kit, documentPath: "", env: box.env });
    assert.equal(dotdot.ok, false);
    if (!dotdot.ok) { assert.equal(dotdot.code, "FMC-GRAPH-JAIL"); assert.match(dotdot.message, /'\.\.'/); }
    for (const unc of ["\\\\server\\share\\05_Scripts\\Dynamo\\x.dyn", "//server/share/x.dyn", "\\\\?\\C:\\kit\\05_Scripts\\Dynamo\\x.dyn"]) {
      const r = graphFormSpec({ file: unc, kit: box.kit, documentPath: "", env: box.env });
      assert.equal(r.ok, false, unc);
      if (!r.ok) { assert.equal(r.code, "FMC-GRAPH-JAIL"); assert.match(r.message, /UNC/); }
    }
    const rel = graphFormSpec({ file: "05_Scripts/Dynamo/form_inputs.dyn", kit: box.kit, documentPath: "", env: box.env });
    assert.equal(rel.ok, false);
    // A junction (Windows) or symlink (POSIX) inside the drafts folder that points outside the project.
    const outside = path.join(box.base, "outside");
    fs.mkdirSync(outside);
    fs.copyFileSync(path.join(FIX, "form_inputs.dyn"), path.join(outside, "evil.dyn"));
    const link = path.join(box.drafts, "linked");
    fs.symlinkSync(outside, link, "junction");
    const viaLink = graphFormSpec({ file: path.join(link, "evil.dyn"), kit: box.kit, documentPath: box.documentPath, env: box.env });
    assert.equal(viaLink.ok, false);
    if (!viaLink.ok) { assert.equal(viaLink.code, "FMC-GRAPH-JAIL"); assert.match(viaLink.message, /link or junction/); }
    const direct = jailCheck(path.join(link, "evil.dyn"), box.drafts);
    assert.equal(direct.ok, false);
  } finally { box.done(); }
});

test("a graph outside the kit and the project drafts is refused", () => {
  const box = sandbox();
  try {
    const outside = path.join(box.base, "Downloads");
    fs.mkdirSync(outside);
    fs.copyFileSync(path.join(FIX, "form_inputs.dyn"), path.join(outside, "form_inputs.dyn"));
    const r = graphFormSpec({ file: path.join(outside, "form_inputs.dyn"), kit: box.kit, documentPath: box.documentPath, env: box.env });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.code, "FMC-GRAPH-JAIL"); assert.match(r.message, /outside the graph folders/); }
    // Another project's drafts folder is outside this document's jail too.
    const other = path.join(box.base, "F26002_Other", "00_Formcraft", "Graphs");
    fs.mkdirSync(other, { recursive: true });
    fs.copyFileSync(path.join(FIX, "form_inputs.dyn"), path.join(other, "x.dyn"));
    const r2 = graphFormSpec({ file: path.join(other, "x.dyn"), kit: box.kit, documentPath: box.documentPath, env: box.env });
    assert.equal(r2.ok, false);
  } finally { box.done(); }
});

test("a non-graph is refused: wrong extension, not JSON, missing file", () => {
  const box = sandbox();
  try {
    const txt = graphFormSpec({ file: path.join(box.dyn, "notes.txt"), kit: box.kit, documentPath: "", env: box.env });
    assert.equal(txt.ok, false);
    if (!txt.ok) assert.equal(txt.code, "FMC-GRAPH-NOT-GRAPH");
    const junk = graphFormSpec({ file: path.join(box.dyn, "not_a_graph.dyn"), kit: box.kit, documentPath: "", env: box.env });
    assert.equal(junk.ok, false);
    if (!junk.ok) assert.equal(junk.code, "FMC-GRAPH-NOT-GRAPH");
    const missing = graphFormSpec({ file: path.join(box.dyn, "nope.dyn"), kit: box.kit, documentPath: "", env: box.env });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "FMC-GRAPH-READ");
  } finally { box.done(); }
});

test("spec never writes: the kit folder is byte-for-byte the same afterwards", () => {
  const box = sandbox();
  try {
    const before = fs.readdirSync(box.dyn).map((name) => `${name}:${sha(path.join(box.dyn, name))}`).sort();
    graphFormSpec({ file: path.join(box.dyn, "FMC_ModelHealth.dyn"), kit: box.kit, documentPath: box.documentPath, env: box.env });
    graphFormSpec({ file: path.join(box.dyn, "form_inputs.dyn"), kit: box.kit, documentPath: box.documentPath, env: box.env });
    const after = fs.readdirSync(box.dyn).map((name) => `${name}:${sha(path.join(box.dyn, name))}`).sort();
    assert.deepEqual(after, before);
  } finally { box.done(); }
});

test("fmc_graph_form tool: spec reply over the kit, refusal is an error reply, values bind", async () => {
  const box = sandbox();
  const saved = process.env.FMC_KIT;
  process.env.FMC_KIT = box.kit;
  try {
    const { runFmcGraphForm } = await import("../../tools/fmc_graph_form.js");
    const ok = await runFmcGraphForm({ action: "spec", path: path.join(box.dyn, "form_inputs.dyn"), kit_folder: "", check_packages: false, values: { Count: 3 } });
    assert.equal(ok.isError, false);
    const body = JSON.parse(ok.content[0].text);
    assert.equal(body.action, "spec");
    assert.equal(body.binding.ok, true);
    assert.deepEqual(body.binding.inputs_by_id, { a1000000000000000000000000000001: 3 });
    const refused = await runFmcGraphForm({ action: "spec", path: "\\\\srv\\share\\x.dyn", kit_folder: "", check_packages: false });
    assert.equal(refused.isError, true);
    assert.equal(JSON.parse(refused.content[0].text).code, "FMC-GRAPH-JAIL");
  } finally {
    if (saved === undefined) delete process.env.FMC_KIT; else process.env.FMC_KIT = saved;
    box.done();
  }
});

test("a package that ships a DLL counts as Python for approval: a person approves every mode (Builder 6 checkPackages)", () => {
  const box = sandbox();
  try {
    const pkg = path.join(box.packages, "Clockwork for Dynamo 2.x");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "pkg.json"), JSON.stringify({ name: "Clockwork for Dynamo 2.x", version: "2.5.0" }));
    fs.writeFileSync(path.join(pkg, "bin", "Clockwork.dll"), "MZ");
    const result = graphFormSpec({ file: path.join(box.dyn, "form_inputs.dyn"), kit: box.kit, documentPath: "", env: box.env });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.spec.has_python, false);
    assert.equal(result.spec.package_check?.packages[0].status, "ok");
    assert.equal(result.spec.package_check?.packages[0].has_dll, true);
    assert.deepEqual(result.spec.approval.person_required_for, ["preview", "apply", "offline"]);
    assert.equal(result.spec.approval.kind_by_mode.apply, "graph_python");
  } finally { box.done(); }
});

test("D4 drafts folder and D1 python policy come from graph_tools.decisions in the guard config", () => {
  const box = sandbox();
  try {
    const other = path.join(box.project, "00_Formcraft", "GraphDrafts");
    fs.mkdirSync(other, { recursive: true });
    fs.copyFileSync(path.join(FIX, "python_string.dyn"), path.join(other, "py.dyn"));
    const cfg = { graph_tools: { decisions: { drafts_folder: "00_Formcraft\\GraphDrafts", python_policy: "off" } } };
    const r = graphFormSpec({ file: path.join(other, "py.dyn"), kit: box.kit, documentPath: box.documentPath, env: box.env, cfg });
    assert.equal(r.ok, true, r.ok ? "" : r.message);
    if (!r.ok) return;
    assert.equal(r.spec.graph.tier, "P");
    assert.equal(r.spec.lock, "draft");
    assert.equal(r.spec.python_policy, "off");
    assert.ok(r.spec.approval.why.some((w) => /FMC-GRAPH-PYTHON-OFF/.test(w)));
    const oldPlace = graphFormSpec({ file: path.join(box.drafts, "draft_form.dyn"), kit: box.kit, documentPath: box.documentPath, env: box.env, cfg });
    assert.equal(oldPlace.ok, false);
  } finally { box.done(); }
});
