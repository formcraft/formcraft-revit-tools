import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import {
  MEP_AUDIT_SCHEMA, MEP_CODES, filterConnectors, filterSystems, normDomain, openConnectorCode, shapeMepAudit, systemIssues,
  type MepAuditOptions, type MepAuditSnapshot, type OpenConnectorRow, type SystemRow,
} from "./mepaudit.js";
import { FMC_MEP_AUDIT_DESCRIPTION, FMC_MEP_AUDIT_SHAPE, mepAuditBody, runFmcMepAudit, type FmcMepAuditArgs } from "../tools/fmc_mep_audit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const opts = (o: Partial<MepAuditOptions> = {}): MepAuditOptions => ({
  domain: "both", systems: [], levels: [], include_equipment: true, mode: "summary", max_results: 200, ...o,
});

function conn(id: number, kind: string, domain = "piping", extra: Partial<OpenConnectorRow> = {}): OpenConnectorRow {
  return { element_id: id, connector_index: 1, domain, kind, level: "L01", system_id: 900, system_name: "DCW 1", ...extra };
}

function sys(id: number, extra: Partial<SystemRow> = {}): SystemRow {
  return {
    id, name: `S${id}`, domain: "piping", classification: "DomesticColdWater", is_well_connected: true, is_valid: true, is_empty: false,
    base_equipment_id: 5000, element_count: 12, levels: ["L01"], flow_lps: 1.25, static_pressure_pa: 1200, critical_path_pressure_loss_pa: 800,
    critical_path_sections: [1, 2, 3], fixture_units: 14, calc_notes: [], ...extra,
  };
}

const snapshot: MepAuditSnapshot = {
  model: "P-0001_USER",
  resolved_document: { title: "P-0001_USER", path: "C:\\WIP\\P-0001_USER.rvt" },
  read_only: true,
  open_connectors: [
    conn(1, "curve"),
    conn(2, "fitting"),
    conn(3, "accessory"),
    conn(4, "equipment", "duct", { system_id: null, system_name: "", level: "L02" }),
    conn(5, "fixture"),
    conn(6, "terminal", "duct", { system_id: 901, system_name: "SA 1" }),
    conn(7, "curve", "conduit"),
    conn(8, "curve", "tray"),
    conn(9, "curve", "CableTrayConduit"),
  ],
  systems: [
    sys(900),
    sys(901, { domain: "duct", name: "SA 1", classification: "SupplyAir", fixture_units: null, base_equipment_id: null, levels: ["L02"] }),
    sys(902, { name: "SAN 1", classification: "Sanitary", base_equipment_id: null }),
    sys(903, { name: "DHW broken", classification: "DomesticHotWater", is_well_connected: false, flow_lps: null, static_pressure_pa: null, critical_path_pressure_loss_pa: null, fixture_units: null, calc_notes: ["not well connected: calculated values not read"] }),
    sys(904, { name: "Empty", is_empty: true, base_equipment_id: null }),
  ],
  scanned: { elements: 40, connectors: 120, systems: 5 },
  truncated: { connectors: false, systems: false },
};

test("domains: piping and duct are in scope, conduit and cable tray never are", () => {
  assert.equal(normDomain("piping"), "piping");
  assert.equal(normDomain("Duct"), "duct");
  assert.equal(normDomain("hvac"), "duct");
  for (const d of ["conduit", "tray", "CableTrayConduit", "electrical", ""]) assert.equal(normDomain(d), null);
  const kept = filterConnectors(snapshot.open_connectors!, opts());
  assert.deepEqual(kept.map((c) => c.element_id), [1, 2, 3, 4, 5, 6]);
  const reply = shapeMepAudit(snapshot, opts({ mode: "detail" }));
  assert.equal(reply.dropped_out_of_scope, 3);
  assert.match(reply.excludes, /fmc_conduit/);
  assert.match(reply.excludes, /fmc_trace/);
  assert.ok(reply.issues.every((i) => i.element_id == null || ![7, 8, 9].includes(i.element_id)));
});

test("open connector kinds map to stable codes and severities", () => {
  assert.equal(openConnectorCode("curve"), MEP_CODES.OPEN_CURVE_END);
  assert.equal(openConnectorCode("fitting"), MEP_CODES.OPEN_FITTING);
  assert.equal(openConnectorCode("accessory"), MEP_CODES.OPEN_ACCESSORY);
  assert.equal(openConnectorCode("fixture"), MEP_CODES.OPEN_FIXTURE);
  assert.equal(openConnectorCode("terminal"), MEP_CODES.OPEN_TERMINAL);
  assert.equal(openConnectorCode("equipment"), MEP_CODES.OPEN_EQUIPMENT);
  assert.equal(openConnectorCode("weird"), MEP_CODES.OPEN_EQUIPMENT);
  const reply = shapeMepAudit(snapshot, opts({ mode: "detail" }));
  const sev = (code: string) => reply.issues.find((i) => i.code === code)?.severity;
  assert.equal(sev(MEP_CODES.OPEN_CURVE_END), "error");
  assert.equal(sev(MEP_CODES.OPEN_FITTING), "error");
  assert.equal(sev(MEP_CODES.OPEN_EQUIPMENT), "warning");
  assert.equal(sev(MEP_CODES.CONNECTOR_NO_SYSTEM), "info");
  // errors come first
  const order = reply.issues.map((i) => i.severity);
  assert.deepEqual(order, [...order].sort((a, b) => ["error", "warning", "info"].indexOf(a) - ["error", "warning", "info"].indexOf(b)));
});

test("system checks: not well connected, no base equipment (info for sanitary), empty, calc unavailable", () => {
  const [broken] = filterSystems([snapshot.systems![3]], opts());
  const codes = systemIssues(broken).map((i) => i.code);
  assert.ok(codes.includes(MEP_CODES.SYS_NOT_WELL_CONNECTED));
  assert.ok(!codes.includes(MEP_CODES.SYS_CALC_UNAVAILABLE), "a not-well-connected system is not also a calc warning");
  const [san] = filterSystems([snapshot.systems![2]], opts());
  assert.equal(systemIssues(san).find((i) => i.code === MEP_CODES.SYS_NO_BASE_EQUIPMENT)?.severity, "info");
  const [sa] = filterSystems([snapshot.systems![1]], opts());
  assert.equal(systemIssues(sa).find((i) => i.code === MEP_CODES.SYS_NO_BASE_EQUIPMENT)?.severity, "warning");
  const [empty] = filterSystems([snapshot.systems![4]], opts());
  assert.deepEqual(systemIssues(empty).map((i) => i.code), [MEP_CODES.SYS_EMPTY]);
  const [calc] = filterSystems([sys(905, { flow_lps: null, calc_notes: ["flow: boom"] })], opts());
  assert.equal(systemIssues(calc).find((i) => i.code === MEP_CODES.SYS_CALC_UNAVAILABLE)?.severity, "info");
  const [ok] = filterSystems([sys(906)], opts());
  assert.deepEqual(systemIssues(ok), []);
});

test("filters: domain, system name or id, level, equipment", () => {
  assert.deepEqual(filterConnectors(snapshot.open_connectors!, opts({ domain: "duct" })).map((c) => c.element_id), [4, 6]);
  assert.deepEqual(filterConnectors(snapshot.open_connectors!, opts({ domain: "piping" })).map((c) => c.element_id), [1, 2, 3, 5]);
  assert.deepEqual(filterConnectors(snapshot.open_connectors!, opts({ systems: ["sa 1"] })).map((c) => c.element_id), [6]);
  assert.deepEqual(filterConnectors(snapshot.open_connectors!, opts({ systems: ["901"] })).map((c) => c.element_id), [6]);
  assert.deepEqual(filterConnectors(snapshot.open_connectors!, opts({ levels: ["l02"] })).map((c) => c.element_id), [4]);
  assert.deepEqual(filterConnectors(snapshot.open_connectors!, opts({ include_equipment: false })).map((c) => c.element_id), [1, 2, 3]);
  assert.deepEqual(filterSystems(snapshot.systems!, opts({ domain: "duct" })).map((s) => s.id), [901]);
  assert.deepEqual(filterSystems(snapshot.systems!, opts({ levels: ["L02"] })).map((s) => s.id), [901]);
  assert.deepEqual(filterSystems(snapshot.systems!, opts({ systems: ["DHW BROKEN", "900"] })).map((s) => s.id), [900, 903]);
});

test("summary versus detail, and the result cap", () => {
  const detail = shapeMepAudit(snapshot, opts({ mode: "detail" }));
  const summary = shapeMepAudit(snapshot, opts());
  assert.equal(detail.summary.issues, summary.summary.issues);
  assert.ok(summary.issues.every((i) => i.severity !== "info"));
  assert.ok(detail.issues.some((i) => i.severity === "info"));
  assert.equal(detail.sample_ids, undefined);
  assert.deepEqual(summary.sample_ids?.[MEP_CODES.OPEN_CURVE_END], [1]);
  assert.equal(detail.systems.length, 5);
  assert.ok(!summary.systems.some((s) => s.id === 900), "summary lists only systems with an issue");
  const capped = shapeMepAudit(snapshot, opts({ mode: "detail", max_results: 2 }));
  assert.equal(capped.issues.length, 2);
  assert.equal(capped.issues_truncated, true);
  assert.equal(capped.systems.length, 2);
  assert.equal(capped.systems_truncated, true);
  assert.equal(detail.summary.systems.not_well_connected, 1);
  assert.equal(detail.summary.systems.no_base_equipment, 2); // 901 and 902; 904 is empty, 903 has a base
  assert.equal(detail.summary.systems.empty, 1);
  assert.equal(detail.summary.open_connectors, 6);
  assert.deepEqual(detail.summary.by_severity, {
    error: detail.issues.filter((i) => i.severity === "error").length,
    warning: detail.issues.filter((i) => i.severity === "warning").length,
    info: detail.issues.filter((i) => i.severity === "info").length,
  });
});

test("facts block: stable shape for fmc_calc's facts_file mep section and fmc_mep_size", () => {
  const reply = shapeMepAudit(snapshot, opts({ mode: "detail" }));
  assert.equal(reply.schema, MEP_AUDIT_SCHEMA);
  assert.equal(reply.read_only, true);
  // fmc_calc MepFacts.pipe_systems: { id, name, classification }
  assert.deepEqual(reply.facts.mep.pipe_systems[0], { id: 900, name: "S900", classification: "DomesticColdWater" });
  assert.equal(reply.facts.mep.model, "P-0001_USER");
  assert.equal(reply.facts.mep.counts.pipe_systems, 4);
  assert.equal(reply.facts.mep.counts.duct_systems, 1);
  const s900 = reply.facts.mep_systems.find((s) => s.id === 900)!;
  assert.deepEqual(Object.keys(s900).sort(), [
    "base_equipment_id", "base_equipment_name", "calc_valid", "classification", "critical_path_pressure_loss_pa", "critical_path_sections",
    "domain", "element_count", "fixture_units", "flow_lps", "id", "is_well_connected", "levels", "name", "static_pressure_pa", "system_type",
  ]);
  assert.equal(s900.calc_valid, true);
  assert.equal(s900.flow_lps, 1.25);
  assert.equal(reply.facts.mep_systems.find((s) => s.id === 901)!.fixture_units, null, "duct systems carry no fixture units");
  assert.equal(reply.facts.mep_systems.find((s) => s.id === 903)!.calc_valid, false);
  // total fixture units only from well-connected piping systems
  assert.equal(reply.summary.totals.fixture_units, 14 * 3); // 900, 902, 904 are well connected with 14 each
});

test("runFmcMepAudit is read-only: no batch_lease, no dry_run, one read call", async () => {
  const bodies: Record<string, unknown>[] = [];
  const args = { document: "P-0001_USER", domain: "both", systems: [], levels: [], include_equipment: true, analysis: true, mode: "summary", max_results: 50 } as FmcMepAuditArgs;
  const result = await runFmcMepAudit(args, { read: async (body) => { bodies.push(body); return snapshot; } });
  assert.equal(result.isError, false);
  assert.equal(bodies.length, 1);
  assert.equal("batch_lease" in bodies[0], false);
  assert.equal("dry_run" in bodies[0], false);
  assert.deepEqual(mepAuditBody(args), bodies[0]);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.tool, "fmc_mep_audit");
  assert.equal(parsed.read_only, true);
  assert.equal("batch_lease" in FMC_MEP_AUDIT_SHAPE, false);
  assert.equal("dry_run" in FMC_MEP_AUDIT_SHAPE, false);
  assert.match(FMC_MEP_AUDIT_DESCRIPTION, /fmc_conduit/);
  const bad = await runFmcMepAudit(args, { read: async () => ({}) });
  assert.equal(bad.isError, true);
  const thrown = await runFmcMepAudit(args, { read: async () => { throw new Error("no Revit"); } });
  assert.equal(thrown.isError, true);
  assert.match(thrown.content[0].text, /no Revit/);
});

test("fmc_mep_audit is a read command: policy, command.json, C# without a transaction, docs", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_mep_audit"));
  assert.equal(WRITE_COMMANDS.has("fmc_mep_audit"), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName?: string }> };
  assert.ok(manifest.commands.some((row) => row.commandName === "fmc_mep_audit"));
  const work = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcMepAuditWork.cs"), "utf8");
  const command = fs.readFileSync(path.join(root, "commandset", "Commands", "Fmc", "FmcMepAuditCommand.cs"), "utf8");
  assert.equal(/Transaction/.test(work + command), false);
  assert.match(work, /mayOpen:\s*false/);
  assert.match(command, /"fmc_mep_audit"/);
  for (const api of ["UnusedConnectors", "HasOpenConnector", "IsWellConnected", "BaseEquipment", "PressureLossOfCriticalPath", "GetCriticalPathSectionNumbers", "GetFlow", "GetStaticPressure", "GetFixtureUnits"]) {
    assert.match(work, new RegExp(api), `${api} not read`);
  }
  assert.equal(/OST_Conduit|OST_CableTray/.test(work), false, "conduit and cable tray stay with fmc_conduit and fmc_trace");
  const doc = fs.readFileSync(path.join(root, "docs", "tools", "fmc_mep_audit.md"), "utf8");
  assert.match(doc, /fmc_conduit/);
  assert.match(doc, /fmc_trace/);
  for (const code of Object.values(MEP_CODES)) assert.match(doc, new RegExp(code), `${code} not documented`);
});
