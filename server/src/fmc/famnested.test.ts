import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FMC_FAM_NESTED_SHAPE, runFmcFamNested } from "../tools/fmc_fam_nested.js";
import { RUN_ID, Kit, callTool, done, fakeRevit, kit } from "./famedit_testkit.js";

const READ = {
  family: "FMC_Host", category: "Furniture",
  nested: [
    { id: 11, name: "leg_1", family: "Leg", type: "Round", category: "Furniture", shared: false, type_label: null,
      parameters: [{ name: "Length", spec: "autodesk.spec.aec:length-2.0.0", associated: null, can_associate: true }, { name: "Mark", spec: "autodesk.spec:string-2.0.0", associated: null, can_associate: true }] },
    { id: 12, name: "leg_2", family: "Leg", type: "Round", category: "Furniture", shared: false, type_label: "Leg Type", parameters: [] },
    { id: 13, name: "hinge", family: "Hinge", type: "Std", category: "Generic Models", shared: true, type_label: null, parameters: [] },
  ],
  families: [
    { name: "Leg", category: "Furniture", types: ["Round", "Square"], nested_count: 2 },
    { name: "Hinge", category: "Generic Models", shared: true, types: ["Std"], nested_count: 1 },
    { name: "Handle", category: "Furniture", types: ["Bar"], nested_count: 0 },
    { name: "Lamp", category: "Lighting Fixtures", types: ["A"], nested_count: 0 },
  ],
  host_parameters: [
    { name: "Leg_Length", spec: "autodesk.spec.aec:length-2.0.0", is_instance: false },
    { name: "Label", spec: "autodesk.spec:string-2.0.0", is_instance: true },
    { name: "Width", spec: "autodesk.spec.aec:length-2.0.0", is_instance: false, formula: "Leg_Length * 2" },
    { name: "Leg Type", spec: "autodesk.revit.category.family:furniture-1.0.0", family_type_category: "Furniture" },
  ],
};

async function call(k: Kit, args: Record<string, unknown>, rv = fakeRevit({ fmc_fam_nested_read: READ }), exists = (f: string) => fs.existsSync(f)) {
  const r = await callTool(FMC_FAM_NESTED_SHAPE, runFmcFamNested, { document: "FMC_Host.rfa", ...args }, { config: k.config, revit: rv.send, exists });
  return { ...r, rv };
}

test("read: lists instances, families and host parameters through the read path, with a run id", async () => {
  const k = kit();
  try {
    const r = await call(k, { action: "read" });
    assert.equal(r.isError, false);
    assert.match(r.body.run_id, RUN_ID);
    assert.equal(r.body.nested.length, 3);
    assert.ok(r.rv.calls.every((c) => c.command === "fmc_fam_nested_read" && c.dry === true && c.payload.document === "FMC_Host.rfa"));
  } finally { done(k); }
});

test("no document, or a project file, is refused before Revit is called", async () => {
  const k = kit();
  try {
    const none = await call(k, { action: "read", document: "" });
    assert.equal(none.isError, true);
    assert.match(none.body.reasons[0], /Name the family document/);
    const proj = await call(k, { action: "swap", document: "C:\\p\\A.rvt", nested: "Leg", to_family: "Leg", to_type: "Square" });
    assert.match(proj.body.reasons[0], /project file/);
    assert.equal(none.rv.calls.length + proj.rv.calls.length, 0);
  } finally { done(k); }
});

test("swap: the dry run goes through the read path as a dry run; a family name picks all its instances", async () => {
  const k = kit();
  try {
    const r = await call(k, { action: "swap", nested: "leg_1", to_family: "Leg", to_type: "Square" });
    assert.equal(r.isError, false);
    const sent = r.rv.applies()[0];
    assert.equal(sent.dry, true);
    assert.deepEqual([sent.payload.action, sent.payload.ids, sent.payload.to_type, sent.payload.dry_run], ["swap", [11], "Square", true]);
    assert.equal(sent.payload.run_id, r.body.run_id);
    assert.match(fs.readFileSync(k.log, "utf8"), new RegExp(`fam_nested_swap,true,FMC_Host.rfa,dry run,"?run ${r.body.run_id}`));
  } finally { done(k); }
});

test("swap: refused for a type the family lacks, another category, a driven type, an unknown instance, an unloaded family", async () => {
  const k = kit();
  try {
    const a = async (args: Record<string, unknown>) => (await call(k, { action: "swap", ...args })).body.reasons?.join(" | ") ?? "";
    assert.match(await a({ nested: "leg_1", to_family: "Leg", to_type: "Hex" }), /no type Hex/);
    assert.match(await a({ nested: "hinge", to_family: "Lamp", to_type: "A" }), /same category/);
    assert.match(await a({ nested: "leg_2", to_family: "Leg", to_type: "Square" }), /<Family Type> parameter Leg Type/);
    assert.match(await a({ nested: "ghost", to_family: "Leg", to_type: "Square" }), /No nested instance or family ghost/);
    assert.match(await a({ nested: "leg_1", to_family: "Nope", to_type: "A" }), /isn't loaded/);
    assert.match(await a({ to_family: "Leg", to_type: "Round" }), /needs nested/);
  } finally { done(k); }
});

test("swap with load_path: the file must be in the family roots and exist; then it is sent", async () => {
  const k = kit();
  try {
    const file = path.join(k.staging, "Nope.rfa");
    const missing = await call(k, { action: "swap", nested: "leg_1", to_family: "Nope", to_type: "A", load_path: file });
    assert.match(missing.body.reasons.join(" "), /No file/);
    fs.writeFileSync(file, "x");
    const outside = await call(k, { action: "swap", nested: "leg_1", to_family: "Nope", to_type: "A", load_path: path.join(k.root, "elsewhere", "Nope.rfa") }, undefined, () => true);
    assert.match(outside.body.reasons.join(" "), /isn't inside the family roots/);
    const ok = await call(k, { action: "swap", nested: "leg_1", to_family: "Nope", to_type: "A", load_path: file });
    assert.equal(ok.isError, false);
    assert.equal(ok.rv.applies()[0].payload.load_path, file);
  } finally { done(k); }
});

test("associate: matching data types go through; wrong type, missing parameter, family-type misuse, read-only are refused", async () => {
  const k = kit();
  try {
    const ok = await call(k, { action: "associate", nested: "leg_1", associate: { Length: "Leg_Length" } });
    assert.equal(ok.isError, false);
    assert.deepEqual(ok.rv.applies()[0].payload.associate, { Length: "Leg_Length" });
    const wrong = await call(k, { action: "associate", nested: "leg_1", associate: { Length: "Label" } });
    assert.match(wrong.body.reasons[0], /same data type/);
    const missing = await call(k, { action: "associate", nested: "leg_1", associate: { Length: "Nope" } });
    assert.match(missing.body.reasons[0], /no parameter Nope/);
    const ft = await call(k, { action: "associate", nested: "leg_1", associate: { Length: "Leg Type" } });
    assert.match(ft.body.reasons.join(" "), /<Family Type> parameter/);
    const notThere = await call(k, { action: "associate", nested: "leg_1", associate: { Colour: "Label" } });
    assert.match(notThere.body.reasons[0], /no instance parameter Colour/);
    const formula = await call(k, { action: "associate", nested: "leg_1", associate: { Length: "Width" } });
    assert.match(formula.body.warnings.join(" "), /has a formula/);
    assert.equal(formula.isError, false);
  } finally { done(k); }
});

test("associate type_parameter: existing <Family Type> of the right category, create, wrong category", async () => {
  const k = kit();
  try {
    const ok = await call(k, { action: "associate", nested: "leg_1", type_parameter: "Leg Type" });
    assert.equal(ok.isError, false);
    const noParam = await call(k, { action: "associate", nested: "leg_1", type_parameter: "Foot Type" });
    assert.match(noParam.body.reasons[0], /create_type_parameter=true/);
    const made = await call(k, { action: "associate", nested: "leg_1", type_parameter: "Foot Type", create_type_parameter: true, is_instance: true });
    assert.equal(made.isError, false);
    assert.deepEqual([made.rv.applies()[0].payload.create_type_parameter, made.rv.applies()[0].payload.is_instance], [true, true]);
    const wrong = await call(k, { action: "associate", nested: "hinge", type_parameter: "Leg Type" });
    assert.match(wrong.body.reasons.join(" "), /is a <Family Type> of Furniture/);
    const plain = await call(k, { action: "associate", nested: "leg_1", type_parameter: "Label" });
    assert.match(plain.body.reasons.join(" "), /isn't a <Family Type> parameter/);
    const many = await call(k, { action: "associate", nested: ["leg_1", "leg_2"], associate: { Length: "Leg_Length" } });
    assert.match(many.body.reasons.join(" "), /one nested instance at a time/);
  } finally { done(k); }
});

test("reload: the file is checked (roots, exists, same name), and a loaded family is required", async () => {
  const k = kit();
  try {
    const file = path.join(k.staging, "Leg.rfa");
    const missing = await call(k, { action: "reload", family: "Leg", path: file });
    assert.match(missing.body.reasons.join(" "), /No file/);
    fs.writeFileSync(file, "x");
    const ok = await call(k, { action: "reload", family: "Leg", path: file, overwrite_values: true });
    assert.equal(ok.isError, false);
    assert.deepEqual([ok.rv.applies()[0].payload.family, ok.rv.applies()[0].payload.overwrite_values], ["Leg", true]);
    const other = path.join(k.staging, "Leg_v2.rfa");
    fs.writeFileSync(other, "x");
    const renamed = await call(k, { action: "reload", family: "Leg", path: other });
    assert.match(renamed.body.reasons.join(" "), /second family, not a reload/);
    const unloaded = await call(k, { action: "reload", family: "Ghost", path: file });
    assert.match(unloaded.body.reasons.join(" "), /isn't loaded/);
    const notRfa = await call(k, { action: "reload", family: "Leg", path: path.join(k.staging, "Leg.rvt") });
    assert.match(notRfa.body.reasons.join(" "), /an \.rfa file/);
    assert.ok(Array.isArray(notRfa.body.family_roots));
  } finally { done(k); }
});

test("real run: dry_run=false needs confirm=true and a readable guard; with both it uses the write path and logs it", async () => {
  const k = kit();
  try {
    const rv = fakeRevit({ fmc_fam_nested_read: READ });
    const no = await call(k, { action: "swap", nested: "leg_1", to_family: "Leg", to_type: "Square", dry_run: false }, rv);
    assert.match(no.body.reasons[0], /confirm=true/);
    k.config.problem = "The guard config isn't readable";
    const bad = await call(k, { action: "swap", nested: "leg_1", to_family: "Leg", to_type: "Square", dry_run: false, confirm: true }, rv);
    assert.ok(bad.body.reasons.includes("The guard config isn't readable"));
    assert.equal(rv.applies().length, 0);
    k.config.problem = "";
    const yes = await call(k, { action: "swap", nested: "leg_1", to_family: "Leg", to_type: "Square", dry_run: false, confirm: true }, rv);
    assert.equal(yes.isError, false);
    assert.equal(rv.applies()[0].dry, false);
    assert.equal(rv.applies()[0].payload.dry_run, false);
    assert.match(fs.readFileSync(k.log, "utf8"), /fam_nested_swap,false,FMC_Host.rfa,done/);
  } finally { done(k); }
});

test("a failed step in the add-in comes back as an error, rolled back, and is logged as rolled back", async () => {
  const k = kit();
  try {
    const rv = fakeRevit({ fmc_fam_nested_read: READ }, () => ({ failed: true, rolled_back: true, results: [{ error: "Revit refused" }] }));
    const r = await call(k, { action: "swap", nested: "leg_1", to_family: "Leg", to_type: "Square", dry_run: false, confirm: true }, rv);
    assert.equal(r.isError, true);
    assert.match(r.body.next, /nothing was kept/);
    assert.match(fs.readFileSync(k.log, "utf8"), /rolled back/);
  } finally { done(k); }
});
