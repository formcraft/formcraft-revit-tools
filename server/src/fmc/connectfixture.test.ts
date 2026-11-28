import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WRITE_COMMANDS } from "./policy.js";
import { screenScript } from "./scriptguard.js";
import { chooseFixtureConnector, FIXTURE_CASES, fixtureConnectCall, systemChoice, type ConnectorFact } from "./connectfixture.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const basin: ConnectorFact[] = [
  { system: "DomesticColdWater", distanceMm: 800 },
  { system: "DomesticHotWater", distanceMm: 820 },
  { system: "Sanitary", distanceMm: 400 },
];
const wc: ConnectorFact[] = [
  { system: "DomesticColdWater", distanceMm: 600 },
  { system: "Sanitary", distanceMm: 250 },
];

test("basin and WC services pick the matching unconnected piping connector", () => {
  const waste = chooseFixtureConnector(basin, ["Sanitary"]);
  assert.deepEqual(waste, { index: 2, system: "Sanitary" });
  const hot = chooseFixtureConnector(basin, ["DomesticHotWater"]);
  assert.deepEqual(hot, { index: 1, system: "DomesticHotWater" });
  const cold = chooseFixtureConnector(basin, ["DomesticColdWater"]);
  assert.deepEqual(cold, { index: 0, system: "DomesticColdWater" });
  const soil = chooseFixtureConnector(wc, ["Sanitary"]);
  assert.deepEqual(soil, { index: 1, system: "Sanitary" });
  const wcCold = chooseFixtureConnector(wc, ["DomesticColdWater"]);
  assert.deepEqual(wcCold, { index: 0, system: "DomesticColdWater" });
  const wcHot = chooseFixtureConnector(wc, ["DomesticHotWater"]);
  assert.match("error" in wcHot ? wcHot.error : "", /no unconnected piping connector/);
  assert.match("error" in wcHot ? wcHot.error : "", /Fix:/);
  for (const row of FIXTURE_CASES) {
    const choice = systemChoice(row.service);
    if ("error" in choice || choice.infer) throw new Error(row.service);
    assert.deepEqual(choice.accept, [...row.systems]);
  }
});

test("an equal distance is refused with a fix hint, and a nearer connector is kept", () => {
  const tied = chooseFixtureConnector([
    { system: "DomesticHotWater", distanceMm: 100 },
    { system: "DomesticColdWater", distanceMm: 100.4 },
  ], ["DomesticHotWater", "DomesticColdWater"]);
  assert.match("error" in tied ? tied.error : "", /same distance/);
  assert.match("error" in tied ? tied.error : "", /Fix:/);
  const nearer = chooseFixtureConnector([
    { system: "DomesticHotWater", distanceMm: 100 },
    { system: "DomesticColdWater", distanceMm: 140 },
  ], ["DomesticHotWater", "DomesticColdWater"]);
  assert.deepEqual(nearer, { index: 0, system: "DomesticHotWater" });
  const connected = chooseFixtureConnector([
    { system: "Sanitary", distanceMm: 10, connected: true },
    { system: "Sanitary", distanceMm: 50 },
  ], ["Sanitary"]);
  assert.deepEqual(connected, { index: 1, system: "Sanitary" });
});

test("the fixture script is a guarded send_code write, one transaction, and it names the document", () => {
  assert.throws(() => fixtureConnectCall({ document: "Plumbing", pipe: "abc", fixture: 1 }), /element id/);
  assert.throws(() => fixtureConnectCall({ document: "Plumbing", pipe: 1, fixture: 2, system: "while (true) { }" }), /Unknown system/);
  const call = fixtureConnectCall({ document: "HEBERT Plumbing", pipe: 710816, fixture: 710817, system: "soil" });
  assert.equal(call.command, "send_code_to_revit");
  assert.ok(WRITE_COMMANDS.has(call.command));
  assert.equal(call.params.transactionMode, "auto");
  assert.equal(call.params.document, "HEBERT Plumbing");
  assert.equal(screenScript(call.params.code), null);
  assert.match(call.params.code, /MEPModel.ConnectorManager/);
  assert.match(call.params.code, /Domain.DomainPiping/);
  assert.match(call.params.code, /ConnectTo/);
  assert.match(call.params.code, /Pipe.Create/);
  assert.match(call.params.code, /"Sanitary"/);
  assert.match(call.params.code, /document\.Title/);
  assert.match(call.params.code, /document\.PathName/);
  assert.match(call.params.code, /KEYNOTE_PARAM/);
  assert.match(call.params.code, /rolls the transaction back/);
  assert.doesNotMatch(call.params.code, /new Transaction/);
  assert.doesNotMatch(call.params.code, /while\s*\(\s*true\s*\)/);
  const inferred = fixtureConnectCall({ document: "Plumbing", pipe: "12", fixture: "34" });
  assert.match(inferred.params.code, /infer = true/);
  assert.equal(screenScript(inferred.params.code), null);
});

test("modify_model connect keeps the curve guard and joins a fixture connector", () => {
  const src = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcModelMep.cs"), "utf8");
  assert.match(src, /isn't a duct, pipe, tray or conduit/);
  assert.match(src, /fixture\.MEPModel\?\.ConnectorManager/);
  assert.match(src, /Pipe\.Create/);
  assert.match(src, /bestPipe\.ConnectTo\(bestFix\)/);
  assert.match(src, /Sanitary/);
  assert.match(src, /DomesticHotWater/);
  assert.match(src, /DomesticColdWater/);
  const edit = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcModelEdit.cs"), "utf8");
  assert.equal(edit.split('["document"] = FmcTarget.DescribeState(doc)').length - 1, 2);
});
