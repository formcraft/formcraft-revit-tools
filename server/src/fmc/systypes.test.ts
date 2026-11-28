import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_NEEDS_PERSON, CODE_PLAN_ONLY_TYPES, deletesTypes, typeBatchRefusal, wireParams } from "./systypes.js";
import { MODEL_EDIT_OPS, MODIFY_MODEL_DESCRIPTION } from "../tools/modify_element.js";
import { typeEdits } from "./explain.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8");
const between = (s: string, a: string, b: string) => { const i = s.indexOf(a); assert.ok(i >= 0, a); const j = s.indexOf(b, i + a.length); assert.ok(j > i, b); return s.slice(i, j); };

test("delete_type is refused for the AI unless only planned", () => {
  const r = typeBatchRefusal([{ op: "edit_type" }, { op: "delete_type", type: 5 }], false);
  assert.equal(r?.code, CODE_NEEDS_PERSON);
  assert.deepEqual(r?.ops, [2]);
  assert.equal(typeBatchRefusal([{ op: "delete_type", type: 5 }], true), null);
  assert.equal(deletesTypes({ ops: [{ op: "delete_type" }], dry_run: true }), true, "a transaction dry run of delete_type is refused too");
  assert.equal(deletesTypes({ ops: [{ op: "delete_type" }], plan_only: true }), false);
});

test("plan_only takes type ops only, set_param only on the type", () => {
  assert.equal(typeBatchRefusal([{ op: "edit_type" }, { op: "duplicate_type" }, { op: "set_param", on_type: true }], true), null);
  const r = typeBatchRefusal([{ op: "move" }, { op: "set_param" }], true);
  assert.equal(r?.code, CODE_PLAN_ONLY_TYPES);
  assert.deepEqual(r?.ops, [1, 2]);
});

test("plan_only goes to Revit as a dry run with plan_only, never a real run", () => {
  assert.deepEqual(wireParams([{ op: "edit_type" }], false, true), { ops: [{ op: "edit_type" }], dry_run: true, plan_only: true });
  assert.deepEqual(wireParams([{ op: "edit_type" }], false, false, "w"), { ops: [{ op: "edit_type" }], dry_run: false, why: "w" });
});

test("modify_model lists the editor ops and documents plan_only and the person rule", () => {
  assert.ok(MODEL_EDIT_OPS.includes("edit_type" as any) && MODEL_EDIT_OPS.includes("delete_type" as any));
  assert.match(MODIFY_MODEL_DESCRIPTION, /plan_only/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /FMC-NEEDS-PERSON/);
  assert.match(MODIFY_MODEL_DESCRIPTION, /Type definitions only/);
  const tool = between(read("server", "src", "tools", "modify_element.ts"), '"modify_model",', "server.tool(");
  assert.match(tool, /sendCommand\("fmc_model_edit"/);
  assert.doesNotMatch(tool, /sendRaw/);
  assert.match(tool, /typeBatchRefusal\(/);
});

test("the approval line names the edit groups", () => {
  assert.equal(typeEdits({ layers: [{ material: "Concrete", width_mm: 200 }], stair: {} }), "layers Concrete 200 mm; stair");
  assert.equal(typeEdits({}), "nothing");
});

test("the AI gate refuses a real delete_type before anything else", () => {
  const gate = read("server", "src", "fmc", "aigate.ts");
  const at = gate.indexOf("deletesTypes(params)");
  assert.ok(at > 0 && at < gate.indexOf("const dryRun = command"));
});

test("plan_only starts no transaction of any kind (no borrowing on a workshared local)", () => {
  const types = read("commandset", "Services", "Fmc", "FmcModelTypes.cs");
  const plan = between(types, "private JObject PlanOnly(", "// ---------------- real runs");
  assert.doesNotMatch(plan, /Transaction/);
  assert.doesNotMatch(plan, /SetCompoundStructure|\.Duplicate\(|\.Delete\(/);
  // Step opens a SubTransaction only when apply is true; plan mode returns before it
  const step = between(types, "private static void Step(", "// ---------------- compound layers");
  assert.ok(step.indexOf("if (!apply)") < step.indexOf("new SubTransaction"));
  assert.ok(step.indexOf("return;") < step.indexOf("new SubTransaction"));
  // The one model write in the layer edit is guarded by apply
  assert.match(types, /if \(summary\.Value<bool>\("ok"\) && apply\) host\.SetCompoundStructure\(cs\);/);
  assert.equal(types.split("SetCompoundStructure(").length - 1, 1);
  // The add-in takes plan_only before the transaction group exists
  const edit = read("commandset", "Services", "Fmc", "FmcModelEdit.cs");
  assert.ok(edit.indexOf('Parameters.Value<bool?>("plan_only")') < edit.indexOf("new TransactionGroup(doc"));
});

test("every MEP and stair write sits behind apply", () => {
  const mep = read("commandset", "Services", "Fmc", "FmcModelTypesMep.cs");
  const types = read("commandset", "Services", "Fmc", "FmcModelTypes.cs");
  // Writers called from the edit code: each call must sit on an "apply" line. Their own bodies are the helpers below.
  const writes = /rpm\.(AddRule|RemoveRule)\(|rpm\.PreferredJunctionType = |seg\.(AddSize|RemoveSize)\(|SetTrayRole\(|SetFittingParam\(|AddRuleNow\(|SetLength\(|SetRef\(st|rt\.MaterialId = |lt\.Thickness = |st\.MiddleSupportsNumber = /;
  const helper = /private static (void|bool) (SetLength|SetRef|SetTrayRole|SetFittingParam|AddRuleNow)\(/;
  for (const line of [...mep.split(/\r?\n/), ...types.split(/\r?\n/)]) {
    if (!writes.test(line) || helper.test(line)) continue;
    assert.match(line, /apply/, `unguarded write: ${line.trim()}`);
  }
});

test("MEP type code stays on the type: it makes, routes or resizes no run", () => {
  const mep = read("commandset", "Services", "Fmc", "FmcModelTypesMep.cs");
  assert.doesNotMatch(mep, /Pipe\.Create|Duct\.Create|CableTray\.Create|NewElbowFitting|NewTeeFitting|ConnectTo\(|RBS_PIPE_DIAMETER_PARAM|RBS_CURVE_WIDTH_PARAM|ChangeTypeId/);
});

test("delete never takes a type, and delete_type always needs a person", () => {
  const edit = read("commandset", "Services", "Fmc", "FmcModelEdit.cs");
  const del = between(edit, 'case "delete":', "doc.Delete(ids)");
  assert.match(del, /is ElementType/);
  assert.match(del, /CodeNeedsPerson/);
  const types = read("commandset", "Services", "Fmc", "FmcModelTypes.cs");
  const run = between(types, "private JObject TypeEdit(", "private static string DeleteRefusal");
  assert.ok(run.indexOf('name == "delete_type"') < run.indexOf("Duplicate("));
  assert.doesNotMatch(types, /doc\.Delete\(/);
});

test("line and surface creation never fall back to the first type or ignore thickness", () => {
  for (const f of ["CreateLineElementEventHandler.cs", "CreateSurfaceElementEventHandler.cs"]) {
    const src = read("commandset", "Services", f);
    assert.match(src, /TypeEditCore\.PickType\(/, f);
    assert.doesNotMatch(src, /Defaulted to/, f);
    assert.doesNotMatch(src, /CreateOrGet\w+Type\(Document/, f);
    assert.doesNotMatch(src, /\.FirstOrDefault\(\);/, f);
    assert.match(src, /Items = _items/, f);
  }
});
