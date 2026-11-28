/**
 * fmc_mep_audit: offline logic. Read-only MEP connectivity and system audit (Builder 19).
 *
 * The add-in command (fmc_mep_audit, FmcMepAuditWork.cs) returns a raw snapshot. This module filters, classifies into
 * issue codes, summarises, caps and shapes the reply. No Revit call, no writes.
 *
 * Scope (agreed with Builder 8, 28 Nov): fmc_trace already emits FLOW-OPEN-END, NOT-CONNECTED, NEAR-MISS, SIZE-MISMATCH,
 * NO-SYSTEM, NO-SOURCE, ISLAND and the NO-FITTING/CAP/TRAP/VENT/WASTE/CLEANOUT/ISOLATION codes. fmc_mep_audit adds only:
 *  - ConnectorManager.UnusedConnectors and PlumbingUtils.HasOpenConnector on piping and HVAC, as a CROSS-CHECK of
 *    fmc_trace's open_end (MEP-OPEN-* rows are info; a disagreement between the two APIs is MEP-XCHK-MISMATCH);
 *  - IsWellConnected per mechanical and piping system;
 *  - systems with no BaseEquipment, as a count plus ids;
 *  - PressureLossOfCriticalPath with the critical-path sections (MEPSection TotalPressureLoss, flow, length) and static pressure;
 *  - fixture units per system.
 * Conduit and cable tray are NOT audited here (fmc_conduit and fmc_trace). Any conduit/tray row the add-in sends is dropped.
 */

export const MEP_AUDIT_SCHEMA = "fmc_mep_audit/1";

export type MepDomain = "piping" | "duct";
export type DomainFilter = MepDomain | "both";
export type Severity = "error" | "warning" | "info";
export type ConnectorKind = "curve" | "fitting" | "accessory" | "equipment" | "fixture" | "terminal";

/** One unused End connector, as the add-in reports it. Lengths in mm. */
export interface OpenConnectorRow {
  element_id: number;
  connector_index: number;
  domain: string; // piping | duct (anything else is dropped)
  kind: ConnectorKind | string;
  category?: string;
  family?: string;
  type_name?: string;
  level?: string;
  system_id?: number | null;
  system_name?: string;
  size_mm?: number | null;
  width_mm?: number | null;
  height_mm?: number | null;
  origin_mm?: number[];
  /** PlumbingUtils.HasOpenConnector on pipe curves, fittings and accessories; null when not piping or not readable. */
  plumbing_open?: boolean | null;
}

/** A piping network element where HasOpenConnector is true but UnusedConnectors found no open End connector. */
export interface PlumbingOnlyOpenRow {
  element_id: number;
  kind: string;
  level?: string;
  type_name?: string;
  system_name?: string;
}

/** One critical-path section (MEPSection), in flow order. Flow L/s, length m, loss Pa, velocity m/s, sizes mm. */
export interface SectionRow {
  number: number;
  flow_lps: number | null;
  length_m: number | null;
  pressure_loss_pa: number | null;
  velocity_ms?: number | null;
  roughness_mm?: number | null;
  total_coefficient?: number | null;
  fixture_units?: number | null;
  shape?: "round" | "rect" | null;
  size_mm?: number | null;
  w_mm?: number | null;
  h_mm?: number | null;
  element_count?: number | null;
  element_ids?: number[];
}

/** One piping or mechanical system. Flow L/s, pressures Pa, fixture units unitless. null = not available. */
export interface SystemRow {
  id: number;
  name: string;
  domain: string; // piping | duct
  classification: string; // PipeSystemType / DuctSystemType name, e.g. DomesticColdWater, SupplyAir
  system_type?: string;
  is_well_connected: boolean | null;
  is_valid?: boolean | null;
  is_empty?: boolean | null;
  base_equipment_id?: number | null;
  base_equipment_name?: string;
  element_count?: number | null;
  levels?: string[];
  flow_lps?: number | null;
  static_pressure_pa?: number | null;
  critical_path_pressure_loss_pa?: number | null;
  critical_path_sections?: number[];
  critical_path?: SectionRow[];
  fixture_units?: number | null;
  calc_notes?: string[];
}

/**
 * MepSegment: COPIED from Builder 8's server/src/fmc/mepsize.ts (branch feat/mep-tools, commit cbe2bf5, worktree
 * C:\Users\USER\agent-tools\builder-8-mep-tools) on 28 Nov 2026, so fmc_mep_size pressure|critical_path can take
 * fmc_mep_audit's segments. Copied, not imported: this branch does not depend on theirs. Keep it in step by hand.
 */
export interface MepSegment {
  id: string;
  kind: "duct" | "pipe";
  /** Design flow in L/s (air or water). */
  flow_l_s: number;
  length_m?: number;
  shape?: "round" | "rect";
  /** Round: the inside diameter. */
  size_mm?: number;
  w_mm?: number;
  h_mm?: number;
  roughness_mm?: number;
  /** Fitting loss factors on this segment (elbows, tees, dampers), summed. */
  k?: number[];
  /** The segment this one flows into or out of (towards the fan, pump or source). Empty for the root. */
  upstream?: string;
  /** Where the facts came from (for example model:123456). Defaults to engineer. */
  source?: string;
}

/** Revit's own values for a segment, kept beside the MepSegment so fmc_mep_size can compare its loss with Revit's. */
export interface SegmentCheck {
  id: string;
  system_id: number;
  section: number;
  revit_pressure_loss_pa: number | null;
  velocity_ms: number | null;
  fixture_units: number | null;
  element_ids: number[];
}

export const segmentId = (systemId: number, section: number) => `${systemId}:${section}`;

/**
 * The critical path of one well-connected system as MepSegments, in flow order: each section's upstream is the section
 * before it (towards the fan, pump or source), the first has none. A section without flow is skipped with a note.
 */
export function segmentsFor(row: SystemRow & { domain: MepDomain }): { segments: MepSegment[]; checks: SegmentCheck[]; notes: string[] } {
  const segments: MepSegment[] = [];
  const checks: SegmentCheck[] = [];
  const notes: string[] = [];
  if (row.is_well_connected !== true) {
    if ((row.critical_path ?? []).length) notes.push(`${row.name}: not well connected, no segments`);
    return { segments, checks, notes };
  }
  let upstream: string | undefined;
  for (const sec of row.critical_path ?? []) {
    const id = segmentId(row.id, sec.number);
    if (sec.flow_lps == null || !Number.isFinite(sec.flow_lps)) {
      notes.push(`${row.name} section ${sec.number}: no flow, skipped`);
      continue;
    }
    const seg: MepSegment = { id, kind: row.domain === "duct" ? "duct" : "pipe", flow_l_s: round(sec.flow_lps, 4)!, source: `model:${row.id}#section:${sec.number}` };
    if (sec.length_m != null) seg.length_m = round(sec.length_m)!;
    if (sec.shape === "round" && sec.size_mm != null) { seg.shape = "round"; seg.size_mm = sec.size_mm; }
    if (sec.shape === "rect" && sec.w_mm != null && sec.h_mm != null) { seg.shape = "rect"; seg.w_mm = sec.w_mm; seg.h_mm = sec.h_mm; }
    if (sec.roughness_mm != null) seg.roughness_mm = sec.roughness_mm;
    if (sec.total_coefficient != null && sec.total_coefficient > 0) seg.k = [round(sec.total_coefficient)!];
    if (upstream) seg.upstream = upstream;
    segments.push(seg);
    checks.push({
      id, system_id: row.id, section: sec.number, revit_pressure_loss_pa: round(sec.pressure_loss_pa, 1),
      velocity_ms: round(sec.velocity_ms), fixture_units: round(sec.fixture_units, 2), element_ids: sec.element_ids ?? [],
    });
    upstream = id;
  }
  return { segments, checks, notes };
}

export interface MepAuditSnapshot {
  model?: string;
  resolved_document?: { title?: string; path?: string };
  read_only?: boolean;
  open_connectors?: OpenConnectorRow[];
  plumbing_only_open?: PlumbingOnlyOpenRow[];
  systems?: SystemRow[];
  scanned?: { elements?: number; connectors?: number; systems?: number };
  truncated?: { connectors?: boolean; systems?: boolean };
  skipped_non_family?: { count?: number; ids?: number[] };
  api_notes?: string[];
}

export interface MepAuditFilters {
  domain: DomainFilter;
  systems: string[];
  levels: string[];
  include_equipment: boolean;
}

export interface MepIssue {
  code: string;
  severity: Severity;
  domain: MepDomain;
  element_id?: number;
  connector_index?: number;
  system_id?: number | null;
  system?: string;
  level?: string;
  message: string;
}

/** Issue codes. Stable: other tools and tests key on these. None reuses an fmc_trace code or its wording. */
export const MEP_CODES = {
  OPEN_CURVE_END: "MEP-OPEN-CURVE-END",
  OPEN_FITTING: "MEP-OPEN-FITTING",
  OPEN_ACCESSORY: "MEP-OPEN-ACCESSORY",
  OPEN_EQUIPMENT: "MEP-OPEN-EQUIPMENT",
  OPEN_FIXTURE: "MEP-OPEN-FIXTURE",
  OPEN_TERMINAL: "MEP-OPEN-TERMINAL",
  XCHK_MISMATCH: "MEP-XCHK-MISMATCH",
  SYS_NOT_WELL_CONNECTED: "MEP-SYS-NOT-WELL-CONNECTED",
  SYS_NO_BASE_EQUIPMENT: "MEP-SYS-NO-BASE-EQUIPMENT",
  SYS_EMPTY: "MEP-SYS-EMPTY",
  SYS_INVALID: "MEP-SYS-INVALID",
  SYS_CALC_UNAVAILABLE: "MEP-SYS-CALC-UNAVAILABLE",
} as const;

/** MEP-OPEN-* are info: they cross-check fmc_trace's FLOW-OPEN-END, which stays the finding of record. */
export const MEP_CODE_SEVERITY: Record<string, Severity> = {
  [MEP_CODES.OPEN_CURVE_END]: "info",
  [MEP_CODES.OPEN_FITTING]: "info",
  [MEP_CODES.OPEN_ACCESSORY]: "info",
  [MEP_CODES.OPEN_EQUIPMENT]: "info",
  [MEP_CODES.OPEN_FIXTURE]: "info",
  [MEP_CODES.OPEN_TERMINAL]: "info",
  [MEP_CODES.XCHK_MISMATCH]: "warning",
  [MEP_CODES.SYS_NOT_WELL_CONNECTED]: "error",
  [MEP_CODES.SYS_NO_BASE_EQUIPMENT]: "warning",
  [MEP_CODES.SYS_EMPTY]: "info",
  [MEP_CODES.SYS_INVALID]: "warning",
  [MEP_CODES.SYS_CALC_UNAVAILABLE]: "info",
};

export const CROSS_CHECK_OF = "fmc_trace open_end (FLOW-OPEN-END)";

/** Gravity, vent and fire systems usually have no BaseEquipment in Revit; there a missing base is info, not a warning. */
const NO_BASE_EXPECTED = new Set(["sanitary", "vent", "fireprotectwet", "fireprotectdry", "fireprotectpreaction", "fireprotectother", "otherpipe"]);

export const EXCLUDED_DOMAINS_NOTE =
  "Conduit and cable tray are not audited here: fmc_conduit scan and fmc_trace (domain conduit, tray or electrical_containment) report their open ends.";

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

export function normDomain(d: unknown): MepDomain | null {
  const v = norm(d);
  if (v === "piping" || v === "pipe" || v === "plumbing") return "piping";
  if (v === "duct" || v === "hvac" || v === "mechanical") return "duct";
  return null;
}

function domainOk(d: MepDomain, filter: DomainFilter) {
  return filter === "both" || filter === d;
}

function systemMatches(filters: MepAuditFilters, id: number | null | undefined, name: string | undefined) {
  if (!filters.systems.length) return true;
  const n = norm(name);
  return filters.systems.some((s) => {
    const want = norm(s);
    return want.length > 0 && (want === n || (id != null && want === String(id)));
  });
}

function levelMatches(filters: MepAuditFilters, levels: string[]) {
  if (!filters.levels.length) return true;
  const have = levels.map(norm);
  return filters.levels.some((l) => have.includes(norm(l)));
}

export function openConnectorCode(kind: string): string {
  switch (norm(kind)) {
    case "curve": return MEP_CODES.OPEN_CURVE_END;
    case "fitting": return MEP_CODES.OPEN_FITTING;
    case "accessory": return MEP_CODES.OPEN_ACCESSORY;
    case "fixture": return MEP_CODES.OPEN_FIXTURE;
    case "terminal": return MEP_CODES.OPEN_TERMINAL;
    default: return MEP_CODES.OPEN_EQUIPMENT;
  }
}

const isEquipmentKind = (kind: string) => ["equipment", "fixture", "terminal"].includes(norm(kind));

export function filterConnectors(rows: OpenConnectorRow[], filters: MepAuditFilters): Array<OpenConnectorRow & { domain: MepDomain }> {
  const out: Array<OpenConnectorRow & { domain: MepDomain }> = [];
  for (const row of rows ?? []) {
    const d = normDomain(row.domain);
    if (!d || !domainOk(d, filters.domain)) continue;
    if (!filters.include_equipment && isEquipmentKind(row.kind)) continue;
    if (!systemMatches(filters, row.system_id ?? null, row.system_name)) continue;
    if (!levelMatches(filters, row.level ? [row.level] : [])) continue;
    out.push({ ...row, domain: d });
  }
  return out;
}

export function filterPlumbingOnly(rows: PlumbingOnlyOpenRow[], filters: MepAuditFilters): PlumbingOnlyOpenRow[] {
  if (!domainOk("piping", filters.domain)) return [];
  return (rows ?? []).filter((r) => systemMatches(filters, null, r.system_name) && levelMatches(filters, r.level ? [r.level] : []));
}

export function filterSystems(rows: SystemRow[], filters: MepAuditFilters): Array<SystemRow & { domain: MepDomain }> {
  const out: Array<SystemRow & { domain: MepDomain }> = [];
  for (const row of rows ?? []) {
    const d = normDomain(row.domain);
    if (!d || !domainOk(d, filters.domain)) continue;
    if (!systemMatches(filters, row.id, row.name)) continue;
    if (!levelMatches(filters, row.levels ?? [])) continue;
    out.push({ ...row, domain: d });
  }
  return out;
}

function connectorIssue(row: OpenConnectorRow & { domain: MepDomain }): MepIssue {
  const code = openConnectorCode(String(row.kind));
  const what = norm(row.kind) === "curve" ? "end" : `${norm(row.kind) || "element"} connector`;
  return {
    code, severity: MEP_CODE_SEVERITY[code], domain: row.domain, element_id: row.element_id, connector_index: row.connector_index,
    system_id: row.system_id ?? null, system: row.system_name ?? "", level: row.level ?? "",
    message: `UnusedConnectors: ${row.domain} ${what} ${row.connector_index} on ${row.element_id} is open${row.type_name ? ` (${row.type_name})` : ""}. Cross-check of ${CROSS_CHECK_OF}.`,
  };
}

/** Where UnusedConnectors and PlumbingUtils.HasOpenConnector disagree on a piping element. One issue per element. */
export function crossCheckIssues(connectors: Array<OpenConnectorRow & { domain: MepDomain }>, plumbingOnly: PlumbingOnlyOpenRow[]): MepIssue[] {
  const out: MepIssue[] = [];
  const seen = new Set<number>();
  for (const c of connectors) {
    if (c.domain !== "piping" || c.plumbing_open !== false || seen.has(c.element_id)) continue;
    seen.add(c.element_id);
    out.push({
      code: MEP_CODES.XCHK_MISMATCH, severity: "warning", domain: "piping", element_id: c.element_id, system_id: c.system_id ?? null,
      system: c.system_name ?? "", level: c.level ?? "",
      message: `UnusedConnectors reports an open end on ${c.element_id}, but PlumbingUtils.HasOpenConnector says it has none.`,
    });
  }
  for (const p of plumbingOnly) {
    if (seen.has(p.element_id)) continue;
    seen.add(p.element_id);
    out.push({
      code: MEP_CODES.XCHK_MISMATCH, severity: "warning", domain: "piping", element_id: p.element_id, system_id: null,
      system: p.system_name ?? "", level: p.level ?? "",
      message: `PlumbingUtils.HasOpenConnector reports an open piping connector on ${p.element_id}, but UnusedConnectors found no open End connector.`,
    });
  }
  return out;
}

export function systemIssues(row: SystemRow & { domain: MepDomain }): MepIssue[] {
  const base = { domain: row.domain, system_id: row.id, system: row.name, level: (row.levels ?? [])[0] ?? "" };
  const out: MepIssue[] = [];
  if (row.is_empty === true) {
    out.push({ ...base, code: MEP_CODES.SYS_EMPTY, severity: "info", message: `System ${row.name} has no components.` });
    return out;
  }
  if (row.is_well_connected === false) {
    out.push({ ...base, code: MEP_CODES.SYS_NOT_WELL_CONNECTED, severity: "error", message: `System ${row.name} is not well connected (IsWellConnected false); its calculated values are invalid.` });
  }
  if (row.is_valid === false) {
    out.push({ ...base, code: MEP_CODES.SYS_INVALID, severity: "warning", message: `Revit marks system ${row.name} as invalid (IsValid false).` });
  }
  if (row.base_equipment_id == null) {
    const expected = NO_BASE_EXPECTED.has(norm(row.classification));
    out.push({
      ...base, code: MEP_CODES.SYS_NO_BASE_EQUIPMENT, severity: expected ? "info" : "warning",
      message: `System ${row.name} (${row.classification}) has no BaseEquipment set${expected ? "; usual for this classification" : ""}.`,
    });
  }
  const calcMissing = row.flow_lps == null || row.static_pressure_pa == null || row.critical_path_pressure_loss_pa == null
    || (row.domain === "piping" && row.fixture_units == null);
  if (calcMissing && row.is_well_connected !== false && (row.calc_notes ?? []).length) {
    out.push({ ...base, code: MEP_CODES.SYS_CALC_UNAVAILABLE, severity: "info", message: `System ${row.name}: ${(row.calc_notes ?? []).join("; ")}` });
  }
  return out;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function sortIssues(issues: MepIssue[]) {
  return [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.code.localeCompare(b.code) || (a.system_id ?? 0) - (b.system_id ?? 0)
    || (a.element_id ?? 0) - (b.element_id ?? 0) || (a.connector_index ?? 0) - (b.connector_index ?? 0));
}

function countBy<T>(items: T[], key: (t: T) => string) {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

export const round = (v: number | null | undefined, dp = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

function sectionFact(s: SectionRow) {
  return {
    number: s.number,
    flow_lps: round(s.flow_lps),
    length_m: round(s.length_m),
    pressure_loss_pa: round(s.pressure_loss_pa, 1),
    velocity_ms: round(s.velocity_ms),
    fixture_units: round(s.fixture_units, 2),
    element_count: s.element_count ?? null,
  };
}

/** The per-system row. One row per system, stable field names and units. */
export function systemFact(row: SystemRow & { domain: MepDomain }) {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    classification: row.classification,
    system_type: row.system_type ?? "",
    is_well_connected: row.is_well_connected,
    base_equipment_id: row.base_equipment_id ?? null,
    base_equipment_name: row.base_equipment_name ?? "",
    element_count: row.element_count ?? null,
    levels: row.levels ?? [],
    flow_lps: round(row.flow_lps),
    static_pressure_pa: round(row.static_pressure_pa, 1),
    critical_path_pressure_loss_pa: round(row.critical_path_pressure_loss_pa, 1),
    critical_path_sections: row.critical_path_sections ?? [],
    critical_path: (row.critical_path ?? []).map(sectionFact),
    fixture_units: row.domain === "piping" ? round(row.fixture_units, 2) : null,
    /** Values are only trusted when the system is well connected. */
    calc_valid: row.is_well_connected === true,
  };
}

export interface MepAuditOptions extends MepAuditFilters {
  mode: "summary" | "detail";
  max_results: number;
}

/** Shape the reply from a snapshot. Pure: no Revit, no disk. */
export function shapeMepAudit(snapshot: MepAuditSnapshot, opts: MepAuditOptions) {
  const filters: MepAuditFilters = { domain: opts.domain, systems: opts.systems, levels: opts.levels, include_equipment: opts.include_equipment };
  const connectors = filterConnectors(snapshot.open_connectors ?? [], filters);
  const plumbingOnly = filterPlumbingOnly(snapshot.plumbing_only_open ?? [], filters);
  const systems = filterSystems(snapshot.systems ?? [], filters);
  const dropped = (snapshot.open_connectors ?? []).filter((r) => !normDomain(r.domain)).length;

  const issues = sortIssues([...connectors.map(connectorIssue), ...crossCheckIssues(connectors, plumbingOnly), ...systems.flatMap(systemIssues)]);
  const cap = Math.max(1, Math.min(5000, Math.floor(opts.max_results || 200)));
  const facts = systems.map(systemFact);
  const segmentParts = systems.map(segmentsFor);
  const segments = segmentParts.flatMap((p) => p.segments);
  const segmentChecks = segmentParts.flatMap((p) => p.checks);
  const segmentCap = Math.max(cap, 1000);
  const noBase = systems.filter((s) => s.base_equipment_id == null && s.is_empty !== true).map((s) => s.id);

  const bySeverity = countBy(issues, (i) => i.severity);
  const summary = {
    open_connectors: connectors.length,
    open_connectors_by_kind: countBy(connectors, (c) => norm(c.kind) || "unknown"),
    cross_check: {
      of: CROSS_CHECK_OF,
      unused_connectors: connectors.length,
      plumbing_open_elements: new Set(connectors.filter((c) => c.plumbing_open === true).map((c) => c.element_id)).size + plumbingOnly.length,
      mismatches: issues.filter((i) => i.code === MEP_CODES.XCHK_MISMATCH).length,
    },
    issues: issues.length,
    by_code: countBy(issues, (i) => i.code),
    by_severity: { error: bySeverity.error ?? 0, warning: bySeverity.warning ?? 0, info: bySeverity.info ?? 0 },
    systems: {
      total: systems.length,
      piping: systems.filter((s) => s.domain === "piping").length,
      duct: systems.filter((s) => s.domain === "duct").length,
      not_well_connected: systems.filter((s) => s.is_well_connected === false).length,
      not_well_connected_ids: systems.filter((s) => s.is_well_connected === false).map((s) => s.id).slice(0, cap),
      no_base_equipment: noBase.length,
      no_base_equipment_ids: noBase.slice(0, cap),
      empty: systems.filter((s) => s.is_empty === true).length,
    },
    totals: {
      fixture_units: round(facts.reduce((a, s) => a + (s.calc_valid && s.fixture_units ? s.fixture_units : 0), 0), 2),
    },
  };

  const detail = opts.mode === "detail";
  const sampleIds: Record<string, number[]> = {};
  if (!detail) {
    for (const i of issues) {
      const id = i.element_id ?? i.system_id;
      if (id == null) continue;
      const list = (sampleIds[i.code] ??= []);
      if (list.length < 20 && !list.includes(id)) list.push(id);
    }
  }
  const issueSystems = new Set(issues.filter((i) => i.system_id != null && i.element_id == null).map((i) => i.system_id));
  const systemRows = detail ? facts : facts.filter((s) => issueSystems.has(s.id));
  const issueRows = detail ? issues : issues.filter((i) => i.severity !== "info");

  return {
    tool: "fmc_mep_audit",
    schema: MEP_AUDIT_SCHEMA,
    read_only: true,
    document: snapshot.resolved_document ?? { title: snapshot.model ?? "", path: "" },
    filters: { domain: filters.domain, systems: filters.systems, levels: filters.levels, include_equipment: filters.include_equipment },
    mode: opts.mode,
    summary,
    issues: issueRows.slice(0, cap),
    issues_truncated: issueRows.length > cap,
    sample_ids: detail ? undefined : sampleIds,
    systems: systemRows.slice(0, cap),
    systems_truncated: systemRows.length > cap,
    /** Every filtered system, capped: the stable per-system block other tools read. */
    mep_systems: facts.slice(0, cap),
    /** fmc_mep_size pressure|critical_path input: MepSegment[] (critical-path sections of well-connected systems, flow order). */
    segments: segments.slice(0, segmentCap),
    segment_checks: segmentChecks.slice(0, segmentCap),
    segments_truncated: segments.length > segmentCap,
    segment_notes: segmentParts.flatMap((p) => p.notes).slice(0, 100),
    scanned: snapshot.scanned ?? {},
    source_truncated: { connectors: !!snapshot.truncated?.connectors, systems: !!snapshot.truncated?.systems },
    dropped_out_of_scope: dropped,
    skipped_non_family: snapshot.skipped_non_family ?? { count: 0, ids: [] },
    excludes: EXCLUDED_DOMAINS_NOTE,
    api_notes: snapshot.api_notes ?? [],
  };
}

export type MepAuditReply = ReturnType<typeof shapeMepAudit>;
