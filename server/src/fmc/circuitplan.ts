/**
 * fmc_circuits, the part that does not need Revit.
 * Devices are grouped by room, then level, then circuit kind. Lighting and sockets are never on one circuit.
 * A standards-bank key that is missing is PROVISIONAL and uses the stated default. It is not a pass.
 */
import { citeLimit, phaseLimits, type TraceBankEntry } from "./trace_bank.js";

export const CIRCUIT_KINDS = ["L", "R", "AC", "SH", "STAIR"] as const;
export type CircuitKind = (typeof CIRCUIT_KINDS)[number];

export const TARGET_DISTRIBUTION = "DS_415-240V_3Ph_4W";
export const FINAL_VOLTAGE_V = 240;
export const DEFAULT_NAME_PATTERN = "{board}/{zone}-{type}{n}";

export interface CapField {
  key: string;
  value: number;
  provisional: boolean;
  clause: string;
}

export interface CircuitCap {
  kind: CircuitKind;
  breaker_a: CapField;
  cable_mm2: CapField;
  poles: number;
  voltage_v: CapField;
  curve: string;
  max_points: CapField | null;
  max_load_w: CapField | null;
  max_area_m2: CapField | null;
  provisional: boolean;
}

export interface CircuitDevice {
  id: number;
  name?: string;
  family?: string;
  type_name?: string;
  category?: string;
  level?: string;
  room?: string;
  room_id?: number;
  mark?: string;
  part_type?: string;
  load_va?: number;
  load_w?: number;
  voltage?: number;
  poles?: number;
  /** Voltage read from the power connector. SelectPanel compares this with the panel distribution system. */
  connector_voltage?: number;
  /** Poles read from RBS_ELEC_NUMBER_OF_POLES. Connector has no poles property in Revit 2025. */
  connector_poles?: number;
  has_connector?: boolean;
  system_type?: string;
  circuit_ids?: number[];
  x?: number;
  y?: number;
  z?: number;
  is_switch?: boolean;
  is_direct_shape?: boolean;
  room_area_m2?: number;
  /** Set when the family is a panel: part type, or a panel-schedule connector. */
  is_board?: boolean;
  schedule_capable?: boolean;
  distribution?: string;
  /** Line-to-line voltage of the panel DistributionSysType, in volts. */
  voltage_ll?: number;
  /** Line-to-ground voltage of the panel DistributionSysType, in volts. */
  voltage_lg?: number;
  /** ElectricalPhase name: ThreePhase, SinglePhase, or empty. */
  phase?: string;
  wires?: number;
}

export interface CircuitPanel {
  id: number;
  name: string;
  level?: string;
  x?: number;
  y?: number;
  z?: number;
  distribution?: string;
  voltage?: number;
  voltage_ll?: number;
  voltage_lg?: number;
  phase?: string;
  wires?: number;
  has_supply?: boolean;
  utility_fed?: boolean;
  part_type?: string;
  is_board?: boolean;
}

export interface ExistingCircuit {
  id: number;
  name?: string;
  panel_id?: number;
  panel_name?: string;
  load_va?: number;
  load_w?: number;
  voltage?: number;
  poles?: number;
  phase?: string;
  rating_a?: number;
  points?: number;
  kind?: string;
  level?: string;
  element_ids?: number[];
}

export interface PlannedCircuit {
  name: string;
  kind: CircuitKind;
  panel_id: number;
  panel_name: string;
  level: string;
  room: string;
  phase: "L1" | "L2" | "L3";
  slot: string;
  load_w: number;
  load_va: number;
  points: number;
  area_m2: number | null;
  breaker_a: number;
  curve: string;
  cable_mm2: number;
  poles: number;
  voltage_v: number;
  element_ids: number[];
  provisional: boolean;
  flags: string[];
}

export interface DistributionFix {
  code: "FMC-PANEL-NO-DISTRIBUTION";
  panel_id: number;
  panel: string;
  hint: string;
  dry_run: true;
  plan: Array<{ op: "set_parameter"; parameter: "Distribution System"; built_in: "RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM"; value: string; panel_id: number }>;
}

export const DISTRIBUTION_HINT = "Set the Distribution System parameter (RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM) on the board.";

/** Panelboard, Switchboard or Other Panel, in the API spelling or the dialog spelling. */
export function isPanelPart(part: string | undefined): boolean {
  return /^(panelboard|switchboard|otherpanel)$/i.test((part ?? "").replace(/[\s_]/g, ""));
}

/** Electrical equipment Revit can take as a circuit panel. A board family is not refused for lacking the word board. */
export function isBoardEquipment(device: Pick<CircuitDevice, "is_board" | "schedule_capable" | "part_type" | "category">): boolean {
  if (device.is_board === true || device.schedule_capable === true) return true;
  if (!isPanelPart(device.part_type)) return false;
  const category = (device.category ?? "").toLowerCase();
  return category.length === 0 || /electrical equipment/.test(category);
}

export function distributionFix(panel: Pick<CircuitPanel, "id" | "name">, distribution: string): DistributionFix {
  const value = (distribution || TARGET_DISTRIBUTION).trim() || TARGET_DISTRIBUTION;
  return {
    code: "FMC-PANEL-NO-DISTRIBUTION",
    panel_id: panel.id,
    panel: panel.name,
    hint: DISTRIBUTION_HINT,
    dry_run: true,
    plan: [{
      op: "set_parameter",
      parameter: "Distribution System",
      built_in: "RBS_FAMILY_CONTENT_DISTRIBUTION_SYSTEM",
      value,
      panel_id: panel.id,
    }],
  };
}

export interface CircuitSkip {
  id: number;
  code: string;
  detail: string;
}

/** One row per connector voltage and pole count that no panel can accept. */
export interface CircuitMismatch {
  code: "FMC-CIRCUIT-PANEL-MISMATCH";
  voltage_v: number;
  poles: number;
  panel_id: number;
  panel_name: string;
  panel_voltage_ll: number;
  panel_voltage_lg: number;
  panel_phase: string;
  count: number;
  ids: number[];
  families: string[];
  detail: string;
}

/** Devices with no electrical connector, grouped so a family can be fixed once. */
export interface NoConnectorFamily {
  code: "FMC-NO-CONNECTOR";
  family: string;
  category: string;
  count: number;
  ids: number[];
}

export interface CircuitPlan {
  circuits: PlannedCircuit[];
  skipped: CircuitSkip[];
  switches: Array<{ switch_id: number; light_ids: number[]; room: string; level: string }>;
  caps: CircuitCap[];
  phase: { L1: number; L2: number; L3: number; imbalance_pct: number | null; limit_pct: number; provisional: boolean; clause: string };
  voltage_drop: CapField;
  counts: { devices: number; planned: number; skipped: number; points: number; no_connector: number; mismatched: number };
  rule: string;
  /** Boards that cannot take a circuit until Distribution System is set. The plan does not write it. */
  distribution_plans: DistributionFix[];
  /** Groups SelectPanel would refuse because the distribution voltage or poles do not match the connector. */
  mismatches: CircuitMismatch[];
  no_connector_families: NoConnectorFamily[];
}

export interface AuditFinding {
  code: string;
  id?: number;
  level?: string;
  category?: string;
  detail: string;
}

const POWER = /power/;
const NOT_POWER = /data|telephone|phone|fire|security|communication|controls|nurse/;

function field(key: string, fallback: number, bank?: Record<string, TraceBankEntry>, override?: number): CapField {
  if (typeof override === "number" && Number.isFinite(override)) {
    return { key, value: override, provisional: false, clause: "Passed on this call." };
  }
  const cited = citeLimit(key, bank);
  if (cited.value == null || cited.source !== "standards") {
    const value = cited.value == null ? fallback : cited.value;
    return { key, value, provisional: true, clause: cited.value == null ? `PROVISIONAL default ${fallback}. ${cited.clause}` : `PROVISIONAL. ${cited.clause}` };
  }
  return { key, value: cited.value, provisional: false, clause: cited.clause };
}

function curveOf(key: string, fallback: string, bank?: Record<string, TraceBankEntry>): string {
  const raw = bank?.[key]?.value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

export function circuitCaps(bank?: Record<string, TraceBankEntry>, overrides: Partial<Record<string, number>> = {}): CircuitCap[] {
  const voltage = field("trace.circuit.voltage_v", FINAL_VOLTAGE_V, bank, overrides.voltage_v);
  const row = (kind: CircuitKind, curve: string, breaker: number, cable: number, points: number | null, load: number | null, area: number | null): CircuitCap => {
    const prefix = `trace.circuit.${kind.toLowerCase()}`;
    const breaker_a = field(`${prefix}.breaker_a`, breaker, bank, overrides[`${kind}.breaker_a`]);
    const cable_mm2 = field(`${prefix}.cable_mm2`, cable, bank, overrides[`${kind}.cable_mm2`]);
    const max_points = points == null ? null : field(`${prefix}.max_points`, points, bank, overrides[`${kind}.max_points`]);
    const max_load_w = load == null ? null : field(`${prefix}.max_load_w`, load, bank, overrides[`${kind}.max_load_w`]);
    const max_area_m2 = area == null ? null : field(`${prefix}.max_area_m2`, area, bank, overrides[`${kind}.max_area_m2`]);
    const provisional = [breaker_a, cable_mm2, voltage, max_points, max_load_w, max_area_m2].some((item) => item?.provisional);
    return { kind, breaker_a, cable_mm2, poles: 1, voltage_v: voltage, curve: curveOf(`${prefix}.curve`, curve, bank), max_points, max_load_w, max_area_m2, provisional };
  };
  return [
    row("L", "B", 6, 1.5, 10, 1000, null),
    row("R", "B", 32, 2.5, 10, null, 100),
    row("AC", "C", 16, 2.5, 1, null, null),
    row("SH", "B", 32, 6, 1, null, null),
    row("STAIR", "B", 6, 1.5, 10, 1000, null),
  ];
}

export function voltageDropLimit(bank?: Record<string, TraceBankEntry>): CapField {
  return field("trace.voltage_drop_pct", 4, bank);
}

function textOf(device: CircuitDevice): string {
  return `${device.name ?? ""} ${device.family ?? ""} ${device.type_name ?? ""} ${device.mark ?? ""} ${device.category ?? ""}`.toLowerCase();
}

export function classifyDevice(device: CircuitDevice): CircuitKind | "switch" | "other" {
  const text = textOf(device);
  const category = (device.category ?? "").toLowerCase();
  if (device.is_switch || (/\bswitch\b/.test(text) && /lighting device/.test(category))) return "switch";
  if (/shower/.test(text)) return "SH";
  if (/\bstair\b/.test(text)) return "STAIR";
  if (/air.?con|\ba\/c\b|\bsplit\b|\bfcu\b|\bspur\b/.test(text)) return "AC";
  if (/lighting fixture|luminaire/.test(category) || (/lighting/.test(category) && !/device/.test(category))) return "L";
  if (/socket|outlet|twin|13\s*a|\bring\b/.test(text)) return "R";
  if (/lighting device/.test(category)) return /\bswitch\b/.test(text) ? "switch" : "L";
  if (/electrical fixture|electrical device/.test(category)) return /socket|outlet/.test(text) ? "R" : "other";
  return "other";
}

function powerType(value: string | undefined): "power" | "other" | "none" {
  const text = (value ?? "").trim().toLowerCase();
  if (!text) return "none";
  if (NOT_POWER.test(text)) return "other";
  if (POWER.test(text) || text === "powercircuit" || text === "powerunbalanced" || text === "powerbalanced") return "power";
  return "other";
}

function distance(a: CircuitDevice | CircuitPanel, b: CircuitPanel | CircuitDevice): number {
  const ax = a.x ?? 0;
  const ay = a.y ?? 0;
  const az = a.z ?? 0;
  const bx = b.x ?? 0;
  const by = b.y ?? 0;
  const bz = b.z ?? 0;
  const level = (a.level ?? "") && (b.level ?? "") && a.level !== b.level ? 1_000_000 : 0;
  return Math.hypot(ax - bx, ay - by, az - bz) + level;
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function phaseOf(value: string | undefined): "Single" | "Three" | "" {
  const text = (value ?? "").toLowerCase();
  if (/three|3\s*ph/.test(text)) return "Three";
  if (/single|1\s*ph/.test(text)) return "Single";
  return "";
}

/** Reads a distribution name such as DS_415-240V_3Ph_4W. The first number is line-to-line when it is the larger. */
export function parseDistributionName(name: string): { ll: number; lg: number; phase: "Single" | "Three" | ""; wires: number } {
  const text = name.trim();
  const wiresMatch = /([234])\s*w/i.exec(text);
  const wires = wiresMatch ? Number(wiresMatch[1]) : 0;
  const named = phaseOf(text);
  const pair = /(\d+(?:\.\d+)?)\s*[-/]\s*(\d+(?:\.\d+)?)/.exec(text);
  if (pair) {
    const a = Number(pair[1]);
    const b = Number(pair[2]);
    const ll = Math.max(a, b);
    const lg = Math.min(a, b);
    const phase = named || (ll > lg ? "Three" : "");
    return { ll, lg, phase, wires: wires || (phase === "Three" ? 4 : 0) };
  }
  const one = /(\d+(?:\.\d+)?)\s*v/i.exec(text);
  if (one) {
    const volts = Number(one[1]);
    if (named === "Three") return { ll: volts, lg: 0, phase: "Three", wires: wires || 3 };
    return { ll: 0, lg: volts, phase: named || "Single", wires: wires || 2 };
  }
  return { ll: 0, lg: 0, phase: named, wires };
}

export interface PanelSupply {
  ll: number;
  lg: number;
  phase: "Single" | "Three" | "";
  wires: number;
  /** parameter: the snapshot read DistributionSysType. name: parsed. none: nothing to compare. */
  source: "parameter" | "name" | "none";
}

export function panelSupply(panel: Pick<CircuitPanel, "distribution" | "voltage_ll" | "voltage_lg" | "phase" | "wires">): PanelSupply {
  const parsed = parseDistributionName(panel.distribution ?? "");
  const ll = positive(panel.voltage_ll) || parsed.ll;
  const lg = positive(panel.voltage_lg) || parsed.lg;
  const phase = phaseOf(panel.phase) || parsed.phase;
  const wires = positive(panel.wires) || parsed.wires;
  const fromParameter = positive(panel.voltage_ll) > 0 || positive(panel.voltage_lg) > 0 || phaseOf(panel.phase) !== "";
  const source: PanelSupply["source"] = fromParameter ? "parameter" : (ll || lg || phase) ? "name" : "none";
  return { ll, lg, phase, wires, source };
}

const VOLT_TOLERANCE = 15;

export function deviceSupply(device: Pick<CircuitDevice, "voltage" | "poles" | "connector_voltage" | "connector_poles">): { voltage: number; poles: number } {
  const voltage = positive(device.connector_voltage) || positive(device.voltage);
  const poles = positive(device.connector_poles) || positive(device.poles) || 1;
  return { voltage, poles: Math.max(1, Math.round(poles)) };
}

/**
 * Revit 2025 ElectricalSystem.SelectPanel throws when the panel has no DistributionSysType, or when the
 * circuit voltage and poles (taken from the device connectors) are not the distribution system's line-to-line
 * or line-to-ground voltage. A 1-pole circuit needs line-to-ground. A 2-pole circuit needs line-to-line.
 * A 3-pole circuit needs a three-phase system and line-to-line. A voltage of 0 was not read, so it is not a mismatch.
 */
export function circuitMatch(panel: CircuitPanel, voltage: number, poles: number): { ok: boolean; expected: number; detail: string } {
  const supply = panelSupply(panel);
  const name = panel.name || String(panel.id);
  const described = `${name} is ${supply.ll || "?"} V line-to-line / ${supply.lg || "?"} V line-to-ground, ${supply.phase || "phase unknown"}${supply.wires ? `, ${supply.wires}-wire` : ""}`;
  const device = `device connector is ${voltage || "?"} V, ${poles}-pole`;
  if (!(panel.distribution ?? "").trim() && supply.source === "none") {
    return { ok: false, expected: 0, detail: `${name} has no distribution system.` };
  }
  if (supply.source === "none") return { ok: true, expected: 0, detail: "" };
  if (poles >= 3) {
    if (supply.phase === "Single") {
      return { ok: false, expected: supply.ll, detail: `FMC-CIRCUIT-PANEL-MISMATCH ${described}. ${device}. A single-phase panel cannot take a ${poles}-pole circuit. SelectPanel refuses: panel and circuit do not match.` };
    }
    if (!supply.ll) {
      return { ok: false, expected: 0, detail: `FMC-CIRCUIT-PANEL-MISMATCH ${described}. ${device}. The distribution system has no line-to-line voltage for a ${poles}-pole circuit.` };
    }
    if (voltage > 0 && Math.abs(voltage - supply.ll) > VOLT_TOLERANCE) {
      return { ok: false, expected: supply.ll, detail: `FMC-CIRCUIT-PANEL-MISMATCH ${described} vs ${device}. A ${poles}-pole circuit needs the line-to-line voltage (${supply.ll} V).` };
    }
    return { ok: true, expected: supply.ll, detail: "" };
  }
  if (poles === 2) {
    const expected = supply.ll || supply.lg;
    if (!expected) return { ok: false, expected: 0, detail: `FMC-CIRCUIT-PANEL-MISMATCH ${described}. ${device}. No line-to-line voltage for a 2-pole circuit.` };
    if (voltage > 0 && Math.abs(voltage - expected) > VOLT_TOLERANCE) {
      return { ok: false, expected, detail: `FMC-CIRCUIT-PANEL-MISMATCH ${described} vs ${device}. A 2-pole circuit needs ${expected} V.` };
    }
    return { ok: true, expected, detail: "" };
  }
  const expected = supply.lg || (supply.phase === "Single" ? supply.ll : 0);
  if (!expected) {
    return { ok: false, expected: 0, detail: `FMC-CIRCUIT-PANEL-MISMATCH ${described}. ${device}. The distribution system has no line-to-ground voltage for a 1-pole circuit.` };
  }
  if (voltage > 0 && Math.abs(voltage - expected) > VOLT_TOLERANCE) {
    return { ok: false, expected, detail: `FMC-CIRCUIT-PANEL-MISMATCH ${described} vs ${device}. A 1-pole circuit needs the line-to-ground voltage (${expected} V).` };
  }
  return { ok: true, expected, detail: "" };
}

function nearestPanel(device: CircuitDevice, panels: CircuitPanel[]): CircuitPanel {
  return panels.reduce((best, panel) => distance(device, panel) < distance(device, best) ? panel : best);
}

function familyOf(device: CircuitDevice): string {
  const family = (device.family || device.type_name || device.name || "(no family)").trim();
  return family || "(no family)";
}

export function formatCircuitName(pattern: string, board: string, zone: string, type: string, index: number): string {
  const n = type === "AC" || index > 1 ? String(index) : "";
  return pattern.replaceAll("{board}", board).replaceAll("{zone}", zone).replaceAll("{type}", type).replaceAll("{n}", n);
}

function loadOf(device: CircuitDevice, unit: "VA" | "W"): { value: number; missing: boolean } {
  const raw = unit === "VA" ? device.load_va : device.load_w;
  if (typeof raw === "number" && Number.isFinite(raw)) return { value: raw, missing: false };
  return { value: 0, missing: true };
}

function zoneOf(device: CircuitDevice): string {
  const room = (device.room ?? "").trim();
  if (room) return room;
  const level = (device.level ?? "").trim();
  return level || "ZZ";
}

interface Bucket {
  kind: CircuitKind;
  room: string;
  level: string;
  poles: number;
  voltage: number;
  unproven: boolean;
  panel: CircuitPanel;
  devices: CircuitDevice[];
}

export function planCircuits(input: {
  devices: CircuitDevice[];
  panels: CircuitPanel[];
  bank?: Record<string, TraceBankEntry>;
  panel?: string;
  pattern?: string;
  load_unit?: "VA" | "W";
  non_board_ids?: number[];
  include_switches?: boolean;
  overrides?: Partial<Record<string, number>>;
  distribution?: string;
}): CircuitPlan {
  const caps = circuitCaps(input.bank, input.overrides);
  const capOf = (kind: CircuitKind) => caps.find((cap) => cap.kind === kind) as CircuitCap;
  const unit = input.load_unit === "VA" ? "VA" : "W";
  const pattern = (input.pattern ?? "").trim() || DEFAULT_NAME_PATTERN;
  const nonBoard = new Set(input.non_board_ids ?? []);
  const promoted: CircuitPanel[] = [];
  for (const device of input.devices) {
    if (!isBoardEquipment(device) || nonBoard.has(device.id)) continue;
    if (input.panels.some((panel) => panel.id === device.id) || promoted.some((panel) => panel.id === device.id)) continue;
    promoted.push({
      id: device.id, name: device.name || device.mark || String(device.id), level: device.level, x: device.x, y: device.y, z: device.z,
      distribution: device.distribution ?? "", voltage: device.voltage, voltage_ll: device.voltage_ll, voltage_lg: device.voltage_lg,
      phase: device.phase, wires: device.wires, is_board: true, part_type: device.part_type,
    });
  }
  const panels = [...input.panels, ...promoted];
  const distribution_plans: DistributionFix[] = [];
  const noted = new Set<number>();
  const noteMissing = (panel: CircuitPanel) => {
    if ((panel.distribution ?? "").trim() || noted.has(panel.id)) return;
    noted.add(panel.id);
    distribution_plans.push(distributionFix(panel, input.distribution ?? ""));
  };
  for (const panel of input.panels) if (panel.is_board !== false) noteMissing(panel);
  const skipped: CircuitSkip[] = [];
  const noConnector = new Map<string, NoConnectorFamily>();
  const noteConnector = (device: CircuitDevice, detail: string) => {
    skipped.push({ id: device.id, code: "FMC-NO-CONNECTOR", detail });
    const family = familyOf(device);
    const row = noConnector.get(family) ?? { code: "FMC-NO-CONNECTOR" as const, family, category: device.category ?? "", count: 0, ids: [] };
    row.count += 1;
    if (row.ids.length < 30) row.ids.push(device.id);
    if (!row.category && device.category) row.category = device.category;
    noConnector.set(family, row);
  };
  const mismatchGroups = new Map<string, CircuitMismatch>();
  const noteMismatch = (panel: CircuitPanel, device: CircuitDevice, supply: { voltage: number; poles: number }, detail: string) => {
    skipped.push({ id: device.id, code: "FMC-CIRCUIT-PANEL-MISMATCH", detail });
    const key = `${panel.id}|${supply.poles}|${Math.round(supply.voltage)}`;
    const supplyInfo = panelSupply(panel);
    const row = mismatchGroups.get(key) ?? {
      code: "FMC-CIRCUIT-PANEL-MISMATCH" as const,
      voltage_v: supply.voltage,
      poles: supply.poles,
      panel_id: panel.id,
      panel_name: panel.name,
      panel_voltage_ll: supplyInfo.ll,
      panel_voltage_lg: supplyInfo.lg,
      panel_phase: supplyInfo.phase,
      count: 0,
      ids: [],
      families: [],
      detail,
    };
    row.count += 1;
    if (row.ids.length < 30) row.ids.push(device.id);
    const family = familyOf(device);
    if (!row.families.includes(family) && row.families.length < 12) row.families.push(family);
    mismatchGroups.set(key, row);
  };
  const buckets = new Map<string, Bucket>();
  const switches: CircuitPlan["switches"] = [];
  const lightsByRoom = new Map<string, number[]>();

  for (const device of input.devices) {
    if (device.is_direct_shape) {
      skipped.push({ id: device.id, code: "FMC-DIRECTSHAPE", detail: "DirectShape skipped. It is not a family." });
      continue;
    }
    if (nonBoard.has(device.id)) {
      /* declared load, even when the part type is Panelboard */
    } else if (isBoardEquipment(device) && device.has_connector !== false) {
      if (/spd|isolat|pump|control panel/i.test(textOf(device))) {
        skipped.push({ id: device.id, code: "CIRCUIT-SUSPECT-BOARD", detail: `${device.name || device.id} has part type ${device.part_type || "panel"}. Pass it in non_board_ids to circuit it as a load.` });
      }
      continue;
    }
    if ((device.circuit_ids ?? []).length > 0) continue;
    if (device.has_connector === false) {
      noteConnector(device, `${device.name || device.family || device.id} has no electrical connector.`);
      continue;
    }
    const system = powerType(device.system_type);
    if (system === "other") {
      skipped.push({ id: device.id, code: "FMC-WRONG-SYSTEM", detail: `System type ${device.system_type} is not a power circuit. Data, telephone and fire alarm are out of scope.` });
      continue;
    }
    if (system === "none" && device.has_connector !== true) {
      noteConnector(device, `${device.name || device.id} has no power connector.`);
      continue;
    }
    const kind = classifyDevice(device);
    if (kind === "switch") {
      if (input.include_switches) {
        const key = `${device.room ?? ""}|${device.level ?? ""}`;
        switches.push({ switch_id: device.id, light_ids: [], room: device.room ?? "", level: device.level ?? "" });
        void key;
      }
      continue;
    }
    if (kind === "other") {
      skipped.push({ id: device.id, code: "FMC-UNCLASSIFIED", detail: `${device.name || device.category || device.id} is not lighting, a socket, an AC spur, a shower or a stair light.` });
      continue;
    }
    const supply = deviceSupply(device);
    const boards = panels.filter((item) => item.is_board !== false);
    const named = (input.panel ?? "").trim().toLowerCase();
    let panel: CircuitPanel | null = null;
    let expected = 0;
    let unproven = false;
    if (!boards.length) {
      skipped.push({ id: device.id, code: "FMC-NO-PANEL", detail: "No panel board to assign." });
      continue;
    }
    if (named) {
      panel = boards.find((item) => item.name.toLowerCase() === named || String(item.id) === named) ?? null;
      if (!panel) {
        skipped.push({ id: device.id, code: "FMC-NO-PANEL", detail: `Panel ${input.panel} is not a board in this model.` });
        continue;
      }
      if (!(panel.distribution ?? "").trim() && panelSupply(panel).source === "none") {
        noteMissing(panel);
        skipped.push({ id: device.id, code: "FMC-PANEL-NO-DISTRIBUTION", detail: `${panel.name} has no distribution system. ${DISTRIBUTION_HINT}` });
        continue;
      }
      const match = circuitMatch(panel, supply.voltage, supply.poles);
      if (!match.ok) {
        noteMismatch(panel, device, supply, match.detail);
        continue;
      }
      expected = match.expected;
      unproven = panelSupply(panel).source === "none";
    } else {
      const compatible = boards.filter((item) => {
        if (!(item.distribution ?? "").trim() && panelSupply(item).source === "none") return false;
        return circuitMatch(item, supply.voltage, supply.poles).ok;
      });
      if (compatible.length) {
        panel = nearestPanel(device, compatible);
        const match = circuitMatch(panel, supply.voltage, supply.poles);
        expected = match.expected;
        unproven = panelSupply(panel).source === "none";
      } else if (!boards.some((item) => (item.distribution ?? "").trim() || panelSupply(item).source !== "none")) {
        const nearest = nearestPanel(device, boards);
        noteMissing(nearest);
        skipped.push({ id: device.id, code: "FMC-PANEL-NO-DISTRIBUTION", detail: `${nearest.name} has no distribution system. ${DISTRIBUTION_HINT}` });
        continue;
      } else {
        const withSupply = boards.filter((item) => (item.distribution ?? "").trim() || panelSupply(item).source !== "none");
        const nearest = nearestPanel(device, withSupply);
        const match = circuitMatch(nearest, supply.voltage, supply.poles);
        noteMismatch(nearest, device, supply, match.detail || `FMC-CIRCUIT-PANEL-MISMATCH ${nearest.name} does not match ${supply.voltage} V, ${supply.poles}-pole.`);
        continue;
      }
    }
    if (!panel) continue;
    if (kind === "L" || kind === "STAIR") {
      const key = `${device.room ?? ""}|${device.level ?? ""}`;
      const list = lightsByRoom.get(key) ?? [];
      list.push(device.id);
      lightsByRoom.set(key, list);
    }
    const poles = supply.poles;
    const bucketVoltage = expected || Math.round(supply.voltage);
    const key = `${kind}|${device.room_id ?? device.room ?? ""}|${device.level ?? ""}|${poles}|${bucketVoltage}|${panel.id}`;
    const bucket = buckets.get(key) ?? { kind, room: device.room ?? "", level: device.level ?? "", poles, voltage: bucketVoltage, unproven, panel, devices: [] };
    bucket.devices.push(device);
    buckets.set(key, bucket);
  }

  if (input.include_switches) {
    for (const row of switches) {
      row.light_ids = lightsByRoom.get(`${row.room}|${row.level}`) ?? [];
    }
  }

  const draft: Array<Omit<PlannedCircuit, "phase" | "slot"> & { panelLoad: number }> = [];
  const names = new Map<string, number>();
  for (const bucket of [...buckets.values()].sort((a, b) => `${a.panel.name}|${a.room}|${a.level}|${a.kind}`.localeCompare(`${b.panel.name}|${b.room}|${b.level}|${b.kind}`))) {
    const cap = capOf(bucket.kind);
    const maxPoints = cap.max_points?.value ?? Number.POSITIVE_INFINITY;
    const maxLoad = cap.max_load_w?.value ?? Number.POSITIVE_INFINITY;
    let current: CircuitDevice[] = [];
    let points = 0;
    let load = 0;
    const flush = () => {
      if (!current.length) return;
      const key = `${bucket.panel.name}|${zoneOf(current[0])}|${bucket.kind}`;
      const index = (names.get(key) ?? 0) + 1;
      names.set(key, index);
      const flags: string[] = [];
      const area = current.reduce((max, device) => Math.max(max, device.room_area_m2 ?? 0), 0);
      if (cap.max_area_m2 && area > cap.max_area_m2.value) flags.push(`CIRCUIT-AREA room ${area} m2 is over ${cap.max_area_m2.value} m2`);
      const missing = current.filter((device) => loadOf(device, unit).missing).map((device) => device.id);
      if (missing.length) flags.push(`Load ${unit} missing on ${missing.join(", ")}. Those points are counted and not added to the load.`);
      const volts = current.filter((device) => {
        const seen = deviceSupply(device).voltage;
        return seen > 0 && Math.abs(seen - cap.voltage_v.value) > VOLT_TOLERANCE;
      });
      if (volts.length) flags.push(`Voltage is not ${cap.voltage_v.value} V on ${volts.map((device) => device.id).join(", ")}.`);
      if (bucket.unproven) flags.push("Distribution voltage was not read. SelectPanel may still refuse this panel.");
      draft.push({
        name: formatCircuitName(pattern, bucket.panel.name, zoneOf(current[0]), bucket.kind, index),
        kind: bucket.kind,
        panel_id: bucket.panel.id,
        panel_name: bucket.panel.name,
        level: bucket.level,
        room: bucket.room,
        load_w: Math.round(current.reduce((sum, device) => sum + (device.load_w ?? 0), 0) * 10) / 10,
        load_va: Math.round(current.reduce((sum, device) => sum + (device.load_va ?? 0), 0) * 10) / 10,
        points,
        area_m2: area > 0 ? area : null,
        breaker_a: cap.breaker_a.value,
        curve: cap.curve,
        cable_mm2: cap.cable_mm2.value,
        poles: bucket.poles,
        voltage_v: bucket.voltage || cap.voltage_v.value,
        element_ids: current.map((device) => device.id),
        provisional: cap.provisional,
        flags,
        panelLoad: current.reduce((sum, device) => sum + (device.load_va ?? device.load_w ?? 0), 0),
      });
      current = [];
      points = 0;
      load = 0;
    };
    for (const device of [...bucket.devices].sort((a, b) => a.id - b.id)) {
      const next = loadOf(device, unit);
      const useLoad = unit === "W" && cap.max_load_w ? next.value : unit === "VA" ? next.value : 0;
      const overPoints = points + 1 > maxPoints;
      const overLoad = cap.max_load_w != null && unit === "W" && load + (next.missing ? 0 : next.value) > maxLoad && points > 0;
      if ((overPoints || overLoad) && current.length) flush();
      current.push(device);
      points += 1;
      load += next.missing ? 0 : useLoad;
      if (points >= maxPoints) flush();
    }
    flush();
  }

  const phases = assignPhases(draft.map((row) => row.panelLoad));
  const limits = phaseLimits(input.bank);
  const limit = limits.standing.value ?? 5;
  const circuits: PlannedCircuit[] = draft.map((row, index) => {
    const { panelLoad: _drop, ...rest } = row;
    void _drop;
    const phase = phases.phases[index];
    return { ...rest, phase, slot: `${phase}/${phases.slots[index]}` };
  });
  const drop = voltageDropLimit(input.bank);
  return {
    circuits,
    skipped,
    switches: switches.filter((row) => row.light_ids.length > 0),
    caps,
    phase: {
      L1: Math.round(phases.loads.L1 * 10) / 10,
      L2: Math.round(phases.loads.L2 * 10) / 10,
      L3: Math.round(phases.loads.L3 * 10) / 10,
      imbalance_pct: phases.imbalance_pct,
      limit_pct: limit,
      provisional: limits.standing.source !== "standards",
      clause: limits.standing.clause,
    },
    voltage_drop: drop,
    distribution_plans,
    mismatches: [...mismatchGroups.values()].sort((a, b) => a.panel_name.localeCompare(b.panel_name) || a.poles - b.poles || a.voltage_v - b.voltage_v),
    no_connector_families: [...noConnector.values()].sort((a, b) => b.count - a.count || a.family.localeCompare(b.family)),
    counts: {
      devices: input.devices.length,
      planned: circuits.length,
      skipped: skipped.length,
      points: circuits.reduce((sum, circuit) => sum + circuit.points, 0),
      no_connector: [...noConnector.values()].reduce((sum, row) => sum + row.count, 0),
      mismatched: [...mismatchGroups.values()].reduce((sum, row) => sum + row.count, 0),
    },
    rule: "Group by room, then level, then kind, then connector voltage and poles. A circuit is assigned only to a panel whose distribution system can feed that voltage and pole count. Lighting and sockets are never on one circuit. A missing standards key is PROVISIONAL.",
  };
}

export function assignPhases(loads: number[]): { phases: Array<"L1" | "L2" | "L3">; slots: number[]; loads: { L1: number; L2: number; L3: number }; imbalance_pct: number | null } {
  const totals = { L1: 0, L2: 0, L3: 0 };
  const counts = { L1: 0, L2: 0, L3: 0 };
  const phases: Array<"L1" | "L2" | "L3"> = [];
  const slots: number[] = [];
  for (const load of loads) {
    const phase = (["L1", "L2", "L3"] as const).reduce((best, name) => totals[name] < totals[best] ? name : best);
    totals[phase] += load;
    counts[phase] += 1;
    phases.push(phase);
    slots.push(counts[phase]);
  }
  const values = [totals.L1, totals.L2, totals.L3];
  const avg = values.reduce((sum, value) => sum + value, 0) / 3;
  const imbalance = avg > 0 ? Math.round(((Math.max(...values) - Math.min(...values)) / avg) * 1000) / 10 : null;
  return { phases, slots, loads: totals, imbalance_pct: imbalance };
}

export function auditCircuits(input: {
  devices: CircuitDevice[];
  panels: CircuitPanel[];
  circuits: ExistingCircuit[];
  bank?: Record<string, TraceBankEntry>;
  accept_no_supply?: string[];
  non_board_ids?: number[];
  distribution?: string;
}): { findings: AuditFinding[]; counts: Record<string, number>; provisional: boolean; distribution: string } {
  const caps = circuitCaps(input.bank);
  const capOf = (kind: CircuitKind) => caps.find((cap) => cap.kind === kind);
  const findings: AuditFinding[] = [];
  const accept = new Set((input.accept_no_supply ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean));
  const nonBoard = new Set(input.non_board_ids ?? []);
  const target = (input.distribution ?? TARGET_DISTRIBUTION).trim() || TARGET_DISTRIBUTION;
  const unassigned = new Map<string, number>();
  for (const device of input.devices) {
    if (device.is_direct_shape) {
      findings.push({ code: "FMC-DIRECTSHAPE", id: device.id, detail: "DirectShape skipped." });
      continue;
    }
    if (device.has_connector === false) {
      findings.push({ code: "FMC-NO-CONNECTOR", id: device.id, category: device.category, level: device.level, detail: `${device.name || device.family || device.id} has no electrical connector.` });
      continue;
    }
    const suspect = /panelboard/i.test(device.part_type ?? "") && !nonBoard.has(device.id);
    if (suspect && /spd|isolat|pump|control panel/i.test(textOf(device))) {
      findings.push({ code: "CIRCUIT-SUSPECT-BOARD", id: device.id, detail: `${device.name || device.id} is part type Panelboard and looks like a load (${device.name || device.family}). Pass non_board_ids to treat it as a load.` });
    }
    if ((device.circuit_ids ?? []).length > 0) continue;
    if (suspect) continue;
    const kind = classifyDevice(device);
    if (kind === "switch" || kind === "other") continue;
    if (powerType(device.system_type) === "other") continue;
    const key = `${device.category || "uncategorised"}|${device.level || "(no level)"}`;
    unassigned.set(key, (unassigned.get(key) ?? 0) + 1);
  }
  for (const [key, count] of unassigned) {
    const [category, level] = key.split("|");
    findings.push({ code: "CIRCUIT-UNASSIGNED", category, level, detail: `${count} unassigned on ${level}.` });
  }
  for (const panel of input.panels) {
    if (panel.is_board === false) continue;
    const accepted = panel.utility_fed === true || accept.has(panel.name.trim().toLowerCase()) || accept.has(String(panel.id));
    if (panel.has_supply === false && !accepted) {
      findings.push({ code: "ELEC-NO-SUPPLY", id: panel.id, detail: `${panel.name} has no supply. Pass it in accept_no_supply when it is utility-fed.` });
    }
    if (!(panel.distribution ?? "").trim()) {
      findings.push({ code: "FMC-PANEL-NO-DISTRIBUTION", id: panel.id, detail: `${panel.name} has no distribution system. ${DISTRIBUTION_HINT}` });
    } else if (panel.distribution !== target) {
      findings.push({ code: "ELEC-VOLTAGE-MISMATCH", id: panel.id, detail: `${panel.name} distribution is ${panel.distribution}. Target is ${target}. Replacing the family in place is out of scope.` });
    }
  }
  for (const circuit of input.circuits) {
    const kind = (CIRCUIT_KINDS as readonly string[]).includes(circuit.kind ?? "") ? circuit.kind as CircuitKind : null;
    const cap = kind ? capOf(kind) : null;
    const points = circuit.points ?? circuit.element_ids?.length ?? 0;
    if (cap?.max_points && points > cap.max_points.value) {
      findings.push({ code: "CIRCUIT-OVERLOAD", id: circuit.id, detail: `${circuit.name || circuit.id} has ${points} points. Cap is ${cap.max_points.value}.` });
    }
    if (cap?.max_load_w && (circuit.load_w ?? 0) > cap.max_load_w.value) {
      findings.push({ code: "CIRCUIT-OVERLOAD", id: circuit.id, detail: `${circuit.name || circuit.id} load ${circuit.load_w} W is over ${cap.max_load_w.value} W.` });
    }
    if (typeof circuit.voltage === "number" && Math.abs(circuit.voltage - FINAL_VOLTAGE_V) > 15 && circuit.poles === 1) {
      findings.push({ code: "ELEC-VOLTAGE-MISMATCH", id: circuit.id, detail: `${circuit.name || circuit.id} is ${circuit.voltage} V. Single-phase final circuits are ${FINAL_VOLTAGE_V} V.` });
    }
    if (cap && circuit.poles && circuit.poles !== cap.poles && kind !== "AC") {
      findings.push({ code: "ELEC-POLE-MISMATCH", id: circuit.id, detail: `${circuit.name || circuit.id} has ${circuit.poles} poles. The ${kind} cap is ${cap.poles}.` });
    }
  }
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  for (const [key, count] of unassigned) counts[`unassigned:${key}`] = count;
  return { findings, counts, provisional: caps.some((cap) => cap.provisional), distribution: target };
}

export function sampleIds(ids: number[], limit: number): { ids: number[]; capped: boolean; count: number } {
  const unique = [...new Set(ids)];
  return { ids: unique.slice(0, limit), capped: unique.length > limit, count: unique.length };
}
