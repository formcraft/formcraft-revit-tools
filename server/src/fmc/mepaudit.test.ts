import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import {
  MEP_AUDIT_SCHEMA, MEP_CODES, crossCheckIssues, filterConnectors, filterPlumbingOnly, filterSystems, normDomain, openConnectorCode,
  segmentsFor, shapeMepAudit, systemIssues, type MepAuditOptions, type MepAuditSnapshot, type OpenConnectorRow, type SystemRow,
} from "./mepaudit.js";
import { FMC_MEP_AUDIT_DESCRIPTION, FMC_MEP_AUDIT_SHAPE, mepAuditBody, runFmcMepAudit, type FmcMepAuditArgs } from "../tools/fmc_mep_audit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const opts = (o: Partial<MepAuditOptions> = {}): MepAuditOptions => ({
  domain: "both", systems: [], levels: [], include_equipment: true, mode: "summary", max_results: 200, ...o,
});

function conn(id: number, kind: string, domain = "piping", extra: Partial<OpenConnectorRow> = {}): OpenConnectorRow {
  return { element_id: id, connector_index: 1, domain, kind, level: "L01", system_id: 900, system_name: "DCW 1", plumbing_open: domain === "piping" && ["curve", "fitting", "accessory"].includes(kind) ? true : null, ...extra };
}

export function sys(id: number, extra: Partial<SystemRow> = {}): SystemRow {
  return {
    id, name: `S${id}`, domain: "piping", classification: "DomesticColdWater", is_well_connected: true, is_valid: true, is_empty: false,
    base_equipment_id: 5000, element_count: 12, levels: ["L01"], flow_lps: 1.25, static_pressure_pa: 1200, critical_path_pressure_loss_pa: 800,
    critical_path_sections: [1, 2], fixture_units: 14, calc_notes: [],
    critical_path: [
      { number: 1, flow_lps: 1.25, length_m: 10, pressure_loss_pa: 500, velocity_ms: 1.1, roughness_mm: 0.0015, total_coefficient: 1.5, fixture_units: 14, shape: "round", size_mm: 32, element_count: 4, element_ids: [11, 12, 13, 14] },
      { number: 2, flow_lps: 0.6, length_m: 6, pressure_loss_pa: 300, velocity_ms: 0.9, roughness_mm: 0.0015, total_coefficient: 0, fixture_units: 7, shape: "round", size_mm: 25, element_count: 2, element_ids: [21, 22] },
    ],
    ...extra,
  };
}

export const snapshot: MepAuditSnapshot = {
  model: "P-0001_USER",
  resolved_document: { title: "P-0001_USER", path: "C:\\WIP\\P-0001_USER.rvt" },
  read_only: true,
  open_connectors: [
    conn(1, "curve"),
    conn(2, "fitting", "piping", { plumbing_open: false }),
    conn(3, "accessory"),
    conn(4, "equipment", "duct", { system_id: null, system_name: "", level: "L02" }),
    conn(5, "fixture"),
    conn(6, "terminal", "duct", { system_id: 901, system_name: "SA 1" }),
    conn(7, "curve", "conduit"),
    conn(8, "curve", "tray"),
    conn(9, "curve", "CableTrayConduit"),
  ],
  plumbing_only_open: [{ element_id: 30, kind: "fitting", level: "L01", type_name: "Tee", system_name: "DCW 1" }],
  systems: [
    sys(900),
    sys(901, { domain: "duct", name: "SA 1", classification: "SupplyAir", fixture_units: null, base_equipment_id: null, levels: ["L02"] }),
    sys(902, { name: "SAN 1", classification: "Sanitary", base_equipment_id: null }),
    sys(903, { name: "DHW broken", classification: "DomesticHotWater", is_well_connected: false, flow_lps: null, static_pressure_pa: null, critical_path_pressure_loss_pa: null, fixture_units: null, critical_path: [], critical_path_sections: [], calc_notes: ["not well connected: calculated values not read"] }),
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
  assert.deepEqual(filterConnectors(snapshot.open_connectors!, opts()).map((c) => c.element_id), [1, 2, 3, 4, 5, 6]);
  const reply = shapeMepAudit(snapshot, opts({ mode: "detail" }));
  assert.equal(reply.dropped_out_of_scope, 3);
  assert.match(reply.excludes, /fmc_conduit/);
  assert.match(reply.excludes, /fmc_trace/);
  assert.ok(reply.issues.every((i) => i.element_id == null || ![7, 8, 9].includes(i.element_id)));
});

test("open connectors are an info cross-check of fmc_trace open_end; no fmc_trace code is reused", () => {
  assert.equal(openConnectorCode("curve"), MEP_CODES.OPEN_CURVE_END);
  assert.equal(openConnectorCode("fitting"), MEP_CODES.OPEN_FITTING);
  assert.equal(openConnectorCode("accessory"), MEP_CODES.OPEN_ACCESSORY);
  assert.equal(openConnectorCode("fixture"), MEP_CODES.OPEN_FIXTURE);
  assert.equal(openConnectorCode("terminal"), MEP_CODES.OPEN_TERMINAL);
  assert.equal(openConnectorCode("weird"), MEP_CODES.OPEN_EQUIPMENT);
  const reply = shapeMepAudit(snapshot, opts({ mode: "detail" }));
  for (const i of reply.issues.filter((x) => x.code.startsWith("MEP-OPEN-"))) {
    assert.equal(i.severity, "info");
    assert.match(i.message, /FLOW-OPEN-END/);
  }
  const trace = ["FLOW-OPEN-END", "NOT-CONNECTED", "NEAR-MISS", "SIZE-MISMATCH", "NO-SYSTEM", "NO-SOURCE", "ISLAND", "NO-FITTING"];
  for (const code of Object.values(MEP_CODES)) for (const t of trace) assert.ok(!code.endsWith(t), `${code} reuses ${t}`);
  assert.ok(reply.issues.every((i) => !/no source/i.test(i.message)));
  assert.equal(reply.summary.cross_check.of, "fmc_trace open_end (FLOW-OPEN-END)");
  const order = reply.issues.map((i) => i.severity);
  assert.deepEqual(order, [...order].sort((a, b) => ["error", "warning", "info"].indexOf(a) - ["error", "warning", "info"].indexOf(b)));
});

test("UnusedConnectors and HasOpenConnector are cross-checked both ways on piping", () => {
  const connectors = filterConnectors(snapshot.open_connectors!, opts());
  const only = filterPlumbingOnly(snapshot.plumbing_only_open!, opts());
  const xs = crossCheckIssues(connectors, only);
  assert.deepEqual(xs.map((x) => x.element_id).sort((a, b) => a! - b!), [2, 30]);
  assert.ok(xs.every((x) => x.code === MEP_CODES.XCHK_MISMATCH && x.severity === "warning"));
  assert.deepEqual(filterPlumbingOnly(snapshot.plumbing_only_open!, opts({ domain: "duct" })), []);
  const reply = shapeMepAudit(snapshot, opts());
  assert.equal(reply.summary.cross_check.mismatches, 2);
  assert.equal(reply.summary.cross_check.unused_connectors, 6);
  assert.equal(reply.summary.cross_check.plumbing_open_elements, 3); // 1 and 3 (both open), plus 30 (HasOpenConnector only)
});

test("system checks: not well connected, no base equipment (count + ids, info for sanitary), empty, calc unavailable", () => {
  const [broken] = filterSystems([snapshot.systems![3]], opts());
  const codes = systemIssues(broken).map((i) => i.code);
  assert.ok(codes.includes(MEP_CODES.SYS_NOT_WELL_CONNECTED));
  assert.ok(!codes.includes(MEP_CODES.SYS_CALC_UNAVAILABLE));
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
  const reply = shapeMepAudit(snapshot, opts());
  assert.equal(reply.summary.systems.no_base_equipment, 2);
  assert.deepEqual(reply.summary.systems.no_base_equipment_ids, [901, 902]);
  assert.deepEqual(reply.summary.systems.not_well_connected_ids, [903]);
});

test("critical path: sections in flow order with loss, flow and length; static pressure and fixture units per system", () => {
  const reply = shapeMepAudit(snapshot, opts({ mode: "detail" }));
  const s900 = reply.mep_systems.find((s) => s.id === 900)!;
  assert.equal(s900.critical_path_pressure_loss_pa, 800);
  assert.equal(s900.static_pressure_pa, 1200);
  assert.equal(s900.fixture_units, 14);
  assert.deepEqual(s900.critical_path.map((c) => c.number), [1, 2]);
  assert.deepEqual(s900.critical_path[0], { number: 1, flow_lps: 1.25, length_m: 10, pressure_loss_pa: 500, velocity_ms: 1.1, fixture_units: 14, element_count: 4 });
  assert.equal(reply.mep_systems.find((s) => s.id === 901)!.fixture_units, null, "duct systems carry no fixture units");
  assert.equal(reply.mep_systems.find((s) => s.id === 903)!.calc_valid, false);
  assert.equal(reply.summary.totals.fixture_units, 14 * 3);
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
  assert.ok(!summary.systems.some((s) => s.id === 900));
  const capped = shapeMepAudit(snapshot, opts({ mode: "detail", max_results: 2 }));
  assert.equal(capped.issues.length, 2);
  assert.equal(capped.issues_truncated, true);
  assert.equal(capped.systems.length, 2);
  assert.equal(capped.systems_truncated, true);
  assert.equal(capped.mep_systems.length, 2);
  assert.deepEqual(detail.summary.by_severity, {
    error: detail.issues.filter((i) => i.severity === "error").length,
    warning: detail.issues.filter((i) => i.severity === "warning").length,
    info: detail.issues.filter((i) => i.severity === "info").length,
  });
  assert.equal(detail.schema, MEP_AUDIT_SCHEMA);
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
  assert.match(FMC_MEP_AUDIT_DESCRIPTION, /fmc_trace/);
  assert.equal((await runFmcMepAudit(args, { read: async () => ({}) })).isError, true);
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
  for (const api of ["UnusedConnectors", "HasOpenConnector", "IsWellConnected", "BaseEquipment", "PressureLossOfCriticalPath", "GetCriticalPathSectionNumbers",
    "GetSectionByNumber", "TotalPressureLoss", "TotalCurveLength", "GetFlow", "GetStaticPressure", "GetFixtureUnits"]) {
    assert.match(work, new RegExp(api), `${api} not read`);
  }
  assert.equal(/OST_Conduit|OST_CableTray/.test(work), false);
  const doc = fs.readFileSync(path.join(root, "docs", "tools", "fmc_mep_audit.md"), "utf8");
  assert.match(doc, /fmc_conduit/);
  assert.match(doc, /fmc_trace/);
  for (const code of Object.values(MEP_CODES)) assert.match(doc, new RegExp(code), `${code} not documented`);
});

test("segments: the critical path as Builder 8's MepSegment, upstream in flow order, Revit's loss beside it", () => {
  const reply = shapeMepAudit(snapshot, opts({ mode: "detail" }));
  const s900 = reply.segments.filter((s) => s.id.startsWith("900:"));
  assert.deepEqual(s900, [
    { id: "900:1", kind: "pipe", flow_l_s: 1.25, source: "model:900#section:1", length_m: 10, shape: "round", size_mm: 32, roughness_mm: 0.0015, k: [1.5] },
    { id: "900:2", kind: "pipe", flow_l_s: 0.6, source: "model:900#section:2", length_m: 6, shape: "round", size_mm: 25, roughness_mm: 0.0015, upstream: "900:1" },
  ]);
  const allowed = new Set(["id", "kind", "flow_l_s", "length_m", "shape", "size_mm", "w_mm", "h_mm", "roughness_mm", "k", "upstream", "source"]);
  for (const seg of reply.segments) for (const key of Object.keys(seg)) assert.ok(allowed.has(key), `${key} is not a MepSegment field`);
  assert.ok(reply.segments.some((s) => s.kind === "duct" && s.id.startsWith("901:")));
  assert.ok(!reply.segments.some((s) => s.id.startsWith("903:")), "a not-well-connected system gives no segments");
  assert.deepEqual(reply.segment_checks.find((c) => c.id === "900:1"), { id: "900:1", system_id: 900, section: 1, revit_pressure_loss_pa: 500, velocity_ms: 1.1, fixture_units: 14, element_ids: [11, 12, 13, 14] });
  const rect = segmentsFor({ ...sys(910, { domain: "duct", classification: "SupplyAir" }), domain: "duct",
    critical_path: [{ number: 1, flow_lps: 400, length_m: 5, pressure_loss_pa: 20, shape: "rect", w_mm: 400, h_mm: 300 }, { number: 2, flow_lps: null, length_m: 3, pressure_loss_pa: null }] });
  assert.deepEqual(rect.segments, [{ id: "910:1", kind: "duct", flow_l_s: 400, source: "model:910#section:1", length_m: 5, shape: "rect", w_mm: 400, h_mm: 300 }]);
  assert.match(rect.notes[0], /section 2: no flow/);
});
