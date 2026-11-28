/**
 * fmc_mep_audit: offline logic. Read-only MEP connectivity and system audit (Builder 19).
 *
 * The add-in command (fmc_mep_audit, FmcMepAuditWork.cs) returns a raw snapshot: open connectors on pipe, duct,
 * their fittings and accessories, and on MEP equipment, fixtures and terminals; and one row per piping or mechanical
 * system with IsWellConnected, BaseEquipment, flow, static pressure, critical-path pressure loss and fixture units.
 * This module filters, classifies into issue codes, summarises, caps and shapes the reply. No Revit call, no writes.
 *
 * Conduit and cable tray are NOT audited here: fmc_conduit scan and fmc_trace (domain conduit, tray or
 * electrical_containment) already report their open ends. Any conduit/tray row the add-in sends is dropped.
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
  /** PlumbingUtils.HasOpenConnector on pipe curves, fittings and accessories; null when not asked or not piping. */
  plumbing_open?: boolean | null;
}

/** One piping or mechanical system. Flow L/s, pressures Pa, fixture units unitless. null = not available. */
export interface SystemRow {
  id: number;
  name: string;
  domain: string; // piping | duct
  classification: string; // PipeSystemType / DuctSystemType name, e.g. DomesticColdWater, SupplyAir
  system_type?: string; // the system type element name
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
  fixture_units?: number | null;
  /** Why a calculated value is missing (API threw, not well connected, analysis off). */
  calc_notes?: string[];
}

export interface MepAuditSnapshot {
  model?: string;
  resolved_document?: { title?: string; path?: string };
  read_only?: boolean;
  open_connectors?: OpenConnectorRow[];
  systems?: SystemRow[];
  scanned?: { elements?: number; connectors?: number; systems?: number };
  truncated?: { connectors?: boolean; systems?: boolean };
  skipped_non_family?: { count?: number; ids?: number[] };
  api_notes?: string[];
}

export interface MepAuditFilters {
  domain: DomainFilter;
  systems: string[]; // names (case-insensitive) or ids
  levels: string[]; // level names (case-insensitive)
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

/** Issue codes. Stable: other tools (fmc_mep_size, fmc_calc) and tests key on these. */
export const MEP_CODES = {
  OPEN_CURVE_END: "MEP-OPEN-CURVE-END",
  OPEN_FITTING: "MEP-OPEN-FITTING",
  OPEN_ACCESSORY: "MEP-OPEN-ACCESSORY",
  OPEN_EQUIPMENT: "MEP-OPEN-EQUIPMENT",
  OPEN_FIXTURE: "MEP-OPEN-FIXTURE",
  OPEN_TERMINAL: "MEP-OPEN-TERMINAL",
  CONNECTOR_NO_SYSTEM: "MEP-CONN-NO-SYSTEM",
  SYS_NOT_WELL_CONNECTED: "MEP-SYS-NOT-WELL-CONNECTED",
  SYS_NO_BASE_EQUIPMENT: "MEP-SYS-NO-BASE-EQUIPMENT",
  SYS_EMPTY: "MEP-SYS-EMPTY",
  SYS_INVALID: "MEP-SYS-INVALID",
  SYS_CALC_UNAVAILABLE: "MEP-SYS-CALC-UNAVAILABLE",
} as const;

export const MEP_CODE_SEVERITY: Record<string, Severity> = {
  [MEP_CODES.OPEN_CURVE_END]: "error",
  [MEP_CODES.OPEN_FITTING]: "error",
  [MEP_CODES.OPEN_ACCESSORY]: "error",
  [MEP_CODES.OPEN_EQUIPMENT]: "warning",
  [MEP_CODES.OPEN_FIXTURE]: "warning",
  [MEP_CODES.OPEN_TERMINAL]: "warning",
  [MEP_CODES.CONNECTOR_NO_SYSTEM]: "info",
  [MEP_CODES.SYS_NOT_WELL_CONNECTED]: "error",
  [MEP_CODES.SYS_NO_BASE_EQUIPMENT]: "warning",
  [MEP_CODES.SYS_EMPTY]: "info",
  [MEP_CODES.SYS_INVALID]: "warning",
  [MEP_CODES.SYS_CALC_UNAVAILABLE]: "info",
};

/**
 * Gravity, vent and fire systems usually have no BaseEquipment in Revit (they end at a drain, a stack or a riser).
 * For these a missing base is info, not a warning.
 */
const NO_BASE_EXPECTED = new Set(["sanitary", "vent", "fireprotectwet", "fireprotectdry", "fireprotectpreaction", "fireprotectother", "otherpipe"]);

export const EXCLUDED_DOMAINS_NOTE =
  "Conduit and cable tray are not audited here: fmc_conduit scan and fmc_trace (domain conduit, tray or electrical_containment) report their open ends.";

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

export function normDomain(d: unknown): MepDomain | null {
  const v = norm(d);
  if (v === "piping" || v === "pipe" || v === "plumbing") return "piping";
  if (v === "duct" || v === "hvac" || v === "mechanical") return "duct";
  return null; // conduit, tray, cabletrayconduit, electrical: out of scope
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

/** Connector rows kept after the domain, system, level and equipment filters. Conduit and tray are always dropped. */
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

function connectorIssues(row: OpenConnectorRow & { domain: MepDomain }): MepIssue[] {
  const code = openConnectorCode(String(row.kind));
  const what = norm(row.kind) === "curve" ? "end" : `${norm(row.kind) || "element"} connector`;
  const issues: MepIssue[] = [{
    code, severity: MEP_CODE_SEVERITY[code], domain: row.domain, element_id: row.element_id, connector_index: row.connector_index,
    system_id: row.system_id ?? null, system: row.system_name ?? "", level: row.level ?? "",
    message: `Open ${row.domain} ${what} ${row.connector_index} on ${row.element_id}${row.type_name ? ` (${row.type_name})` : ""}.`,
  }];
  if (row.system_id == null && !row.system_name) {
    issues.push({
      code: MEP_CODES.CONNECTOR_NO_SYSTEM, severity: "info", domain: row.domain, element_id: row.element_id, connector_index: row.connector_index,
      system_id: null, system: "", level: row.level ?? "", message: `Connector ${row.connector_index} on ${row.element_id} is in no ${row.domain} system.`,
    });
  }
  return issues;
}

export function systemIssues(row: SystemRow & { domain: MepDomain }): MepIssue[] {
  const base = { domain: row.domain, system_id: row.id, system: row.name, level: (row.levels ?? [])[0] ?? "" };
  const out: MepIssue[] = [];
  if (row.is_empty === true) {
    out.push({ ...base, code: MEP_CODES.SYS_EMPTY, severity: "info", message: `System ${row.name} has no components.` });
    return out; // nothing else is meaningful on an empty system
  }
  if (row.is_well_connected === false) {
    out.push({ ...base, code: MEP_CODES.SYS_NOT_WELL_CONNECTED, severity: "error", message: `System ${row.name} is not well connected; its calculated values are invalid.` });
  }
  if (row.is_valid === false) {
    out.push({ ...base, code: MEP_CODES.SYS_INVALID, severity: "warning", message: `Revit marks system ${row.name} as invalid.` });
  }
  if (row.base_equipment_id == null) {
    const expected = NO_BASE_EXPECTED.has(norm(row.classification));
    out.push({
      ...base, code: MEP_CODES.SYS_NO_BASE_EQUIPMENT, severity: expected ? "info" : "warning",
      message: expected
        ? `System ${row.name} (${row.classification}) has no base equipment, which is usual for this classification.`
        : `System ${row.name} (${row.classification}) has no base equipment.`,
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

const round = (v: number | null | undefined, dp = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

/** The per-system block fmc_mep_size and fmc_calc read. One row per system, stable field names and units. */
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
  const systems = filterSystems(snapshot.systems ?? [], filters);
  const dropped = (snapshot.open_connectors ?? []).filter((r) => !normDomain(r.domain)).length;

  const issues = sortIssues([...connectors.flatMap(connectorIssues), ...systems.flatMap(systemIssues)]);
  const cap = Math.max(1, Math.min(5000, Math.floor(opts.max_results || 200)));
  const facts = systems.map(systemFact);

  const bySeverity = countBy(issues, (i) => i.severity);
  const summary = {
    open_connectors: connectors.length,
    open_connectors_by_kind: countBy(connectors, (c) => norm(c.kind) || "unknown"),
    issues: issues.length,
    by_code: countBy(issues, (i) => i.code),
    by_severity: { error: bySeverity.error ?? 0, warning: bySeverity.warning ?? 0, info: bySeverity.info ?? 0 },
    systems: {
      total: systems.length,
      piping: systems.filter((s) => s.domain === "piping").length,
      duct: systems.filter((s) => s.domain === "duct").length,
      not_well_connected: systems.filter((s) => s.is_well_connected === false).length,
      no_base_equipment: systems.filter((s) => s.base_equipment_id == null && s.is_empty !== true).length,
      empty: systems.filter((s) => s.is_empty === true).length,
    },
    totals: {
      fixture_units: round(facts.reduce((a, s) => a + (s.calc_valid && s.fixture_units ? s.fixture_units : 0), 0), 2),
    },
  };

  // summary: counts, a capped sample of ids per code, and only systems that have an issue; detail: every issue and system, capped.
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
    /** Feeds fmc_calc (merge facts.mep into a facts_file's mep section) and fmc_mep_size (facts.mep_systems). */
    facts: {
      mep: {
        model: snapshot.model ?? snapshot.resolved_document?.title ?? "",
        pipe_systems: facts.filter((s) => s.domain === "piping").map((s) => ({ id: s.id, name: s.name, classification: s.classification })),
        counts: { pipe_systems: summary.systems.piping, duct_systems: summary.systems.duct, open_connectors: connectors.length },
      },
      mep_systems: facts.slice(0, cap),
    },
    scanned: snapshot.scanned ?? {},
    source_truncated: { connectors: !!snapshot.truncated?.connectors, systems: !!snapshot.truncated?.systems },
    dropped_out_of_scope: dropped,
    skipped_non_family: snapshot.skipped_non_family ?? { count: 0, ids: [] },
    excludes: EXCLUDED_DOMAINS_NOTE,
    api_notes: snapshot.api_notes ?? [],
  };
}

export type MepAuditReply = ReturnType<typeof shapeMepAudit>;
