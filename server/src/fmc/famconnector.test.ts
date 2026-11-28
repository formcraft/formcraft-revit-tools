import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FMC_FAM_CONNECTOR_SHAPE, runFmcFamConnector } from "../tools/fmc_fam_connector.js";
import { checkConnector, validateConnectors, type FamilyConnectors } from "./famconn_rules.js";
import { RUN_ID, Kit, callTool, done, fakeRevit, kit } from "./famedit_testkit.js";

const LEN = "autodesk.spec.aec:length-2.0.0";
const PARAMS = [{ name: "Duct_Dia", spec: LEN }, { name: "Duct_W", spec: LEN }, { name: "Duct_H", spec: LEN }, { name: "Flow", spec: "autodesk.spec.aec:airFlow-2.0.0" },
  { name: "Volts", spec: "autodesk.spec.aec:electricalPotential-2.0.0" }, { name: "Label", spec: "autodesk.spec:string-2.0.0" }, { name: "Pipe_Dia", spec: LEN }];
const FAM = (over: Partial<FamilyConnectors> = {}): FamilyConnectors => ({
  family: "FMC_Diffuser", category: "Air Terminals", parameters: PARAMS,
  connectors: [
    { id: 1, name: "supply", domain: "duct", system: "SupplyAir", shape: "round", flow_direction: "In", is_primary: true, associations: { diameter: "Duct_Dia", duct_flow: "Flow" } },
    { id: 2, name: "power", domain: "electrical", system: "PowerBalanced", shape: null, flow_direction: null, associations: { voltage: "Volts" } },
  ], ...over,
});

async function call(k: Kit, fam: FamilyConnectors, args: Record<string, unknown>) {
  const rv = fakeRevit({ fmc_fam_connector_read: fam });
  const r = await callTool(FMC_FAM_CONNECTOR_SHAPE, runFmcFamConnector, { document: "FMC_Diffuser.rfa", ...args }, { config: k.config, revit: rv.send });
  return { ...r, rv };
}

test("read: connectors and parameters through the read path, with a run id", async () => {
  const k = kit();
  try {
    const r = await call(k, FAM(), { action: "read" });
    assert.match(r.body.run_id, RUN_ID);
    assert.equal(r.body.connectors.length, 2);
    assert.deepEqual(r.rv.calls.map((c) => [c.command, c.dry]), [["fmc_fam_connector_read", true]]);
  } finally { done(k); }
});

test("validate: a good family is ok; the report has domain, system, flow direction and size associations per connector", async () => {
  const k = kit();
  try {
    const r = await call(k, FAM(), { action: "validate" });
    assert.equal(r.isError, false);
    assert.equal(r.body.ok, true);
    const c = r.body.connectors[0];
    assert.deepEqual([c.domain, c.system, c.flow_direction, c.shape, c.associations.diameter], ["duct", "SupplyAir", "In", "round", "Duct_Dia"]);
    assert.match(fs.readFileSync(k.log, "utf8"), /fam_connector_validate,true,FMC_Diffuser.rfa,valid/);
  } finally { done(k); }
});

test("validate: each invalid combination is an error with a clear reason", () => {
  const e = (c: object, cat = "Air Terminals") => checkConnector({ id: 9, name: "c", domain: "duct", associations: {}, ...c } as any, PARAMS, cat).errors.join(" | ");
  assert.match(e({ system: "SupplyAir", flow_direction: "In", shape: "round", domain: "electrical" }), /flow direction is only for duct and pipe/);
  assert.match(e({ system: "PowerBalanced", shape: "round" }), /isn't a duct system/);
  assert.match(e({ system: "" }), /needs a system classification/);
  assert.match(e({ system: "Fitting", shape: "round" }), /for fittings and accessories/);
  assert.equal(e({ system: "Fitting", shape: "round" }, "Duct Fittings"), "");
  assert.match(e({ system: "SupplyAir", flow_direction: "Sideways", shape: "round" }), /isn't In, Out or Bidirectional/);
  assert.match(e({ system: "SupplyAir", domain: "pipe", shape: "rectangular" }), /isn't a pipe system|pipe connector is round/);
  assert.match(e({ system: "SupplyAir", shape: "round", associations: { width: "Duct_W" } }), /Width doesn't apply to a round connector/);
  assert.match(e({ system: "SupplyAir", shape: "round", associations: { diameter: "Label" } }), /Diameter needs a length parameter; Label is autodesk.spec:string/);
  assert.match(e({ system: "SupplyAir", shape: "round", associations: { diameter: "Nope" } }), /which the family doesn't have/);
  assert.match(e({ system: "SupplyAir", shape: "round", associations: { voltage: "Volts" } }), /isn't a duct connector parameter/);
  assert.match(e({ system: "SupplyAir", shape: "round", associations: { diameter: "Duct_Dia", radius: "Duct_W" } }), /both associated/);
  assert.match(e({ system: "SupplyAir", shape: "round", associations: { colour: "Label" } }), /isn't a connector parameter the tool knows/);
  assert.match(e({ domain: "cable_tray", system: "SupplyAir", shape: "rectangular" }), /has no system classification/);
  assert.match(e({ domain: "bogus" }), /isn't one of duct/);
});

test("validate: warnings for undriven sizes, no flow direction, no primary; errors for two primaries and links across domains", () => {
  const f = FAM({ connectors: [
    { id: 1, name: "a", domain: "duct", system: "SupplyAir", shape: "round", flow_direction: null, associations: {} },
    { id: 2, name: "b", domain: "duct", system: "ReturnAir", shape: "rectangular", flow_direction: "Out", associations: { width: "Duct_W" }, linked_to: 3 },
    { id: 3, name: "c", domain: "pipe", system: "DomesticColdWater", shape: "round", flow_direction: "In", associations: { diameter: "Pipe_Dia" } },
  ] });
  const v = validateConnectors(f);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /linked across domains/);
  assert.match(v.warnings.join(" "), /no flow direction set/);
  assert.match(v.warnings.join(" "), /diameter isn't driven/);
  assert.match(v.warnings.join(" "), /width and height aren't both driven/);
  assert.match(v.warnings.join(" "), /2 duct connectors and none is primary/);
  const two = validateConnectors(FAM({ connectors: FAM().connectors.map((c) => ({ ...c, is_primary: true, id: c.id })).concat([{ id: 7, name: "supply2", domain: "duct", system: "SupplyAir", shape: "round", flow_direction: "In", is_primary: true, associations: { diameter: "Duct_Dia" } }]) }));
  assert.match(two.errors.join(" "), /2 primary duct connectors/);
  assert.match(validateConnectors(FAM({ connectors: [] })).warnings.join(" "), /no connectors/);
});

test("set: a valid change is sent as a dry run through the read path; the associate map carries Revit's parameter name", async () => {
  const k = kit();
  try {
    const r = await call(k, FAM(), { action: "set", connector: "supply", flow_direction: "Out", associate: { duct_flow: "Flow", diameter: null } });
    assert.equal(r.isError, false);
    const sent = r.rv.applies()[0];
    assert.equal(sent.dry, true);
    assert.deepEqual([sent.payload.action, sent.payload.connector, sent.payload.flow_direction], ["set", 1, "Out"]);
    assert.deepEqual(sent.payload.associate.duct_flow, { revit: "Duct Flow", param: "Flow" });
    assert.deepEqual(sent.payload.associate.diameter, { revit: "Diameter", param: null });
  } finally { done(k); }
});

test("set: an invalid combination is refused with the reasons before Revit is called", async () => {
  const k = kit();
  try {
    const flow = await call(k, FAM(), { action: "set", connector: 2, flow_direction: "In" });
    assert.equal(flow.isError, true);
    assert.match(flow.body.reasons.join(" "), /flow direction is only for duct and pipe/);
    const sys = await call(k, FAM(), { action: "set", connector: "supply", system: "DomesticColdWater" });
    assert.match(sys.body.reasons.join(" "), /isn't a duct system/);
    const type = await call(k, FAM(), { action: "set", connector: "supply", associate: { diameter: "Label" } });
    assert.match(type.body.reasons.join(" "), /needs a length parameter/);
    const ghost = await call(k, FAM(), { action: "set", connector: "ghost", system: "SupplyAir" });
    assert.match(ghost.body.reasons[0], /No connector ghost/);
    const empty = await call(k, FAM(), { action: "set", connector: "supply" });
    assert.match(empty.body.reasons[0], /needs system, flow_direction or associate/);
    assert.equal([flow, sys, type, ghost, empty].reduce((n, r) => n + r.rv.applies().length, 0), 0);
    assert.match(fs.readFileSync(k.log, "utf8"), /fam_connector_set,true,FMC_Diffuser.rfa,refused/);
  } finally { done(k); }
});

test("add: needs domain, a host and the size its shape needs; round vs rectangular; duplicate name refused", async () => {
  const k = kit();
  try {
    const host = { solid: "Body", side: "top" };
    const ok = await call(k, FAM(), { action: "add", name: "return", domain: "duct", system: "ReturnAir", shape: "rectangular", size: { width: 300, height: 200 }, flow_direction: "Out", host, associate: { width: "Duct_W", height: "Duct_H" } });
    assert.equal(ok.isError, false);
    assert.deepEqual([ok.rv.applies()[0].payload.action, ok.rv.applies()[0].payload.size, ok.rv.applies()[0].payload.host], ["add", { width: 300, height: 200 }, host]);
    const noSize = await call(k, FAM(), { action: "add", name: "x", domain: "duct", system: "SupplyAir", flow_direction: "In", host });
    assert.match(noSize.body.reasons.join(" "), /needs size.diameter/);
    const wrongSize = await call(k, FAM(), { action: "add", name: "x", domain: "duct", system: "SupplyAir", flow_direction: "In", host, size: { diameter: 100, width: 5 } });
    assert.match(wrongSize.body.reasons.join(" "), /takes size.diameter, not width or height/);
    const noHost = await call(k, FAM(), { action: "add", name: "x", domain: "duct", system: "SupplyAir", size: { diameter: 100 }, flow_direction: "In" });
    assert.match(noHost.body.reasons.join(" "), /needs host/);
    const dup = await call(k, FAM(), { action: "add", name: "supply", domain: "duct", system: "SupplyAir", size: { diameter: 100 }, flow_direction: "In", host });
    assert.match(dup.body.reasons.join(" "), /already has a connector named supply/);
    const elec = await call(k, FAM(), { action: "add", name: "p2", domain: "electrical", system: "PowerBalanced", size: { diameter: 5 }, host });
    assert.match(elec.body.reasons.join(" "), /electrical connector has no size/);
    const badSys = await call(k, FAM(), { action: "add", name: "p3", domain: "electrical", system: "SupplyAir", host });
    assert.match(badSys.body.reasons.join(" "), /isn't a electrical system/);
    const noDomain = await call(k, FAM(), { action: "add", name: "p4", host });
    assert.match(noDomain.body.reasons.join(" "), /needs a domain/);
  } finally { done(k); }
});

test("add: a cable tray connector is rectangular and takes no system; pipe takes a diameter", async () => {
  const k = kit();
  try {
    const host = { element_id: 42, side: "front" };
    const tray = await call(k, FAM(), { action: "add", name: "t", domain: "cable_tray", size: { width: 200, height: 50 }, host });
    assert.equal(tray.isError, false);
    const pipe = await call(k, FAM(), { action: "add", name: "w", domain: "pipe", system: "DomesticColdWater", flow_direction: "In", size: { diameter: 20 }, host, associate: { diameter: "Pipe_Dia" } });
    assert.equal(pipe.isError, false);
    assert.equal(pipe.rv.applies()[0].payload.host.element_id, 42);
  } finally { done(k); }
});

test("real run: dry_run=false needs confirm=true; with it the write path is used, and a rolled-back result is an error", async () => {
  const k = kit();
  try {
    const args = { action: "set", connector: "supply", flow_direction: "Out", dry_run: false };
    const no = await call(k, FAM(), args);
    assert.match(no.body.reasons[0], /confirm=true/);
    assert.equal(no.rv.applies().length, 0);
    const yes = await call(k, FAM(), { ...args, confirm: true });
    assert.equal(yes.isError, false);
    assert.equal(yes.rv.applies()[0].dry, false);
    assert.match(fs.readFileSync(k.log, "utf8"), /fam_connector_set,false,FMC_Diffuser.rfa,done/);
    const rv = fakeRevit({ fmc_fam_connector_read: FAM() }, () => ({ failed: true, rolled_back: true, results: [{ error: "Revit refused" }] }));
    const bad = await callTool(FMC_FAM_CONNECTOR_SHAPE, runFmcFamConnector, { document: "F.rfa", ...args, confirm: true }, { config: k.config, revit: rv.send });
    assert.equal(bad.isError, true);
  } finally { done(k); }
});

test("no document and project files are refused; every refusal still carries a run id", async () => {
  const k = kit();
  try {
    const r = await call(k, FAM(), { action: "validate", document: "" });
    assert.equal(r.isError, true);
    assert.match(r.body.run_id, RUN_ID);
    assert.equal(r.rv.calls.length, 0);
  } finally { done(k); }
});
