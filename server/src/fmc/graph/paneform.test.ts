import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { graphFormSpec, type GraphFormSpec } from "./form.js";
import { approvalStep, paneForm, planRequest, runCheck, valuesFromPane } from "./paneform.js";
import { buildPlan, type GraphPlan } from "./plan.js";
import { decideGraphApproval, readGraphApproval, requestGraphApproval } from "./approvals.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, "../../../src/fmc/fixtures/graph_form");

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fmc-pane-form-")));
  const kit = path.join(base, "kit");
  const dyn = path.join(kit, "05_Scripts", "Dynamo");
  fs.mkdirSync(dyn, { recursive: true });
  for (const name of ["FMC_ModelHealth.dyn", "form_inputs.dyn", "python_string.dyn"]) fs.copyFileSync(path.join(FIX, name), path.join(dyn, name));
  const packages = path.join(base, "packages");
  fs.mkdirSync(packages);
  const approvals = path.join(base, "approvals");
  const env = { FMC_DYNAMO_PACKAGE_DIRS: packages, LOCALAPPDATA: path.join(base, "local"), FMC_GRAPH_APPROVALS: approvals } as NodeJS.ProcessEnv;
  return { base, kit, dyn, packages, env, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function specOf(box: ReturnType<typeof sandbox>, name: string): GraphFormSpec {
  const r = graphFormSpec({ file: path.join(box.dyn, name), kit: box.kit, documentPath: "", env: box.env });
  assert.equal(r.ok, true, r.ok ? "" : r.message);
  if (!r.ok) throw new Error("spec refused");
  return r.spec;
}

function realPlan(box: ReturnType<typeof sandbox>, spec: GraphFormSpec, texts: Record<string, string>, mode: "preview" | "apply" | "offline"): GraphPlan {
  const req = planRequest(spec, texts, mode);
  assert.equal(req.ok, true, req.ok ? "" : req.message);
  if (!req.ok) throw new Error("bind refused");
  const planned = buildPlan({ file: req.request.args.path, inputs: req.request.args.inputs, mode, document: null, kit: box.kit, cfg: {} as never, env: box.env, packageDirs: [box.packages] });
  assert.equal(planned.ok, true, planned.ok ? "" : planned.message);
  if (!planned.ok) throw new Error("plan refused");
  return planned.plan;
}

test("form rendering model: controls by widget with values, rules, options, disabled element picker without a model", () => {
  const box = sandbox();
  try {
    const form = paneForm(specOf(box, "form_inputs.dyn"), { documentOpen: false });
    const by = Object.fromEntries(form.controls.map((c) => [c.label, c]));
    assert.deepEqual([by["Count"].control, by["Count"].value, by["Count"].min, by["Count"].max, by["Count"].step, by["Count"].rule], ["slider", "4", 1, 10, 1, "whole number, 1 to 10, step 1"]);
    assert.deepEqual([by["Dry run only"].control, by["Dry run only"].value], ["toggle", "true"]);
    assert.deepEqual([by["Mode"].control, by["Mode"].options, by["Mode"].value], ["choice", ["Fast", "Full"], "Full"]);
    assert.equal(by["Room list CSV"].control, "file");
    assert.equal(by["Output folder"].control, "folder");
    assert.deepEqual([by["Pick a wall"].control, by["Pick a wall"].disabled], ["element", true]);
    assert.match(by["Pick a wall"].disabled_why, /Open the model/);
    assert.equal(by["Category"].control, "text");
    assert.match(by["Category"].rule, /open model/);
    assert.deepEqual(form.outputs, ["Result", "Sum"]);
    assert.deepEqual(form.person_required_for, ["apply", "offline"]);
    assert.ok(form.banners.some((b) => /needs the open model/.test(b.text)));
    const open = paneForm(specOf(box, "form_inputs.dyn"), { documentOpen: true });
    assert.equal(open.controls.find((c) => c.label === "Pick a wall")?.disabled, false);
    const py = paneForm(specOf(box, "FMC_ModelHealth.dyn"), { documentOpen: true });
    assert.equal(py.banners[0].kind, "warn");
    assert.match(py.banners[0].text, /Python\. A person approves every run/);
    assert.deepEqual(py.person_required_for, ["preview", "apply", "offline"]);
  } finally { box.done(); }
});

test("binding errors: bad number, out of range, not in list, element typed; blank keeps the saved value", () => {
  const box = sandbox();
  try {
    const spec = specOf(box, "form_inputs.dyn");
    const id = (label: string) => spec.fields.find((f) => f.name === label)!.id;
    const typed = valuesFromPane(spec, { [id("Count")]: "abc", [id("Dry run only")]: "maybe", [id("Mode")]: "Slow", [id("Pick a wall")]: "123" });
    assert.equal(typed.problems.length, 4);
    const range = planRequest(spec, { [id("Count")]: "11" }, "preview");
    assert.equal(range.ok, false);
    if (!range.ok) { assert.equal(range.code, "FMC-GRAPH-FORM-INPUT"); assert.match(range.message, /above 10/); }
    const slider = planRequest(spec, { [id("Offset (m)")]: "0,2" }, "preview");
    assert.equal(slider.ok, false);
    if (!slider.ok) assert.match(slider.message, /below 0\.5/);
    const blank = planRequest(spec, { [id("Count")]: "", [id("Level name")]: "  " }, "preview");
    assert.equal(blank.ok, true);
    if (blank.ok) assert.deepEqual(blank.request.args.inputs, {});
  } finally { box.done(); }
});

test("plan request shape: fmc_dynamo plan, inputs by node id, the mode; Builder 6 buildPlan accepts it", () => {
  const box = sandbox();
  try {
    const spec = specOf(box, "form_inputs.dyn");
    const id = (label: string) => spec.fields.find((f) => f.name === label)!.id;
    const req = planRequest(spec, { [id("Count")]: "7", [id("Mode")]: "Fast", [id("Dry run only")]: "off", [id("Level name")]: "L2" }, "apply");
    assert.equal(req.ok, true);
    if (!req.ok) return;
    assert.deepEqual(req.request, {
      tool: "fmc_dynamo",
      args: { action: "plan", path: path.join(box.dyn, "form_inputs.dyn"), mode: "apply",
        inputs: { [id("Count")]: 7, [id("Mode")]: "fast", [id("Dry run only")]: false, [id("Level name")]: "L2" } },
    });
    assert.deepEqual(req.binding.map((b) => b.name).sort(), ["Count", "Dry run only", "Level name", "Mode"]);
    const plan = realPlan(box, spec, { [id("Count")]: "7" }, "apply");
    assert.match(plan.plan_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(plan.inputs_by_id, { [id("Count")]: 7 });
  } finally { box.done(); }
});

test("apply needs a person's approval: approval step asks; run refused until a person approves this plan_hash; single use", () => {
  const box = sandbox();
  try {
    const spec = specOf(box, "form_inputs.dyn");
    const preview = realPlan(box, spec, {}, "preview");
    const previewStep = approvalStep(preview, "");
    assert.equal(previewStep.needs_approval, false);
    assert.equal(previewStep.request_approval, null);
    assert.equal(runCheck(preview, null).ok, true);
    const apply = realPlan(box, spec, {}, "apply");
    const step = approvalStep(apply, "Set the counts");
    assert.equal(step.needs_approval, true);
    assert.deepEqual(step.decide_via, ["graph_approve", "graph_refuse"]);
    assert.deepEqual(step.request_approval?.args, { action: "request_approval", path: apply.graph, inputs: apply.inputs_by_id, mode: "apply", reason: "Set the counts" });
    const none = runCheck(apply, null);
    assert.equal(none.ok, false);
    if (!none.ok) assert.equal(none.code, "FMC-GRAPH-APPROVAL-NEEDED");
    const item = requestGraphApproval({ kind: apply.approval_kind, plan: apply, reason: "Set the counts", requested_by: "pane" }, box.env);
    const pending = runCheck(apply, readGraphApproval(item.id, box.env));
    assert.equal(pending.ok, false);
    if (!pending.ok) assert.equal(pending.code, "FMC-GRAPH-APPROVAL-PENDING");
    const decided = decideGraphApproval(item.id, "approved", "emlyn", box.env);
    assert.equal(decided.ok, true);
    const go = runCheck(apply, readGraphApproval(item.id, box.env));
    assert.equal(go.ok, true);
    if (go.ok) assert.deepEqual(go.request.args, { action: "run", path: apply.graph, inputs: apply.inputs_by_id, mode: "apply", approval_id: item.id });
    const other = realPlan(box, spec, { [spec.fields[0].id]: "9" }, "apply");
    const mismatch = runCheck(other, readGraphApproval(item.id, box.env));
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.code, "FMC-GRAPH-APPROVAL-MISMATCH");
    const used = runCheck(apply, { ...readGraphApproval(item.id, box.env)!, status: "used" });
    assert.equal(used.ok, false);
    if (!used.ok) assert.equal(used.code, "FMC-GRAPH-APPROVAL-USED");
    const late = runCheck(apply, readGraphApproval(item.id, box.env), new Date(Date.now() + 31 * 60 * 1000));
    assert.equal(late.ok, false);
  } finally { box.done(); }
});

test("Python refused without a person: even preview needs approval; a refused or auto approval never runs", () => {
  const box = sandbox();
  try {
    const spec = specOf(box, "FMC_ModelHealth.dyn");
    const plan = realPlan(box, spec, {}, "preview");
    assert.equal(plan.python, true);
    const step = approvalStep(plan, "");
    assert.equal(step.needs_approval, true);
    assert.equal(step.kind, "graph_python");
    const none = runCheck(plan, null);
    assert.equal(none.ok, false);
    if (!none.ok) assert.match(none.message, /Python: a person must approve/);
    const item = requestGraphApproval({ kind: plan.approval_kind, plan, requested_by: "pane" }, box.env);
    const auto = runCheck(plan, { ...readGraphApproval(item.id, box.env)!, status: "approved", decided_by: "auto_approve" });
    assert.equal(auto.ok, false);
    if (!auto.ok) assert.equal(auto.code, "FMC-GRAPH-APPROVAL-AUTO");
    decideGraphApproval(item.id, "refused", "emlyn", box.env);
    const refused = runCheck(plan, readGraphApproval(item.id, box.env));
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "FMC-GRAPH-APPROVAL-REFUSED");
    // Even a plan object that claims no approval is needed is refused when it has Python.
    const forged = runCheck({ ...plan, needs_approval: false }, null);
    assert.equal(forged.ok, false);
  } finally { box.done(); }
});

test("fmc_graph_form tool: form, bind, approval and run_check actions", async () => {
  const box = sandbox();
  const saved = { kit: process.env.FMC_KIT, ap: process.env.FMC_GRAPH_APPROVALS };
  process.env.FMC_KIT = box.kit;
  process.env.FMC_GRAPH_APPROVALS = box.env.FMC_GRAPH_APPROVALS;
  try {
    const { runFmcGraphForm } = await import("../../tools/fmc_graph_form.js");
    const file = path.join(box.dyn, "form_inputs.dyn");
    const base = { kit_folder: "", reason: "", approval_id: "", mode: "preview" as const, check_packages: false };
    const form = JSON.parse((await runFmcGraphForm({ ...base, action: "form", path: file })).content[0].text);
    assert.equal(form.form.controls.length, 9);
    const countId = form.form.controls.find((c: { label: string }) => c.label === "Count").id;
    const bind = await runFmcGraphForm({ ...base, action: "bind", path: file, mode: "apply", texts: { [countId]: "12" } });
    assert.equal(bind.isError, true);
    const ok = JSON.parse((await runFmcGraphForm({ ...base, action: "bind", path: file, mode: "apply", texts: { [countId]: "3" } })).content[0].text);
    assert.equal(ok.request.args.action, "plan");
    const spec = specOf(box, "form_inputs.dyn");
    const plan = realPlan(box, spec, { [countId]: "3" }, "apply");
    const step = JSON.parse((await runFmcGraphForm({ ...base, action: "approval", path: "", plan: plan as unknown as Record<string, unknown> })).content[0].text);
    assert.equal(step.needs_approval, true);
    const check = await runFmcGraphForm({ ...base, action: "run_check", path: "", plan: plan as unknown as Record<string, unknown> });
    assert.equal(check.isError, true);
    assert.equal(JSON.parse(check.content[0].text).code, "FMC-GRAPH-APPROVAL-NEEDED");
    const missing = await runFmcGraphForm({ ...base, action: "run_check", path: "", approval_id: "0000000000000000", plan: plan as unknown as Record<string, unknown> });
    assert.equal(JSON.parse(missing.content[0].text).code, "FMC-GRAPH-APPROVAL-NOT-FOUND");
  } finally {
    if (saved.kit === undefined) delete process.env.FMC_KIT; else process.env.FMC_KIT = saved.kit;
    if (saved.ap === undefined) delete process.env.FMC_GRAPH_APPROVALS; else process.env.FMC_GRAPH_APPROVALS = saved.ap;
    box.done();
  }
});
