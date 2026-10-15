import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIAGRAM_KINDS, DRAW_SPEC, DiagramKind, SCAN_RESULT, ScanResult } from "./contract.js";
import { collisions, segmentHitsBox, textBox } from "./geometry.js";
import { Plan, drawSpec, layoutScan, planSummary } from "./layout.js";
import { DEFAULT_DIAGRAM_KIT, breakerFor, loadDiagramKit, mergeKit, symbolFor, tableSymbols } from "./symbols.js";
import { WRITE_COMMANDS } from "../policy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// build/fmc/diagram -> repo root
const FIXTURE = path.resolve(HERE, "../../../../tests/fixtures/FMC_Diagram_Symbols.json");

// ---------------------------------------------------------------------------------------------------------------
// A small two-storey building (plus roof), one scan graph per diagram kind

type P = Record<string, string | number | null>;
const N = (id: string, kind: string, name: string, level: string | null = null, params: P = {}, family = "", category = "") =>
  ({ id, kind, name, level, params, family, category, type: "" });
const E = (from: string, to: string, kind: string, params: P = {}, id: string | null = null) => ({ id, from, to, kind, params });

function circuits(board: string, prefix: string, n: number) {
  const nodes = [], edges = [];
  for (let i = 1; i <= n; i++) {
    nodes.push(N(`${prefix}-L${i}`, "load", `${prefix} load ${i}`));
    edges.push(E(board, `${prefix}-L${i}`, "circuit", { circuit: String(i), rating: 16, poles: 1, cable: "2.5 mm² T+E", load_name: `Load ${i}`, apparent_load: 800 }, `${prefix}-c${i}`));
  }
  return { nodes, edges };
}

/** Building controls: a head end on the ground floor, three DDC controllers (GF, FF, roof plant) and their points. */
function controlsDiagram() {
  const pt = (id: string, kind: string, name: string, level: string, ctl: string | null, type: string | null, signal: string | null, family = "", cat = "Mechanical Equipment") =>
    N(id, kind, name, level, { controller_id: ctl, point_type: type, signal, protocol: null, mark: id }, family, cat);
  return {
    kind: "m_controls", system: "BMS",
    nodes: [
      N("HE", "controller", "BMS Head End", "L00", { controller_id: null, protocol: "BACnet/IP", mark: "BMS-01" }, "FMC_E_BMSHeadEnd", "Electrical Equipment"),
      N("DDC1", "controller", "DDC Controller", "L00", { controller_id: "BMS-01", protocol: "BACnet MS/TP", mark: "DDC-01" }, "FMC_E_DDCController", "Electrical Equipment"),
      N("DDC2", "controller", "DDC Controller", "L01", { controller_id: "BMS-01", protocol: "BACnet MS/TP", mark: "DDC-02" }, "FMC_E_DDCController", "Electrical Equipment"),
      N("DDC3", "controller", "DDC Controller", "RF", { controller_id: "BMS-01", protocol: null, mark: "DDC-03" }, "FMC_E_DDCController", "Electrical Equipment"),
      pt("TS1", "sensor", "Room Temperature Sensor", "L00", "DDC-01", "AI", "0-10V", "FMC_M_TempSensor", "Data Devices"),
      pt("TH1", "sensor", "Room Thermostat", "L00", "DDC-01", "AI", "4-20mA", "FMC_M_Thermostat", "Data Devices"),
      pt("PIR1", "sensor", "Occupancy PIR Sensor", "L00", "DDC-01", "DI", "Volt-free", "FMC_E_PIR", "Lighting Devices"),
      pt("DA1", "actuator", "Damper Actuator", "L00", "DDC-01", "AO", "0-10V", "FMC_M_DamperActuator", "Duct Accessories"),
      pt("TS2", "sensor", "Duct Temperature Sensor", "L01", "DDC-02", "AI", null, "FMC_M_TempSensor", "Duct Accessories"),
      pt("VA2", "actuator", "Motorised Valve Actuator", "L01", "DDC-02", "AO", "0-10V", "FMC_M_ValveActuator", "Pipe Accessories"),
      pt("VFD1", "drive", "AHU Fan VFD", "RF", "DDC-03", "AO", "0-10V", "FMC_E_VFD", "Electrical Equipment"),
      pt("VFD1S", "drive", "AHU Fan VFD Status", "RF", "DDC-03", "DI", "Volt-free", "FMC_E_VFD", "Electrical Equipment"),
      pt("MS1", "drive", "Pump Motor Starter", "RF", "DDC-03", "DO", "24VAC", "FMC_E_MotorStarter", "Electrical Equipment"),
      pt("LS1", "sensor", "Tank Level Float Switch", "RF", "DDC-03", "DI", "Volt-free", "FMC_P_FloatSwitch", "Pipe Accessories"),
      pt("FS1", "sensor", "Filter Pressure Switch", "RF", null, "DI", "Volt-free", "FMC_M_PressureSwitch", "Duct Accessories"),
      pt("XX1", "sensor", "CO2 Sensor", "L01", "DDC-09", "AI", "0-10V", "FMC_M_CO2Sensor", "Data Devices"),
    ],
    edges: [
      E("HE", "DDC1", "data", { protocol: "BACnet MS/TP" }), E("HE", "DDC2", "data", { protocol: "BACnet MS/TP" }), E("HE", "DDC3", "data", { protocol: null }),
      E("DDC1", "TS1", "data"), E("DDC1", "TH1", "data"), E("DDC1", "PIR1", "data"), E("DDC1", "DA1", "data"),
      E("DDC2", "TS2", "data"), E("DDC2", "VA2", "data"),
      E("DDC3", "VFD1", "data"), E("DDC3", "VFD1S", "data"), E("DDC3", "MS1", "data"), E("DDC3", "LS1", "data"),
    ],
  };
}

export function fixtureScan(): ScanResult {
  const big = circuits("DBX", "X", 30);
  return SCAN_RESULT.parse({
    model: "F26001-FMC-ZZ-XX-M3-E-0001.rvt",
    levels: [{ id: "L00", name: "Ground", elevation_mm: 0 }, { id: "L01", name: "First", elevation_mm: 3500 }, { id: "RF", name: "Roof", elevation_mm: 7000 }],
    diagrams: [
      {
        kind: "e_sld", system: "Electrical",
        nodes: [
          N("S1", "supply", "Utility supply", null, { voltage: "400/230 V", earthing: null }),
          N("MDB", "board", "MDB", "L00", { panel_id: "MDB", part_type: "Switchboard", distribution_system: "400/230 V 3P+N", ways: 12 }),
          N("DB1", "board", "DB-1", "L00", { panel_id: "DB-1", part_type: "Panelboard", distribution_system: "400/230 V 3P+N", ways: 12 }),
          N("DB2", "board", "DB-2", "L01", { panel_id: null, part_type: null, distribution_system: null, ways: null }),
          N("LT1", "load", "Lighting ground"), N("SK1", "load", "Sockets ground"), N("AC1", "load", "AC unit 1"),
          N("LT2", "load", "Lighting first A"), N("LT3", "load", "Lighting first B"), N("SK2", "load", "Sockets first"), N("WH2", "load", "Water heater"),
          N("LOOSE", "load", "Loose device"),
        ],
        edges: [
          E("S1", "MDB", "feeder", { cable: "4C 95 mm² SWA" }, "f0"),
          E("MDB", "DB1", "feeder", { circuit: "1", rating: 63, poles: 4, cable: "4C 16 mm² SWA", breaker: "MCCB", apparent_load: 12000 }, "f1"),
          E("MDB", "DB2", "feeder", { circuit: "2", rating: null, poles: null, cable: null, apparent_load: null }, "f2"),
          E("DB1", "LT1", "circuit", { circuit: "1", rating: 10, poles: 1, cable: "1.5 mm² T+E", load_name: "Lighting", apparent_load: 600, breaker: "MCB" }, "c11"),
          E("DB1", "SK1", "circuit", { circuit: "2", rating: 32, poles: 1, cable: "2.5 mm² T+E", load_name: "Sockets", apparent_load: 3000, breaker: "RCBO" }, "c12"),
          E("DB1", "AC1", "circuit", { circuit: "3", rating: null, poles: 2, cable: "4 mm² T+E", load_name: "AC", apparent_load: 2500 }, "c13"),
          E("DB2", "LT2", "circuit", { circuit: "1", rating: 10, poles: 1, cable: null, load_name: "Lighting", apparent_load: 400 }, "c21"),
          E("DB2", "LT3", "circuit", { circuit: "1", rating: 10, poles: 1, cable: null, load_name: "Lighting", apparent_load: 400 }, "c21b"),
          E("DB2", "SK2", "circuit", { circuit: "2", rating: null, poles: null, cable: null, load_name: null, apparent_load: null }, "c22"),
          E("DB2", "WH2", "circuit", { circuit: "3", rating: 20, poles: 2, cable: "4 mm² T+E", load_name: "Water heater", apparent_load: 3000 }, "c23"),
        ],
      },
      { kind: "e_sld", system: "Workshop", nodes: [N("DBX", "board", "DB-X", "L00", { panel_id: "DB-X", part_type: "Panelboard", distribution_system: "230 V", ways: 36 }), ...big.nodes], edges: big.edges },
      {
        kind: "e_fa_riser", system: "Fire alarm",
        nodes: [
          N("FACP", "panel", "Fire Alarm Panel", "L00", {}, "FMC_E_FireAlarmPanel"),
          N("SD1", "device", "SD-01", "L00", { zone: "1", loop: "L1" }, "FMC_E_SmokeDetector"),
          N("SD2", "device", "SD-02", "L00", { zone: "1", loop: "L1" }, "FMC_E_SmokeDetector"),
          N("SD3", "device", "SD-03", "L01", { zone: "2", loop: "L1" }, "FMC_E_SmokeDetector"),
          N("HD1", "device", "HD-01", "L00", { zone: "1", loop: "L1" }, "FMC_E_HeatDetector"),
          N("MCP1", "device", "MCP-01", "L00", { zone: "1", loop: "L1" }, "FMC_E_ManualCallPoint"),
          N("MCP2", "device", "MCP-02", "L01", { zone: "2", loop: "L1" }, "FMC_E_ManualCallPoint"),
          N("SN1", "device", "SN-01", "L01", { zone: "2", loop: "L1" }, "FMC_E_Sounder"),
          N("SD4", "device", "SD-04", "L01", { zone: null, loop: "L1" }, "FMC_E_SmokeDetector"),
          N("ODD", "other", "Mystery gadget", "L01", { zone: "2" }, "Generic Model"),
        ],
        edges: [E("FACP", "SD1", "loop"), E("SD1", "SD2", "loop"), E("SD2", "HD1", "loop"), E("HD1", "MCP1", "loop"), E("MCP1", "SD3", "loop"), E("SD3", "MCP2", "loop"), E("MCP2", "SN1", "loop")],
      },
      {
        kind: "e_elv_riser", system: "ELV",
        nodes: [
          N("NVR", "panel", "NVR-01", "L00", {}, "FMC_E_NVR"),
          N("CAM1", "device", "CAM-01", "L00", {}, "FMC_E_CCTVCamera"), N("CAM2", "device", "CAM-02", "L01", {}, "FMC_E_CCTVCamera"),
          N("DO1", "device", "DO-01", "L00", {}, "FMC_E_DataOutlet"), N("DO2", "device", "DO-02", "L01", {}, "FMC_E_DataOutlet"),
          N("AR1", "device", "AR-01", "L00", {}, "FMC_E_AccessReader"), N("DR1", "device", "DR-01", "L00", {}, "FMC_E_DoorRelease"),
        ],
        edges: [E("NVR", "CAM1", "data"), E("NVR", "CAM2", "data")],
      },
      {
        kind: "fp_schematic", system: "Hydrant and hose reel",
        nodes: [
          N("FT", "tank", "Fire water tank", "L00"), N("FP1", "pump", "Fire pump duty", "L00"), N("JP", "pump", "Jockey pump", "L00"),
          N("AV", "valve", "Alarm valve set", "L00"), N("R1", "riser", "Wet riser 1", "L00"), N("HT", "tank", "Header tank", "RF"),
          N("LV0", "valve", "Landing valve G", "L00"), N("LV1", "valve", "Landing valve 1", "L01"),
          N("HR0", "hose_reel", "Hose reel G", "L00"), N("HR1", "hose_reel", "Hose reel 1", "L01"), N("BI", "inlet", "Breeching inlet", "L00"),
        ],
        edges: [
          E("FT", "FP1", "pipe", { size: "DN150" }), E("FT", "JP", "pipe", { size: "DN50" }), E("FP1", "AV", "pipe", { size: "DN150" }),
          E("AV", "R1", "pipe", { size: "DN100" }), E("HT", "R1", "pipe", { size: "DN100" }), E("BI", "R1", "pipe", { size: null }),
          E("R1", "LV0", "pipe", { size: "DN65" }), E("R1", "LV1", "pipe", { size: null }), E("R1", "HR0", "pipe", { size: "DN25" }), E("R1", "HR1", "pipe", { size: "DN25" }),
        ],
      },
      {
        kind: "p_water", system: "Domestic cold water",
        nodes: [
          N("WT", "tank", "Cold water tank", "RF"), N("BP", "pump", "Booster set", "L00"), N("WM", "meter", "Water meter", "L00"), N("CWR", "riser", "CW riser", "L00"),
          N("WC0", "fixture", "WC G", "L00", {}, "FMC_P_WC"), N("WC1", "fixture", "WC 1", "L01", {}, "FMC_P_WC"),
          N("WHB0", "fixture", "Basin G", "L00", {}, "FMC_P_WashHandBasin"), N("SNK1", "fixture", "Sink 1", "L01", {}, "FMC_P_KitchenSink"),
        ],
        edges: [E("WM", "BP", "pipe", { size: "32 mm" }), E("BP", "CWR", "pipe", { size: "32 mm" }), E("WT", "CWR", "pipe", { size: "40 mm" }),
          E("CWR", "WC0", "pipe", { size: "15 mm" }), E("CWR", "WC1", "pipe", { size: "15 mm" }), E("CWR", "WHB0", "pipe", { size: "15 mm" }), E("CWR", "SNK1", "pipe", { size: null })],
      },
      {
        kind: "p_drainage", system: "Soil and waste",
        nodes: [
          N("SVP", "stack", "SVP-1", "L00"), N("D-WC0", "fixture", "WC G", "L00", {}, "FMC_P_WC"), N("D-WC1", "fixture", "WC 1", "L01", {}, "FMC_P_WC"),
          N("D-SH1", "fixture", "Shower 1", "L01", {}, "FMC_P_ShowerTray"), N("MH1", "equipment", "Manhole MH1", "L00"), N("ST", "tank", "Septic tank", "L00"),
          N("SA", "equipment", "Soakaway", "L00"),
        ],
        edges: [E("D-WC1", "SVP", "pipe", { size: "100 mm" }), E("D-SH1", "SVP", "pipe", { size: "50 mm" }), E("D-WC0", "SVP", "pipe", { size: "100 mm" }),
          E("SVP", "MH1", "pipe", { size: "100 mm" }), E("MH1", "ST", "pipe", { size: "100 mm" }), E("ST", "SA", "pipe", { size: null })],
      },
      {
        kind: "m_refrigerant", system: "VRF 1",
        nodes: [
          N("ODU1", "outdoor_unit", "ODU-1", "RF"), N("BJ1", "equipment", "Branch joint 1", "L01"),
          N("IDU1", "indoor_unit", "IDU-01", "L01", { capacity: "2.8 kW" }), N("IDU2", "indoor_unit", "IDU-02", "L01", { capacity: null }),
          N("IDU3", "indoor_unit", "IDU-03", "L00", { capacity: "5.6 kW" }), N("CD1", "other", "Condensate drain point", "L01"),
        ],
        edges: [
          E("ODU1", "BJ1", "refrigerant", { liquid_size: "9.52", gas_size: "15.88" }), E("BJ1", "IDU1", "refrigerant", { liquid_size: "6.35", gas_size: "12.7" }),
          E("BJ1", "IDU2", "refrigerant", { liquid_size: null, gas_size: null }), E("ODU1", "IDU3", "refrigerant", { liquid_size: "9.52", gas_size: "15.88" }),
          E("IDU1", "CD1", "condensate", { size: "20 mm" }),
        ],
      },
      {
        kind: "lp_schematic", system: "Lightning protection",
        nodes: [
          N("AT1", "air_terminal", "AT-1", "RF"), N("AT2", "air_terminal", "AT-2", "RF"), N("AT3", "air_terminal", "AT-3", "RF"),
          N("DC1", "down_conductor", "DC-1"), N("DC2", "down_conductor", "DC-2"),
          N("TJ1", "test_joint", "TJ-1"), N("TJ2", "test_joint", "TJ-2"),
          N("EP1", "earth_pit", "EP-1", null, { resistance: null }), N("EP2", "earth_pit", "EP-2", null, { resistance: "4.2 ohm" }),
          N("MET", "earth_bar", "MET"), N("SPD1", "spd", "SPD at MDB"), N("BD1", "bond", "Bond to water main"),
        ],
        edges: [E("AT1", "DC1", "conductor"), E("AT2", "DC1", "conductor"), E("AT3", "DC2", "conductor"), E("DC1", "TJ1", "conductor"), E("DC2", "TJ2", "conductor"),
          E("TJ1", "EP1", "conductor"), E("TJ2", "EP2", "conductor"), E("EP1", "MET", "conductor"), E("EP2", "MET", "conductor"), E("MET", "SPD1", "bond"), E("MET", "BD1", "bond")],
      },
      controlsDiagram(),
    ],
    gaps: [{ kind: "e_sld", element_id: "DB2", message: "Circuit 2 has no rating" }],
  });
}

const views = (plan: Plan, kind: DiagramKind) => plan.views.filter((v) => v.view.kind === kind);
const texts = (plan: Plan, kind: DiagramKind) => views(plan, kind).flatMap((v) => v.view.items).filter((i) => i.t === "text").map((i) => (i as { text: string }).text);

// ---------------------------------------------------------------------------------------------------------------

test("every diagram kind lays out, with no collisions and a valid DRAW_SPEC", () => {
  const plan = layoutScan(fixtureScan());
  for (const k of DIAGRAM_KINDS) assert.ok(views(plan, k).length >= 1, `${k} has a view`);
  for (const v of plan.views) assert.deepEqual(v.collisions, [], `${v.view.name} has no collisions`);
  assert.ok(DRAW_SPEC.safeParse(drawSpec(plan, true)).success);
  const names = plan.views.map((v) => v.view.name);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, "view names are unique");
  assert.ok(names.includes("E-SLD-MDB") && names.includes("E-FA-Riser") && names.includes("LP-Schematic"));
});

test("layouts are deterministic, whatever order the scan lists things in", () => {
  const a = JSON.stringify(layoutScan(fixtureScan()));
  assert.equal(JSON.stringify(layoutScan(fixtureScan())), a);
  const shuffled = fixtureScan();
  for (const d of shuffled.diagrams) { d.nodes.reverse(); d.edges.reverse(); }
  shuffled.levels.reverse();
  assert.equal(JSON.stringify(layoutScan(shuffled)), a);
});

test("every node appears: drawn once, or counted, labelled or listed", () => {
  const scan = fixtureScan();
  const plan = layoutScan(scan);
  for (const d of scan.diagrams) {
    const vs = views(plan, d.kind);
    const covered = new Set(vs.flatMap((v) => v.covered));
    for (const n of d.nodes) assert.ok(covered.has(n.id), `${d.kind}: ${n.id} (${n.name}) is shown`);
    for (const v of vs) {
      const symbols = v.view.items.filter((i) => i.t === "symbol" && i.source_id);
      for (const n of d.nodes) assert.ok(symbols.filter((s) => s.source_id === n.id).length <= 1, `${v.view.name}: ${n.id} drawn at most once`);
    }
    // across views only a board repeats, at the head of its continuation view
    const drawnIn = new Map<string, number>();
    for (const v of vs) for (const i of v.view.items) if (i.t === "symbol" && i.source_id) drawnIn.set(i.source_id, (drawnIn.get(i.source_id) ?? 0) + 1);
    for (const n of d.nodes) if ((drawnIn.get(n.id) ?? 0) > 1) assert.ok(n.kind === "board" && vs.some((v) => v.view.name.endsWith("-2")), `${n.id} repeats only as a continued board`);
  }
  // counted devices: the fire alarm zone chart says ×2 for the two smoke detectors in zone 1 on the ground floor
  assert.ok(texts(plan, "e_fa_riser").includes("×2"));
  // the loose load is listed in the notes, not dropped
  assert.ok(texts(plan, "e_sld").some((t) => t.includes("Not on any board in the model (1): Loose device")));
});

test("TBC is printed for nulls and listed in the notes; nothing is computed", () => {
  const plan = layoutScan(fixtureScan());
  const mdb = plan.views.find((v) => v.view.name === "E-SLD-MDB")!;
  const all = mdb.view.items.filter((i) => i.t === "text").map((i) => (i as { text: string }).text);
  assert.ok(all.some((t) => t.includes("Rating TBC") && t.includes("To DB-2")), "the DB-2 feeder's rating prints TBC");
  assert.ok(all.some((t) => t.includes("Panel ID: TBC")), "DB-2's panel id prints TBC");
  const notes = all.find((t) => t.startsWith("Every value comes from the model"))!;
  assert.ok(notes.includes("- MDB circuit 2: rating TBC"));
  assert.ok(notes.includes("- DB-2: panel ID TBC"));
  assert.ok(notes.includes("- DB-2 circuit 2: apparent load TBC"));
  // no load name on the circuit: the load's own name from the model, not TBC
  assert.ok(all.some((t) => t.startsWith("Ckt 2\nRating TBC · Poles TBC · MCB (type TBC)\nCable TBC\nSockets first · load TBC")));
  assert.ok(mdb.tbc > 0);
  // a load with no rating is never given one: the 600 VA lighting circuit keeps its model values only
  assert.ok(all.some((t) => t.includes("10 A · 1P · MCB") && t.includes("Lighting · 600 VA")));
  // DB-2 circuit 1 feeds two lights: one way, both loads
  assert.ok(all.some((t) => t.startsWith("Ckt 1\n10 A") && t.includes("Lighting · 400 VA")));
  // fire alarm: a device without a zone goes in "Zone TBC" and the zone is listed
  assert.ok(texts(plan, "e_fa_riser").some((t) => t.startsWith("Zone TBC")));
  assert.ok(texts(plan, "e_fa_riser").some((t) => t.includes("Fire alarm devices") || t.includes("zone")));
  // refrigerant: IDU-02's sizes and capacity are TBC
  assert.ok(texts(plan, "m_refrigerant").some((t) => t.startsWith("IDU-02") && t.includes("Liquid TBC · Gas TBC") && t.includes("capacity: TBC")));
  // fire fighting: the landing valve on the first floor has no pipe size
  assert.ok(texts(plan, "fp_schematic").some((t) => t.includes("×1") && t.includes("TBC")));
});

test("breakers: only what the model says; unknown is MCB with the type TBC", () => {
  assert.equal(breakerFor(E("a", "b", "circuit", { breaker: "MCCB 3P" }) as any).type, "MCCB");
  assert.equal(breakerFor(E("a", "b", "circuit", { breaker: "RCBO 30mA" }) as any).type, "RCD");
  const u = breakerFor(E("a", "b", "circuit", { rating: 160 }) as any);
  assert.deepEqual([u.type, u.known], ["MCB", false], "a 160 A rating doesn't make it an MCCB");
  const plan = layoutScan(fixtureScan());
  const t = texts(plan, "e_sld");
  assert.ok(t.some((x) => x.includes("· MCCB\n") && x.includes("To DB-1")));
  assert.ok(t.some((x) => x.includes("MCB (type TBC)")));
});

test("symbols come from the kit table; an unknown node is a plain box with a warning", () => {
  const plan = layoutScan(fixtureScan());
  const allowed = new Set(tableSymbols().map((s) => `${s.family}:${s.type}`));
  for (const v of plan.views) for (const i of v.view.items) if (i.t === "symbol") assert.ok(allowed.has(`${i.family}:${i.type}`), `${i.family}:${i.type} is in the table`);
  const fa = views(plan, "e_fa_riser")[0];
  assert.ok(fa.warnings.some((w) => w.includes("No kit symbol for other / Generic Model")));
  assert.ok(fa.view.items.some((i) => i.t === "text" && i.text === "Mystery gadget"));
  assert.ok(fa.view.items.some((i) => i.t === "line" && i.source_id === "ODD" && i.points.length === 5), "drawn as a closed box");
  const fams = (k: DiagramKind) => new Set(views(plan, k).flatMap((v) => v.view.items).filter((i) => i.t === "symbol").map((i) => (i as { family: string }).family));
  assert.ok(fams("e_fa_riser").has("FMC_SYM_E_SmokeDetector") && fams("e_fa_riser").has("FMC_SYM_E_FireAlarmPanel"));
  assert.ok(fams("fp_schematic").has("FMC_SYM_FP_FirePump") && fams("fp_schematic").has("FMC_SYM_FP_JockeyPump") && fams("fp_schematic").has("FMC_SYM_FP_LandingValveRiserOutlet"));
  assert.ok(fams("p_drainage").has("FMC_SYM_P_Manhole") && fams("p_drainage").has("FMC_SYM_P_Soakaway"));
  assert.ok(fams("lp_schematic").has("FMC_SYM_LP_MainEarthingTerminal"));
  // a generic fixture keeps its own name beside the count
  assert.ok(texts(plan, "p_water").some((t) => t.startsWith("×1 FMC_P_KitchenSink")));
  // rules see Revit names as words
  const tv = symbolFor(SCAN_RESULT.parse({ model: "", levels: [], gaps: [], diagrams: [{ kind: "e_elv_riser", system: "", edges: [],
    nodes: [N("t", "device", "TV-1", null, {}, "FMC_E_TVCoaxialOutlet")] }] }).diagrams[0].nodes[0], "e_elv_riser");
  assert.equal(tv.t === "symbol" && tv.family, "FMC_SYM_E_TVCoaxialOutlet");
});

test("a board with more than 24 ways continues on a second view", () => {
  const plan = layoutScan(fixtureScan());
  const a = plan.views.find((v) => v.view.name === "E-SLD-DB-X")!, b = plan.views.find((v) => v.view.name === "E-SLD-DB-X-2")!;
  assert.ok(a && b);
  const breakers = (v: typeof a) => v.view.items.filter((i) => i.t === "symbol" && i.family === "FMC_DI_E_SLD_Breaker" && i.source_id).length; // not the legend's
  assert.equal(breakers(a), 24);
  assert.equal(breakers(b), 6);
  assert.ok(a.view.items.some((i) => i.t === "text" && i.text === "Ways 25-30 continued on E-SLD-DB-X-2"));
  assert.ok(b.view.items.some((i) => i.t === "text" && i.text.includes("Continued from E-SLD-DB-X")));
});

test("levels run top down and the riser sizes sit between them", () => {
  const plan = layoutScan(fixtureScan());
  const fa = views(plan, "e_fa_riser")[0].view.items.filter((i) => i.t === "text") as Array<{ text: string; at: number[] }>;
  const y = (s: string) => fa.find((t) => t.text.startsWith(s))!.at[1];
  assert.ok(y("Roof") > y("First") && y("First") > y("Ground"));
  const fp = texts(plan, "fp_schematic");
  assert.ok(fp.includes("DN100"), "header tank to riser size beside the riser");
  assert.ok(fp.some((t) => t.includes("\nPipework Fire water tank to Fire pump duty: DN150")), "plant pipework in the notes");
});

function powerScan(): ScanResult {
  const levels = [{ id: "GF", name: "Ground floor", elevation_mm: 0 }, { id: "FF", name: "First floor", elevation_mm: 3500 },
    { id: "SF", name: "Second floor", elevation_mm: 7000 }, { id: "RF", name: "Roof", elevation_mm: 10500 }];
  const board = (id: string, name: string, level: string, p: P) => N(id, "board", name, level, { part_type: "Panelboard", ways: 12, ...p });
  return SCAN_RESULT.parse({
    model: "F26001-FMC-ZZ-XX-M3-E-0002.rvt", levels, gaps: [],
    diagrams: [{
      kind: "e_sld", system: "Power",
      nodes: [
        N("SUP", "supply", "Utility supply", null, { voltage: "400/230 V" }),
        board("MDB", "MDB", "GF", { panel_id: "MDB", part_type: "Switchboard" }),
        board("DBGF", "DB-GF", "GF", { panel_id: "DB-GF" }), board("DBFF", "DB-FF", "FF", { panel_id: "DB-FF" }),
        board("DBSF", "DB-SF", "SF", { panel_id: null, ways: null }), board("PP", "Pump panel", "RF", { panel_id: "PP-1" }),
        N("L1", "load", "Lights GF"), N("L2", "load", "Sockets FF"),
      ],
      edges: [
        E("SUP", "MDB", "feeder", {}, "e0"),
        E("MDB", "DBGF", "feeder", { circuit: "1", rating: 63, poles: 4, cable: "4C 16 mm² SWA", breaker: "MCCB" }, "e1"),
        E("MDB", "DBFF", "feeder", { circuit: "2", rating: 63, poles: 4, cable: "4C 16 mm² SWA", breaker: "MCCB" }, "e2"),
        E("MDB", "DBSF", "feeder", { circuit: "3", rating: null, poles: null, cable: null }, "e3"),
        E("MDB", "PP", "feeder", { circuit: "4", rating: 32, poles: 4, cable: "4C 6 mm² SWA", breaker: "MCB" }, "e4"),
        E("DBGF", "L1", "circuit", { circuit: "1", rating: 10, poles: 1 }, "c1"), E("DBFF", "L2", "circuit", { circuit: "1", rating: 32, poles: 1 }, "c2"),
      ],
    }],
  });
}

test("power riser: boards on their levels, feeders labelled, circuits left to the SLD", () => {
  const plan = layoutScan(powerScan());
  const v = plan.views.find((x) => x.view.name === "E-Power-Riser")!;
  assert.ok(v, "one power riser view");
  assert.deepEqual(v.collisions, []);
  const items = v.view.items;
  const txt = items.filter((i) => i.t === "text") as Array<{ text: string; at: number[]; source_id: string | null }>;
  const sym = (id: string) => items.find((i) => i.t === "symbol" && i.source_id === id) as { at: number[]; family: string; type: string } | undefined;
  for (const id of ["MDB", "DBGF", "DBFF", "DBSF", "PP"]) assert.ok(sym(id), `${id} is drawn`);
  assert.equal(sym("MDB")!.type, "MDB");
  // levels: roof above second above first above ground; ground boards side by side
  assert.ok(sym("PP")!.at[1] > sym("DBSF")!.at[1] && sym("DBSF")!.at[1] > sym("DBFF")!.at[1] && sym("DBFF")!.at[1] > sym("MDB")!.at[1]);
  assert.equal(sym("MDB")!.at[1], sym("DBGF")!.at[1]);
  assert.ok(sym("DBGF")!.at[0] > sym("MDB")!.at[0]);
  // final circuits are not drawn
  assert.ok(!items.some((i) => i.source_id === "L1" || i.source_id === "c1"));
  // feeder labels, TBC when null, and the SLD cross-reference
  assert.ok(txt.some((t) => t.text.includes("From MDB ckt 1: 63 A · 4P · MCCB") && t.text.includes("Cable: 4C 16 mm² SWA") && t.text.includes("See E-SLD-MDB")));
  assert.ok(txt.some((t) => t.text.includes("From MDB ckt 3: Rating TBC · Poles TBC · MCB (type TBC)") && t.text.includes("Cable: TBC")));
  assert.ok(txt.some((t) => t.text === "DB-SF"), "no panel ID: the board name");
  const notes = txt.find((t) => t.text.startsWith("Every value comes from the model"))!.text;
  assert.ok(notes.includes("- DB-SF feeder: rating TBC") && notes.includes("- DB-SF: number of ways TBC"));
  // the roof pump panel is fed up a riser line from the MDB
  assert.ok(items.some((i) => i.t === "line" && i.source_id === "e4" && i.points[i.points.length - 1][1] < sym("PP")!.at[1]));
  assert.equal(JSON.stringify(layoutScan(powerScan()).views), JSON.stringify(plan.views), "deterministic");
});

test("the collision check catches overlaps and a line through text", () => {
  const view = { name: "T", kind: "e_sld" as const, scale: 50, sheet_hint: null, items: [
    { t: "text" as const, at: [0, 0], text: "ABCDEFGH", style: "FMC_Arial_2.5", align: "left" as const, source_id: null, rotation_deg: 0 },
    { t: "symbol" as const, family: "FMC_SYM_E_Sounder", type: "Standard", at: [5, -1], rotation_deg: 0, source_id: null, params: {} },
    { t: "line" as const, points: [[2, 5], [2, -10]], style: "FMC_Thin", source_id: null },
  ] };
  assert.equal(collisions(view).length, 2);
  const rotated = textBox([10, 0], "ABCD", "FMC_Arial_2.5", "right", 90);
  assert.ok(rotated.x0 >= 10 - 1e-9 && rotated.y1 <= 0 + 1e-9 && rotated.y0 < -7, "a right-aligned label turned 90° hangs below its anchor");
  assert.ok(!segmentHitsBox([0, 1], [10, 1], { x0: 0, y0: -1, x1: 10, y1: 0.5 }));
});

test("the kit file overrides the default; mistakes are reported, never fatal", () => {
  const { kit, problems } = mergeKit(DEFAULT_DIAGRAM_KIT, {
    styles: { lines: { wide: "FMC_Busbar" } },
    symbols: [{ kinds: ["device"], match: "smoke", family: "FMC_SYM_E_SmokeDetector", type: "Standard", label: "Smoke" }, { kinds: ["device"], match: "(", family: "X", type: "Y", label: "bad" }],
  });
  assert.equal(kit.styles.lines.wide, "FMC_Busbar");
  assert.equal(kit.styles.lines.thin, "FMC_Thin");
  assert.equal(kit.symbols.length, 1);
  assert.equal(problems.length, 1);
  assert.equal(loadDiagramKit("nowhere.json", () => { throw new Error("missing"); }).source, "default");
  assert.equal(loadDiagramKit("x.json", () => "{ not json").problems.length, 1);
  const plan = layoutScan(fixtureScan(), kit, ["e_sld"]);
  assert.ok(plan.views[0].view.items.some((i) => i.t === "line" && i.style === "FMC_Busbar"));
});

test("the fixture tests/fixtures/FMC_Diagram_Symbols.json is the default table", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(fixture, JSON.parse(JSON.stringify(DEFAULT_DIAGRAM_KIT)));
  assert.equal(loadDiagramKit(FIXTURE).problems.length, 0);
});

test("plan summary: counts per view, no geometry", () => {
  const s = planSummary(layoutScan(fixtureScan()));
  const mdb = s.find((v) => v.name === "E-SLD-MDB")!;
  assert.ok(mdb.items.symbols > 0 && mdb.items.texts > 0 && mdb.tbc > 0 && mdb.collisions === 0);
});

test("fmc_diagram_draw is behind the live-model lock; the tool refuses a real draw without confirm", async () => {
  assert.ok(WRITE_COMMANDS.has("fmc_diagram_draw"));
  assert.ok(!WRITE_COMMANDS.has("fmc_diagram_scan"));
  const { runFmcDiagram, FMC_DIAGRAM_DESCRIPTION } = await import("../../tools/fmc_diagram.js");
  const r = await runFmcDiagram({ action: "draw", kinds: [], kit_folder: "", views: [], save: false, dry_run: false, confirm: false });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).refused, true);
  assert.ok(FMC_DIAGRAM_DESCRIPTION.includes("_Staging and _ChainTests") && FMC_DIAGRAM_DESCRIPTION.includes("presses Generate in the pane"));
});

test("controls: head end at the base, DDC controllers on their levels, points counted, gaps listed", () => {
  const scan = fixtureScan();
  const plan = layoutScan(scan, DEFAULT_DIAGRAM_KIT, ["m_controls"]);
  const riser = plan.views.find((v) => v.view.name === "M-Controls-Riser")!, points = plan.views.find((v) => v.view.name === "M-Controls-Points")!;
  assert.ok(riser && points, "a riser and a points list");
  assert.deepEqual(riser.collisions, []);
  assert.deepEqual(points.collisions, []);
  const items = riser.view.items;
  const sym = (id: string) => items.find((i) => i.t === "symbol" && i.source_id === id) as { at: number[]; family: string } | undefined;
  assert.equal(sym("HE")!.family, "FMC_SYM_M_BMSController");
  for (const id of ["DDC1", "DDC2", "DDC3"]) assert.equal(sym(id)!.family, "FMC_SYM_M_DDCController");
  // levels top down; the head end under every band
  assert.ok(sym("DDC3")!.at[1] > sym("DDC2")!.at[1] && sym("DDC2")!.at[1] > sym("DDC1")!.at[1] && sym("DDC1")!.at[1] > sym("HE")!.at[1]);
  const txt = items.filter((i) => i.t === "text").map((i) => (i as { text: string }).text);
  // points by type, by kit symbol
  assert.ok(txt.some((t) => t.includes("Protocol: BACnet MS/TP\nPoints 4: AI 2 · AO 1 · DI 1 · DO 0\nSee M-Controls-Points")), "DDC-01 counts");
  assert.ok(txt.some((t) => t.includes("Points 4: AI 0 · AO 1 · DI 2 · DO 1")), "DDC-03 counts");
  assert.ok(txt.some((t) => t === "DDC-03") && txt.some((t) => t.includes("Protocol: TBC")), "no protocol: TBC");
  assert.ok(txt.some((t) => t.startsWith("BMS-01\nLevel: Ground\nBACnet/IP backbone")), "head end level and backbone");
  assert.equal(txt.filter((t) => t === "BACnet MS/TP").length, 2, "each link labelled with its protocol");
  assert.ok(txt.includes("Protocol TBC"), "the DDC-03 link has no protocol");
  const fams = new Set(items.filter((i) => i.t === "symbol").map((i) => (i as { family: string }).family));
  for (const f of ["FMC_SYM_M_Sensor", "FMC_SYM_M_Actuator", "FMC_SYM_E_VFD", "FMC_SYM_E_MotorStarter", "FMC_SYM_M_RoomThermostatController", "FMC_SYM_E_OccupancyPIRSensor"])
    assert.ok(fams.has(f), `${f} used`);
  assert.ok(txt.includes("×2") , "two VFD points on DDC-03");
  // gaps: no controller id, an id that matches no controller
  const notes = txt.find((t) => t.startsWith("Every value comes from the model"))!;
  assert.ok(notes.includes("Points with no FMC_Controller_ID (1): FS1."));
  assert.ok(notes.includes('FMC_Controller_ID "DDC-09" matches no controller in the model (1): XX1.'));
  assert.ok(notes.includes("- DDC-03: protocol TBC"));
  // the points list: a table per controller, TBC for the missing signal
  const ptxt = points.view.items.filter((i) => i.t === "text").map((i) => (i as { text: string }).text);
  assert.ok(ptxt.includes("DDC-02 · BACnet MS/TP · 2 points"));
  assert.ok(ptxt.includes("Signal\nTBC\n0-10V"), "TS2 has no signal");
  assert.ok(ptxt.some((t) => t.startsWith("Every value comes from the model") && t.includes("- Duct Temperature Sensor: signal TBC")));
  assert.ok(points.tbc > 0 && riser.tbc > 0);
  // deterministic, whatever order the scan lists things in
  const shuffled = fixtureScan();
  for (const d of shuffled.diagrams) { d.nodes.reverse(); d.edges.reverse(); }
  shuffled.levels.reverse();
  assert.equal(JSON.stringify(layoutScan(shuffled, DEFAULT_DIAGRAM_KIT, ["m_controls"])), JSON.stringify(plan));
});

test("controls: more points than the kit's maximum list counts only and refer to the schedule", () => {
  const scan = fixtureScan();
  const d = scan.diagrams.find((x) => x.kind === "m_controls")!;
  for (let i = 1; i <= 45; i++) {
    d.nodes.push(SCAN_RESULT.shape.diagrams.element.shape.nodes.element.parse(N(`P${i}`, "sensor", `Sensor ${i}`, "L01", { controller_id: "DDC-02", point_type: i % 2 ? "AI" : "DI", signal: "0-10V", mark: `S-${i}` })));
    d.edges.push(SCAN_RESULT.shape.diagrams.element.shape.edges.element.parse(E("DDC2", `P${i}`, "data")));
  }
  const plan = layoutScan(scan, DEFAULT_DIAGRAM_KIT, ["m_controls"]);
  for (const v of plan.views) assert.deepEqual(v.collisions, [], v.view.name);
  const ptxt = plan.views.find((v) => v.view.name === "M-Controls-Points")!.view.items.filter((i) => i.t === "text").map((i) => (i as { text: string }).text);
  assert.ok(ptxt.includes("Points 47: AI 24 · AO 1 · DI 22 · DO 0\nMore than 40 points: see M15_Controls_Points"));
  assert.ok(ptxt.includes("DDC-01 · BACnet MS/TP · 4 points"), "the others still list their points");
});
