/**
 * fmc_fabrication, the engine side (pure, no Revit): what the add-in read of the MEP fabrication setup and the
 * FabricationParts becomes a config report, an audit, an ancillary summary and the export rows. The add-in only reads
 * (commandset/Services/Fmc/FmcFabrication.cs); every count and every flag is decided here, where the tests can reach it.
 * Names and ids are the model's and the fabrication configuration's own: nothing is defaulted or guessed.
 */

export interface FabAncillary { id: number; name: string; usage: string; type: string; code: string; qty: number; length_mm: number }

export interface FabPart {
  id: number | string; category: string; level: string;
  service_id: number; service: string; spec_id: number; spec: string; material_id: number; material: string;
  insulation_id: number; insulation: string; has_insulation: boolean;
  product: string; size: string; alias: string; item_number: string; length_mm: number;
  status_id: number; status: string; validation: string; iso_update: boolean;
  hanger: boolean; straight: boolean; bought_out: boolean; ends: number; open_ends: number; no_connections: boolean;
  anc: FabAncillary[];
}

export interface FabService { id: number; name: string; abbreviation: string; loaded: boolean; used: boolean }

export interface FabConfigInfo {
  name: string; description: string; version: string; product_version: string; path: string; guid: string;
  unit_system: string; is_cloud: boolean; is_locked: boolean; valid: boolean;
}

/** What the add-in answers (fmc_fabrication). configured=false carries a message and, when it can tell, the parts it saw. */
export interface FabRead {
  configured: boolean; message?: string; config?: FabConfigInfo; services?: FabService[];
  parts?: FabPart[]; parts_total?: number; parts_truncated?: boolean; notes?: string[];
  fabrication_parts_in_model?: number; resolved_document?: { title?: string; path?: string };
}

export const ISSUE_LABELS = {
  missing_service: "No service name on the part",
  service_not_in_config: "Service id isn't in the loaded fabrication configuration",
  service_not_loaded: "Service is in the configuration but not loaded",
  missing_specification: "No specification name resolves for the part",
  missing_material: "No material (or the API's validation status says NoMaterial)",
  missing_insulation: "No insulation specification (counted only when require_insulation is set)",
  disconnected_ends: "One or more ends are not connected (hangers and bought-out items without ends excluded)",
  invalid: "The API's validation status isn't Valid",
  iso_drawing_out_of_date: "NeedToUpdateIsoDrawing is set (the part's iso drawing is out of date)",
} as const;
export type IssueKey = keyof typeof ISSUE_LABELS;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** The add-in's rows made safe: a field it couldn't read becomes "" / 0 / false, never undefined. */
export function cleanPart(raw: unknown): FabPart {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const anc = Array.isArray(r.anc) ? r.anc : [];
  return {
    id: typeof r.id === "number" ? r.id : str(r.id), category: str(r.category), level: str(r.level),
    service_id: num(r.service_id), service: str(r.service), spec_id: num(r.spec_id), spec: str(r.spec),
    material_id: num(r.material_id), material: str(r.material), insulation_id: num(r.insulation_id), insulation: str(r.insulation),
    has_insulation: r.has_insulation === true, product: str(r.product), size: str(r.size), alias: str(r.alias), item_number: str(r.item_number),
    length_mm: num(r.length_mm), status_id: num(r.status_id), status: str(r.status), validation: str(r.validation), iso_update: r.iso_update === true,
    hanger: r.hanger === true, straight: r.straight === true, bought_out: r.bought_out === true,
    ends: num(r.ends), open_ends: num(r.open_ends), no_connections: r.no_connections === true,
    anc: anc.map((a) => {
      const x = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
      return { id: num(x.id), name: str(x.name), usage: str(x.usage) || "Undefined", type: str(x.type), code: str(x.code), qty: num(x.qty), length_mm: num(x.length_mm) };
    }),
  };
}

export function filterByLevel(parts: FabPart[], levels: string[]): FabPart[] {
  const want = new Set(levels.map((l) => l.trim().toLowerCase()).filter(Boolean));
  return want.size ? parts.filter((p) => want.has(p.level.trim().toLowerCase())) : parts;
}

export function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out = new Map<string, number>();
  for (const item of items) { const k = key(item).trim() || "(none)"; out.set(k, (out.get(k) ?? 0) + 1); }
  return Object.fromEntries([...out.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/** Which of the audit's problems this part has. Pure: the same part, services and options always give the same keys. */
export function partIssues(p: FabPart, services: FabService[] | undefined, requireInsulation: boolean): IssueKey[] {
  const out: IssueKey[] = [];
  if (!p.service.trim()) out.push("missing_service");
  else if (services && services.length) {
    const s = services.find((x) => x.id === p.service_id);
    if (!s) out.push("service_not_in_config");
    else if (!s.loaded) out.push("service_not_loaded");
  }
  if (!p.spec.trim()) out.push("missing_specification");
  if (!p.material.trim() || /nomaterial/i.test(p.validation)) out.push("missing_material");
  if (requireInsulation && !p.hanger && !p.has_insulation && !p.insulation.trim()) out.push("missing_insulation");
  if (!p.hanger && (p.open_ends > 0 || (p.no_connections && p.ends > 0))) out.push("disconnected_ends");
  if (p.validation.trim() && !/^valid$/i.test(p.validation.trim())) out.push("invalid");
  if (p.iso_update) out.push("iso_drawing_out_of_date");
  return out;
}

export interface AuditOptions { require_insulation: boolean; sample_limit: number }

export function auditParts(parts: FabPart[], services: FabService[] | undefined, opts: AuditOptions) {
  const issues = {} as Record<IssueKey, { count: number; label: string; sample_ids: Array<number | string> }>;
  for (const k of Object.keys(ISSUE_LABELS) as IssueKey[]) issues[k] = { count: 0, label: ISSUE_LABELS[k], sample_ids: [] };
  let withIssues = 0;
  for (const p of parts) {
    const keys = partIssues(p, services, opts.require_insulation);
    if (keys.length) withIssues++;
    for (const k of keys) {
      issues[k].count++;
      if (issues[k].sample_ids.length < opts.sample_limit) issues[k].sample_ids.push(p.id);
    }
  }
  const noInsulation = parts.filter((p) => !p.has_insulation && !p.insulation.trim() && !p.hanger).length;
  return {
    parts: parts.length,
    parts_with_issues: withIssues,
    by_service: countBy(parts, (p) => p.service),
    by_category: countBy(parts, (p) => p.category),
    by_level: countBy(parts, (p) => p.level),
    by_specification: countBy(parts, (p) => p.spec),
    by_material: countBy(parts, (p) => p.material),
    hangers: parts.filter((p) => p.hanger).length,
    straights: parts.filter((p) => p.straight).length,
    parts_without_insulation_info: noInsulation,
    issues,
    not_exposed: "The API gives a validation status and the iso-drawing flag; it doesn't compare a part with its catalogue item, so 'out of date' here means only NeedToUpdateIsoDrawing.",
  };
}

const bump = (map: Map<string, { rows: number; qty: number }>, key: string, qty: number) => {
  const k = key.trim() || "(none)";
  const e = map.get(k) ?? { rows: 0, qty: 0 };
  e.rows++; e.qty += qty; map.set(k, e);
};
const obj = (m: Map<string, { rows: number; qty: number }>) => Object.fromEntries([...m.entries()].sort((a, b) => b[1].qty - a[1].qty || a[0].localeCompare(b[0])));

/** Per-part ancillary usage (hangers, supports, seams, stiffeners ...) and the totals by usage, type and name. */
export function ancillarySummary(parts: FabPart[], sampleLimit: number) {
  const usage = new Map<string, { rows: number; qty: number }>();
  const type = new Map<string, { rows: number; qty: number }>();
  const name = new Map<string, { rows: number; qty: number }>();
  const perPart: Array<{ id: number | string; product: string; service: string; level: string; ancillaries: number; quantity: number; usages: string[] }> = [];
  let rows = 0, quantity = 0, withAnc = 0;
  for (const p of parts) {
    if (!p.anc.length) continue;
    withAnc++;
    let q = 0;
    for (const a of p.anc) {
      rows++; quantity += a.qty; q += a.qty;
      bump(usage, a.usage, a.qty); bump(type, a.type, a.qty); bump(name, a.name || a.code, a.qty);
    }
    perPart.push({ id: p.id, product: p.product, service: p.service, level: p.level, ancillaries: p.anc.length, quantity: q, usages: [...new Set(p.anc.map((a) => a.usage))].sort() });
  }
  perPart.sort((a, b) => b.quantity - a.quantity || String(a.id).localeCompare(String(b.id)));
  return {
    parts: parts.length, parts_with_ancillaries: withAnc, parts_without_ancillaries: parts.length - withAnc,
    ancillary_rows: rows, ancillary_quantity: quantity,
    hanger_parts: parts.filter((p) => p.hanger).length,
    hanger_usage: usage.get("Hanger") ?? { rows: 0, qty: 0 },
    by_usage: obj(usage), by_type: obj(type), by_name: obj(name),
    per_part: perPart.slice(0, Math.max(1, sampleLimit)), per_part_truncated: perPart.length > Math.max(1, sampleLimit),
  };
}

/** The config check: is one loaded, what is it, which services are loaded and which are not. */
export function configReport(read: FabRead) {
  if (!read.configured || !read.config) {
    return { configured: false, message: read.message || "No fabrication configuration is loaded in this model.", fabrication_parts_in_model: read.fabrication_parts_in_model ?? 0 };
  }
  const services = read.services ?? [];
  const brief = (s: FabService) => ({ id: s.id, name: s.name, abbreviation: s.abbreviation });
  return {
    configured: true,
    config: read.config,
    services: {
      total: services.length,
      loaded: services.filter((s) => s.loaded).map(brief),
      unloaded: services.filter((s) => !s.loaded).map(brief),
      used_by_parts: services.filter((s) => s.used).map(brief),
    },
    fabrication_parts_in_model: read.parts_total ?? read.parts?.length ?? 0,
  };
}
