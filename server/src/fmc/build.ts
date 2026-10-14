/**
 * Build (U26, boards build/PaneBuild, B_Workspace, B_RevitViews): quantities from the model joined to the kit's codes
 * (FMC_Master_Data.json "codes": description, unit, group, trade package). The quantity follows the code's unit (m2:
 * area, m3: volume, m: length, nr: count); units the model can't measure (t, kg, sum) are left for the QS, never
 * guessed. Rates are never returned: they are the QS's, behind the rates permission.
 */
export interface KitCode { description: string; group: string; unit: string; trade_package: string; measurement_rule?: string }
export interface CodeSum { count: number; area_m2: number; volume_m3: number; length_m: number; category: string }

export interface BoqItem {
  code: string; description: string; unit: string; group: string; package: string; category: string;
  count: number; qty: number | null; why_no_qty?: string; previous?: number | null; changed?: boolean;
}

export function kitCodes(master: unknown): Record<string, KitCode> {
  const codes = (master as { codes?: Record<string, any> })?.codes ?? {};
  return Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, { description: String(v?.description ?? ""), group: String(v?.group ?? ""),
    unit: String(v?.unit ?? ""), trade_package: String(v?.trade_package ?? ""), measurement_rule: String(v?.measurement_rule ?? "") }]));
}

export function quantityFor(unit: string, s: CodeSum): { qty: number | null; why?: string } {
  const u = unit.toLowerCase().replace(/[²³]/g, (m) => (m === "²" ? "2" : "3"));
  if (u === "m2") return { qty: round(s.area_m2) };
  if (u === "m3") return { qty: round(s.volume_m3, 3) };
  if (u === "m") return { qty: round(s.length_m) };
  if (u === "nr" || u === "no" || u === "item" || u === "ea") return { qty: s.count };
  return { qty: null, why: `${unit || "no unit"}: not measured from the model (the QS measures it)` };
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** A change of more than half a percent (or any change in a count) is flagged for the QS. */
export function moved(prev: number | null | undefined, now: number | null): boolean {
  if (prev === undefined) return true; // new since the baseline
  if (prev === null || now === null) return prev !== now;
  return Math.abs(now - prev) > Math.max(0.005 * Math.abs(prev), 1e-9);
}

export function boq(facts: any, codes: Record<string, KitCode>, baseline: Record<string, number | null> | null) {
  const items: BoqItem[] = [];
  const unknown: Array<{ code: string; count: number; category: string }> = [];
  for (const [code, s] of Object.entries((facts?.codes ?? {}) as Record<string, CodeSum>)) {
    const k = codes[code];
    if (!k) { unknown.push({ code, count: s.count, category: s.category }); continue; }
    const q = quantityFor(k.unit, s);
    const item: BoqItem = { code, description: k.description, unit: k.unit, group: k.group, package: k.trade_package, category: s.category, count: s.count, qty: q.qty };
    if (q.why) item.why_no_qty = q.why;
    if (baseline) { item.previous = baseline[code] ?? undefined; item.changed = moved(baseline[code], q.qty); }
    items.push(item);
  }
  if (baseline) for (const code of Object.keys(baseline).filter((c) => !items.some((i) => i.code === c) && codes[c]))
    items.push({ code, description: codes[code].description, unit: codes[code].unit, group: codes[code].group, package: codes[code].trade_package, category: "",
      count: 0, qty: 0, previous: baseline[code], changed: true });
  items.sort((a, b) => a.code.localeCompare(b.code));
  const bills = [...new Set(items.map((i) => i.group))].map((g) => {
    const its = items.filter((i) => i.group === g);
    return { bill: g, package: its[0]?.package ?? "", items: its.length, changed: its.filter((i) => i.changed).length, unmeasured: its.filter((i) => i.qty === null).length };
  });
  const unmapped = Object.entries((facts?.unmapped ?? {}) as Record<string, number>).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
  return { items, bills, unknown, unmapped, measured: items.filter((i) => i.qty !== null).length, unmeasured: items.filter((i) => i.qty === null).length,
    changed: items.filter((i) => i.changed).length };
}

export function baselineOf(items: BoqItem[]): Record<string, number | null> {
  return Object.fromEntries(items.filter((i) => i.count > 0).map((i) => [i.code, i.qty]));
}

/** Status counts in a fixed order for the legend: known words first, then the rest as found. */
export function statusLegend(status: Record<string, number>) {
  const order = ["Done", "Complete", "Completed", "In progress", "Late", "Delayed", "Not started", "(none)"];
  return Object.entries(status ?? {}).sort((a, b) => {
    const ia = order.findIndex((o) => o.toLowerCase() === a[0].toLowerCase()), ib = order.findIndex((o) => o.toLowerCase() === b[0].toLowerCase());
    return (ia < 0 ? 50 : ia) - (ib < 0 ? 50 : ib) || b[1] - a[1];
  }).map(([value, count]) => ({ value, count }));
}
