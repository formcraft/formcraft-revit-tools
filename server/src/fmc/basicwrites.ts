/**
 * Dry runs for the inherited create_grid, create_level and create_dimensions tools. The plan is built here from the
 * call and a read of the model (ai_element_filter, get_current_view_info), so it needs no add-in change and opens no
 * transaction. The grid labels follow CreateGridEventHandler.GenerateLabels exactly.
 */

/** Rows from a Revit reply: the array under Response/response/data/elements, or the reply itself. */
export function rowsOf(reply: unknown): Array<Record<string, unknown>> {
  const pick = (v: unknown): unknown[] | null => Array.isArray(v) ? v : null;
  const r = reply as Record<string, unknown> | null;
  const list = pick(reply) ?? pick(r?.Response) ?? pick(r?.response) ?? pick(r?.data) ?? pick(r?.elements)
    ?? pick((r?.Response as Record<string, unknown> | undefined)?.elements) ?? pick((r?.response as Record<string, unknown> | undefined)?.elements) ?? [];
  return list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

function field(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (row[n] !== undefined) return row[n];
  return undefined;
}

export function namesOf(reply: unknown): string[] {
  return rowsOf(reply).map((row) => String(field(row, "name", "Name") ?? "").trim()).filter(Boolean);
}

function alphabetic(start: string, offset: number): string {
  let index = (start.charCodeAt(0) - 65) + offset;
  if (index < 26) return String.fromCharCode(65 + index);
  let out = "";
  while (index >= 0) {
    out = String.fromCharCode(65 + (index % 26)) + out;
    index = Math.floor(index / 26) - 1;
  }
  return out;
}

/** Port of CreateGridEventHandler.GenerateLabels. */
export function gridLabels(count: number, startLabel: string, style: "alphabetic" | "numeric"): string[] {
  const label = startLabel ?? "";
  const out: string[] = [];
  const digits = /^(.*?)(\d+)$/.exec(label);
  if (digits) {
    const n = parseInt(digits[2], 10);
    const width = digits[2].startsWith("0") ? digits[2].length : 1;
    for (let i = 0; i < count; i++) out.push(digits[1] + String(n + i).padStart(width, "0"));
    return out;
  }
  if (style !== "numeric" && label.length > 1 && /\p{L}/u.test(label[label.length - 1])) {
    const prefix = label.slice(0, -1);
    const last = label[label.length - 1].toUpperCase();
    for (let i = 0; i < count; i++) out.push(prefix + alphabetic(last, i));
    return out;
  }
  if (style === "numeric") {
    const parsed = /^[+-]?\d+$/.test(label.trim()) ? parseInt(label, 10) : 1;
    for (let i = 0; i < count; i++) out.push(String(parsed + i));
    return out;
  }
  const first = label.toUpperCase()[0] ?? "A";
  const start = /[A-Z]/.test(first) ? first : "A";
  for (let i = 0; i < count; i++) out.push(alphabetic(start, i));
  return out;
}

export interface GridArgs {
  xCount: number; xSpacing: number; xStartLabel: string; xNamingStyle: "alphabetic" | "numeric";
  yCount: number; ySpacing: number; yStartLabel: string; yNamingStyle: "alphabetic" | "numeric";
  xExtentMin: number; xExtentMax: number; yExtentMin: number; yExtentMax: number;
  elevation: number; xStartPosition: number; yStartPosition: number;
}

export interface GridRow { axis: "X" | "Y"; name: string; position_mm: number; from_mm: { x: number; y: number }; to_mm: { x: number; y: number }; duplicate: boolean }

/** Final names and positions. A name that exists, or repeats in this call, is a duplicate: never renamed (A to A1). */
export function planGrid(args: GridArgs, existing: string[]): { grids: GridRow[]; duplicates: string[] } {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const grids: GridRow[] = [];
  const duplicates: string[] = [];
  const add = (axis: "X" | "Y", name: string, pos: number) => {
    const key = name.toLowerCase();
    const duplicate = taken.has(key) || seen.has(key);
    if (duplicate) duplicates.push(name);
    seen.add(key);
    grids.push(axis === "X"
      ? { axis, name, position_mm: pos, from_mm: { x: pos, y: args.yExtentMin }, to_mm: { x: pos, y: args.yExtentMax }, duplicate }
      : { axis, name, position_mm: pos, from_mm: { x: args.xExtentMin, y: pos }, to_mm: { x: args.xExtentMax, y: pos }, duplicate });
  };
  gridLabels(args.xCount, args.xStartLabel, args.xNamingStyle).forEach((n, i) => add("X", n, args.xStartPosition + i * args.xSpacing));
  gridLabels(args.yCount, args.yStartLabel, args.yNamingStyle).forEach((n, i) => add("Y", n, args.yStartPosition + i * args.ySpacing));
  return { grids, duplicates: [...new Set(duplicates)] };
}

export interface LevelRow { name: string; elevation: number; createFloorPlan?: boolean; createCeilingPlan?: boolean }

/** Names, elevations, the views a real run makes, and conflicts with the model's levels (same name, or same elevation). */
export function planLevels(data: LevelRow[], existingReply: unknown) {
  const existing = rowsOf(existingReply).map((row) => ({
    name: String(field(row, "name", "Name") ?? ""),
    elevation: Number(field(row, "elevation", "Elevation", "height", "Height")),
  }));
  const levels = data.map((row) => {
    const sameName = existing.find((e) => e.name.toLowerCase() === row.name.trim().toLowerCase());
    const sameElevation = existing.find((e) => Number.isFinite(e.elevation) && Math.abs(e.elevation - row.elevation) < 0.5);
    const views = [row.createFloorPlan !== false ? "floor plan" : "", row.createCeilingPlan !== false ? "ceiling plan" : ""].filter(Boolean);
    const conflict = sameName ? `a level called ${sameName.name} exists` : sameElevation ? `${sameElevation.name} is at the same elevation` : "";
    return { name: row.name, elevation_mm: row.elevation, views, conflict };
  });
  return { levels, conflicts: levels.filter((l) => l.conflict).map((l) => `${l.name}: ${l.conflict}`) };
}

const PLAN_VIEWS = new Set(["FloorPlan", "CeilingPlan", "EngineeringPlan", "AreaPlan"]);

/** The view a dimension with viewId -1 would go into: only an active plan view, named explicitly. */
export function activePlanView(viewReply: unknown): { id: number; name: string; type: string; problem: string | null } {
  const r = (viewReply && typeof viewReply === "object" ? viewReply : {}) as Record<string, unknown>;
  const row = ((r.Response ?? r.response ?? r.data ?? r) as Record<string, unknown>) ?? {};
  const id = Number(field(row, "id", "Id"));
  const name = String(field(row, "name", "Name") ?? "");
  const type = String(field(row, "viewType", "ViewType") ?? "");
  if (!Number.isFinite(id) || id <= 0) return { id: -1, name, type, problem: "The active view could not be read. Pass viewId." };
  if (!PLAN_VIEWS.has(type)) return { id, name, type, problem: `viewId -1 means the active view, and the active view (${name || id}, ${type || "unknown type"}) is not a plan view. Pass viewId.` };
  return { id, name, type, problem: null };
}