/**
 * Legend views and symbols on fmc_legend. The chain action stays in the tool file.
 * Revit cannot create a LegendComponent or a ViewLegend. These plans only copy a seed.
 * No free text notes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGEND_FIX, labelPlan, paperMmToFeet, placePlan, type LabelMode, type PlaceItemPlan } from "./legendmath.js";

export interface LegendComponentRow {
  id: string;
  view_id?: string;
  view_name?: string;
  type_id?: string;
  direction?: number | null;
  length_mm?: number | null;
}

export interface LegendViewRow {
  id: string;
  name: string;
  scale?: number;
  component_count?: number;
}

export interface LegendDoc {
  title: string;
  path?: string;
  is_central?: boolean;
  views?: LegendViewRow[];
  components?: LegendComponentRow[];
}

export interface LegendSnapshot {
  documents?: LegendDoc[];
  resolved_document?: { title?: string; path?: string };
  is_central?: boolean;
  refused?: boolean;
  code?: string;
  message?: string;
}

export function legendDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_LEGEND_DIR ?? "").trim()) return env.FMC_LEGEND_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(os.tmpdir(), "FormcraftLocal");
  return path.join(local, "Formcraft", "legend");
}

export function writeLegendReport(env: NodeJS.ProcessEnv, action: string, body: unknown, dir = legendDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `legend-${action}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

export function legendReferenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return LEGEND_FIX["FMC-LEGEND-REFERENCES"];
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) return LEGEND_FIX["FMC-LEGEND-REFERENCES"];
  }
  return null;
}

export function seedVerdict(doc: LegendDoc | undefined, source: LegendDoc | undefined): { code?: string; fix?: string; seed_view?: LegendViewRow; seed_component?: LegendComponentRow; source_component?: LegendComponentRow } {
  const views = doc?.views ?? [];
  const components = doc?.components ?? [];
  const sourceComponents = source?.components ?? [];
  const seedComponent = components[0] ?? sourceComponents[0];
  const seedView = views.find((view) => view.id === seedComponent?.view_id) ?? views[0] ?? (source?.views ?? [])[0];
  if (!seedComponent) {
    return { code: "FMC-LEGEND-NO-SEED", fix: LEGEND_FIX["FMC-LEGEND-NO-SEED"], seed_view: seedView };
  }
  return { seed_view: seedView, seed_component: components[0], source_component: components[0] ? undefined : sourceComponents[0] };
}

export function apiFeetFor(item: PlaceItemPlan, scale: number): { x_ft: number; y_ft: number; length_ft: number | null } {
  return {
    x_ft: paperMmToFeet(item.x_mm, scale),
    y_ft: paperMmToFeet(item.y_mm, scale),
    length_ft: item.length_mm == null ? null : item.length_mm / 304.8,
  };
}

export function buildPlace(input: {
  types: Array<{ id: string | number; category: string; view?: "front" | "back" }>;
  columns: number;
  spacing_x_mm: number;
  spacing_y_mm: number;
  origin_x_mm: number;
  origin_y_mm: number;
  length_mm: number;
  label: LabelMode;
  scale: number;
}): { items: Array<PlaceItemPlan & { x_ft: number; y_ft: number; length_ft: number | null }>; rejected: ReturnType<typeof placePlan>["rejected"]; label: ReturnType<typeof labelPlan> } {
  const planned = placePlan(input);
  const label = labelPlan(input.label);
  return {
    items: planned.items.map((item) => ({ ...item, ...apiFeetFor(item, input.scale) })),
    rejected: planned.rejected,
    label,
  };
}

export { LEGEND_FIX };
