/**
 * Systems flow tracer (phase 1). Pure: the add-in collects a connector and circuit graph,
 * and this module walks it. No Revit types, no transactions.
 *
 * Leak test: water or air from a source, through Connector.AllRefs, against piping and duct system membership.
 * Continuity: current from each panel, through ElectricalSystem.BaseEquipment and Elements.
 * Later checks plug in as TraceCheck entries. They stay unimplemented until their rules exist.
 *
 * Tolerances are PROVISIONAL. They are not kit values. A standards-bank lookup can replace a key;
 * a missing key stays provisional (rule 7: a missing value is a kit change request, not a guessed one).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MISSING_CHECK, REMAINING_PHASE2, STANDARDS_CHECKS, STANDARDS_IDS } from "./trace_phase2.js";
import type { TraceBankEntry } from "./trace_bank.js";

export const LEAK_CODES = [
  "FLOW-OPEN-END",
  "FLOW-NOT-CONNECTED",
  "FLOW-SIZE-MISMATCH",
  "FLOW-NEAR-MISS",
  "FLOW-NO-SYSTEM",
  "FLOW-ISLAND",
] as const;

export const ELEC_CODES = [
  "ELEC-NO-CIRCUIT",
  "ELEC-NO-PANEL",
  "ELEC-NO-SUPPLY",
  "ELEC-VOLTAGE-MISMATCH",
  "ELEC-EMPTY-CIRCUIT",
] as const;

export type ProblemCode = (typeof LEAK_CODES)[number] | (typeof ELEC_CODES)[number];

/** Keys a later standards-bank reader can supply. Absent keys stay PROVISIONAL. */
export const TRACE_STANDARD_KEYS = {
  near_miss_mm: "trace.near_miss_mm",
  touch_mm: "trace.touch_mm",
  size_mismatch_mm: "trace.size_mismatch_mm",
  direction_deg: "trace.direction_deg",
  connected_gap_mm: "trace.connected_gap_mm",
  voltage_tol_v: "trace.voltage_tol_v",
} as const;

export type LimitKey = keyof typeof TRACE_STANDARD_KEYS;

/** PROVISIONAL defaults. Not from the kit. */
export const PROVISIONAL_LIMITS: Record<LimitKey, number> = {
  near_miss_mm: 50,
  touch_mm: 10,
  size_mismatch_mm: 2,
  direction_deg: 15,
  connected_gap_mm: 15,
  voltage_tol_v: 15,
};

export interface LimitField {
  key: string;
  value: number;
  source: "call" | "standards" | "provisional";
  status: "PROVISIONAL" | "standards" | "call";
}

export interface ResolvedLimits {
  /** PROVISIONAL when any field is still a default. */
  status: "PROVISIONAL" | "standards" | "call";
  values: Record<LimitKey, number>;
  fields: LimitField[];
  kit_change: string;
}

export type StandardsLookup = (key: string) => number | undefined;

export interface TraceConnector {
  element_id: number;
  index: number;
  domain: string;
  origin: number[];
  direction: number[];
  flow: string;
  shape: string;
  size_mm: number;
  height_mm: number;
  connected: boolean;
  type: string;
  open_end: boolean;
  system_id: number;
  /** PipeSystemType or DuctSystemType, when Revit has one. */
  system_class?: string;
  refs: number[][];
}

export interface TraceElement {
  id: number;
  name?: string;
  category?: string;
  kind?: string;
  domain?: string;
  system_ids?: number[];
  bbox?: number[] | null;
  curve?: number[][];
  /** Stored residual pressure, when the family has it. Compared with trace.residual_pressure_min. */
  pressure_kpa?: number;
}

export interface TraceSystem {
  id: number;
  name: string;
  domain: string;
  classification?: string;
  base_equipment_id?: number;
  element_ids: number[];
}

export interface TracePanel {
  id: number;
  name: string;
  distribution?: string;
  voltage?: number;
  poles?: number;
  has_supply: boolean;
  supply_circuit_id?: number;
  supply_from_id?: number;
  /** Main device rating in amperes. 0 means the parameter is empty. */
  main_a?: number;
  /** Panel ways, when the family stores them. 0 means unknown. */
  ways?: number;
}

export interface TraceCircuit {
  id: number;
  name?: string;
  number?: string;
  panel_id: number;
  panel_name?: string;
  system_type?: string;
  voltage?: number;
  poles?: number;
  distribution?: string;
  element_ids: number[];
  apparent_va?: number;
  rating_a?: number;
  length_m?: number;
  wire_size?: string;
  phase?: string;
}

export interface TraceDevice {
  id: number;
  name?: string;
  category?: string;
  voltage?: number;
  poles?: number;
  distribution?: string;
  power_connector: boolean;
  circuit_ids: number[];
  /** Ground connector on the family: connected, open, or absent when the family exposes none. */
  ground?: "connected" | "open" | "absent";
}

export interface TraceSnapshot {
  model?: string;
  resolved_document?: { title?: string; path?: string };
  active_unchanged?: boolean;
  modified_during_call?: boolean;
  truncated?: boolean;
  connectors_skipped?: number;
  api_limits?: string[];
  flow?: {
    elements?: TraceElement[];
    connectors?: TraceConnector[];
    systems?: TraceSystem[];
  };
  electrical?: {
    panels?: TracePanel[];
    circuits?: TraceCircuit[];
    devices?: TraceDevice[];
  };
  highlight?: { requested?: string; applied?: boolean; reason?: string; ids?: number[] };
  is_central?: boolean;
  is_workshared?: boolean;
}

export interface TraceFilter {
  system?: string;
  source?: string;
  domain?: "piping" | "duct" | "both";
  panel?: string;
  /** Standards-bank rows for this call, keyed by trace.*. A number, null, or a table. */
  bank?: Record<string, TraceBankEntry>;
}

export interface TraceFinding {
  code: string;
  id: number;
  other_id?: number;
  connector?: number;
  other_connector?: number;
  system?: string;
  detail: string;
}

export interface CheckRun {
  id: string;
  title: string;
  phase: number;
  implemented: boolean;
  pass: boolean;
  counts: Record<string, number>;
  findings: TraceFinding[];
  checked: Record<string, number>;
  warnings: string[];
  /** System roll-ups and the list of things the model cannot show. */
  extra?: {
    not_detectable?: string[];
    systems?: Array<{ id: number; name: string; verdict: "compliant" | "not compliant" | "incomplete data" }>;
  };
}

export interface TraceCheck {
  id: string;
  title: string;
  phase: number;
  implemented: boolean;
  codes: readonly string[];
  /** What a later phase needs before this check can run. */
  needs: string;
  run: (snapshot: TraceSnapshot, limits: ResolvedLimits, filter: TraceFilter) => CheckRun;
}

export interface TraceSelection {
  run: TraceCheck[];
  skipped: Array<{ id: string; title: string; phase: number; needs: string }>;
  unknown: string[];
}

const PHASE_2: Array<{ id: string; title: string; needs: string }> = REMAINING_PHASE2;

function unimplemented(spec: { id: string; title: string; needs: string }, codes: readonly string[] = []): TraceCheck {
  return {
    id: spec.id,
    title: spec.title,
    phase: 2,
    implemented: false,
    codes,
    needs: spec.needs,
    run: () => ({
      id: spec.id,
      title: spec.title,
      phase: 2,
      implemented: false,
      pass: false,
      counts: {},
      findings: [],
      checked: {},
      warnings: [`${spec.id} is not in phase 1. ${spec.needs}`],
    }),
  };
}

export const TRACE_CHECKS: TraceCheck[] = [
  { id: "leak", title: "Leak test (piping, drainage, duct)", phase: 1, implemented: true, codes: LEAK_CODES, needs: "Connector graph and piping or duct systems.", run: runLeak },
  { id: "continuity", title: "Electrical continuity", phase: 1, implemented: true, codes: ELEC_CODES, needs: "Panels, power circuits and power connectors.", run: runContinuity },
  MISSING_CHECK,
  ...STANDARDS_CHECKS,
  ...PHASE_2.map((spec) => unimplemented(spec)),
];

export const TRACE_API_LIMITS = [
  "Connector.Direction is flow (In, Out, Bidirectional). The joint axis is CoordinateSystem.BasisZ. Either read can throw; that connector is skipped.",
  "AllRefs includes the connector itself. Self-references are ignored.",
  "A curve connector left unconnected is a tap host, not an open end.",
  "PipingNetwork is incomplete on some large systems. The walk uses AllRefs plus system membership.",
  "Touching uses model bounding boxes, not solid intersection. A flag also needs an open connector within touch_mm of the other box, and no connector pair within near_miss_mm, so parallel runs are not all flagged.",
  "View.IsolateElementsTemporary does not switch views and is not saved. It runs only when this document is already active. Schedules and sheets can reject it.",
  "Electrical continuity walks ElectricalSystem.BaseEquipment and Elements. A typical model has no geometric wire path.",
  "RBS_ELEC_VOLTAGE and ElectricalSystem.Voltage are volts. A device or circuit with no voltage is not a mismatch.",
  "Power connectors are PowerCircuit, PowerBalanced and PowerUnBalanced. Data and fire-alarm connectors are left out.",
  "A closed workshared file is not opened: opening it would detach the local. The document must already be open.",
  "The snapshot stops at 100000 connectors or elements. A truncated snapshot is not a pass.",
  "Cable trays and conduits are not collected. Tray fill is phase 2.",
  "Power devices are read from electrical fixtures, lighting, mechanical equipment, plumbing fixtures, specialty equipment and fire-alarm devices. A power connector on another category is not in this pass.",
];

const CONNECTOR_CAP = 100000;

export function lookupTraceStandard(rows: Array<{ key: string; value: unknown }> | null | undefined, key: string): number | undefined {
  const hit = rows?.find((row) => row.key === key);
  if (!hit) return undefined;
  const value = typeof hit.value === "number" ? hit.value : typeof hit.value === "string" && hit.value.trim() ? Number(hit.value) : NaN;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function resolveTraceLimits(overrides: Partial<Record<LimitKey, number>> | null | undefined, lookup?: StandardsLookup): { ok: true; limits: ResolvedLimits } | { ok: false; message: string } {
  const values = { ...PROVISIONAL_LIMITS };
  const fields: LimitField[] = [];
  for (const key of Object.keys(PROVISIONAL_LIMITS) as LimitKey[]) {
    const call = overrides?.[key];
    if (call != null) {
      if (!Number.isFinite(call) || call < 0) return { ok: false, message: `${key} must be a number that is zero or greater.` };
      if (key === "direction_deg" && call > 180) return { ok: false, message: "direction_deg must be from 0 to 180." };
      values[key] = call;
      fields.push({ key: TRACE_STANDARD_KEYS[key], value: call, source: "call", status: "call" });
      continue;
    }
    const fromBank = lookup?.(TRACE_STANDARD_KEYS[key]);
    if (fromBank != null && Number.isFinite(fromBank) && fromBank >= 0) {
      values[key] = fromBank;
      fields.push({ key: TRACE_STANDARD_KEYS[key], value: fromBank, source: "standards", status: "standards" });
      continue;
    }
    fields.push({ key: TRACE_STANDARD_KEYS[key], value: values[key], source: "provisional", status: "PROVISIONAL" });
  }
  const status = fields.some((field) => field.source === "provisional") ? "PROVISIONAL" : fields.every((field) => field.source === "call") ? "call" : "standards";
  return {
    ok: true,
    limits: {
      status,
      values,
      fields,
      kit_change: fields.some((field) => field.source === "provisional")
        ? "trace.* limits are not in the standards bank yet. Defaults are PROVISIONAL."
        : "",
    },
  };
}

export function selectChecks(action: string, names?: string[]): TraceSelection {
  const known = new Map(TRACE_CHECKS.map((check) => [check.id, check]));
  let ids: string[];
  if (action === "leak") ids = ["leak"];
  else if (action === "continuity") ids = ["continuity"];
  else if (action === "missing") ids = ["missing"];
  else if (action === "standards") ids = [...STANDARDS_IDS];
  else ids = names && names.length ? names.map((name) => name.trim()).filter(Boolean) : ["leak", "continuity"];
  const run: TraceCheck[] = [];
  const skipped: TraceSelection["skipped"] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const check = known.get(id);
    if (!check) { unknown.push(id); continue; }
    if (!check.implemented) { skipped.push({ id: check.id, title: check.title, phase: check.phase, needs: check.needs }); continue; }
    run.push(check);
  }
  return { run, skipped, unknown };
}

export function catalogue() {
  return {
    tool: "fmc_trace",
    read_only: true,
    phase: 1,
    checks: TRACE_CHECKS.map((check) => ({
      id: check.id,
      title: check.title,
      phase: check.phase,
      implemented: check.implemented,
      codes: [...check.codes],
      needs: check.needs,
    })),
    codes: [...LEAK_CODES, ...ELEC_CODES],
    standard_keys: TRACE_STANDARD_KEYS,
    provisional: PROVISIONAL_LIMITS,
    api_limits: TRACE_API_LIMITS,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function domainWanted(filter: TraceFilter): string[] {
  if (filter.domain === "piping") return ["piping"];
  if (filter.domain === "duct") return ["hvac"];
  return ["piping", "hvac"];
}

function systemDomainOk(domain: string, filter: TraceFilter): boolean {
  const want = domainWanted(filter);
  return want.includes(domain === "duct" ? "hvac" : domain);
}

function dot(a: number[], b: number[]): number | null {
  if (a.length < 3 || b.length < 3) return null;
  const al = Math.hypot(a[0], a[1], a[2]);
  const bl = Math.hypot(b[0], b[1], b[2]);
  if (al < 1e-6 || bl < 1e-6) return null;
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (al * bl);
}

/** True when the two connector axes face each other within direction_deg of 180°. */
export function directionsOppose(a: number[], b: number[], directionDeg: number): boolean | null {
  const value = dot(a, b);
  if (value == null) return null;
  const limit = Math.cos((directionDeg * Math.PI) / 180);
  return value <= -limit + 1e-9;
}

function dist(a: number[], b: number[]): number {
  if (a.length < 3 || b.length < 3) return Number.POSITIVE_INFINITY;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function pointBoxDistance(point: number[], box: number[]): number {
  if (point.length < 3 || box.length < 6) return Number.POSITIVE_INFINITY;
  const dx = point[0] < box[0] ? box[0] - point[0] : point[0] > box[3] ? point[0] - box[3] : 0;
  const dy = point[1] < box[1] ? box[1] - point[1] : point[1] > box[4] ? point[1] - box[4] : 0;
  const dz = point[2] < box[2] ? box[2] - point[2] : point[2] > box[5] ? point[2] - box[5] : 0;
  return Math.hypot(dx, dy, dz);
}

function sizesDiffer(a: TraceConnector, b: TraceConnector, tol: number): boolean {
  if (num(a.size_mm) <= 0 || num(b.size_mm) <= 0) return false;
  const round = (c: TraceConnector) => c.shape === "round" || num(c.height_mm) <= 0;
  if (round(a) && round(b)) return Math.abs(a.size_mm - b.size_mm) > tol;
  const ah = num(a.height_mm) > 0 ? a.height_mm : a.size_mm;
  const bh = num(b.height_mm) > 0 ? b.height_mm : b.size_mm;
  const same = Math.abs(a.size_mm - b.size_mm) <= tol && Math.abs(ah - bh) <= tol;
  const swapped = Math.abs(a.size_mm - bh) <= tol && Math.abs(ah - b.size_mm) <= tol;
  return !same && !swapped;
}

function flowConflicts(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (!left || !right || left === "bidirectional" || right === "bidirectional") return false;
  return left === right && (left === "in" || left === "out");
}

function reachable(starts: number[], adj: Map<number, Set<number>>): Set<number> {
  const seen = new Set<number>();
  const stack = starts.filter((id) => Number.isFinite(id));
  while (stack.length) {
    const id = stack.pop() as number;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adj.get(id) ?? []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

function components(ids: number[], adj: Map<number, Set<number>>): number[][] {
  const left = new Set(ids);
  const out: number[][] = [];
  for (const id of ids) {
    if (!left.has(id)) continue;
    const reach = reachable([id], adj);
    const comp: number[] = [];
    for (const node of reach) if (left.delete(node)) comp.push(node);
    if (!comp.length) left.delete(id);
    if (comp.length) out.push(comp);
  }
  return out;
}

function adjacency(connectors: TraceConnector[]): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)?.add(b);
    adj.get(b)?.add(a);
  };
  for (const connector of connectors) {
    if (!adj.has(connector.element_id)) adj.set(connector.element_id, new Set());
    for (const ref of connector.refs ?? []) link(connector.element_id, ref[0]);
  }
  return adj;
}

function cellOf(value: number, cell: number): number {
  return Math.floor(value / cell);
}

function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

class PointIndex {
  private readonly cells = new Map<string, number[]>();
  constructor(private readonly points: Array<{ at: number; x: number; y: number; z: number }>, private readonly cell: number) {
    points.forEach((point, index) => {
      const key = cellKey(cellOf(point.x, cell), cellOf(point.y, cell), cellOf(point.z, cell));
      const list = this.cells.get(key);
      if (list) list.push(index);
      else this.cells.set(key, [index]);
    });
  }

  near(x: number, y: number, z: number, radius: number): number[] {
    const cx = cellOf(x, this.cell);
    const cy = cellOf(y, this.cell);
    const cz = cellOf(z, this.cell);
    const span = Math.max(1, Math.ceil(radius / this.cell));
    const hits: number[] = [];
    for (let ix = cx - span; ix <= cx + span; ix++) {
      for (let iy = cy - span; iy <= cy + span; iy++) {
        for (let iz = cz - span; iz <= cz + span; iz++) {
          for (const index of this.cells.get(cellKey(ix, iy, iz)) ?? []) {
            const point = this.points[index];
            if (Math.hypot(point.x - x, point.y - y, point.z - z) <= radius) hits.push(index);
          }
        }
      }
    }
    return hits;
  }
}

function pairKey(a: number, ai: number, b: number, bi: number): string {
  return a < b || (a === b && ai <= bi) ? `${a}:${ai}|${b}:${bi}` : `${b}:${bi}|${a}:${ai}`;
}

function elementPair(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function emptyCounts(codes: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of codes) counts[code] = 0;
  return counts;
}

function finish(check: { id: string; title: string; phase: number }, codes: readonly string[], findings: TraceFinding[], checked: Record<string, number>, warnings: string[]): CheckRun {
  const counts = emptyCounts(codes);
  for (const finding of findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  findings.sort((a, b) => a.code.localeCompare(b.code) || a.id - b.id || (a.connector ?? 0) - (b.connector ?? 0) || (a.other_id ?? 0) - (b.other_id ?? 0));
  return {
    id: check.id,
    title: check.title,
    phase: check.phase,
    implemented: true,
    pass: findings.length === 0 && warnings.length === 0,
    counts,
    findings,
    checked,
    warnings,
  };
}

function push(findings: TraceFinding[], seen: Set<string>, finding: TraceFinding) {
  const key = `${finding.code}|${finding.id}|${finding.other_id ?? ""}|${finding.connector ?? ""}|${finding.other_connector ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

interface FlowPrep {
  elements: TraceElement[];
  connectors: TraceConnector[];
  systems: TraceSystem[];
  scope: Set<number>;
  adj: Map<number, Set<number>>;
  membership: Map<number, number[]>;
  warnings: string[];
  matched: TraceSystem[] | null;
  sourceId: number | null;
}

function prepareFlow(snapshot: TraceSnapshot, filter: TraceFilter): FlowPrep {
  const warnings: string[] = [];
  const want = new Set(domainWanted(filter));
  const elements = (snapshot.flow?.elements ?? []).filter((element) => want.has(element.domain ?? "") || (element.domain === "both" && (want.has("piping") || want.has("hvac"))));
  const connectors = (snapshot.flow?.connectors ?? []).filter((connector) => want.has(connector.domain));
  const systems = (snapshot.flow?.systems ?? []).filter((system) => systemDomainOk(system.domain, filter));
  if ((snapshot.flow?.connectors?.length ?? 0) >= CONNECTOR_CAP || snapshot.truncated) warnings.push("The connector snapshot is truncated. This is not a complete leak test.");
  const membership = new Map<number, Set<number>>();
  const addMember = (id: number, systemId: number) => {
    if (!Number.isFinite(id) || !Number.isFinite(systemId) || systemId === 0) return;
    const set = membership.get(id) ?? new Set<number>();
    set.add(systemId);
    membership.set(id, set);
  };
  for (const element of snapshot.flow?.elements ?? []) for (const systemId of element.system_ids ?? []) addMember(element.id, systemId);
  for (const system of systems) {
    for (const id of system.element_ids ?? []) addMember(id, system.id);
    if (system.base_equipment_id) addMember(system.base_equipment_id, system.id);
  }
  const adj = adjacency(connectors);
  const domainIds = new Set<number>(elements.map((element) => element.id));
  for (const system of systems) for (const id of system.element_ids ?? []) domainIds.add(id);

  let matched: TraceSystem[] | null = null;
  const systemKey = text(filter.system).trim();
  if (systemKey) {
    const asId = Number(systemKey);
    matched = systems.filter((system) => system.id === asId || norm(system.name) === norm(systemKey) || norm(system.classification ?? "") === norm(systemKey));
    if (!matched.length) warnings.push(`No piping or duct system "${systemKey}".`);
  }
  let sourceId: number | null = null;
  const sourceKey = text(filter.source).trim();
  if (sourceKey) {
    const asId = Number(sourceKey);
    if (!Number.isInteger(asId)) warnings.push(`Source "${sourceKey}" is not an element id.`);
    else {
      sourceId = asId;
      const known = domainIds.has(asId) || (snapshot.flow?.elements ?? []).some((element) => element.id === asId);
      if (!known) warnings.push(`Source ${asId} is not in the connector graph.`);
    }
  }

  const scope = new Set<number>();
  if (systemKey && !matched?.length) {
    return { elements, connectors, systems, scope, adj, membership: new Map(), warnings, matched, sourceId };
  }
  if (matched) {
    const seeds: number[] = [];
    for (const system of matched) {
      for (const id of system.element_ids ?? []) seeds.push(id);
      if (system.base_equipment_id) seeds.push(system.base_equipment_id);
    }
    for (const id of seeds) scope.add(id);
    for (const id of reachable(sourceId != null ? [sourceId] : seeds, adj)) if (domainIds.has(id) || scope.has(id)) scope.add(id);
  } else if (sourceId != null) {
    scope.add(sourceId);
    for (const id of reachable([sourceId], adj)) scope.add(id);
    for (const system of systems) {
      const onSystem = (system.element_ids ?? []).includes(sourceId) || system.base_equipment_id === sourceId;
      if (!onSystem) continue;
      for (const id of system.element_ids ?? []) scope.add(id);
      if (system.base_equipment_id) scope.add(system.base_equipment_id);
    }
  } else {
    for (const id of domainIds) scope.add(id);
  }
  const memberList = new Map<number, number[]>();
  for (const [id, set] of membership) memberList.set(id, [...set]);
  return { elements, connectors, systems, scope, adj, membership: memberList, warnings, matched, sourceId };
}

function systemsForIslands(prep: FlowPrep): TraceSystem[] {
  if (prep.matched) return prep.matched;
  if (prep.sourceId != null) {
    return prep.systems.filter((system) => (system.element_ids ?? []).includes(prep.sourceId as number) || system.base_equipment_id === prep.sourceId);
  }
  return prep.systems;
}

function islandIds(system: TraceSystem, prep: FlowPrep): { islands: number[]; reachable: number } {
  const members = [...new Set([...(system.element_ids ?? []), ...(system.base_equipment_id ? [system.base_equipment_id] : [])])];
  const explicit = prep.sourceId != null && (members.includes(prep.sourceId) || system.base_equipment_id === prep.sourceId);
  if (explicit && prep.sourceId != null) {
    const reach = reachable([prep.sourceId], prep.adj);
    return { islands: members.filter((id) => !reach.has(id)), reachable: members.filter((id) => reach.has(id)).length };
  }
  if (!explicit && system.base_equipment_id && members.includes(system.base_equipment_id)) {
    const reach = reachable([system.base_equipment_id], prep.adj);
    return { islands: members.filter((id) => !reach.has(id)), reachable: members.filter((id) => reach.has(id)).length };
  }
  const comps = components(members, prep.adj).sort((a, b) => b.length - a.length || Math.min(...a) - Math.min(...b));
  const main = new Set(comps[0] ?? []);
  return { islands: members.filter((id) => !main.has(id)), reachable: main.size };
}

export function runLeak(snapshot: TraceSnapshot, limits: ResolvedLimits, filter: TraceFilter): CheckRun {
  const prep = prepareFlow(snapshot, filter);
  const findings: TraceFinding[] = [];
  const seen = new Set<string>();
  const values = limits.values;
  const byElement = new Map<number, TraceElement>();
  for (const element of prep.elements) byElement.set(element.id, element);
  const byConnector = new Map<string, TraceConnector>();
  for (const connector of prep.connectors) byConnector.set(`${connector.element_id}:${connector.index}`, connector);

  if (!snapshot.flow) prep.warnings.push("The installed add-in returned no connector graph. fmc_trace needs the command set, then a Revit restart.");

  const systemName = (id: number) => prep.systems.find((system) => (prep.membership.get(id) ?? []).includes(system.id))?.name;

  for (const connector of prep.connectors) {
    if (!prep.scope.has(connector.element_id) || !connector.open_end || connector.connected) continue;
    push(findings, seen, {
      code: "FLOW-OPEN-END",
      id: connector.element_id,
      connector: connector.index,
      system: systemName(connector.element_id),
      detail: `open ${connector.domain} ${connector.type || "end"} at ${connector.origin.map((n) => Math.round(n)).join(",")}`,
    });
  }

  const jointSeen = new Set<string>();
  const nearElements = new Set<string>();
  for (const connector of prep.connectors) {
    for (const ref of connector.refs ?? []) {
      const other = byConnector.get(`${ref[0]}:${ref[1]}`);
      if (!other || other.element_id === connector.element_id) continue;
      if (!prep.scope.has(connector.element_id) && !prep.scope.has(other.element_id)) continue;
      const key = pairKey(connector.element_id, connector.index, other.element_id, other.index);
      if (jointSeen.has(key)) continue;
      jointSeen.add(key);
      const reasons: string[] = [];
      const gap = dist(connector.origin, other.origin);
      if (Number.isFinite(gap) && gap > values.connected_gap_mm) reasons.push(`origins ${Math.round(gap)} mm apart`);
      const oppose = directionsOppose(connector.direction, other.direction, values.direction_deg);
      if (oppose === false) reasons.push("directions do not face each other");
      if (flowConflicts(connector.flow, other.flow)) reasons.push(`flow ${connector.flow} meets ${other.flow}`);
      if (reasons.length) {
        const fitting = byElement.get(connector.element_id)?.kind === "fitting" ? connector : byElement.get(other.element_id)?.kind === "fitting" ? other : connector;
        const partner = fitting === connector ? other : connector;
        push(findings, seen, {
          code: "FLOW-NEAR-MISS",
          id: fitting.element_id,
          other_id: partner.element_id,
          connector: fitting.index,
          other_connector: partner.index,
          system: systemName(fitting.element_id),
          detail: reasons.join("; "),
        });
      }
      if (sizesDiffer(connector, other, values.size_mismatch_mm)) {
        const fitting = byElement.get(connector.element_id)?.kind === "fitting" ? connector : other;
        const partner = fitting === connector ? other : connector;
        push(findings, seen, {
          code: "FLOW-SIZE-MISMATCH",
          id: fitting.element_id,
          other_id: partner.element_id,
          connector: fitting.index,
          other_connector: partner.index,
          system: systemName(fitting.element_id),
          detail: `${Math.round(connector.size_mm)} mm against ${Math.round(other.size_mm)} mm`,
        });
      }
    }
  }

  const physical = prep.connectors.filter((connector) => connector.type !== "curve" && connector.origin.length >= 3);
  const index = new PointIndex(physical.map((connector, at) => ({ at, x: connector.origin[0], y: connector.origin[1], z: connector.origin[2] })), Math.max(values.near_miss_mm, 1));
  const nearSeen = new Set<string>();
  for (let i = 0; i < physical.length; i++) {
    const connector = physical[i];
    if (!prep.scope.has(connector.element_id)) continue;
    for (const hit of index.near(connector.origin[0], connector.origin[1], connector.origin[2], values.near_miss_mm)) {
      const other = physical[hit];
      if (other.element_id === connector.element_id || other.domain !== connector.domain) continue;
      if (!prep.scope.has(other.element_id) && !prep.scope.has(connector.element_id)) continue;
      const linked = (connector.refs ?? []).some((ref) => ref[0] === other.element_id && ref[1] === other.index)
        || (other.refs ?? []).some((ref) => ref[0] === connector.element_id && ref[1] === connector.index);
      if (linked) continue;
      const key = pairKey(connector.element_id, connector.index, other.element_id, other.index);
      if (nearSeen.has(key)) continue;
      nearSeen.add(key);
      nearElements.add(elementPair(connector.element_id, other.element_id));
      const gap = dist(connector.origin, other.origin);
      const oppose = directionsOppose(connector.direction, other.direction, values.direction_deg);
      const reasons = [`origins ${Math.round(gap)} mm apart and not connected`];
      if (oppose === false) reasons.push("directions do not face each other");
      push(findings, seen, {
        code: "FLOW-NEAR-MISS",
        id: connector.element_id,
        other_id: other.element_id,
        connector: connector.index,
        other_connector: other.index,
        system: systemName(connector.element_id) ?? systemName(other.element_id),
        detail: reasons.join("; "),
      });
    }
  }

  const boxCell = 1000;
  const boxes = prep.elements.filter((element) => prep.scope.has(element.id) && (element.bbox?.length ?? 0) >= 6);
  const boxIndex = new Map<string, number[]>();
  const addBox = (at: number, box: number[]) => {
    const minX = cellOf(box[0] - values.touch_mm, boxCell);
    const maxX = cellOf(box[3] + values.touch_mm, boxCell);
    const minY = cellOf(box[1] - values.touch_mm, boxCell);
    const maxY = cellOf(box[4] + values.touch_mm, boxCell);
    const minZ = cellOf(box[2] - values.touch_mm, boxCell);
    const maxZ = cellOf(box[5] + values.touch_mm, boxCell);
    let n = 0;
    for (let x = minX; x <= maxX && n < 200; x++) {
      for (let y = minY; y <= maxY && n < 200; y++) {
        for (let z = minZ; z <= maxZ && n < 200; z++) {
          const key = cellKey(x, y, z);
          const list = boxIndex.get(key);
          if (list) list.push(at);
          else boxIndex.set(key, [at]);
          n++;
        }
      }
    }
  };
  boxes.forEach((element, at) => addBox(at, element.bbox as number[]));
  const touchSeen = new Set<string>();
  for (const connector of prep.connectors) {
    if (!connector.open_end || connector.connected || !prep.scope.has(connector.element_id) || connector.origin.length < 3) continue;
    const cx = cellOf(connector.origin[0], boxCell);
    const cy = cellOf(connector.origin[1], boxCell);
    const cz = cellOf(connector.origin[2], boxCell);
    const candidates = new Set<number>();
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (let z = cz - 1; z <= cz + 1; z++) {
          for (const at of boxIndex.get(cellKey(x, y, z)) ?? []) candidates.add(at);
        }
      }
    }
    for (const at of candidates) {
      const other = boxes[at];
      if (other.id === connector.element_id) continue;
      if (!prep.scope.has(other.id)) continue;
      if (pointBoxDistance(connector.origin, other.bbox as number[]) > values.touch_mm) continue;
      if (prep.adj.get(connector.element_id)?.has(other.id)) continue;
      const elementsKey = elementPair(connector.element_id, other.id);
      if (nearElements.has(elementsKey) || touchSeen.has(elementsKey)) continue;
      touchSeen.add(elementsKey);
      push(findings, seen, {
        code: "FLOW-NOT-CONNECTED",
        id: connector.element_id,
        other_id: other.id,
        connector: connector.index,
        system: systemName(connector.element_id),
        detail: `open end within ${values.touch_mm} mm of element ${other.id} (${other.kind || other.category || "element"}) and they share no connector`,
      });
    }
  }

  for (const element of prep.elements) {
    if (!prep.scope.has(element.id)) continue;
    if ((prep.membership.get(element.id) ?? []).length > 0) continue;
    push(findings, seen, {
      code: "FLOW-NO-SYSTEM",
      id: element.id,
      detail: `${element.kind || element.category || "element"} is on no piping or duct system`,
    });
  }

  let reachableCount = 0;
  const islanded = new Set<number>();
  for (const system of systemsForIslands(prep)) {
    const result = islandIds(system, prep);
    reachableCount += result.reachable;
    for (const id of result.islands) {
      if (islanded.has(id)) continue;
      islanded.add(id);
      push(findings, seen, {
        code: "FLOW-ISLAND",
        id,
        system: system.name,
        detail: prep.sourceId != null || system.base_equipment_id
          ? `not reachable by connectors from ${prep.sourceId ?? system.base_equipment_id}`
          : "not in the largest connected part of the system",
      });
    }
  }

  return finish(
    { id: "leak", title: "Leak test (piping, drainage, duct)", phase: 1 },
    LEAK_CODES,
    findings,
    { elements: prep.scope.size, connectors: prep.connectors.filter((connector) => prep.scope.has(connector.element_id)).length, systems: (prep.matched ?? prep.systems).length, reachable: reachableCount, islands: islanded.size },
    prep.warnings,
  );
}

export function runContinuity(snapshot: TraceSnapshot, limits: ResolvedLimits, filter: TraceFilter): CheckRun {
  const warnings: string[] = [];
  const panels = snapshot.electrical?.panels ?? [];
  const circuits = snapshot.electrical?.circuits ?? [];
  const devices = snapshot.electrical?.devices ?? [];
  if (!snapshot.electrical) warnings.push("The installed add-in returned no electrical graph. fmc_trace needs the command set, then a Revit restart.");
  let panelSet = panels;
  const panelKey = text(filter.panel).trim();
  if (panelKey) {
    const asId = Number(panelKey);
    panelSet = panels.filter((panel) => panel.id === asId || norm(panel.name) === norm(panelKey));
    if (!panelSet.length) warnings.push(`No panel "${panelKey}".`);
  }
  const panelIds = new Set(panelSet.map((panel) => panel.id));
  const knownPanels = new Set(panels.map((panel) => panel.id));
  const byPanel = new Map(panels.map((panel) => [panel.id, panel]));
  const byCircuit = new Map(circuits.map((circuit) => [circuit.id, circuit]));
  const findings: TraceFinding[] = [];
  const seen = new Set<string>();

  for (const device of devices) {
    if (!device.power_connector || (device.circuit_ids ?? []).length > 0) continue;
    push(findings, seen, { code: "ELEC-NO-CIRCUIT", id: device.id, detail: `${device.category || "device"} has a power connector on no circuit` });
  }

  for (const circuit of circuits) {
    const named = circuit.panel_id > 0 && knownPanels.has(circuit.panel_id);
    if (!named) {
      push(findings, seen, {
        code: "ELEC-NO-PANEL",
        id: circuit.id,
        detail: circuit.panel_id > 0 ? `circuit names panel ${circuit.panel_id}, which is not an electrical equipment element` : "circuit has no panel",
      });
    }
    const inFilter = !panelKey || panelIds.has(circuit.panel_id);
    if (inFilter && (circuit.element_ids ?? []).length === 0) {
      push(findings, seen, { code: "ELEC-EMPTY-CIRCUIT", id: circuit.id, detail: `${circuit.panel_name || "panel"} circuit ${circuit.number || circuit.name || circuit.id} has no loads` });
    }
  }

  for (const panel of panelSet) {
    if (panel.has_supply) continue;
    push(findings, seen, {
      code: "ELEC-NO-SUPPLY",
      id: panel.id,
      detail: "no feeder circuit and no connected power connector; a service head is for the engineer to accept",
    });
  }

  for (const device of devices) {
    for (const circuitId of device.circuit_ids ?? []) {
      const circuit = byCircuit.get(circuitId);
      if (!circuit) continue;
      if (panelKey && !panelIds.has(circuit.panel_id)) continue;
      const panel = byPanel.get(circuit.panel_id);
      const volts = num(circuit.voltage) > 0 ? num(circuit.voltage) : 0;
      const reasons: string[] = [];
      if (volts > 0 && num(device.voltage) > 0 && Math.abs(volts - num(device.voltage)) > limits.values.voltage_tol_v) {
        reasons.push(`device ${device.voltage} V, circuit ${volts} V`);
      }
      const deviceDist = norm(device.distribution ?? "");
      const circuitDist = norm(circuit.distribution || panel?.distribution || "");
      if (deviceDist && circuitDist && deviceDist !== circuitDist) reasons.push(`distribution ${device.distribution} against ${circuit.distribution || panel?.distribution}`);
      if (num(device.poles) > 0 && num(circuit.poles) > 0 && num(device.poles) !== num(circuit.poles)) reasons.push(`device ${device.poles} poles, circuit ${circuit.poles} poles`);
      if (!reasons.length) continue;
      push(findings, seen, {
        code: "ELEC-VOLTAGE-MISMATCH",
        id: device.id,
        other_id: circuit.id,
        detail: reasons.join("; "),
      });
    }
  }

  const scopedCircuits = panelKey ? circuits.filter((circuit) => panelIds.has(circuit.panel_id)) : circuits;
  return finish(
    { id: "continuity", title: "Electrical continuity", phase: 1 },
    ELEC_CODES,
    findings,
    { panels: panelSet.length, circuits: scopedCircuits.length, devices: devices.length },
    warnings,
  );
}

export interface TraceSummary {
  tool: "fmc_trace";
  read_only: true;
  pass: boolean;
  document?: { title: string; path: string };
  active_unchanged?: boolean;
  limits_status: ResolvedLimits["status"];
  kit_change: string;
  checks: Array<{
    id: string;
    title: string;
    pass: boolean;
    fail: number;
    counts: Record<string, number>;
    ids: Array<{ code: string; id: number }>;
    checked: Record<string, number>;
    warnings: string[];
  }>;
  skipped: TraceSelection["skipped"];
  unknown: string[];
  highlight: { mode: string; applied: boolean; reason?: string; ids?: Array<{ code: string; id: number }> };
  report: string;
  sample_limit: number;
  warnings: string[];
}

function capIds(findings: TraceFinding[], limit: number): Array<{ code: string; id: number }> {
  const groups = new Map<string, TraceFinding[]>();
  for (const finding of findings) {
    const list = groups.get(finding.code);
    if (list) list.push(finding);
    else groups.set(finding.code, [finding]);
  }
  const out: Array<{ code: string; id: number }> = [];
  const seen = new Set<string>();
  let index = 0;
  let added = true;
  while (out.length < limit && added) {
    added = false;
    for (const list of groups.values()) {
      if (out.length >= limit) break;
      const finding = list[index];
      if (!finding) continue;
      const key = `${finding.code}|${finding.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ code: finding.code, id: finding.id });
      added = true;
    }
    index++;
  }
  return out;
}

export function summarizeTrace(runs: CheckRun[], extra: {
  limits: ResolvedLimits;
  skipped: TraceSelection["skipped"];
  unknown: string[];
  sampleLimit: number;
  highlight: string;
  report: string;
  snapshot?: TraceSnapshot;
  highlightResult?: { applied?: boolean; reason?: string };
}): TraceSummary {
  const sampleLimit = Math.max(1, Math.min(100, Math.floor(extra.sampleLimit || 20)));
  const checks = runs.map((run) => {
    const fail = run.findings.length;
    return {
      id: run.id,
      title: run.title,
      pass: run.pass,
      fail,
      counts: run.counts,
      ids: capIds(run.findings, sampleLimit),
      checked: run.checked,
      warnings: run.warnings,
      ...(run.extra?.systems ? { systems: run.extra.systems } : {}),
      ...(run.extra?.not_detectable ? { not_detectable: run.extra.not_detectable } : {}),
    };
  });
  const highlightIds = extra.highlight === "ids" || extra.highlight === "temporary"
    ? capIds(runs.flatMap((run) => run.findings), Math.min(100, sampleLimit * 5))
    : undefined;
  const warnings: string[] = [];
  if (extra.snapshot?.modified_during_call) warnings.push("Revit reported the document modified during a read-only trace. Nothing was saved.");
  if (extra.snapshot && extra.snapshot.active_unchanged === false) warnings.push("The active document or view changed during the trace.");
  if (extra.highlight === "temporary" && extra.highlightResult && extra.highlightResult.applied === false) {
    warnings.push(extra.highlightResult.reason || "Temporary highlight was not applied.");
  }
  const resolved = extra.snapshot?.resolved_document;
  return {
    tool: "fmc_trace",
    read_only: true,
    pass: checks.every((check) => check.pass) && extra.unknown.length === 0 && extra.skipped.length === 0 && warnings.length === 0,
    ...(resolved ? { document: { title: resolved.title ?? "", path: resolved.path ?? "" } } : {}),
    ...(extra.snapshot && "active_unchanged" in extra.snapshot ? { active_unchanged: extra.snapshot.active_unchanged !== false } : {}),
    limits_status: extra.limits.status,
    kit_change: extra.limits.kit_change,
    checks,
    skipped: extra.skipped,
    unknown: extra.unknown,
    highlight: {
      mode: extra.highlight,
      applied: extra.highlight === "temporary" && extra.highlightResult?.applied === true,
      ...(extra.highlightResult?.reason ? { reason: extra.highlightResult.reason } : {}),
      ...(highlightIds ? { ids: highlightIds } : {}),
    },
    report: extra.report,
    sample_limit: sampleLimit,
    warnings,
  };
}

const win = path.win32;

export function traceReportDir(env: NodeJS.ProcessEnv = process.env): string {
  const user = env.USERPROFILE || env.HOME || os.homedir();
  const local = env.LOCALAPPDATA || win.join(user, "AppData", "Local");
  const preferred = win.join(local, "Formcraft", "trace");
  if (!/^d:/i.test(preferred)) return preferred;
  const home = win.join(user, "Formcraft", "trace");
  if (!/^d:/i.test(home)) return home;
  return "C:\\Users\\Public\\Formcraft\\trace";
}

/** The directory the process can create. On Windows that is the reported path. */
export function traceReportHostDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return traceReportDir(env);
  const local = env.LOCALAPPDATA;
  if (local && !/^([a-zA-Z]:|\\\\)/.test(local)) return path.join(local, "Formcraft", "trace");
  return path.join(os.tmpdir(), "Formcraft", "trace");
}

export function writeTraceReport(snapshot: TraceSnapshot, runs: CheckRun[], limits: ResolvedLimits, filter: TraceFilter, env: NodeJS.ProcessEnv = process.env): string {
  const dir = traceReportHostDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const title = (snapshot.model || snapshot.resolved_document?.title || "model").replace(/[<>:"|?*\\/]/g, "_").slice(0, 40);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `trace-${title}-${stamp}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(reportBody(snapshot, runs, limits, filter)));
  if (process.platform === "win32") return win.join(traceReportDir(env), name);
  return file;
}

export function traceFromSnapshot(snapshot: TraceSnapshot, selection: TraceSelection, limits: ResolvedLimits, filter: TraceFilter): CheckRun[] {
  return selection.run.map((check) => check.run(snapshot, limits, filter));
}

export function reportBody(snapshot: TraceSnapshot, runs: CheckRun[], limits: ResolvedLimits, filter: TraceFilter): Record<string, unknown> {
  return {
    tool: "fmc_trace",
    read_only: true,
    model: snapshot.model ?? "",
    resolved_document: snapshot.resolved_document ?? null,
    active_unchanged: snapshot.active_unchanged !== false,
    modified_during_call: snapshot.modified_during_call === true,
    limits_status: limits.status,
    limits: limits.fields,
    kit_change: limits.kit_change,
    filter,
    checks: runs.map((run) => ({
      id: run.id,
      title: run.title,
      pass: run.pass,
      counts: run.counts,
      checked: run.checked,
      warnings: run.warnings,
      findings: run.findings,
      ...(run.extra ? { extra: run.extra } : {}),
    })),
    api_limits: snapshot.api_limits?.length ? snapshot.api_limits : TRACE_API_LIMITS,
    phase_2: PHASE_2,
  };
}
