/**
 * fmc_wipe (GAP-02): a project model's clutter found, counted and listed by id, and deleted only on
 * dry_run=false + confirm=true under a batch lease. Elements another user owns are skipped. Pure: the plan and the
 * gate. The Revit side is commandset/Services/Fmc/FmcWipe.cs. Not a family purge (fmc_fam_purge) or a material
 * purge (fmc_material_purge).
 */

export const WIPE_CATEGORIES = [
  "unused_view_templates",
  "unused_filters",
  "unplaced_views",
  "unplaced_schedules",
  "cad_imports",
  "orphan_tags",
  "purgeable",
] as const;
export type WipeCategory = typeof WIPE_CATEGORIES[number];

export const WIPE_CATEGORY_HELP: Record<WipeCategory, string> = {
  unused_view_templates: "view templates no view uses and no view type has as its default",
  unused_filters: "view filters (rule and selection) not applied to any view or template",
  unplaced_views: "plans, sections, elevations, 3D, drafting, detail and legend views on no sheet (not the active view, not with dependents)",
  unplaced_schedules: "schedules on no sheet (not revision or keynote schedules)",
  cad_imports: "imported (not linked) CAD",
  orphan_tags: "tags whose element is gone",
  purgeable: "what Revit's Purge Unused would remove (Revit 2024+); opt-in",
};

/** The default: everything but the deep purge, which is opt-in. */
export const DEFAULT_WIPE_CATEGORIES: WipeCategory[] = WIPE_CATEGORIES.filter((c) => c !== "purgeable");

/** Names kept whatever: the kit's own FMC templates and filters, and the default 3D views. */
export const DEFAULT_PROTECT = ["^FMC[_-]", "^\\{3D"];

export const DEFAULT_MAX = 500;

export interface ScanRow {
  id: string;
  category: string;
  name?: string;
  kind?: string;
  checkout?: string;
  owner?: string;
}

export interface WipeItem { id: string; category: WipeCategory; name: string }
export interface Skip { id: string; category: string; name: string; reason: string }

export interface WipePlan {
  counts: Record<string, number>;
  ids: Record<string, string[]>;
  items: WipeItem[];
  skipped: Skip[];
  problems: string[];
}

export function planWipe(rows: ScanRow[], opts: { categories: WipeCategory[]; protect?: string[]; onlyIds?: string[] }): WipePlan {
  const problems: string[] = [];
  const protect: RegExp[] = [];
  for (const p of [...DEFAULT_PROTECT, ...(opts.protect ?? [])]) {
    try { protect.push(new RegExp(p, "i")); } catch { problems.push(`protect pattern ${p} is not a valid regular expression`); }
  }
  const only = opts.onlyIds?.length ? new Set(opts.onlyIds.map(String)) : null;
  const wanted = new Set<string>(opts.categories);
  const counts: Record<string, number> = {};
  const ids: Record<string, string[]> = {};
  for (const c of opts.categories) { counts[c] = 0; ids[c] = []; }
  const items: WipeItem[] = [];
  const skipped: Skip[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!wanted.has(r.category)) continue;
    const id = String(r.id);
    const name = r.name ?? "";
    const cat = r.category as WipeCategory;
    if (only && !only.has(id)) continue;
    if (seen.has(id)) continue; // purgeable can repeat an id another category found
    if (r.checkout === "owned_by_other") { skipped.push({ id, category: cat, name, reason: `owned by ${r.owner || "another user"}` }); continue; }
    const hit = protect.find((re) => re.test(name));
    if (hit) { skipped.push({ id, category: cat, name, reason: `protected name (${hit.source})` }); continue; }
    seen.add(id);
    counts[cat]++;
    ids[cat].push(id);
    items.push({ id, category: cat, name });
  }
  if (only) for (const id of only) if (!seen.has(id) && !skipped.some((s) => s.id === id)) problems.push(`id ${id} is not in the scan for the chosen categories`);
  return { counts, ids, items, skipped, problems };
}

/** Why a real delete may not run (empty when it may). A dry run never deletes, so it is never gated. */
export function wipeGate(g: { dry_run: boolean; confirm: boolean; lease: string; blocked?: string; count: number; max: number }): string[] {
  if (g.dry_run) return [];
  const out: string[] = [];
  if (!g.confirm) out.push("Deleting needs confirm=true as well as dry_run=false");
  if (!g.lease.trim()) out.push("Deleting needs a batch_lease (writes only under a batch lease)");
  if (g.blocked) out.push(g.blocked);
  if (g.count > g.max) out.push(`${g.count} elements is more than max=${g.max}; raise max or narrow categories/ids`);
  return out;
}

export function asRows(x: unknown): ScanRow[] {
  const rows = (x as { rows?: unknown[] } | null)?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      id: String(o.id ?? ""),
      category: String(o.category ?? ""),
      name: o.name === undefined ? undefined : String(o.name),
      kind: o.kind === undefined ? undefined : String(o.kind),
      checkout: o.checkout === undefined ? undefined : String(o.checkout),
      owner: o.owner === undefined ? undefined : String(o.owner),
    };
  });
}
