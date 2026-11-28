import { test } from "node:test";
import assert from "node:assert/strict";
import { auditCircuits, circuitCaps, formatCircuitName, planCircuits, type CircuitDevice, type CircuitPanel } from "./circuitplan.js";
import { runFmcCircuits } from "../tools/fmc_circuits.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const panel: CircuitPanel = { id: 10, name: "DB-BQ", level: "Level 1", x: 0, y: 0, z: 0, distribution: "DS_415-240V_3Ph_4W", has_supply: true, is_board: true };

function light(id: number, room = "A1"): CircuitDevice {
  return { id, name: "Downlight", category: "Lighting Fixtures", level: "Level 1", room, has_connector: true, system_type: "PowerCircuit", load_w: 12, voltage: 240, poles: 1, x: id, y: 0, z: 0 };
}

test("a missing cap key is PROVISIONAL and uses the stated default", () => {
  const caps = circuitCaps({});
  const lighting = caps.find((cap) => cap.kind === "L");
  assert.equal(lighting?.provisional, true);
  assert.equal(lighting?.breaker_a.value, 6);
  assert.equal(lighting?.max_points?.value, 10);
  assert.equal(lighting?.max_load_w?.value, 1000);
  assert.equal(lighting?.cable_mm2.value, 1.5);
  assert.equal(caps.find((cap) => cap.kind === "R")?.max_area_m2?.value, 100);
  assert.equal(caps.find((cap) => cap.kind === "AC")?.curve, "C");
  assert.equal(caps.find((cap) => cap.kind === "SH")?.cable_mm2.value, 6);
});

test("names follow the board, zone and type pattern", () => {
  assert.equal(formatCircuitName("{board}/{zone}-{type}{n}", "DB-BQ", "A1", "L", 1), "DB-BQ/A1-L");
  assert.equal(formatCircuitName("{board}/{zone}-{type}{n}", "DB-BQ", "A1", "R", 1), "DB-BQ/A1-R");
  assert.equal(formatCircuitName("{board}/{zone}-{type}{n}", "DB-BQ", "A1", "AC", 1), "DB-BQ/A1-AC1");
  assert.equal(formatCircuitName("{board}/{zone}-{type}{n}", "DB-BQ", "A1", "SH", 1), "DB-BQ/A1-SH");
  assert.equal(formatCircuitName("{board}/{zone}-{type}{n}", "DB-BQ", "A1", "L", 2), "DB-BQ/A1-L2");
});

test("lighting and sockets are never on one circuit, and 358 lights stay within 10 points", () => {
  const devices: CircuitDevice[] = [light(1), { ...light(2), name: "Twin socket", category: "Electrical Fixtures" }];
  const mixed = planCircuits({ devices, panels: [panel] });
  assert.equal(mixed.circuits.length, 2);
  assert.equal(mixed.circuits.some((circuit) => circuit.element_ids.includes(1) && circuit.element_ids.includes(2)), false);
  const many = Array.from({ length: 358 }, (_, index) => light(index + 1));
  const planned = planCircuits({ devices: many, panels: [panel] });
  assert.equal(planned.counts.points, 358);
  assert.ok(planned.circuits.every((circuit) => circuit.points <= 10 && circuit.kind === "L"));
  assert.equal(planned.circuits.length, 36);
  const phases = new Set(planned.circuits.map((circuit) => circuit.phase));
  assert.equal(phases.size, 3);
});

test("no connector, a suspect panelboard and a declared load are reported separately", () => {
  const devices: CircuitDevice[] = [
    { id: 1, name: "ESB-1", category: "Electrical Fixtures", has_connector: false },
    { id: 2, name: "SPD-1", category: "Electrical Equipment", part_type: "PanelBoard", has_connector: true, system_type: "PowerCircuit" },
    { id: 3, name: "Pump control", category: "Electrical Equipment", part_type: "PanelBoard", has_connector: true, system_type: "PowerCircuit", load_w: 500, level: "Level 1", room: "A1" },
  ];
  const plan = planCircuits({ devices, panels: [panel], non_board_ids: [3] });
  assert.equal(plan.skipped.some((row) => row.id === 1 && row.code === "FMC-NO-CONNECTOR"), true);
  assert.equal(plan.skipped.some((row) => row.id === 2 && row.code === "CIRCUIT-SUSPECT-BOARD"), true);
  assert.equal(plan.circuits.some((circuit) => circuit.element_ids.includes(3)), false);
  const audit = auditCircuits({
    devices, panels: [{ ...panel, id: 9, name: "MDB-1", has_supply: false, utility_fed: false }, { id: 8, name: "DB-OLD", has_supply: false, distribution: "120/208", is_board: true }],
    circuits: [{ id: 4, name: "old", voltage: 120, poles: 1, kind: "L", points: 12, load_w: 2000 }],
    accept_no_supply: ["MDB-1"],
  });
  assert.equal(audit.findings.some((finding) => finding.id === 9 && finding.code === "ELEC-NO-SUPPLY"), false);
  assert.equal(audit.findings.some((finding) => finding.id === 8 && finding.code === "ELEC-DISTRIBUTION-TARGET" && finding.replaces === "ELEC-VOLTAGE-MISMATCH"), true);
  assert.equal(audit.findings.some((finding) => finding.id === 4 && finding.code === "ELEC-CIRCUIT-VOLTAGE" && finding.replaces === "ELEC-VOLTAGE-MISMATCH"), true);
  assert.equal(audit.findings.some((finding) => finding.code === "ELEC-VOLTAGE-MISMATCH"), false);
  assert.equal(audit.findings.some((finding) => finding.code === "CIRCUIT-OVERLOAD"), true);
  assert.equal(audit.findings.some((finding) => finding.id === 1 && finding.code === "FMC-NO-CONNECTOR"), true);
});

test("a board without a distribution system returns FMC-PANEL-NO-DISTRIBUTION and a dry-run plan", () => {
  const bare = { id: 10, name: "DB-BQ", level: "Level 1", x: 0, y: 0, z: 0, distribution: "", has_supply: false, is_board: true, part_type: "Panelboard" };
  const planned = planCircuits({ devices: [light(1)], panels: [bare], distribution: "DS_415-240V_3Ph_4W" });
  assert.equal(planned.circuits.length, 0);
  assert.equal(planned.distribution_plans[0]?.code, "FMC-PANEL-NO-DISTRIBUTION");
  assert.match(planned.distribution_plans[0]?.hint ?? "", /Distribution System/);
  assert.equal(planned.distribution_plans[0]?.plan[0]?.parameter, "Distribution System");
  assert.equal(planned.distribution_plans[0]?.plan[0]?.value, "DS_415-240V_3Ph_4W");
  assert.equal(planned.skipped.some((row) => row.code === "FMC-PANEL-NO-DISTRIBUTION"), true);
});

test("electrical equipment with a panel-schedule connector is a board, not a refused family", () => {
  const device = {
    id: 44, name: "DB Board", category: "Electrical Equipment", schedule_capable: true, has_connector: true,
    system_type: "PowerUnBalanced", distribution: "DS_415-240V_3Ph_4W", level: "Level 1",
  };
  const load = light(1);
  const planned = planCircuits({ devices: [device, load], panels: [] });
  assert.equal(planned.skipped.some((row) => row.id === 44 && /refused/i.test(row.detail)), false);
  assert.equal(planned.circuits.some((circuit) => circuit.panel_id === 44), true);
});

test("apply without a lease changes nothing", async () => {
  let applied = false;
  const result = await runFmcCircuits({
    action: "apply", document: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", dry_run: false, batch_lease: "",
    panel: "", pattern: "{board}/{zone}-{type}{n}", load_unit: "W", distribution: "DS_415-240V_3Ph_4W",
    accept_no_supply: [], non_board_ids: [], include_switches: false, supply_from: "", feeder: "", mains_type: "", sample_limit: 20,
  }, {
    bank: {},
    read: async () => ({ model: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", path: "C:\\WIP\\E.rvt" }, devices: [light(1)], panels: [panel], circuits: [] }),
    apply: async () => { applied = true; return { applied: true }; },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /FMC-BATCH-LOCKED/);
  assert.equal(applied, false);
});

test("devices are grouped by connector voltage and poles, and a mismatch names the panel against the device", () => {
  const mismatched = planCircuits({
    devices: [
      { ...light(1), voltage: 120, connector_voltage: 120, poles: 1, connector_poles: 1, family: "FMC_E_Downlight" },
      { ...light(2), voltage: 120, connector_voltage: 120, poles: 1, connector_poles: 1, family: "FMC_E_Downlight" },
    ],
    panels: [panel],
  });
  assert.equal(mismatched.circuits.length, 0);
  assert.equal(mismatched.mismatches.length, 1);
  assert.equal(mismatched.mismatches[0].code, "FMC-CIRCUIT-PANEL-MISMATCH");
  assert.equal(mismatched.mismatches[0].count, 2);
  assert.equal(mismatched.mismatches[0].panel_voltage_ll, 415);
  assert.equal(mismatched.mismatches[0].panel_voltage_lg, 240);
  assert.match(mismatched.mismatches[0].detail, /415/);
  assert.match(mismatched.mismatches[0].detail, /240/);
  assert.match(mismatched.mismatches[0].detail, /120/);
  assert.equal(mismatched.mismatches[0].families.includes("FMC_E_Downlight"), true);

  const split = planCircuits({
    devices: [
      light(1),
      { ...light(2), name: "Twin socket", category: "Electrical Fixtures", voltage: 415, poles: 3, connector_voltage: 415, connector_poles: 3 },
    ],
    panels: [panel],
  });
  assert.equal(split.circuits.length, 2);
  assert.equal(split.circuits.filter((circuit) => circuit.poles === 1).length, 1);
  assert.equal(split.circuits.filter((circuit) => circuit.poles === 3 && circuit.voltage_v === 415).length, 1);
  assert.equal(split.mismatches.length, 0);
});

test("a board with no distribution system keeps its dry-run plan, and missing connectors are grouped by family", () => {
  const bare = { id: 11, name: "TPN_T1", level: "Level 1", distribution: "", has_supply: false, is_board: true };
  const planned = planCircuits({
    devices: [
      light(1),
      { id: 21, family: "FMC_E_Downlight", category: "Lighting Fixtures", has_connector: false },
      { id: 22, family: "FMC_E_Downlight", category: "Lighting Fixtures", has_connector: false },
      { id: 23, family: "FMC_E_Socket", category: "Electrical Fixtures", has_connector: false },
    ],
    panels: [bare],
    distribution: "DS_415-240V_3Ph_4W",
  });
  assert.equal(planned.circuits.length, 0);
  assert.equal(planned.mismatches.length, 0);
  assert.equal(planned.distribution_plans[0]?.panel, "TPN_T1");
  assert.equal(planned.distribution_plans[0]?.plan[0]?.parameter, "Distribution System");
  assert.equal(planned.distribution_plans[0]?.plan[0]?.value, "DS_415-240V_3Ph_4W");
  const lights = planned.no_connector_families.find((row) => row.family === "FMC_E_Downlight");
  assert.equal(lights?.count, 2);
  assert.equal(planned.no_connector_families.find((row) => row.family === "FMC_E_Socket")?.count, 1);
  assert.equal(planned.counts.no_connector, 3);
});

test("HEBERT HOSTELS is not written", async () => {
  const result = await runFmcCircuits({
    action: "apply", document: "HEBERT HOSTELS_USER", dry_run: false, batch_lease: "lease-1",
    panel: "", pattern: "{board}/{zone}-{type}{n}", load_unit: "W", distribution: "DS_415-240V_3Ph_4W",
    accept_no_supply: [], non_board_ids: [], include_switches: false, supply_from: "", feeder: "", mains_type: "", sample_limit: 20,
  }, {
    bank: {},
    read: async () => ({ model: "HEBERT HOSTELS_USER", resolved_document: { title: "HEBERT HOSTELS_USER", path: "C:\\HEBERT HOSTELS_USER.rvt" }, devices: [], panels: [] }),
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HEBERT HOSTELS/);
});

test("batch 8: the audit says its total and whether it was cut, what mismatched counts, that caps are defaults, and the report's size", async () => {
  const env = { LOCALAPPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "fmc-circuits-")) };
  const old = (id: number) => ({ id, name: `old-${id}`, voltage: 120, poles: 1, kind: "L" as const, points: 2, load_w: 100 });
  const result = await runFmcCircuits({
    action: "audit", document: "electrical_USER", dry_run: true, batch_lease: "",
    panel: "", pattern: "{board}/{zone}-{type}{n}", load_unit: "W", distribution: "DS_415-240V_3Ph_4W",
    accept_no_supply: [], non_board_ids: [], include_switches: false, supply_from: "", feeder: "", mains_type: "", sample_limit: 2,
  }, {
    bank: {}, env,
    read: async () => ({ model: "electrical_USER", devices: [], panels: [panel], circuits: [old(31), old(32), old(33)] }),
  });
  const body = JSON.parse(result.content[0].text);
  assert.equal(result.isError, false);
  assert.match(body.caps_note, /PROVISIONAL defaults/);
  assert.match(body.counts_meaning.mismatched, /ELEC-CIRCUIT-VOLTAGE/);
  assert.equal(body.audit.total, 3);
  assert.equal(body.audit.truncated, true);
  assert.equal(body.audit.findings.length, 2);
  assert.ok(body.audit.findings.every((finding: { code: string }) => finding.code === "ELEC-CIRCUIT-VOLTAGE"));
  assert.ok(body.report_bytes > 0);
  assert.equal(body.report_folder.files, 1);

  const read = await runFmcCircuits({ action: "report", report_file: "" } as never, { env });
  const back = JSON.parse(read.content[0].text);
  assert.equal(read.isError, false);
  assert.equal(back.read_only, true);
  assert.equal(back.file, body.report);
  assert.equal(back.body.audit.findings.length, 3);

  const bad = await runFmcCircuits({ action: "report", report_file: "..\\..\\fmc_guard.json" } as never, { env });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /FMC-REPORT-NAME/);
  const missing = await runFmcCircuits({ action: "report", report_file: "audit-none.json" } as never, { env });
  assert.match(missing.content[0].text, /FMC-REPORT-MISSING/);
});
