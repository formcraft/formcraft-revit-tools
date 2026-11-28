/**
 * F59: the kit's assembly designs against what the model has (read by fmc_assemblies_read): per item create, update,
 * unchanged or blocked, and the payload the add-in carries out. And the legend: an fmc_legend place call for the
 * curtain wall types (legend components of walls); railings and patterns are listed, not placed. Pure: no Revit.
 */
import { AssembliesSpec, CurtainGrid, CurtainSpec, LAYOUT_CODE, PatternGrid, PatternSpec, RailingSpec } from "./assemblies_spec.js";

export interface ModelGrid { angle: number; spacing: number; shift?: number; origin?: [number, number] }
export interface ModelRead {
  patterns: Array<{ name: string; target: "drafting" | "model"; id: number; grids: ModelGrid[] }>;
  curtain_types: Array<{ name: string; id: number; vertical?: CurtainGrid; horizontal?: CurtainGrid; mullion?: { interior?: string; border?: string }; panel?: string }>;
  railing_types: Array<{ name: string; id: number; height?: number; top_rail?: string }>;
  mullion_types: string[];
  panel_types: string[];
  top_rail_types: string[];
  legend_views: string[];
}

export type OpAction = "create" | "update" | "unchanged" | "blocked";
export interface Op { kind: "pattern" | "curtain_wall" | "railing"; name: string; action: OpAction; changes: string[]; why: string[]; payload?: Record<string, unknown> }
export interface KitAsk { item: string; request: string; why: string }

const same = (a: number | undefined, b: number | undefined, tol: number) => a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
const lc = (s: string) => s.trim().toLowerCase();
/** Lines at a and a+180 degrees are the same lines */
const angleOf = (a: number) => ((a % 180) + 180) % 180;

function gridChanges(want: PatternGrid[], have: ModelGrid[]): string[] {
  if (want.length !== have.length) return [`${have.length} grid(s) → ${want.length}`];
  const out: string[] = [];
  want.forEach((w, i) => {
    const h = have[i];
    const da = Math.abs(angleOf(w.angle) - angleOf(h.angle));
    if (Math.min(da, 180 - da) > 0.01) out.push(`grid ${i + 1} angle ${h.angle} → ${w.angle}`);
    if (!same(w.spacing, h.spacing, 0.01)) out.push(`grid ${i + 1} spacing ${h.spacing} → ${w.spacing}`);
    if (!same(w.shift ?? 0, h.shift ?? 0, 0.01)) out.push(`grid ${i + 1} shift ${h.shift ?? 0} → ${w.shift ?? 0}`);
    const [wx, wy] = w.origin ?? [0, 0], [hx, hy] = h.origin ?? [0, 0];
    if (!same(wx, hx, 0.01) || !same(wy, hy, 0.01)) out.push(`grid ${i + 1} origin ${hx},${hy} → ${wx},${wy}`);
  });
  return out;
}

function patternOp(p: PatternSpec, read: ModelRead): Op {
  const have = read.patterns.find((x) => lc(x.name) === lc(p.name) && x.target === p.target);
  const payload = { name: p.name, target: p.target, update: !!have, grids: p.grids.map((g) => ({ angle: g.angle, spacing: g.spacing, shift: g.shift ?? 0, origin: g.origin ?? [0, 0] })) };
  if (!have) return { kind: "pattern", name: p.name, action: "create", changes: [`new ${p.target} pattern, ${p.grids.length} grid(s)`], why: [], payload };
  const changes = gridChanges(p.grids, have.grids);
  return changes.length ? { kind: "pattern", name: p.name, action: "update", changes, why: [], payload: { ...payload, id: have.id } } : { kind: "pattern", name: p.name, action: "unchanged", changes: [], why: [] };
}

function gridDiff(which: string, want: CurtainGrid, have: CurtainGrid | undefined): string[] {
  const out: string[] = [];
  if (have?.layout !== want.layout) out.push(`${which} layout ${have?.layout ?? "?"} → ${want.layout}`);
  if (want.spacing !== undefined && !same(want.spacing, have?.spacing, 0.5)) out.push(`${which} spacing ${have?.spacing ?? "?"} → ${want.spacing}`);
  return out;
}

function needType(list: string[], name: string | undefined, what: string, owner: string, why: string[], asks: KitAsk[]) {
  if (name === undefined || list.some((x) => lc(x) === lc(name))) return;
  why.push(`the model has no ${what} ${name}`);
  asks.push({ item: `${what} ${name}`, request: `Load or make the ${what} ${name} in the template (needed by ${owner})`, why: `${owner} uses it; the tool never substitutes another type` });
}

function curtainOp(c: CurtainSpec, read: ModelRead, asks: KitAsk[]): Op {
  const have = read.curtain_types.find((x) => lc(x.name) === lc(c.name));
  const why: string[] = [];
  if (!have && !read.curtain_types.some((x) => lc(x.name) === lc(c.base))) why.push(`the model has no curtain wall type ${c.base} to start from`);
  needType(read.mullion_types, c.mullion?.interior, "mullion type", c.name, why, asks);
  needType(read.mullion_types, c.mullion?.border, "mullion type", c.name, why, asks);
  needType(read.panel_types, c.panel, "curtain panel type", c.name, why, asks);
  if (why.length) return { kind: "curtain_wall", name: c.name, action: "blocked", changes: [], why };
  const g = (x: CurtainGrid) => ({ layout: x.layout, layout_code: LAYOUT_CODE[x.layout], spacing: x.spacing ?? null });
  const payload = { name: c.name, base: c.base, update: !!have, vertical: g(c.vertical), horizontal: g(c.horizontal),
    mullion_interior: c.mullion?.interior ?? null, mullion_border: c.mullion?.border ?? null, panel: c.panel ?? null };
  if (!have) return { kind: "curtain_wall", name: c.name, action: "create", changes: [`new type from ${c.base}`], why, payload };
  const changes = [...gridDiff("vertical", c.vertical, have.vertical), ...gridDiff("horizontal", c.horizontal, have.horizontal)];
  if (c.mullion?.interior && lc(c.mullion.interior) !== lc(have.mullion?.interior ?? "")) changes.push(`interior mullion ${have.mullion?.interior ?? "none"} → ${c.mullion.interior}`);
  if (c.mullion?.border && lc(c.mullion.border) !== lc(have.mullion?.border ?? "")) changes.push(`border mullion ${have.mullion?.border ?? "none"} → ${c.mullion.border}`);
  if (c.panel && lc(c.panel) !== lc(have.panel ?? "")) changes.push(`panel ${have.panel ?? "none"} → ${c.panel}`);
  return changes.length ? { kind: "curtain_wall", name: c.name, action: "update", changes, why, payload: { ...payload, id: have.id } } : { kind: "curtain_wall", name: c.name, action: "unchanged", changes, why };
}

function railingOp(r: RailingSpec, read: ModelRead, asks: KitAsk[]): Op {
  const have = read.railing_types.find((x) => lc(x.name) === lc(r.name));
  const why: string[] = [];
  if (!have && !read.railing_types.some((x) => lc(x.name) === lc(r.base))) why.push(`the model has no railing type ${r.base} to start from`);
  needType(read.top_rail_types, r.top_rail, "top rail type", r.name, why, asks);
  if (why.length) return { kind: "railing", name: r.name, action: "blocked", changes: [], why };
  const payload = { name: r.name, base: r.base, update: !!have, height: r.height, top_rail: r.top_rail ?? null };
  if (!have) return { kind: "railing", name: r.name, action: "create", changes: [`new type from ${r.base}, ${r.height} high`], why, payload };
  const changes: string[] = [];
  if (!same(r.height, have.height, 0.5)) changes.push(`height ${have.height ?? "?"} → ${r.height}`);
  if (r.top_rail && lc(r.top_rail) !== lc(have.top_rail ?? "")) changes.push(`top rail ${have.top_rail ?? "none"} → ${r.top_rail}`);
  return changes.length ? { kind: "railing", name: r.name, action: "update", changes, why, payload: { ...payload, id: have.id } } : { kind: "railing", name: r.name, action: "unchanged", changes, why };
}

/** Every design item against the model; blocked items say why and what the kit needs. */
export function planOps(spec: AssembliesSpec, read: ModelRead): { ops: Op[]; kit_requests: KitAsk[]; counts: Record<OpAction, number> } {
  const asks: KitAsk[] = [];
  const ops = [...spec.patterns.map((p) => patternOp(p, read)), ...spec.curtain_walls.map((c) => curtainOp(c, read, asks)), ...spec.railings.map((r) => railingOp(r, read, asks))];
  const counts = { create: 0, update: 0, unchanged: 0, blocked: 0 } as Record<OpAction, number>;
  for (const o of ops) counts[o.action]++;
  const seen = new Set<string>();
  return { ops, kit_requests: asks.filter((a) => !seen.has(a.item) && seen.add(a.item)), counts };
}

/** The add-in's payload: only what changes. */
export function applyPayload(ops: Op[], dry: boolean) {
  const of = (k: Op["kind"]) => ops.filter((o) => o.kind === k && (o.action === "create" || o.action === "update")).map((o) => o.payload!);
  return { dry_run: dry, patterns: of("pattern"), curtain_walls: of("curtain_wall"), railings: of("railing") };
}

/** The legend: an fmc_legend place call for the curtain wall types in the model; the rest listed for a person. */
export function legendPlan(spec: AssembliesSpec, read: ModelRead) {
  if (!spec.legend) return { problem: "The designs name no legend view (legend: {view, columns?})" };
  const types = spec.curtain_walls.map((c) => read.curtain_types.find((t) => lc(t.name) === lc(c.name))).filter((t): t is ModelRead["curtain_types"][number] => !!t);
  const missing = spec.curtain_walls.filter((c) => !read.curtain_types.some((t) => lc(t.name) === lc(c.name))).map((c) => c.name);
  const viewExists = read.legend_views.some((v) => lc(v) === lc(spec.legend!.view));
  return {
    view: spec.legend.view, view_exists: viewExists,
    ...(viewExists ? {} : { first: { tool: "fmc_legend", args: { action: "create_view", name: spec.legend.view, dry_run: true } } }),
    place: { tool: "fmc_legend", args: { action: "place", view: spec.legend.view, types: types.map((t) => ({ id: t.id, category: "wall" })), columns: spec.legend.columns ?? 1, dry_run: true } },
    not_in_model_yet: missing,
    not_placed: [...spec.railings.map((r) => `${r.name} (railing: fmc_legend places doors, windows, walls, floors, roofs and ceilings)`),
      ...spec.patterns.map((p) => `${p.name} (${p.target} pattern: shown by a filled region or a material, not a legend component)`)],
  };
}
