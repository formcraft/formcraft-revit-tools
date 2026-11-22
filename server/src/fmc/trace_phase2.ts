/**
 * Phase 2 of the systems flow tracer. Pure. The add-in only adds fields the model already stores
 * (system class, ratings, ground connector, main rating). A limit that is not in the standards bank
 * is PROVISIONAL and never produces PASS.
 */

import type { CheckRun, TraceCheck, TraceConnector, TraceElement, TraceFilter, TraceFinding, TraceSnapshot, TraceSystem } from "./trace.js";
import { citeCell, citeLimit as bankCite, deadLegLimitMm, fallLimit, loadingUnits, phaseLimits, pipeCapacity, voltageDropMv, type CitedLimit } from "./trace_bank.js";
export { PHASE2_DEFAULTS } from "./trace_bank.js";
export type { CitedLimit };

export const MISSING_CODES = [
  "FLOW-NO-WASTE",
  "FLOW-NO-TRAP",
  "FLOW-NO-ISOLATION",
  "FLOW-NO-CLEANOUT",
  "FLOW-NO-VENT",
  "FLOW-NO-FITTING",
  "FLOW-NO-CAP",
  "FLOW-NO-SOURCE",
  "ELEC-NO-RATING",
  "ELEC-NO-MAIN",
  "ELEC-NO-SWITCH",
  "ELEC-NO-EARTH",
  "DUCT-NO-SYSTEM",
  "DUCT-NO-DAMPER",
] as const;

export const STANDARD_CODES = ["STD-FAIL", "STD-PROVISIONAL", "STD-UNKNOWN"] as const;

/** What a Revit model does not reliably store. Reported with the missing-parts check, never as a pass. */
export const NOT_DETECTABLE = [
  "Trap seal depth and trap form (P, S or bottle). Only a family whose name says trap is counted.",
  "A valve that is isolating rather than a check valve, when the family name does not say valve, isolator, gate or ball.",
  "A cleanout, access eye or rodding point whose family name does not say cleanout, access or rodding.",
  "A vent that has neither a vent name nor a Vent system classification.",
  "Whether a damper is required on a main duct. Only a duct tee (three connectors) is treated as a branch.",
  "Residual pressure and flow. Fixture units are a count, not a hydraulic result.",
  "Voltage drop when circuit length or wire size is empty. Revit often stores neither.",
  "Phase assignment when the circuit has no Phase or FMC_Phase value.",
  "An earth path when the family exposes no connector described as ground, earth or CPC.",
  "Breaker curve and cable installation method. Only the ampere rating, when it is stored, is compared.",
  "Fixture units for a fixture whose name matches none of WC, basin, sink, shower, bath or urinal.",
  "Cable-tray fill, earthing resistance, and airflow. Those collectors are not in this pass.",
];

/** A trace.* row as the standards file stores it, or the normalized number tests already pass. */
export function citeLimit(key: string, filter?: TraceFilter): CitedLimit {
  return bankCite(key, filter?.bank as never);
}

export interface TraceEdit {
  op: "connect" | "elbow" | "tee" | "transition" | "resize" | "cap" | "assign_system" | "circuit";
  ids: number[];
  element_id?: number;
  system_id?: number;
  circuit_id?: number;
  a?: number;
  ai?: number;
  b?: number;
  bi?: number;
  c?: number;
  ci?: number;
  index?: number;
  size_mm?: number;
  height_mm?: number;
  detail: string;
}

const RESIZE_RULE = "The smaller pipe or duct is resized up to the larger size at the joint. Fittings are not resized; Revit follows the pipe.";

function words(el?: TraceElement): string {
  return `${el?.name ?? ""} ${el?.category ?? ""} ${el?.kind ?? ""}`.toLowerCase();
}

export function partRole(el?: TraceElement): string {
  const text = words(el);
  if (/trap/.test(text)) return "trap";
  if (/cleanout|rodding|access eye|access point/.test(text)) return "cleanout";
  if (/(isolat|gate valve|ball valve|stop valve|\bvalve\b)/.test(text) && !/check valve|non-?return|\bnrv\b/.test(text)) return "valve";
  if (/\bvent\b|air admittance|\baav\b/.test(text)) return "vent";
  if (/\bcap\b|end cap/.test(text)) return "cap";
  if (/tank|cistern|calorifier|water heater|geyser|\bpump\b|\bboiler\b/.test(text)) return "source";
  if (/damper/.test(text)) return "damper";
  if (/switch/.test(text)) return "switch";
  return el?.kind ?? "";
}

function wasteClass(value: string): boolean {
  return /sanitary|waste|soil|sewage|foul|storm|sewer/.test(value.toLowerCase());
}

function supplyClass(value: string): boolean {
  return /domestichot|domesticcold|domestic hot|domestic cold|hotwater|coldwater/.test(value.toLowerCase().replace(/[\s_-]/g, ""))
    || /domestic hot|domestic cold/.test(value.toLowerCase());
}

function ventClass(value: string): boolean {
  return /\bvent\b/.test(value.toLowerCase());
}

function dot(a: number[], b: number[]): number | null {
  if (a.length < 3 || b.length < 3) return null;
  const al = Math.hypot(a[0], a[1], a[2]);
  const bl = Math.hypot(b[0], b[1], b[2]);
  if (al < 1e-6 || bl < 1e-6) return null;
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (al * bl);
}

function oppose(a: number[], b: number[], deg: number): boolean | null {
  const value = dot(a, b);
  if (value == null) return null;
  return value <= -Math.cos((deg * Math.PI) / 180) + 1e-9;
}

function dist(a: number[], b: number[]): number {
  if (a.length < 3 || b.length < 3) return Number.POSITIVE_INFINITY;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function curveLength(el?: TraceElement): number {
  const curve = el?.curve;
  if (!curve || curve.length < 2) return 0;
  return dist(curve[0], curve[1]);
}

function slope(el?: TraceElement): number | null {
  const curve = el?.curve;
  if (!curve || curve.length < 2) return null;
  const horiz = Math.hypot(curve[1][0] - curve[0][0], curve[1][1] - curve[0][1]);
  if (horiz < 50) return null;
  return Math.abs(curve[1][2] - curve[0][2]) / horiz;
}

export function fixtureUnits(el: TraceElement, filter?: TraceFilter): { units: number; known: boolean; key: string } {
  const text = words(el);
  const cell = /\bwc\b|water closet|closet/.test(text) ? "wc"
    : /basin/.test(text) ? "basin"
      : /sink/.test(text) ? "sink"
        : /shower/.test(text) ? "shower"
          : /\bbath\b/.test(text) ? "bath"
            : /urinal/.test(text) ? "urinal"
              : "";
  if (!cell) return { units: 0, known: false, key: "trace.fixture_units" };
  const limit = citeCell("trace.fixture_units", cell, filter?.bank as never);
  return { units: limit.value ?? 0, known: limit.value != null, key: "trace.fixture_units" };
}

interface Graph {
  elements: Map<number, TraceElement>;
  connectors: TraceConnector[];
  byElement: Map<number, TraceConnector[]>;
  systems: TraceSystem[];
  member: Map<number, number[]>;
  adj: Map<number, Set<number>>;
}

function graphOf(snapshot: TraceSnapshot): Graph {
  const elements = new Map<number, TraceElement>();
  for (const element of snapshot.flow?.elements ?? []) elements.set(element.id, element);
  const connectors = snapshot.flow?.connectors ?? [];
  const byElement = new Map<number, TraceConnector[]>();
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)?.add(b);
    adj.get(b)?.add(a);
  };
  for (const connector of connectors) {
    const list = byElement.get(connector.element_id) ?? [];
    list.push(connector);
    byElement.set(connector.element_id, list);
    for (const ref of connector.refs ?? []) link(connector.element_id, ref[0]);
  }
  const systems = snapshot.flow?.systems ?? [];
  const member = new Map<number, Set<number>>();
  const add = (id: number, systemId: number) => {
    if (!systemId) return;
    const set = member.get(id) ?? new Set<number>();
    set.add(systemId);
    member.set(id, set);
  };
  for (const element of elements.values()) for (const id of element.system_ids ?? []) add(element.id, id);
  for (const system of systems) {
    for (const id of system.element_ids ?? []) add(id, system.id);
    if (system.base_equipment_id) add(system.base_equipment_id, system.id);
  }
  const lists = new Map<number, number[]>();
  for (const [id, set] of member) lists.set(id, [...set]);
  return { elements, connectors, byElement, systems, member: lists, adj };
}

function systemNames(graph: Graph, id: number): string {
  return (graph.member.get(id) ?? []).map((systemId) => graph.systems.find((system) => system.id === systemId)?.name ?? "").filter(Boolean).join(", ");
}

function systemBlob(graph: Graph, id: number): string {
  const names = (graph.member.get(id) ?? []).map((systemId) => {
    const system = graph.systems.find((item) => item.id === systemId);
    return `${system?.name ?? ""} ${system?.classification ?? ""}`;
  });
  return names.join(" ");
}

function connectorClass(graph: Graph, connector: TraceConnector): string {
  return `${connector.system_class ?? ""} ${systemBlob(graph, connector.element_id)}`;
}

function nearest(graph: Graph, start: number, depth: number): number[] {
  const seen = new Set<number>([start]);
  let edge = [start];
  for (let step = 0; step < depth; step++) {
    const next: number[] = [];
    for (const id of edge) for (const other of graph.adj.get(id) ?? []) if (!seen.has(other)) { seen.add(other); next.push(other); }
    edge = next;
  }
  return [...seen];
}

function pathLength(graph: Graph, from: number, to: number): number | null {
  const parent = new Map<number, number>();
  const queue = [from];
  parent.set(from, from);
  while (queue.length) {
    const id = queue.shift() as number;
    if (id === to) break;
    for (const next of graph.adj.get(id) ?? []) if (!parent.has(next)) { parent.set(next, id); queue.push(next); }
  }
  if (!parent.has(to)) return null;
  let length = 0;
  let cursor = to;
  const guard = new Set<number>();
  while (cursor !== from && !guard.has(cursor)) {
    guard.add(cursor);
    length += curveLength(graph.elements.get(cursor));
    cursor = parent.get(cursor) as number;
  }
  length += curveLength(graph.elements.get(from));
  return length;
}

function finding(code: string, id: number, detail: string, system?: string, other?: number): TraceFinding {
  return { code, id, detail, ...(system ? { system } : {}), ...(other != null ? { other_id: other } : {}) };
}

function runOf(check: { id: string; title: string }, codes: readonly string[], findings: TraceFinding[], checked: Record<string, number>, warnings: string[] = [], extra?: CheckRun["extra"]): CheckRun {
  const counts: Record<string, number> = {};
  for (const code of codes) counts[code] = 0;
  for (const item of findings) counts[item.code] = (counts[item.code] ?? 0) + 1;
  findings.sort((a, b) => a.code.localeCompare(b.code) || a.id - b.id);
  return { id: check.id, title: check.title, phase: 2, implemented: true, pass: findings.length === 0 && warnings.length === 0, counts, findings, checked, warnings, extra };
}

export function runMissing(snapshot: TraceSnapshot, _limits: { values: { near_miss_mm: number; direction_deg: number } }, _filter: TraceFilter): CheckRun {
  const graph = graphOf(snapshot);
  const findings: TraceFinding[] = [];
  const seen = new Set<string>();
  const add = (item: TraceFinding) => {
    const key = `${item.code}|${item.id}|${item.other_id ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(item);
  };
  const near = _limits.values.near_miss_mm;

  for (const element of graph.elements.values()) {
    if (element.kind !== "fixture" && !/plumb/.test((element.category ?? "").toLowerCase())) continue;
    const cons = graph.byElement.get(element.id) ?? [];
    const sanitary = cons.filter((connector) => wasteClass(connectorClass(graph, connector)));
    const supply = cons.filter((connector) => supplyClass(connectorClass(graph, connector)));
    if (sanitary.length === 0 && cons.some((connector) => connector.domain === "piping") && /plumb|fixture/.test(words(element))) {
      // A plumbing fixture with piping connectors and no sanitary class is not assumed to need waste.
    }
    if (sanitary.some((connector) => !connector.connected && (connector.refs ?? []).length === 0)) {
      add(finding("FLOW-NO-WASTE", element.id, "sanitary connector is not connected", systemNames(graph, element.id)));
    }
    if (sanitary.some((connector) => connector.connected || (connector.refs ?? []).length > 0)) {
      const around = nearest(graph, element.id, 8);
      if (!around.some((id) => partRole(graph.elements.get(id)) === "trap")) {
        add(finding("FLOW-NO-TRAP", element.id, "no trap within 8 connections of the waste", systemNames(graph, element.id)));
      }
      const vented = around.some((id) => partRole(graph.elements.get(id)) === "vent" || ventClass(systemBlob(graph, id)));
      if (!around.some((id) => partRole(graph.elements.get(id)) === "trap") ? false : !vented) {
        add(finding("FLOW-NO-VENT", element.id, "no vent reached from the trap", systemNames(graph, element.id)));
      }
    }
    if (supply.some((connector) => connector.connected || (connector.refs ?? []).length > 0)) {
      const around = nearest(graph, element.id, 6);
      if (!around.some((id) => partRole(graph.elements.get(id)) === "valve")) {
        add(finding("FLOW-NO-ISOLATION", element.id, "no isolation valve within 6 connections of the supply", systemNames(graph, element.id)));
      }
    }
  }

  for (const element of graph.elements.values()) {
    if (partRole(element) !== "trap") continue;
    const around = nearest(graph, element.id, 8);
    if (!around.some((id) => partRole(graph.elements.get(id)) === "vent" || ventClass(systemBlob(graph, id)))) {
      add(finding("FLOW-NO-VENT", element.id, "trap has no vent within 8 connections", systemNames(graph, element.id)));
    }
  }

  for (const element of graph.elements.values()) {
    const cons = (graph.byElement.get(element.id) ?? []).filter((connector) => connector.type !== "curve" && connector.domain === "piping");
    if (cons.length < 2 || element.kind !== "fitting") continue;
    if (!wasteClass(systemBlob(graph, element.id) + cons.map((connector) => connector.system_class ?? "").join(" "))) continue;
    const turned = cons.length >= 2 && oppose(cons[0].direction, cons[1].direction, 20) === false;
    const openEnd = cons.some((connector) => connector.open_end);
    if (!turned && !openEnd) continue;
    const around = nearest(graph, element.id, 2);
    if (!around.some((id) => partRole(graph.elements.get(id)) === "cleanout")) {
      add(finding("FLOW-NO-CLEANOUT", element.id, turned ? "change of direction with no cleanout within 2 connections" : "drainage end with no cleanout within 2 connections", systemNames(graph, element.id)));
    }
  }

  const physical = graph.connectors.filter((connector) => connector.type !== "curve" && connector.origin.length >= 3);
  const usedPairs = new Set<string>();
  for (let i = 0; i < physical.length; i++) {
    for (let j = i + 1; j < physical.length; j++) {
      const left = physical[i];
      const right = physical[j];
      if (left.element_id === right.element_id || left.domain !== right.domain) continue;
      if (dist(left.origin, right.origin) > near) continue;
      const linked = (left.refs ?? []).some((ref) => ref[0] === right.element_id);
      const a = graph.elements.get(left.element_id);
      const b = graph.elements.get(right.element_id);
      const curves = ["pipe", "duct", "flex_pipe", "flex_duct", "curve"].includes(a?.kind ?? "") && ["pipe", "duct", "flex_pipe", "flex_duct", "curve"].includes(b?.kind ?? "");
      if (!curves) continue;
      const key = left.element_id < right.element_id ? `${left.element_id}|${right.element_id}` : `${right.element_id}|${left.element_id}`;
      if (usedPairs.has(key)) continue;
      const corner = oppose(left.direction, right.direction, _limits.values.direction_deg) === false;
      if (corner) {
        usedPairs.add(key);
        add(finding("FLOW-NO-FITTING", left.element_id, linked ? "pipes meet with no fitting" : "gap between pipes with no fitting", systemNames(graph, left.element_id), right.element_id));
      }
    }
  }

  for (const connector of physical) {
    if (!connector.open_end || connector.connected) continue;
    const element = graph.elements.get(connector.element_id);
    if (!element || !["pipe", "duct", "flex_pipe", "flex_duct", "curve"].includes(element.kind ?? "")) continue;
    const nearOther = physical.some((other) => other.element_id !== connector.element_id && other.domain === connector.domain && dist(other.origin, connector.origin) <= near);
    if (nearOther) continue;
    add(finding("FLOW-NO-CAP", connector.element_id, "open pipe or duct end with no cap", systemNames(graph, connector.element_id)));
  }

  for (const system of graph.systems) {
    if (!supplyClass(`${system.classification ?? ""} ${system.name}`)) continue;
    const members = new Set([...(system.element_ids ?? []), ...(system.base_equipment_id ? [system.base_equipment_id] : [])]);
    const sourced = [...members].some((id) => partRole(graph.elements.get(id)) === "source" || graph.elements.get(id)?.kind === "equipment" || id === system.base_equipment_id && system.base_equipment_id);
    if (system.base_equipment_id || sourced) continue;
    const host = [...members][0] ?? system.id;
    add(finding("FLOW-NO-SOURCE", host, "supply system has no tank, pump or water heater", system.name));
  }

  for (const element of graph.elements.values()) {
    if (element.kind !== "terminal" && element.domain !== "hvac") continue;
    if (element.kind === "terminal" && (graph.member.get(element.id) ?? []).length === 0) {
      add(finding("DUCT-NO-SYSTEM", element.id, "air terminal is on no system"));
    }
  }
  for (const element of graph.elements.values()) {
    const cons = (graph.byElement.get(element.id) ?? []).filter((connector) => connector.domain === "hvac" && connector.type !== "curve");
    if (cons.length < 3) continue;
    const around = nearest(graph, element.id, 2);
    if (!around.some((id) => partRole(graph.elements.get(id)) === "damper")) {
      add(finding("DUCT-NO-DAMPER", element.id, "duct tee has no damper within 2 connections", systemNames(graph, element.id)));
    }
  }

  for (const circuit of snapshot.electrical?.circuits ?? []) {
    if (circuit.rating_a === 0) add(finding("ELEC-NO-RATING", circuit.id, "power circuit has no protective-device rating", circuit.panel_name));
  }
  for (const panel of snapshot.electrical?.panels ?? []) {
    if (panel.main_a === 0) add(finding("ELEC-NO-MAIN", panel.id, "panel has no main rating"));
  }
  const devices = snapshot.electrical?.devices ?? [];
  const circuits = snapshot.electrical?.circuits ?? [];
  for (const circuit of circuits) {
    const on = devices.filter((device) => (device.circuit_ids ?? []).includes(circuit.id));
    const lights = on.filter((device) => /lighting fixture/.test((device.category ?? "").toLowerCase()));
    const switches = on.filter((device) => /lighting device/.test((device.category ?? "").toLowerCase()) || partRole({ id: device.id, name: device.name, category: device.category }) === "switch");
    if (lights.length > 0 && switches.length === 0) add(finding("ELEC-NO-SWITCH", lights[0].id, "lighting circuit has no switch", circuit.panel_name, circuit.id));
  }
  for (const device of devices) {
    if (device.ground === "open") add(finding("ELEC-NO-EARTH", device.id, "family ground connector is not connected"));
  }

  return runOf(
    { id: "missing", title: "Missing parts" },
    MISSING_CODES,
    findings,
    { elements: graph.elements.size, circuits: circuits.length, panels: snapshot.electrical?.panels?.length ?? 0 },
    [],
    { not_detectable: NOT_DETECTABLE },
  );
}

interface Verdict {
  id: number;
  system?: string;
  system_id?: number;
  check: string;
  verdict: "PASS" | "FAIL" | "UNKNOWN" | "PROVISIONAL";
  key: string;
  clause: string;
  measured?: number;
  limit?: number;
  detail: string;
}

function verdictFinding(item: Verdict): TraceFinding | null {
  if (item.verdict === "PASS") return null;
  const code = item.verdict === "FAIL" ? "STD-FAIL" : item.verdict === "UNKNOWN" ? "STD-UNKNOWN" : "STD-PROVISIONAL";
  return finding(code, item.id, `${item.check}: ${item.detail} [${item.key}: ${item.clause}]`, item.system);
}

function rollup(verdicts: Verdict[], systems: TraceSystem[]): Array<{ id: number; name: string; verdict: "compliant" | "not compliant" | "incomplete data" }> {
  const ids = new Set<number>([...systems.map((system) => system.id), ...verdicts.map((item) => item.system_id ?? 0)].filter((id) => id > 0));
  return [...ids].map((id) => {
    const mine = verdicts.filter((item) => item.system_id === id);
    const name = systems.find((system) => system.id === id)?.name ?? "";
    const verdict = mine.some((item) => item.verdict === "FAIL") ? "not compliant"
      : mine.some((item) => item.verdict === "UNKNOWN" || item.verdict === "PROVISIONAL") || mine.length === 0 ? "incomplete data"
        : "compliant";
    return { id, name, verdict };
  });
}

function judge(measured: number | null, limit: CitedLimit, failsWhen: "above" | "below", check: string, id: number, system?: string, systemId?: number): Verdict {
  if (measured == null || !Number.isFinite(measured) || limit.value == null) {
    return { id, system, system_id: systemId, check, verdict: "UNKNOWN", key: limit.key, clause: limit.clause, detail: limit.value == null ? "the bank value is null and there is no default" : "the model does not store a value to compare" };
  }
  const limitValue = limit.value;
  const bad = failsWhen === "above" ? measured > limitValue + 1e-9 : measured < limitValue - 1e-9;
  const placement = bad ? "outside" : "inside";
  if (limit.source === "provisional") {
    return { id, system, system_id: systemId, check, verdict: "PROVISIONAL", key: limit.key, clause: limit.clause, measured, limit: limit.value,     detail: `${placement} the provisional limit (${round(measured)} against ${round(limitValue)})` };
  }
  return { id, system, system_id: systemId, check, verdict: bad ? "FAIL" : "PASS", key: limit.key, clause: limit.clause, measured, limit: limitValue, detail: `${placement} ${limit.key} (${round(measured)} against ${round(limitValue)})` };
}

function round(value: number): string {
  if (Math.abs(value) >= 10) return String(Math.round(value));
  return String(Math.round(value * 1000) / 1000);
}

function standardsRun(id: string, title: string, verdicts: Verdict[], systems: TraceSystem[], checked: Record<string, number>): CheckRun {
  const findings = verdicts.map(verdictFinding).filter((item): item is TraceFinding => item != null);
  return runOf({ id, title }, STANDARD_CODES, findings, checked, [], { systems: rollup(verdicts, systems) });
}

function pipeSize(graph: Graph, id: number): number {
  const cons = graph.byElement.get(id) ?? [];
  return Math.max(0, ...cons.map((connector) => connector.size_mm || 0));
}

export function runDrainageFall(snapshot: TraceSnapshot, _limits: unknown, filter: TraceFilter): CheckRun {
  const graph = graphOf(snapshot);
  const verdicts: Verdict[] = [];
  for (const element of graph.elements.values()) {
    if (!["pipe", "flex_pipe", "curve"].includes(element.kind ?? "")) continue;
    const blob = systemBlob(graph, element.id);
    if (!wasteClass(blob)) continue;
    const systemId = (graph.member.get(element.id) ?? [])[0];
    const limit = fallLimit(pipeSize(graph, element.id), filter.bank as never);
    verdicts.push(judge(slope(element), limit, "below", "drainage_fall", element.id, systemNames(graph, element.id), systemId));
  }
  return standardsRun("drainage_fall", "Drainage fall", verdicts, graph.systems, { pipes: verdicts.length });
}

/** Distance from the trap to the vent connection, not the length of the whole trap arm. */
function ventJunctionMm(graph: Graph, trapId: number): number | null {
  const seen = new Set<number>([trapId]);
  const queue: Array<{ id: number; dist: number }> = [{ id: trapId, dist: 0 }];
  while (queue.length) {
    const current = queue.shift() as { id: number; dist: number };
    for (const next of graph.adj.get(current.id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (partRole(graph.elements.get(next)) === "vent" || ventClass(systemBlob(graph, next))) return current.dist;
      const element = graph.elements.get(next);
      const step = element && ["pipe", "flex_pipe", "curve"].includes(element.kind ?? "") ? curveLength(element) : 0;
      queue.push({ id: next, dist: current.dist + step });
    }
  }
  return null;
}

export function runVenting(snapshot: TraceSnapshot, _limits: unknown, filter: TraceFilter): CheckRun {
  const graph = graphOf(snapshot);
  const verdicts: Verdict[] = [];
  const limit = bankCite("trace.vent_distance", filter.bank as never);
  for (const element of graph.elements.values()) {
    if (partRole(element) !== "trap" && !(element.kind === "fixture" && (graph.byElement.get(element.id) ?? []).some((connector) => wasteClass(connectorClass(graph, connector))))) continue;
    const around = nearest(graph, element.id, 8);
    const vent = around.find((id) => id !== element.id && (partRole(graph.elements.get(id)) === "vent" || ventClass(systemBlob(graph, id))));
    const systemId = (graph.member.get(element.id) ?? [])[0];
    const offset = ventJunctionMm(graph, element.id);
    if (offset == null) {
      verdicts.push({ id: element.id, system: systemNames(graph, element.id), system_id: systemId, check: "venting", verdict: "UNKNOWN", key: limit.key, clause: limit.clause, detail: "no vent connection was reached, so the distance from the trap outlet is not measurable" });
      continue;
    }
    verdicts.push(judge(offset, limit, "above", "venting", element.id, systemNames(graph, element.id), systemId));
  }
  return standardsRun("venting", "Venting distance", verdicts, graph.systems, { traps: verdicts.length });
}

export function runCrossConnection(snapshot: TraceSnapshot, _limits: unknown, filter: TraceFilter): CheckRun {
  const graph = graphOf(snapshot);
  const verdicts: Verdict[] = [];
  const limit = citeLimit("trace.cross_connection", filter);
  const seen = new Set<string>();
  let joins = 0;
  for (const connector of graph.connectors) {
    const mine = connectorClass(graph, connector);
    const potable = supplyClass(mine);
    const waste = wasteClass(mine);
    if (!potable && !waste) continue;
    for (const ref of connector.refs ?? []) {
      const other = graph.connectors.find((item) => item.element_id === ref[0] && item.index === ref[1]);
      const otherClass = other ? connectorClass(graph, other) : systemBlob(graph, ref[0]);
      const cross = (potable && wasteClass(otherClass)) || (waste && supplyClass(otherClass));
      if (!cross) continue;
      const key = connector.element_id < ref[0] ? `${connector.element_id}|${ref[0]}` : `${ref[0]}|${connector.element_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      joins++;
      const systemId = (graph.member.get(connector.element_id) ?? [])[0];
      if (limit.source === "provisional") {
        verdicts.push({ id: connector.element_id, system: systemNames(graph, connector.element_id), system_id: systemId, check: "cross_connection", verdict: "PROVISIONAL", key: limit.key, clause: limit.clause, detail: "a supply connector joins a waste connector" });
      } else {
        verdicts.push({ id: connector.element_id, system: systemNames(graph, connector.element_id), system_id: systemId, check: "cross_connection", verdict: "FAIL", key: limit.key, clause: limit.clause, measured: 1, limit: limit.value ?? undefined, detail: "a supply connector joins a waste connector" });
      }
    }
  }
  if (joins === 0) {
    for (const system of graph.systems) {
      verdicts.push({ id: system.id, system: system.name, system_id: system.id, check: "cross_connection", verdict: limit.source === "provisional" ? "PROVISIONAL" : "PASS", key: limit.key, clause: limit.clause, measured: 0, limit: limit.value ?? undefined, detail: limit.source === "provisional" ? "no supply-to-waste join seen; the rule is not in the standards bank" : "no supply-to-waste join" });
    }
  }
  return standardsRun("cross_connection", "Cross-connection", verdicts, graph.systems, { joins });
}

export function runDeadLegs(snapshot: TraceSnapshot, _limits: unknown, filter: TraceFilter): CheckRun {
  const graph = graphOf(snapshot);
  const verdicts: Verdict[] = [];
  for (const element of graph.elements.values()) {
    const cons = (graph.byElement.get(element.id) ?? []).filter((connector) => connector.type !== "curve");
    if (element.kind !== "fitting" || cons.length < 3) continue;
    if (!/hot/.test(systemBlob(graph, element.id).toLowerCase())) continue;
    for (const branch of cons) {
      const next = (branch.refs ?? [])[0]?.[0];
      if (next == null) continue;
      const end = followToCap(graph, element.id, next);
      if (!end) continue;
      const length = pathLength(graph, element.id, end) ?? 0;
      const size = Math.max(pipeSize(graph, element.id), pipeSize(graph, next));
      const limit = deadLegLimitMm(size, filter.bank as never);
      const systemId = (graph.member.get(element.id) ?? [])[0];
      verdicts.push(judge(length, limit, "above", "dead_legs", element.id, systemNames(graph, element.id), systemId));
    }
  }
  if (verdicts.length === 0) {
    const limit = deadLegLimitMm(15, filter.bank as never);
    for (const system of graph.systems.filter((system) => /hot/.test(`${system.classification ?? ""} ${system.name}`.toLowerCase()))) {
      verdicts.push({ id: system.id, system: system.name, system_id: system.id, check: "dead_legs", verdict: "UNKNOWN", key: limit.key, clause: limit.clause, detail: "no capped hot-water branch was measured" });
    }
  }
  return standardsRun("dead_legs", "Dead legs", verdicts, graph.systems, { branches: verdicts.length });
}

function followToCap(graph: Graph, from: number, start: number): number | null {
  let prev = from;
  let cursor = start;
  for (let step = 0; step < 8; step++) {
    if (partRole(graph.elements.get(cursor)) === "cap") return cursor;
    const next = [...(graph.adj.get(cursor) ?? [])].filter((id) => id !== prev);
    if (next.length !== 1) return partRole(graph.elements.get(cursor)) === "cap" ? cursor : null;
    prev = cursor;
    cursor = next[0];
  }
  return null;
}

export function runPressureFlow(snapshot: TraceSnapshot, _limits: unknown, filter: TraceFilter): CheckRun {
  const graph = graphOf(snapshot);
  const verdicts: Verdict[] = [];
  for (const system of graph.systems) {
    if (!supplyClass(`${system.classification ?? ""} ${system.name}`)) continue;
    const members = [...new Set(system.element_ids ?? [])];
    let units = 0;
    let unknown = false;
    let pressure: number | null = null;
    for (const id of members) {
      const element = graph.elements.get(id);
      if (!element) continue;
      if (element.pressure_kpa != null) pressure = pressure == null ? element.pressure_kpa : Math.min(pressure, element.pressure_kpa);
      if (element.kind !== "fixture") continue;
      const lu = loadingUnits(`${element.name ?? ""} ${element.category ?? ""}`, filter.bank as never);
      if (!lu.known || lu.units == null) unknown = true;
      else units += lu.units;
    }
    const sized = members.map((id) => pipeSize(graph, id)).filter((size) => size > 0);
    const size = sized.length ? Math.max(...sized) : 0;
    const limit = size > 0 ? pipeCapacity(size, filter.bank as never) : citeLimit("trace.pipe_capacity_fu", filter);
    if (unknown || size <= 0 || limit.value == null) {
      verdicts.push({ id: system.id, system: system.name, system_id: system.id, check: "pressure_flow", verdict: "UNKNOWN", key: limit.key, clause: limit.clause, measured: units, detail: unknown ? "a fixture has no supply loading unit" : "no pipe size or pipe capacity to compare" });
    } else {
      verdicts.push(judge(units, limit, "above", "pressure_flow", system.id, system.name, system.id));
    }
    const residual = bankCite("trace.residual_pressure_min", filter.bank as never);
    verdicts.push(pressure == null
      ? { id: system.id, system: system.name, system_id: system.id, check: "residual_pressure", verdict: "UNKNOWN", key: residual.key, clause: residual.clause, limit: residual.value ?? undefined, detail: "residual pressure is not stored on the system" }
      : judge(pressure, residual, "below", "residual_pressure", system.id, system.name, system.id));
  }
  return standardsRun("pressure_flow", "Pressure and flow by fixture units", verdicts, graph.systems, { systems: verdicts.length });
}

function wireArea(wire: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(wire ?? "");
  if (!match) return null;
  const mm2 = Number(match[1]);
  return Number.isFinite(mm2) && mm2 > 0 ? mm2 : null;
}

export function runVoltageDrop(snapshot: TraceSnapshot, _limits: unknown, filter: TraceFilter): CheckRun {
  const verdicts: Verdict[] = [];
  const dropLimit = citeLimit("trace.voltage_drop_pct", filter);
  for (const circuit of snapshot.electrical?.circuits ?? []) {
    const length = circuit.length_m;
    const volts = circuit.voltage ?? 0;
    const area = wireArea(circuit.wire_size ?? "");
    const amps = (circuit.apparent_va && volts) ? circuit.apparent_va / volts : (circuit.rating_a ?? 0);
    const mv = area == null ? null : voltageDropMv(area, filter.bank as never);
    if (length == null || length <= 0 || volts <= 0 || area == null || amps <= 0 || mv == null || mv.value == null || dropLimit.value == null) {
      verdicts.push({ id: circuit.id, system: circuit.panel_name, check: "voltage_drop", verdict: "UNKNOWN", key: mv?.key ?? dropLimit.key, clause: mv?.clause ?? dropLimit.clause, detail: "length, voltage, wire size, current or mV/A/m is missing" });
      continue;
    }
    const percent = (mv.value * amps * length) / volts / 10;
    const bad = percent > dropLimit.value;
    const source = dropLimit.source === "provisional" || mv.source === "provisional" ? "provisional" : dropLimit.source;
    const clause = source === "provisional" ? mv.clause : dropLimit.clause;
    verdicts.push({ id: circuit.id, system: circuit.panel_name, check: "voltage_drop", verdict: source === "provisional" ? "PROVISIONAL" : bad ? "FAIL" : "PASS", key: mv.key, clause, measured: percent, limit: dropLimit.value, detail: `${bad ? "outside" : "inside"} ${round(percent)}% against ${dropLimit.value}%` });
  }
  return standardsRun("voltage_drop", "Voltage drop", verdicts, [], { circuits: verdicts.length });
}

export function runOverload(snapshot: TraceSnapshot, _limits: unknown, filter: TraceFilter): CheckRun {
  const verdicts: Verdict[] = [];
  const limit = citeLimit("trace.overload_ratio", filter);
  for (const circuit of snapshot.electrical?.circuits ?? []) {
    const rating = circuit.rating_a ?? 0;
    const volts = circuit.voltage ?? 0;
    if (rating <= 0 || volts <= 0 || circuit.apparent_va == null) {
      verdicts.push({ id: circuit.id, system: circuit.panel_name, check: "overload", verdict: "UNKNOWN", key: limit.key, clause: limit.clause, detail: "rating, voltage or apparent load is missing" });
      continue;
    }
    const ratio = (circuit.apparent_va / volts) / rating;
    verdicts.push(judge(ratio, limit, "above", "overload", circuit.id, circuit.panel_name));
  }
  return standardsRun("overload", "Overload", verdicts, [], { circuits: verdicts.length });
}

export function runPhaseBalance(snapshot: TraceSnapshot, _limits: unknown, filter: TraceFilter): CheckRun {
  const verdicts: Verdict[] = [];
  const limits = phaseLimits(filter.bank as never);
  const limit = limits.standing;
  const byPanel = new Map<number, Array<{ phase: string; load: number }>>();
  for (const circuit of snapshot.electrical?.circuits ?? []) {
    if (!circuit.panel_id) continue;
    const list = byPanel.get(circuit.panel_id) ?? [];
    list.push({ phase: (circuit.phase ?? "").trim(), load: circuit.apparent_va ?? 0 });
    byPanel.set(circuit.panel_id, list);
  }
  for (const panel of snapshot.electrical?.panels ?? []) {
    const rows = byPanel.get(panel.id) ?? [];
    if (rows.length === 0 || rows.some((row) => !row.phase)) {
      verdicts.push({ id: panel.id, system: panel.name, check: "phase_balance", verdict: "UNKNOWN", key: limit.key, clause: limit.clause, detail: "a circuit has no phase" });
      continue;
    }
    const loads = new Map<string, number>();
    for (const row of rows) loads.set(row.phase, (loads.get(row.phase) ?? 0) + row.load);
    const values = [...loads.values()];
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    const imbalance = avg > 0 ? ((max - min) / avg) * 100 : 0;
    if (limits.shortTerm.value != null && limit.value != null && imbalance > limit.value && imbalance <= limits.shortTerm.value) {
      verdicts.push({ id: panel.id, system: panel.name, check: "phase_balance", verdict: "PROVISIONAL", key: limit.key, clause: limits.shortTerm.clause, measured: imbalance, limit: limit.value, detail: `within the ${limits.shortTerm.value}% short-term allowance, over the ${limit.value}% limit` });
    } else {
      verdicts.push(judge(imbalance, limit, "above", "phase_balance", panel.id, panel.name));
    }
  }
  return standardsRun("phase_balance", "Phase balance", verdicts, [], { panels: verdicts.length });
}

export const MISSING_CHECK: TraceCheck = {
  id: "missing",
  title: "Missing parts",
  phase: 2,
  implemented: true,
  codes: MISSING_CODES,
  needs: "Connector graph, names, and system classification.",
  run: (snapshot, limits, filter) => runMissing(snapshot, limits, filter),
};

export const STANDARDS_CHECKS: TraceCheck[] = [
  { id: "drainage_fall", title: "Drainage fall", phase: 2, implemented: true, codes: STANDARD_CODES, needs: "Curve endpoints and a sanitary classification.", run: runDrainageFall },
  { id: "venting", title: "Venting distance", phase: 2, implemented: true, codes: STANDARD_CODES, needs: "A trap or a sanitary fixture, and a vent reached through connectors.", run: runVenting },
  { id: "cross_connection", title: "Cross-connection", phase: 2, implemented: true, codes: STANDARD_CODES, needs: "Supply and waste classifications on the connectors that meet.", run: runCrossConnection },
  { id: "dead_legs", title: "Dead legs", phase: 2, implemented: true, codes: STANDARD_CODES, needs: "A tee, a single capped branch, and curve lengths.", run: runDeadLegs },
  { id: "pressure_flow", title: "Pressure and flow by fixture units", phase: 2, implemented: true, codes: STANDARD_CODES, needs: "Fixture names and a pipe size. This is not a pressure result.", run: runPressureFlow },
  { id: "voltage_drop", title: "Voltage drop", phase: 2, implemented: true, codes: STANDARD_CODES, needs: "Circuit length, wire size, voltage and load.", run: runVoltageDrop },
  { id: "overload", title: "Overload", phase: 2, implemented: true, codes: STANDARD_CODES, needs: "Apparent load, voltage and a stored ampere rating.", run: runOverload },
  { id: "phase_balance", title: "Phase balance", phase: 2, implemented: true, codes: STANDARD_CODES, needs: "A phase value on every circuit of the panel.", run: runPhaseBalance },
];

export const REMAINING_PHASE2 = [
  { id: "duct_airflow", title: "Duct airflow", needs: "Airflow on terminals and a kit velocity band. This pass does not read airflow." },
  { id: "fitting_corner", title: "Fitting and corner", needs: "A kit minimum bend radius. Phase 2 reports a missing fitting, not the bend radius." },
  { id: "earthing", title: "Earthing resistance", needs: "A measured earth resistance. An open ground connector is ELEC-NO-EARTH, not a resistance." },
  { id: "tray_fill", title: "Tray fill", needs: "Cable trays and their contents. They are not in this snapshot." },
];

export const STANDARDS_IDS = STANDARDS_CHECKS.map((check) => check.id);

function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function planFixes(snapshot: TraceSnapshot, limits: { values: { near_miss_mm: number; direction_deg: number; size_mismatch_mm: number } }, options: { caps?: boolean; circuit?: string; max?: number } = {}): { edits: TraceEdit[]; warnings: string[]; rule: string; capped: boolean } {
  const graph = graphOf(snapshot);
  const edits: TraceEdit[] = [];
  const warnings: string[] = [];
  const max = options.max ?? 25;
  const used = new Set<string>();
  const take = (key: string) => { if (used.has(key)) return false; used.add(key); return true; };
  const physical = graph.connectors.filter((connector) => connector.type !== "curve" && !connector.connected && connector.open_end && connector.origin.length >= 3);
  type Pair = { left: TraceConnector; right: TraceConnector; gap: number };
  const pairs: Pair[] = [];
  for (let i = 0; i < physical.length; i++) {
    for (let j = i + 1; j < physical.length; j++) {
      const left = physical[i];
      const right = physical[j];
      if (left.element_id === right.element_id || left.domain !== right.domain) continue;
      const gap = dist(left.origin, right.origin);
      if (gap > limits.values.near_miss_mm) continue;
      if ((left.refs ?? []).some((ref) => ref[0] === right.element_id)) continue;
      pairs.push({ left, right, gap });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap);
  const claimed = new Set<string>();
  const claim = (connector: TraceConnector) => {
    const key = `${connector.element_id}:${connector.index}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  };
  for (const pair of pairs) {
    const third = pairs.find((other) => other !== pair && (
      (other.left.element_id === pair.left.element_id && other.left.index === pair.left.index)
      || (other.right.element_id === pair.left.element_id && other.right.index === pair.left.index)
      || (other.left.element_id === pair.right.element_id && other.left.index === pair.right.index)
      || (other.right.element_id === pair.right.element_id && other.right.index === pair.right.index)
    ));
    if (!third) continue;
    const ids = [pair.left, pair.right, third.left, third.right];
    const unique = [...new Map(ids.map((connector) => [`${connector.element_id}:${connector.index}`, connector])).values()];
    if (unique.length !== 3) continue;
    if (unique.some((connector) => claimed.has(`${connector.element_id}:${connector.index}`))) continue;
    unique.forEach(claim);
    const [a, b, c] = unique;
    edits.push({ op: "tee", ids: [a.element_id, b.element_id, c.element_id], a: a.element_id, ai: a.index, b: b.element_id, bi: b.index, c: c.element_id, ci: c.index, detail: "three open connectors meet: insert a tee" });
  }
  for (const pair of pairs) {
    if (!claim(pair.left) || !claim(pair.right)) continue;
    const aligned = oppose(pair.left.direction, pair.right.direction, limits.values.direction_deg) === true;
    const sizes = pair.left.size_mm > 0 && pair.right.size_mm > 0 && Math.abs(pair.left.size_mm - pair.right.size_mm) > limits.values.size_mismatch_mm;
    const ids = [pair.left.element_id, pair.right.element_id];
    if (aligned && sizes) edits.push({ op: "transition", ids, a: pair.left.element_id, ai: pair.left.index, b: pair.right.element_id, bi: pair.right.index, detail: "in-line connectors differ in size: insert a transition" });
    else if (aligned) edits.push({ op: "connect", ids, a: pair.left.element_id, ai: pair.left.index, b: pair.right.element_id, bi: pair.right.index, detail: "connectors face each other within tolerance: connect them" });
    else edits.push({ op: "elbow", ids, a: pair.left.element_id, ai: pair.left.index, b: pair.right.element_id, bi: pair.right.index, detail: "connectors meet off the straight: insert an elbow" });
  }
  const resized = new Set<string>();
  for (const connector of graph.connectors) {
    for (const ref of connector.refs ?? []) {
      const other = graph.connectors.find((item) => item.element_id === ref[0] && item.index === ref[1]);
      if (!other || other.element_id === connector.element_id) continue;
      if (connector.size_mm <= 0 || other.size_mm <= 0) continue;
      if (Math.abs(connector.size_mm - other.size_mm) <= limits.values.size_mismatch_mm) continue;
      const key = pairKey(connector.element_id, other.element_id);
      if (resized.has(key)) continue;
      const smaller = connector.size_mm < other.size_mm ? connector : other;
      const larger = smaller === connector ? other : connector;
      const element = graph.elements.get(smaller.element_id);
      if (!element || !["pipe", "duct", "flex_pipe", "flex_duct", "curve"].includes(element.kind ?? "")) continue;
      resized.add(key);
      edits.push({ op: "resize", ids: [smaller.element_id], element_id: smaller.element_id, size_mm: larger.size_mm, height_mm: larger.height_mm || 0, detail: `${RESIZE_RULE} ${smaller.element_id} from ${smaller.size_mm} mm to ${larger.size_mm} mm.` });
    }
  }
  if (options.caps) {
    for (const connector of physical) {
      if (claimed.has(`${connector.element_id}:${connector.index}`)) continue;
      const element = graph.elements.get(connector.element_id);
      if (!element || !["pipe", "duct", "flex_pipe", "flex_duct", "curve"].includes(element.kind ?? "")) continue;
      edits.push({ op: "cap", ids: [connector.element_id], element_id: connector.element_id, index: connector.index, detail: "open pipe or duct end: place a cap if a cap family is loaded" });
    }
  }
  for (const element of graph.elements.values()) {
    if ((graph.member.get(element.id) ?? []).length > 0) continue;
    const neighbourSystems = new Set<number>();
    for (const other of graph.adj.get(element.id) ?? []) for (const systemId of graph.member.get(other) ?? []) neighbourSystems.add(systemId);
    if (neighbourSystems.size !== 1) continue;
    const systemId = [...neighbourSystems][0];
    edits.push({ op: "assign_system", ids: [element.id], element_id: element.id, system_id: systemId, detail: `element touches only system ${systemId}: assign it` });
  }
  const circuitId = Number(options.circuit ?? "");
  if (options.circuit && !Number.isInteger(circuitId)) warnings.push("circuit must be an element id.");
  else if (Number.isInteger(circuitId) && circuitId > 0) {
    const known = (snapshot.electrical?.circuits ?? []).some((circuit) => circuit.id === circuitId);
    if (!known) warnings.push(`Circuit ${circuitId} is not in the snapshot.`);
    else {
      for (const device of snapshot.electrical?.devices ?? []) {
        if (!device.power_connector || (device.circuit_ids ?? []).length > 0) continue;
        edits.push({ op: "circuit", ids: [device.id], element_id: device.id, circuit_id: circuitId, detail: `add the device to circuit ${circuitId}` });
      }
    }
  }
  const capped = edits.length > max;
  return { edits: edits.slice(0, max), warnings, rule: RESIZE_RULE, capped };
}

export function dropOwnedEdits(edits: TraceEdit[], skipped: Array<{ id: string }>): TraceEdit[] {
  const drop = new Set(skipped.map((row) => String(row.id)));
  return edits.filter((edit) => edit.ids.every((id) => !drop.has(String(id))));
}

export function refuseTraceWrite(doc: { title?: string; path?: string; is_central?: boolean }, protectedPaths: string[] = []): string | null {
  const title = doc.title ?? "";
  const file = (doc.path ?? "").replace(/\//g, "\\");
  if (/hebert hostels/i.test(`${title} ${file}`)) return "HEBERT HOSTELS is not written by fmc_trace.";
  if (doc.is_central) return "A central model is not written by fmc_trace.";
  const path = file.toLowerCase();
  for (const root of protectedPaths) {
    const norm = root.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (!norm) continue;
    if (path === norm || path.startsWith(norm + "\\")) return `The document is under a protected path (${root}).`;
  }
  return null;
}
