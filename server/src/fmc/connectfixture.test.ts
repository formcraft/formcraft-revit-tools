import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WRITE_COMMANDS } from "./policy.js";
import { screenScript } from "./scriptguard.js";
import { chooseFixtureConnector, DEFAULT_MAX_GAP_MM, FIXTURE_CASES, fixtureConnectCall, systemChoice, type ConnectorFact } from "./connectfixture.js";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import { NEVER, NOT_AI_COMMANDS } from "./aiuse.js";
import { aiGate } from "./aigate.js";
import { runConnectFixture } from "../tools/fmc_connect_fixture.js";

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
  const call = fixtureConnectCall({ document: "HEBERT Plumbing", pipe: 710816, fixture: 710817, system: "soil", dry_run: false });
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

test("B4: the dry run is the same script in read_only mode; max gap is checked in the script and bounded", () => {
  const dry = fixtureConnectCall({ document: "Plumbing", pipe: 1, fixture: 2, system: "soil" });
  assert.equal(dry.params.transactionMode, "read_only");
  assert.match(dry.params.code, /bool dryRun = true;/);
  assert.match(dry.params.code, new RegExp(`double maxGap = ${DEFAULT_MAX_GAP_MM} / 304.8;`));
  assert.match(dry.params.code, /FMC-CONNECT-GAP/);
  assert.match(dry.params.code, /FMC-CONNECT-CENTRAL/);
  assert.equal(screenScript(dry.params.code), null);
  const real = fixtureConnectCall({ document: "Plumbing", pipe: 1, fixture: 2, system: "soil", dry_run: false, max_gap_mm: 150 });
  assert.equal(real.params.transactionMode, "auto");
  assert.match(real.params.code, /bool dryRun = false;/);
  assert.match(real.params.code, /double maxGap = 150 \/ 304.8;/);
  assert.throws(() => fixtureConnectCall({ document: "Plumbing", pipe: 1, fixture: 2, max_gap_mm: 5000 }), /max_gap_mm/);
  assert.throws(() => fixtureConnectCall({ document: "Plumbing", pipe: 1, fixture: 2, max_gap_mm: -1 }), /max_gap_mm/);
});

test("B4: fmc_connect_fixture refuses a central, a protected path or forbidden project, and a real run without the held lease", async () => {
  const cfg: GuardConfig = { ...DEFAULT_CONFIG, protected_roots: ["D:\\Live"], protected_paths: [], save_exclude: [], sync_exclude: [] };
  const base = { document: "P-0003", pipe: 1, fixture: 2, system: "soil" };
  const run = async (active: Record<string, unknown>, extra: Record<string, unknown> = {}, holder: { lease: string; client: string } | null = { lease: "L1", client: "c" }) => {
    const calls: string[] = [];
    const r = await runConnectFixture({ ...base, ...extra } as any, {
      config: () => cfg,
      holder: () => holder,
      send: async (command) => { calls.push(command); return command === "fmc_document_info" ? { active } : { success: true, result: { title: "P-0003", path: "C:\\WIP\\P-0003.rvt", how: "pipe", gap_mm: 42 } }; },
    });
    return { body: JSON.parse(r.content[0].text), isError: r.isError, calls };
  };
  const local = { title: "P-0003", path: "C:\\WIP\\P-0003.rvt", isFamily: false, isWorkshared: true, isLocal: true, isActive: true };
  const central = await run({ ...local, isLocal: false });
  assert.equal(central.body.code, "FMC-CONNECT-CENTRAL");
  assert.deepEqual(central.calls, ["fmc_document_info"]);
  const unknown = await run({ ...local, isLocal: undefined });
  assert.equal(unknown.body.code, "FMC-CONNECT-CENTRAL");
  const prot = await run({ ...local, path: "D:\\Live\\P-0003.rvt" });
  assert.equal(prot.body.code, "FMC-CONNECT-GUARD");
  assert.deepEqual(prot.calls, ["fmc_document_info"]);
  const forbidden = await run({ ...local, title: "HEBERT HOSTELS_P", path: "C:\\WIP\\HEBERT HOSTELS_P.rvt" });
  assert.equal(forbidden.body.code, "FMC-CONNECT-GUARD");
  // dry run (default): read_only script, no lease needed
  const dry = await run(local, {}, null);
  assert.equal(dry.isError, false);
  assert.equal(dry.body.dry_run, true);
  assert.deepEqual(dry.calls, ["fmc_document_info", "send_code_to_revit"]);
  // real run: no lease, nobody holding, or a different lease are all refused before anything is sent
  for (const [extra, holder] of [[{ dry_run: false }, { lease: "L1", client: "c" }], [{ dry_run: false, batch_lease: "L1" }, null], [{ dry_run: false, batch_lease: "made-up" }, { lease: "L1", client: "c" }]] as const) {
    const r = await run(local, extra, holder);
    assert.equal(r.body.code, "FMC-CONNECT-LEASE", JSON.stringify(extra));
    assert.deepEqual(r.calls, ["fmc_document_info"]);
  }
  const real = await run(local, { dry_run: false, batch_lease: "L1" });
  assert.equal(real.isError, false);
  assert.deepEqual(real.calls, ["fmc_document_info", "fmc_connect_fixture"]);
  const unread = await runConnectFixture(base, { config: () => cfg, send: async () => { throw new Error("bridge down"); } });
  assert.equal(JSON.parse(unread.content[0].text).code, "FMC-CONNECT-GUARD");
});

test("B4 / P-fmc_connect_fixture-01: out of the AI set at any access level; a gated write", async () => {
  assert.ok(NOT_AI_COMMANDS.has("fmc_connect_fixture"));
  assert.ok(NEVER.fmc_connect_fixture);
  assert.ok(WRITE_COMMANDS.has("fmc_connect_fixture"));
  const gate = await aiGate("fmc_connect_fixture", {}, { title: "P-0003", path: "C:\\WIP\\P-0003.rvt", isFamily: false, isWorkshared: true, isActive: true } as any, { ...DEFAULT_CONFIG }, async () => ({}));
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /not in the AI set/);
});
