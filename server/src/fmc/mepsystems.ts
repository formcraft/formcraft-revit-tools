/**
 * fmc_mep_systems, the part that does not need Revit: duct and piping systems and the routing preferences of duct and
 * pipe types, summarised. Read-only. Routing preferences are read, never written (modify_model owns type edits).
 */

export interface SystemRow {
  id: number;
  name: string;
  kind: "duct" | "piping";
  system_type?: string;
  classification?: string;
  base_equipment?: { id: number; name: string } | null;
  elements?: number | null;
  flow?: string | null;
  static_pressure?: string | null;
  fixture_units?: string | null;
}

export interface RoutingRule { index: number; part?: string; part_id?: number; description?: string; error?: string }

export interface CurveTypeRow {
  id: number;
  name: string;
  kind: "duct" | "pipe";
  preferred_junction?: string;
  routing?: Record<string, RoutingRule[]>;
  error?: string;
}

export interface SystemsSnapshot {
  model?: string;
  resolved_document?: { title?: string; path?: string };
  systems?: SystemRow[];
  system_count?: number;
  capped?: boolean;
  system_types?: Array<{ id: number; name: string; kind: string; classification: string; abbreviation?: string }>;
  curve_types?: CurveTypeRow[];
}

/** The routing groups a run with corners, branches, size changes and joints needs, per kind. Pipes also need a segment. */
export const NEEDED_GROUPS: Record<"duct" | "pipe", string[]> = {
  duct: ["Elbows", "Junctions", "Transitions", "Unions"],
  pipe: ["Segments", "Elbows", "Junctions", "Transitions", "Unions"],
};

export interface RoutingCoverage { id: number; name: string; kind: "duct" | "pipe"; missing: string[]; caps: boolean; ready: boolean; preferred_junction: string }

/** Which routing groups a type has no rule in, so a route can say up front which fittings Revit cannot place. */
export function routingCoverage(type: CurveTypeRow): RoutingCoverage {
  const groups = type.routing ?? {};
  const has = (g: string) => (groups[g] ?? []).some((r) => !r.error && (r.part_id ?? 0) > 0);
  const missing = NEEDED_GROUPS[type.kind].filter((g) => !has(g));
  return { id: type.id, name: type.name, kind: type.kind, missing, caps: has("Caps"), ready: missing.length === 0, preferred_junction: type.preferred_junction ?? "" };
}

export interface SystemsSummary {
  count: number;
  by_kind: Record<string, number>;
  by_classification: Record<string, number>;
  with_flow: number;
  capped: boolean;
}

export function summarise(snapshot: SystemsSnapshot): SystemsSummary {
  const rows = snapshot.systems ?? [];
  const by_kind: Record<string, number> = {};
  const by_classification: Record<string, number> = {};
  for (const r of rows) {
    by_kind[r.kind] = (by_kind[r.kind] ?? 0) + 1;
    const c = r.classification || "(none)";
    by_classification[c] = (by_classification[c] ?? 0) + 1;
  }
  return { count: snapshot.system_count ?? rows.length, by_kind, by_classification, with_flow: rows.filter((r) => r.flow != null && r.flow !== "").length, capped: snapshot.capped === true };
}

export function filterSystems(rows: SystemRow[], opts: { name?: string; classification?: string; kind?: string }): SystemRow[] {
  const name = (opts.name ?? "").trim().toLowerCase();
  const cls = (opts.classification ?? "").trim().toLowerCase();
  return rows.filter((r) => (!name || r.name.toLowerCase().includes(name)) && (!cls || (r.classification ?? "").toLowerCase() === cls) && (!opts.kind || r.kind === opts.kind));
}
