/**
 * Counts and recommendations for the systems flow tracer. Pure: both read the snapshot
 * the leak and continuity checks already collect. A limit missing from the standards bank
 * is marked PROVISIONAL.
 */

import type { TraceElement, TraceFilter, TraceSnapshot, TraceSystem } from "./trace.js";
import { citeLimit, fixtureUnits, partRole, runMissing, type CitedLimit, type TraceEdit } from "./trace_phase2.js";

export const RECOMMENDATION_CODES = [
  "REC-UPSIZE-PIPE",
  "REC-SPLIT-SOCKETS",
  "REC-SPLIT-LIGHTS",
  "REC-SPLIT-LOAD",
  "REC-REBALANCE",
  "REC-ADD-CLEANOUT",
  "REC-ADD-VALVE",
  "REC-REGRADE",
  "REC-ADD-CAP",
  "REC-ASSIGN-SYSTEM",
] as const;

const SIZE_LADDER = [
  { nominal: 15, key: "trace.fu_capacity_15" },
  { nominal: 22, key: "trace.fu_capacity_22" },
  { nominal: 28, key: "trace.fu_capacity_28" },
  { nominal: 32, key: "trace.fu_capacity_32" },
  { nominal: 40, key: "trace.fu_capacity_40" },
  { nominal: 50, key: "trace.fu_capacity_50" },
  { nominal: 54, key: "trace.fu_capacity_54" },
] as const;

export interface TraceRecommendation {
  id: string;
  code: (typeof RECOMMENDATION_CODES)[number];
  element_id: number;
  system?: string;
  current: string;
  target: string;
  key: string;
  clause: string;
  provisional: boolean;
  advisory: boolean;
  edit?: TraceEdit;
}

export interface TraceCounts {
  document: { systems: number; elements: number; orphans: number; uncircuited: number };
  systems: Array<Record<string, unknown>>;
  plumbing: { fixtures: Record<string, number>; fixture_units: number; fittings: { elbow: number; tee: number; transition: number; cap: number; other: number }; valves: number; traps: number; cleanouts: number; vents: number; pipe_m_by_size: Record<string, number> };
  ducts: { terminals: number; fittings: number; dampers: number; duct_m_by_size: Record<string, number> };
  electrical: { panels: Array<{ id: number; name: string; circuits: number; load_va: number; phases: Record<string, number>; spare_ways: number | null; circuit_detail: Array<Record<string, unknown>> }>; cable_m: number | null };
  orphans: number[];
}

function lengthMm(el?: TraceElement): number {
  const curve = el?.curve;
  if (!curve || curve.length < 2) return 0;
  const a = curve[0];
  const b = curve[1];
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function slopeOf(el?: TraceElement): number | null {
  const curve = el?.curve;
  if (!curve || curve.length < 2) return null;
  const horiz = Math.hypot(curve[1][0] - curve[0][0], curve[1][1] - curve[0][1]);
  if (horiz < 50) return null;
  return Math.abs(curve[1][2] - curve[0][2]) / horiz;
}

function ratio(slope: number): string {
  if (slope <= 0) return "flat";
  return `1:${Math.round(1 / slope)}`;
}

function addCount(bag: Record<string, number>, key: string, amount = 1) {
  bag[key] = Math.round(((bag[key] ?? 0) + amount) * 1000) / 1000;
}

function pipeSize(snapshot: TraceSnapshot, id: number): number {
  const sizes = (snapshot.flow?.connectors ?? []).filter((connector) => connector.element_id === id).map((connector) => connector.size_mm || 0);
  return Math.max(0, ...sizes);
}

function connectorsOf(snapshot: TraceSnapshot, id: number) {
  return (snapshot.flow?.connectors ?? []).filter((connector) => connector.element_id === id && connector.type !== "curve");
}

function fittingKind(snapshot: TraceSnapshot, el: TraceElement): string {
  const role = partRole(el);
  if (role === "cap") return "cap";
  if (el.kind !== "fitting") return "";
  const cons = connectorsOf(snapshot, el.id);
  if (cons.length >= 3) return "tee";
  if (cons.length === 2) {
    const sizes = cons.map((connector) => connector.size_mm || 0).filter((size) => size > 0);
    const differ = sizes.length === 2 && Math.abs(sizes[0] - sizes[1]) > 2;
    return differ ? "transition" : "elbow";
  }
  return "other";
}

function members(system: TraceSystem, elements: TraceElement[]): TraceElement[] {
  const ids = new Set(system.element_ids ?? []);
  return elements.filter((element) => ids.has(element.id) || (element.system_ids ?? []).includes(system.id));
}

function supply(system: TraceSystem): boolean {
  return /domestic/.test(`${system.classification ?? ""} ${system.name}`.toLowerCase());
}

function isSocket(name: string, category: string): boolean {
  return /socket|outlet|power point/.test(`${name} ${category}`.toLowerCase());
}

function isLight(category: string): boolean {
  return /lighting fixture/.test(category.toLowerCase());
}

export function countSystems(snapshot: TraceSnapshot): TraceCounts {
  const elements = snapshot.flow?.elements ?? [];
  const systems = snapshot.flow?.systems ?? [];
  const memberIds = new Set<number>();
  for (const system of systems) for (const id of system.element_ids ?? []) memberIds.add(id);
  for (const element of elements) if ((element.system_ids ?? []).length) memberIds.add(element.id);
  const orphans = elements.filter((element) => !memberIds.has(element.id)).map((element) => element.id);
  const plumbing = { fixtures: {} as Record<string, number>, fixture_units: 0, fittings: { elbow: 0, tee: 0, transition: 0, cap: 0, other: 0 }, valves: 0, traps: 0, cleanouts: 0, vents: 0, pipe_m_by_size: {} as Record<string, number> };
  const ducts = { terminals: 0, fittings: 0, dampers: 0, duct_m_by_size: {} as Record<string, number> };
  const rows: Array<Record<string, unknown>> = [];

  for (const system of systems) {
    const mine = members(system, elements);
    const fixtures: Record<string, number> = {};
    let units = 0;
    const fittings = { elbow: 0, tee: 0, transition: 0, cap: 0, other: 0 };
    let valves = 0;
    let traps = 0;
    let cleanouts = 0;
    let vents = 0;
    let terminals = 0;
    let dampers = 0;
    let ductFittings = 0;
    const pipeBySize: Record<string, number> = {};
    const ductBySize: Record<string, number> = {};
    for (const element of mine) {
      const role = partRole(element);
      if (element.kind === "fixture" && system.domain === "piping") {
        const type = (element.name || "fixture").slice(0, 60);
        addCount(fixtures, type);
        addCount(plumbing.fixtures, type);
        const fu = fixtureUnits(element);
        if (fu.known) { units += fu.units; plumbing.fixture_units += fu.units; }
      }
      if (role === "valve") { valves++; plumbing.valves++; }
      if (role === "trap") { traps++; plumbing.traps++; }
      if (role === "cleanout") { cleanouts++; plumbing.cleanouts++; }
      if (role === "vent") { vents++; plumbing.vents++; }
      if (role === "damper") { dampers++; ducts.dampers++; }
      if (element.kind === "terminal") { terminals++; ducts.terminals++; }
      const kind = fittingKind(snapshot, element);
      if (kind && system.domain === "piping") {
        fittings[kind as "elbow"]++;
        plumbing.fittings[kind as "elbow"]++;
      }
      if (element.kind === "fitting" && system.domain === "hvac") { ductFittings++; ducts.fittings++; }
      const metres = lengthMm(element) / 1000;
      const size = String(Math.round(pipeSize(snapshot, element.id)) || "unset");
      if (metres > 0 && (element.kind === "pipe" || element.kind === "flex_pipe")) {
        addCount(pipeBySize, size, metres);
        addCount(plumbing.pipe_m_by_size, size, metres);
      }
      if (metres > 0 && (element.kind === "duct" || element.kind === "flex_duct")) {
        addCount(ductBySize, size, metres);
        addCount(ducts.duct_m_by_size, size, metres);
      }
    }
    rows.push({
      id: system.id, name: system.name, domain: system.domain, classification: system.classification ?? "", elements: mine.length,
      ...(system.domain === "piping" ? { fixtures, fixture_units: units, fittings, valves, traps, cleanouts, vents, pipe_m_by_size: pipeBySize } : {}),
      ...(system.domain === "hvac" ? { terminals, fittings: ductFittings, dampers, duct_m_by_size: ductBySize } : {}),
    });
  }

  const devices = snapshot.electrical?.devices ?? [];
  const circuits = snapshot.electrical?.circuits ?? [];
  let cable = 0;
  let cableKnown = false;
  const panels = (snapshot.electrical?.panels ?? []).map((panel) => {
    const mine = circuits.filter((circuit) => circuit.panel_id === panel.id);
    const phases: Record<string, number> = {};
    let load = 0;
    const detail = mine.map((circuit) => {
      const on = devices.filter((device) => (device.circuit_ids ?? []).includes(circuit.id));
      const byType: Record<string, number> = {};
      for (const device of on) addCount(byType, (device.name || device.category || "device").slice(0, 60));
      const va = circuit.apparent_va ?? 0;
      load += va;
      const phase = (circuit.phase ?? "").trim() || "unset";
      phases[phase] = (phases[phase] ?? 0) + va;
      if ((circuit.length_m ?? 0) > 0) { cable += circuit.length_m ?? 0; cableKnown = true; }
      return { id: circuit.id, number: circuit.number || String(circuit.id), devices: byType, load_va: va, length_m: (circuit.length_m ?? 0) > 0 ? circuit.length_m : null, phase };
    });
    const ways = panel.ways ?? 0;
    return { id: panel.id, name: panel.name, circuits: mine.length, load_va: load, phases, spare_ways: ways > 0 ? Math.max(0, ways - mine.length) : null, circuit_detail: detail };
  });
  const uncircuited = devices.filter((device) => device.power_connector && (device.circuit_ids ?? []).length === 0).length;
  return {
    document: { systems: systems.length, elements: elements.length, orphans: orphans.length, uncircuited },
    systems: rows,
    plumbing,
    ducts,
    electrical: { panels, cable_m: cableKnown ? Math.round(cable * 100) / 100 : null },
    orphans,
  };
}

function rung(size: number): { nominal: number; key: string } {
  return SIZE_LADDER.find((step) => size <= step.nominal) ?? SIZE_LADDER[SIZE_LADDER.length - 1];
}

function nextRung(size: number, units: number, filter: TraceFilter): { nominal: number; limit: CitedLimit } | null {
  for (const step of SIZE_LADDER) {
    if (step.nominal <= size) continue;
    const limit = citeLimit(step.key, filter);
    if (limit.value >= units) return { nominal: step.nominal, limit };
  }
  return null;
}

function rec(partial: Omit<TraceRecommendation, "provisional" | "key" | "clause"> & { limit: CitedLimit }): TraceRecommendation {
  return {
    id: partial.id, code: partial.code, element_id: partial.element_id, system: partial.system,
    current: partial.current, target: partial.target, key: partial.limit.key, clause: partial.limit.clause,
    provisional: partial.limit.source !== "standards", advisory: partial.advisory, edit: partial.edit,
  };
}

export function recommend(snapshot: TraceSnapshot, filter: TraceFilter, limits: { values: { near_miss_mm: number; direction_deg: number; size_mismatch_mm: number; connected_gap_mm: number; touch_mm: number; voltage_tol_v: number } }): TraceRecommendation[] {
  const out: TraceRecommendation[] = [];
  const elements = snapshot.flow?.elements ?? [];
  const systems = snapshot.flow?.systems ?? [];
  for (const system of systems.filter(supply)) {
    const mine = members(system, elements).filter((element) => element.kind === "pipe" || element.kind === "flex_pipe");
    let units = 0;
    for (const element of members(system, elements)) if (element.kind === "fixture") {
      const fu = fixtureUnits(element, filter);
      if (fu.known) units += fu.units;
    }
    const sizes = mine.map((element) => pipeSize(snapshot, element.id)).filter((size) => size > 0);
    if (!sizes.length || units <= 0) continue;
    const main = Math.max(...sizes);
    const current = citeLimit(rung(main).key, filter);
    if (units <= current.value) continue;
    const next = nextRung(main, units, filter);
    if (!next) continue;
    for (const element of mine.filter((item) => pipeSize(snapshot, item.id) === main)) {
      out.push(rec({
        id: `REC-UPSIZE-PIPE:${element.id}`, code: "REC-UPSIZE-PIPE", element_id: element.id, system: system.name,
        current: `${units} FU on ${main} mm`, target: `${next.nominal} mm`, limit: current, advisory: false,
        edit: { op: "resize", ids: [element.id], element_id: element.id, size_mm: next.nominal, height_mm: 0, detail: `increase pipe ${main} to ${next.nominal} mm: ${units} FU exceeds the ${current.value} FU capacity` },
      }));
    }
  }

  const points = citeLimit("trace.max_points_per_circuit", filter);
  const lights = citeLimit("trace.max_lights_per_circuit", filter);
  const loadLimit = citeLimit("trace.max_circuit_load_w", filter);
  for (const circuit of snapshot.electrical?.circuits ?? []) {
    const on = (snapshot.electrical?.devices ?? []).filter((device) => (device.circuit_ids ?? []).includes(circuit.id));
    const sockets = on.filter((device) => isSocket(device.name ?? "", device.category ?? "")).length;
    const lamps = on.filter((device) => isLight(device.category ?? "")).length;
    const label = circuit.number || String(circuit.id);
    if (sockets > points.value) {
      out.push(rec({
        id: `REC-SPLIT-SOCKETS:${circuit.id}`, code: "REC-SPLIT-SOCKETS", element_id: circuit.id, system: circuit.panel_name,
        current: `circuit ${label} has ${sockets} sockets`, target: `max ${points.value} per circuit, so split it`, limit: points, advisory: true,
      }));
    }
    if (lamps > lights.value) {
      out.push(rec({
        id: `REC-SPLIT-LIGHTS:${circuit.id}`, code: "REC-SPLIT-LIGHTS", element_id: circuit.id, system: circuit.panel_name,
        current: `${lamps} lights`, target: `${lights.value} per circuit`, limit: lights, advisory: true,
      }));
    }
    const va = circuit.apparent_va ?? 0;
    if (lamps > 0 && va > loadLimit.value) {
      out.push(rec({
        id: `REC-SPLIT-LOAD:${circuit.id}`, code: "REC-SPLIT-LOAD", element_id: circuit.id, system: circuit.panel_name,
        current: `lighting circuit load ${Math.round(va / 100) / 10} kW`, target: `exceeds ${Math.round(loadLimit.value / 100) / 10} kW, so split it`, limit: loadLimit, advisory: true,
      }));
    }
  }

  const balance = citeLimit("trace.phase_imbalance_pct", filter);
  for (const panel of snapshot.electrical?.panels ?? []) {
    const mine = (snapshot.electrical?.circuits ?? []).filter((circuit) => circuit.panel_id === panel.id && (circuit.phase ?? "").trim());
    const all = (snapshot.electrical?.circuits ?? []).filter((circuit) => circuit.panel_id === panel.id);
    if (all.length < 2 || mine.length !== all.length) continue;
    const loads = new Map<string, number>();
    for (const circuit of mine) {
      const phase = circuit.phase!.trim();
      loads.set(phase, (loads.get(phase) ?? 0) + (circuit.apparent_va ?? 0));
    }
    const entries = [...loads.entries()];
    if (entries.length < 2) continue;
    const max = Math.max(...entries.map((entry) => entry[1]));
    const min = Math.min(...entries.map((entry) => entry[1]));
    const avg = entries.reduce((sum, entry) => sum + entry[1], 0) / entries.length;
    const imbalance = avg > 0 ? ((max - min) / avg) * 100 : 0;
    if (imbalance <= balance.value) continue;
    const heavy = entries.reduce((best, entry) => entry[1] > best[1] ? entry : best);
    const light = entries.reduce((best, entry) => entry[1] < best[1] ? entry : best);
    const movers = mine.filter((circuit) => circuit.phase!.trim() === heavy[0]).sort((a, b) => (b.apparent_va ?? 0) - (a.apparent_va ?? 0)).slice(0, 2);
    out.push(rec({
      id: `REC-REBALANCE:${panel.id}`, code: "REC-REBALANCE", element_id: panel.id, system: panel.name,
      current: `${heavy[0]} ${Math.round(imbalance)}%`, target: `${balance.value}% by moving to ${light[0]}`, limit: balance, advisory: true,
    }));
    out[out.length - 1].current = `phase ${heavy[0]} is ${Math.round(imbalance)}% over`;
    out[out.length - 1].target = `move circuits ${movers.map((circuit) => circuit.number || circuit.id).join(" and ")} to ${light[0]}`;
  }

  const missing = runMissing(snapshot, limits, filter);
  for (const item of missing.findings) {
    if (item.code === "FLOW-NO-CLEANOUT") {
      const limit = citeLimit("trace.dead_leg_mm", filter);
      out.push(rec({ id: `REC-ADD-CLEANOUT:${item.id}`, code: "REC-ADD-CLEANOUT", element_id: item.id, system: item.system, current: "no cleanout", target: "a cleanout at this bend", limit, advisory: true }));
    }
    if (item.code === "FLOW-NO-ISOLATION") {
      const limit = citeLimit("trace.dead_leg_mm", filter);
      out.push(rec({ id: `REC-ADD-VALVE:${item.id}`, code: "REC-ADD-VALVE", element_id: item.id, system: item.system, current: "no isolation valve", target: "an isolation valve on this branch", limit, advisory: true }));
    }
    if (item.code === "FLOW-NO-CAP") {
      const connector = (snapshot.flow?.connectors ?? []).find((itemConnector) => itemConnector.element_id === item.id && itemConnector.open_end);
      out.push(rec({
        id: `REC-ADD-CAP:${item.id}`, code: "REC-ADD-CAP", element_id: item.id, system: item.system, current: "open end", target: "an end cap", limit: citeLimit("trace.near_miss_mm", filter), advisory: false,
        edit: { op: "cap", ids: [item.id], element_id: item.id, index: connector?.index ?? 0, detail: "open pipe or duct end: place a cap if a cap family is loaded" },
      }));
    }
  }

  for (const element of elements) {
    const classes = (element.system_ids ?? []).map((id) => systems.find((system) => system.id === id)?.classification ?? "").join(" ");
    if (!/sanitary|waste|soil|storm|foul/.test(classes.toLowerCase())) continue;
    if (element.kind !== "pipe" && element.kind !== "flex_pipe") continue;
    const value = slopeOf(element);
    if (value == null) continue;
    const limit = citeLimit(pipeSize(snapshot, element.id) <= 100 ? "trace.drain_fall_100" : pipeSize(snapshot, element.id) <= 150 ? "trace.drain_fall_150" : "trace.drain_fall_over", filter);
    if (value >= limit.value) continue;
    const system = systems.find((item) => (element.system_ids ?? []).includes(item.id));
    out.push(rec({
      id: `REC-REGRADE:${element.id}`, code: "REC-REGRADE", element_id: element.id, system: system?.name,
      current: ratio(value), target: ratio(limit.value), limit, advisory: true,
    }));
  }

  const memberIds = new Set<number>();
  for (const system of systems) for (const id of system.element_ids ?? []) memberIds.add(id);
  for (const element of elements) {
    if (memberIds.has(element.id) || (element.system_ids ?? []).length) continue;
    const neighbours = new Set<number>();
    for (const connector of snapshot.flow?.connectors ?? []) {
      if (connector.element_id !== element.id) continue;
      for (const ref of connector.refs ?? []) {
        const host = elements.find((item) => item.id === ref[0]);
        for (const systemId of host?.system_ids ?? []) neighbours.add(systemId);
        for (const system of systems) if ((system.element_ids ?? []).includes(ref[0])) neighbours.add(system.id);
      }
    }
    if (neighbours.size !== 1) continue;
    const systemId = [...neighbours][0];
    out.push(rec({
      id: `REC-ASSIGN-SYSTEM:${element.id}`, code: "REC-ASSIGN-SYSTEM", element_id: element.id, system: systems.find((system) => system.id === systemId)?.name,
      current: "no system", target: `system ${systemId}`, limit: citeLimit("trace.near_miss_mm", filter), advisory: false,
      edit: { op: "assign_system", ids: [element.id], element_id: element.id, system_id: systemId, detail: `element touches only system ${systemId}: assign it` },
    }));
  }
  return out;
}

export function editsForRecommendations(items: TraceRecommendation[], ids: string[]): { edits: TraceEdit[]; advisory: TraceRecommendation[]; unknown: string[] } {
  const wanted = new Set(ids);
  const chosen = items.filter((item) => wanted.has(item.id));
  const known = new Set(chosen.map((item) => item.id));
  return {
    edits: chosen.flatMap((item) => item.edit ? [item.edit] : []),
    advisory: chosen.filter((item) => item.advisory || !item.edit),
    unknown: ids.filter((id) => !known.has(id)),
  };
}

export function summariseCounts(full: TraceCounts, sample: number): Record<string, unknown> {
  return {
    document: full.document,
    systems: full.systems.slice(0, sample),
    systems_total: full.systems.length,
    plumbing: full.plumbing,
    ducts: full.ducts,
    electrical: {
      cable_m: full.electrical.cable_m,
      panels: full.electrical.panels.slice(0, sample).map((panel) => ({ ...panel, circuit_detail: (panel.circuit_detail as unknown[]).slice(0, sample) })),
    },
    orphans: full.orphans.slice(0, sample),
  };
}

export function summariseRecommendations(items: TraceRecommendation[], sample: number): Record<string, unknown> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.code] = (counts[item.code] ?? 0) + 1;
  return {
    counts,
    recommendations: items.slice(0, sample).map((item) => ({
      id: item.id, code: item.code, element_id: item.element_id, system: item.system,
      current: item.current, target: item.target, key: item.key, clause: item.clause,
      provisional: item.provisional, advisory: item.advisory,
    })),
    recommendations_total: items.length,
  };
}
