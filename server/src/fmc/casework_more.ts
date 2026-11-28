/**
 * options and bulk: read-only actions that lay out more than one run. Part of the fmc_casework tool.
 *
 *   options  three layouts of one run (A largest units, B even widths, C more drawers / narrow doors), each saved
 *            under <run_id>-A/-B/-C so the chosen one can be packed or placed with run_id; the choice is the person's.
 *   bulk     many rooms (read from Revit, read only) and/or runs given with labels: each saved under its own run id,
 *            with a summary where the widths are known, and the totals. Nothing is written to the model or the pack.
 */
import { Run, Standards, layoutAny, summaryOf } from "./casework.js";
import { newRunId } from "./casework_run.js";
import { saveRun } from "./casework_store.js";
import { runFromRoom } from "./casework_place.js";
import { Ctx, Prepared, Reply, costOf, prepare, readRoom } from "./casework_tool.js";
import type { FmcCaseworkArgs } from "./casework_shape.js";

const BULK_MAX = 50;
type Score = ReturnType<typeof scoreOf>;

function scoreOf(p: Prepared) {
  const s = summaryOf(p.casework);
  const cost = costOf(p).total;
  return { units: s.units, fillers: s.fillers.length, filler_mm: s.fillers.reduce((a, f) => a + f.width, 0), sheets: s.sheets,
    yield_pct: s.boards.map((b) => `${b.material} ${b.yield_pct}%`), edge_m: s.edge_m, worktop_m: s.worktop_m,
    drawers: p.casework.layout.units.filter((u) => /drawer$/.test(u.fronts)).length, cost_ugx: cost.priced ? [cost.ugx_low, cost.ugx_high] : null,
    prices_needed: cost.price_needed, units_hash: p.units_hash, problems: p.casework.problems };
}

/** B: the one module width that leaves the least filler (ties: the wider). */
function evenRun(run: Run, s: Standards): { run: Run; why: string } {
  const filler = (m: number) => layoutAny({ ...run, modules: [m] }, s).fillers.filter((f) => f.layer === "base").reduce((a, f) => a + f.width, 0);
  const best = [...new Set(run.modules)].map((m) => ({ m, f: filler(m) })).sort((a, b) => a.f - b.f || b.m - a.m)[0];
  return { run: { ...run, modules: [best.m], ...(run.wall_modules?.length ? { wall_modules: [best.m] } : {}) },
    why: `every unit ${best.m} wide (the width of ${run.modules.join(", ")} that leaves the least filler, ${best.f} mm)` };
}

/** C: drawers in the narrow base and vanity units (the kit's largest drawer set), or for wardrobes the narrow doors. */
function storageRun(run: Run, s: Standards): { run: Run; why: string } {
  if (run.kind === "wardrobe") {
    const narrow = run.modules.filter((m) => m <= 600);
    const mods = narrow.length ? narrow : [Math.min(...run.modules)];
    return { run: { ...run, modules: mods }, why: `narrow doors: only the widths ${mods.join(", ")}` };
  }
  const sets = Object.keys(s.construction.drawer.heights ?? {}).map(Number).filter((n) => n >= 1 && n <= 6).sort((a, b) => b - a);
  if (!sets.length) return { run, why: "the same as A: the kit's standards have no drawer heights" };
  const n = sets[0];
  const fronts = { ...(run.fronts ?? {}) };
  for (const u of layoutAny(run, s).units)
    if ((u.kind === "base" || u.kind === "vanity") && u.width <= 600 && !run.fronts?.[u.mark]) fronts[u.mark] = `${n}drawer`;
  return { run: { ...run, fronts }, why: `${n}-drawer fronts in the base units up to 600 wide (the kit's largest drawer set)` };
}

export async function optionsAction(ctx: Ctx, base: Prepared): Promise<Reply> {
  const { args, config, reply, run_id } = ctx;
  const run = args.run as Run | undefined;
  if (!run) return reply({ refused: true, reasons: ["options lay out a run three ways: give a run (or the run_id of one), not a unit list"] }, true);
  const s = base.standards;
  const variants: Array<{ name: string; title: string; run: Run; why: string }> = [
    { name: "A", title: "Largest units", run, why: `the largest of ${run.modules.join(", ")} that fits, again and again` },
    { name: "B", title: "Even widths", ...evenRun(run, s) },
    { name: "C", title: run.kind === "wardrobe" ? "Narrow doors" : "More drawers", ...storageRun(run, s) },
  ];
  const options: Array<{ option: string; run_id: string; title: string; how: string; saved: boolean } & Score> = [];
  for (const v of variants) {
    const p = v.name === "A" ? { ok: base } : prepare({ ...args, run: v.run as FmcCaseworkArgs["run"] }, config);
    if (!("ok" in p)) return reply(p.refused, true);
    const id = `${run_id}-${v.name}`;
    const saved = saveRun({ id, at: new Date().toISOString(), action: "options", run: v.run, standards: args.standards,
      room_read: ctx.entry.room_read, option: { of: run_id, name: v.name } }, ctx.store);
    options.push({ option: v.name, run_id: id, title: v.title, how: v.why, saved, ...scoreOf(p.ok) });
  }
  const least = (k: "sheets" | "filler_mm" | "units") => options.filter((o) => o[k] === Math.min(...options.map((x) => x[k]))).map((o) => o.option).join(", ");
  return reply({ standards_from: base.from, options,
    compare: { fewest_sheets: least("sheets"), least_filler: least("filler_mm"), fewest_units: least("units") },
    next: "Show the person the three; the choice is theirs. Then call units, summary, pack or place with that option's run_id" });
}

async function bulkItem(ctx: Ctx, from: { room?: string; label?: string; run?: Run }) {
  const { args, config, send } = ctx;
  const id = newRunId();
  let run = from.run;
  let room_read;
  if (from.room) {
    const read = await readRoom(send, from.room);
    run = { ...(args.run_kind ? { kind: args.run_kind } : {}), walls: runFromRoom(read).walls, modules: [] };
    room_read = { room: from.room, at: new Date().toISOString(), read };
  }
  if (args.modules?.length && run) run = { ...run, modules: args.modules };
  const saved = saveRun({ id, at: new Date().toISOString(), action: "bulk", run, standards: args.standards, room_read }, ctx.store);
  const head = { ...(from.room ? { room: from.room } : { label: from.label }), run_id: id, saved, walls: run?.walls.length ?? 0 };
  if (!run?.modules?.length) return { ...head, next: `Give modules (here or with run_id "${id}") to lay it out` };
  const p = prepare({ ...args, run: run as FmcCaseworkArgs["run"], units: undefined }, config);
  if (!("ok" in p)) return { ...head, refused: p.refused };
  return { ...head, ...scoreOf(p.ok) };
}

export async function bulkAction(ctx: Ctx): Promise<Reply> {
  const { args, reply } = ctx;
  const rooms = (args.rooms ?? []).map((r) => r.trim()).filter(Boolean);
  const runs = args.runs ?? [];
  if (!rooms.length && !runs.length) return reply({ refused: true, reasons: ["Name the rooms (numbers or names in the active model) and/or give runs with labels"] }, true);
  if (rooms.length + runs.length > BULK_MAX) return reply({ refused: true, reasons: [`At most ${BULK_MAX} rooms and runs in one call (${rooms.length + runs.length} given)`] }, true);
  const items: Array<Record<string, unknown>> = [];
  for (const room of rooms) {
    try { items.push(await bulkItem(ctx, { room })); } catch (e) { items.push({ room, error: e instanceof Error ? e.message : String(e) }); }
  }
  for (const r of runs) items.push(await bulkItem(ctx, { label: r.label, run: r.run as Run }));
  const laid = items.filter((i) => typeof i.sheets === "number") as unknown as Score[];
  const sum = (k: "units" | "sheets" | "edge_m" | "worktop_m") => Math.round(laid.reduce((a, x) => a + (x[k] as number), 0) * 10) / 10;
  const priced = laid.filter((x) => x.cost_ugx);
  return reply({ items, totals: { laid_out: laid.length, of: items.length, units: sum("units"), sheets: sum("sheets"), edge_m: sum("edge_m"), worktop_m: sum("worktop_m"),
    cost_ugx: priced.length ? [priced.reduce((a, x) => a + x.cost_ugx![0], 0), priced.reduce((a, x) => a + x.cost_ugx![1], 0)] : null,
    ...(priced.length < laid.length ? { cost_note: `${laid.length - priced.length} of ${laid.length} have no priced lines` } : {}) },
    next: "Read only: nothing was written. Each item's run_id carries on to units, summary, check, pack or place for that room" });
}
