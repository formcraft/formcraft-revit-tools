/**
 * Dry runs, project-base-point placement, duplicate errors and per-item results for the inherited grid, level,
 * dimension and point-placement tools (tool research 3, 4, 5 and 7: create_dimensions, create_grid, create_level,
 * create_point_based_element). A dry run reads the model once (fmc_datum_read, no transaction) and plans here; nothing
 * is written. A write sends internal coordinates to the same add-in command it always did.
 *
 * Grid labels, duplicate names and blank tag text have a C# twin in commandset/Services/Fmc/FmcPlacementCore.cs; both
 * run server/src/fmc/fixtures/placement_cases.json.
 */

export type RelativeTo = "project_base_point" | "internal_origin";
export type OnDuplicate = "error" | "rename" | "reuse";

export interface Xyz { x: number; y: number; z: number }

export interface DatumSnapshot {
  title?: string;
  /** Internal coordinates (mm) of the project base point and the survey point. */
  base_point?: Xyz;
  survey_point?: Xyz;
  grids?: Array<{ id: string; name: string }>;
  levels?: Array<{ id: string; name: string; elevation_mm: number }>;
  views?: Array<{ id: string; name: string; view_type: string; can_dimension: boolean }>;
  instances?: Array<{ id: string; type_id: string; x: number; y: number; z: number }>;
}

export const DATUM_FIX: Record<string, string> = {
  "FMC-DATUM-READ": "The model read for the dry run failed. Nothing was written.",
  "FMC-DATUM-NO-BASE-POINT": "The model did not report its project base point. Use relative_to internal_origin, or check the model.",
  "FMC-DATUM-BLOCKED": "At least one item has an error. Nothing was written: fix the items, or drop them, and run again.",
  "FMC-GRID-DUPLICATE": "A grid with this name exists, or the name is repeated in the request. Grids are not renamed silently: pick other labels, or pass on_duplicate rename.",
  "FMC-GRID-TOO-MANY": "More grid lines than one call allows. Split the call.",
  "FMC-LEVEL-DUPLICATE": "A level with this name exists, or the name is repeated in the request. Pick another name, or pass on_duplicate reuse to keep the existing level.",
  "FMC-LEVEL-SAME-ELEVATION": "A level already sits at this elevation (within 1 mm). Two levels at one height are not created.",
  "FMC-LEVEL-TOO-MANY": "More levels than one call allows. Split the call.",
  "FMC-DIM-VIEW-REQUIRED": "Name the view (viewId). The active view is not a guess.",
  "FMC-DIM-VIEW": "That view is not in the model.",
  "FMC-DIM-VIEW-TYPE": "Dimensions cannot be drawn in that view (a 3D view, schedule or sheet). Use a plan, section, elevation, detail or drafting view.",
  "FMC-DIM-ZERO": "The start and end points are the same. A dimension line needs length.",
  "FMC-DIM-REFS": "Give two or more elementIds, or none (then the points pick the references).",
  "FMC-DIM-DUPLICATE": "The same dimension (view, elements and points) is listed twice. It is made once.",
  "FMC-DIM-TOO-MANY": "More dimensions than one call allows. Split the call.",
  "FMC-PLACE-DUPLICATE": "An instance of this type already stands at this point (within 10 mm), or the request repeats it. Nothing is placed on top of it.",
  "FMC-PLACE-TOO-MANY": "More elements than one call allows. Split the call.",
};

export const LIMITS = { grids: 200, levels: 100, dimensions: 50, points: 200 };
const LEVEL_TOLERANCE_MM = 1;
const POINT_TOLERANCE_MM = 10;

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Internal coordinates (mm) of the origin the caller's numbers are measured from. */
export function originOf(snapshot: DatumSnapshot | null | undefined, relativeTo: RelativeTo): Xyz | null {
  if (relativeTo === "internal_origin") return { x: 0, y: 0, z: 0 };
  const bp = snapshot?.base_point;
  if (!bp || ![bp.x, bp.y, bp.z].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { x: bp.x, y: bp.y, z: bp.z };
}

/**
 * Model point from a point measured from the project base point. Project coordinates share the internal axes (the
 * angle to true north rotates shared coordinates, not these), so the move is a translation.
 */
export function toInternal(point: Xyz, origin: Xyz): Xyz {
  return { x: r1(point.x + origin.x), y: r1(point.y + origin.y), z: r1(point.z + origin.z) };
}

/** C# twin: FmcPlacementCore.AlphabeticLabel. */
export function alphabeticLabel(start: string, offset: number): string {
  let index = (start.charCodeAt(0) - 65) + offset;
  if (index < 26) return String.fromCharCode(65 + index);
  let out = "";
  while (index >= 0) {
    out = String.fromCharCode(65 + (index % 26)) + out;
    index = Math.floor(index / 26) - 1;
  }
  return out;
}

const isLetter = (ch: string) => /\p{L}/u.test(ch);

/** C# twin: FmcPlacementCore.GridLabels. */
export function gridLabels(count: number, startLabel: string, style: string): string[] {
  const start = startLabel ?? "";
  const labels: string[] = [];
  const m = /^(.*?)(\d+)$/.exec(start);
  if (m) {
    const n = parseInt(m[2], 10);
    const width = m[2].startsWith("0") ? m[2].length : 1;
    for (let i = 0; i < count; i++) labels.push(m[1] + String(n + i).padStart(width, "0"));
    return labels;
  }
  if (style !== "numeric" && start.length > 1 && isLetter(start[start.length - 1])) {
    const prefix = start.slice(0, -1);
    const last = start[start.length - 1].toUpperCase();
    for (let i = 0; i < count; i++) labels.push(prefix + alphabeticLabel(last, i));
    return labels;
  }
  if (style === "numeric") {
    const parsed = /^[+-]?\d+$/.test(start.trim()) ? parseInt(start, 10) : 1;
    for (let i = 0; i < count; i++) labels.push(String(parsed + i));
    return labels;
  }
  let first = start.toUpperCase()[0] ?? "A";
  if (!isLetter(first)) first = "A";
  for (let i = 0; i < count; i++) labels.push(alphabeticLabel(first, i));
  return labels;
}

/** C# twin: FmcPlacementCore.UniqueName. */
export function uniqueName(base: string, existing: Set<string>): string {
  let candidate = base;
  let counter = 1;
  while (existing.has(candidate)) candidate = `${base}${counter++}`;
  return candidate;
}

/** C# twin: FmcPlacementCore.Duplicates. Case-insensitive; empty names are not checked. */
export function duplicates(requested: string[], existing: string[]): Array<[number, "exists" | "repeated"]> {
  const have = new Set(existing.map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  const out: Array<[number, "exists" | "repeated"]> = [];
  requested.forEach((raw, i) => {
    const name = (raw ?? "").trim().toLowerCase();
    if (!name) return;
    if (have.has(name)) out.push([i, "exists"]);
    else if (seen.has(name)) out.push([i, "repeated"]);
    else seen.add(name);
  });
  return out;
}

export interface DatumItem {
  index: number;
  status: "would_create" | "would_rename" | "would_reuse" | "error";
  code?: string;
  reason?: string;
  [key: string]: unknown;
}

function bad(index: number, code: string, extra: Record<string, unknown> = {}): DatumItem {
  return { index, status: "error", code, reason: DATUM_FIX[code], ...extra };
}

export interface GridArgs {
  xCount: number; xSpacing: number; xStartLabel: string; xNamingStyle: string;
  yCount: number; ySpacing: number; yStartLabel: string; yNamingStyle: string;
  xExtentMin: number; xExtentMax: number; yExtentMin: number; yExtentMax: number;
  elevation: number; xStartPosition: number; yStartPosition: number;
}

export function planGrids(args: GridArgs, snapshot: DatumSnapshot, origin: Xyz, onDuplicate: OnDuplicate) {
  const items: DatumItem[] = [];
  const xs = gridLabels(args.xCount, args.xStartLabel, args.xNamingStyle);
  const ys = gridLabels(args.yCount, args.yStartLabel, args.yNamingStyle);
  const names = [...xs, ...ys];
  const existing = (snapshot.grids ?? []).map((grid) => grid.name);
  const clash = new Map(duplicates(names, existing));
  const taken = new Set(existing);
  const tooMany = names.length > LIMITS.grids;
  names.forEach((name, i) => {
    const axis = i < xs.length ? "X" : "Y";
    const k = axis === "X" ? i : i - xs.length;
    const position = axis === "X" ? args.xStartPosition + k * args.xSpacing : args.yStartPosition + k * args.ySpacing;
    const internal = r1(position + (axis === "X" ? origin.x : origin.y));
    const base = { axis, name, position_mm: r1(position), position_internal_mm: internal };
    if (tooMany) { items.push(bad(i, "FMC-GRID-TOO-MANY", base)); return; }
    const why = clash.get(i);
    if (why && onDuplicate !== "rename") { items.push(bad(i, "FMC-GRID-DUPLICATE", { ...base, clash: why })); return; }
    const finalName = why ? uniqueName(name, taken) : name;
    taken.add(finalName);
    items.push({ index: i, status: why ? "would_rename" : "would_create", ...base, name: finalName, requested_name: name });
  });
  const params = {
    ...args,
    xStartPosition: r1(args.xStartPosition + origin.x),
    yStartPosition: r1(args.yStartPosition + origin.y),
    xExtentMin: r1(args.xExtentMin + origin.x),
    xExtentMax: r1(args.xExtentMax + origin.x),
    yExtentMin: r1(args.yExtentMin + origin.y),
    yExtentMax: r1(args.yExtentMax + origin.y),
    elevation: r1(args.elevation + origin.z),
    onDuplicate: onDuplicate === "rename" ? "rename" : "error",
  };
  return { items, params, errors: items.filter((row) => row.status === "error").length };
}

export interface LevelArgs { name: string; elevation: number; [key: string]: unknown }

export function planLevels(levels: LevelArgs[], snapshot: DatumSnapshot, origin: Xyz, onDuplicate: OnDuplicate) {
  const existing = snapshot.levels ?? [];
  const clash = new Map(duplicates(levels.map((row) => row.name), existing.map((row) => row.name)));
  const tooMany = levels.length > LIMITS.levels;
  const items: DatumItem[] = [];
  const data: Array<Record<string, unknown>> = [];
  levels.forEach((level, i) => {
    const internal = r1(level.elevation + origin.z);
    const base = { name: level.name, elevation_mm: r1(level.elevation), elevation_internal_mm: internal };
    if (tooMany) { items.push(bad(i, "FMC-LEVEL-TOO-MANY", base)); return; }
    const why = clash.get(i);
    const same = existing.find((row) => row.name.toLowerCase() === (level.name ?? "").trim().toLowerCase());
    if (why === "exists" && onDuplicate === "reuse") {
      items.push({ index: i, status: "would_reuse", ...base, existing_id: same?.id, existing_elevation_internal_mm: same?.elevation_mm });
      data.push({ ...level, elevation: internal });
      return;
    }
    if (why) { items.push(bad(i, "FMC-LEVEL-DUPLICATE", { ...base, clash: why, existing_elevation_internal_mm: same?.elevation_mm })); return; }
    const level2 = existing.find((row) => Math.abs(row.elevation_mm - internal) <= LEVEL_TOLERANCE_MM);
    const earlier = levels.slice(0, i).findIndex((row) => Math.abs(r1(row.elevation + origin.z) - internal) <= LEVEL_TOLERANCE_MM);
    if (level2 || earlier >= 0) {
      items.push(bad(i, "FMC-LEVEL-SAME-ELEVATION", { ...base, at: level2 ? level2.name : levels[earlier].name }));
      return;
    }
    items.push({ index: i, status: "would_create", ...base });
    data.push({ ...level, elevation: internal });
  });
  return { items, data, onDuplicate: onDuplicate === "reuse" ? "reuse" : "error", errors: items.filter((row) => row.status === "error").length };
}

export interface DimArgs {
  startPoint: Xyz; endPoint: Xyz; linePoint?: Xyz;
  elementIds?: number[]; dimensionType?: string; dimensionStyleId?: number; viewId?: number;
}

export function planDimensions(dims: DimArgs[], snapshot: DatumSnapshot, origin: Xyz) {
  const views = new Map((snapshot.views ?? []).map((view) => [String(view.id), view]));
  const seen = new Map<string, number>();
  const tooMany = dims.length > LIMITS.dimensions;
  const items: DatumItem[] = [];
  const out: DimArgs[] = [];
  dims.forEach((dim, i) => {
    const viewId = dim.viewId ?? -1;
    const base = { view_id: String(viewId), element_ids: dim.elementIds ?? [] };
    if (tooMany) { items.push(bad(i, "FMC-DIM-TOO-MANY", base)); return; }
    if (!(viewId > 0)) { items.push(bad(i, "FMC-DIM-VIEW-REQUIRED", base)); return; }
    const view = views.get(String(viewId));
    if (!view) { items.push(bad(i, "FMC-DIM-VIEW", base)); return; }
    if (!view.can_dimension) { items.push(bad(i, "FMC-DIM-VIEW-TYPE", { ...base, view: view.name, view_type: view.view_type })); return; }
    const a = dim.startPoint;
    const b = dim.endPoint;
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (length < 1) { items.push(bad(i, "FMC-DIM-ZERO", base)); return; }
    if ((dim.elementIds ?? []).length === 1) { items.push(bad(i, "FMC-DIM-REFS", base)); return; }
    const key = [viewId, [...(dim.elementIds ?? [])].sort((p, q) => p - q).join(","), r1(a.x), r1(a.y), r1(a.z), r1(b.x), r1(b.y), r1(b.z)].join("|");
    if (seen.has(key)) { items.push(bad(i, "FMC-DIM-DUPLICATE", { ...base, same_as: seen.get(key) })); return; }
    seen.set(key, i);
    const moved: DimArgs = {
      ...dim,
      startPoint: toInternal(a, origin),
      endPoint: toInternal(b, origin),
      ...(dim.linePoint ? { linePoint: toInternal(dim.linePoint, origin) } : {}),
    };
    items.push({ index: i, status: "would_create", ...base, view: view.name, length_mm: r1(length), by: (dim.elementIds ?? []).length ? "elements" : "points" });
    out.push(moved);
  });
  return { items, dimensions: out, errors: items.filter((row) => row.status === "error").length };
}

export interface PointArgs { typeId?: number; locationPoint: Xyz; baseLevel: number; [key: string]: unknown }

export function planPoints(data: PointArgs[], snapshot: DatumSnapshot, origin: Xyz) {
  const tooMany = data.length > LIMITS.points;
  const items: DatumItem[] = [];
  const out: PointArgs[] = [];
  const planned: Array<{ type: string; p: Xyz; index: number }> = [];
  data.forEach((row, i) => {
    const p = toInternal(row.locationPoint, origin);
    const type = String(row.typeId ?? "");
    const base = { type_id: type, location_mm: row.locationPoint, location_internal_mm: p };
    if (tooMany) { items.push(bad(i, "FMC-PLACE-TOO-MANY", base)); return; }
    const near = (q: Xyz) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) <= POINT_TOLERANCE_MM;
    const standing = (snapshot.instances ?? []).find((inst) => inst.type_id === type && near(inst));
    if (standing) { items.push(bad(i, "FMC-PLACE-DUPLICATE", { ...base, existing_id: standing.id })); return; }
    const twin = planned.find((other) => other.type === type && near(other.p));
    if (twin) { items.push(bad(i, "FMC-PLACE-DUPLICATE", { ...base, same_as: twin.index })); return; }
    planned.push({ type, p, index: i });
    items.push({ index: i, status: "would_create", ...base });
    out.push({ ...row, locationPoint: p, baseLevel: r1(row.baseLevel + origin.z) });
  });
  return { items, data: out, errors: items.filter((row) => row.status === "error").length };
}

/**
 * One row per input after a write. The add-in answers items (index into what it was sent). Inputs the plan refused
 * keep their plan row; inputs the add-in did not report are status unknown, never assumed created.
 */
export function mergeResults(plan: DatumItem[], sent: number[], response: unknown): Array<Record<string, unknown>> {
  const body = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const rows = Array.isArray(body.Items) ? body.Items as Array<Record<string, unknown>>
    : Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : null;
  return plan.map((item) => {
    if (item.status === "error") return { ...item };
    const at = sent.indexOf(item.index);
    const row = rows?.find((r) => Number(r.index) === at);
    if (!row) return { ...item, status: "unknown", reason: "The add-in did not report this item. Check the model before running again." };
    const { index: _drop, ...rest } = row;
    return { ...item, ...rest, index: item.index };
  });
}

export function summarize(items: Array<Record<string, unknown>>) {
  const count = (status: string) => items.filter((row) => row.status === status).length;
  return { total: items.length, created: count("created"), reused: count("reused"), failed: count("failed") + count("error"), unknown: count("unknown") };
}
