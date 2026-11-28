/**
 * Renumbering doors, windows, rooms, sheets, views (viewport detail numbers) and grids by rule.
 *
 * Pure logic: a snapshot read from Revit in, a plan out. Nothing here touches Revit or the disk.
 * Every item in the snapshot gets one row: rename, unchanged, skipped (with a reason) or error.
 * A duplicate resulting number is an error on every item that carries it, and the plan cannot be written.
 *
 * Kit values: the kit and the repo carry no door, window, room, sheet, view or grid numbering table yet
 * (CLAUDE.md rule 7: kit data comes from the kit, a missing value is a kit change request). DEFAULT_RULES below are
 * labelled defaults that need confirmation. The tool takes `rules` to override any of them per call.
 */

export type NumberingCategory = "Doors" | "Windows" | "Rooms" | "Sheets" | "Views" | "Grids";
export const NUMBERING_CATEGORIES: NumberingCategory[] = ["Doors", "Windows", "Rooms", "Sheets", "Views", "Grids"];

/** What each category renumbers in Revit. */
export const NUMBERING_TARGETS: Record<NumberingCategory, string> = {
  Doors: "Mark (instance)",
  Windows: "Mark (instance)",
  Rooms: "Room Number",
  Sheets: "Sheet Number",
  Views: "Detail Number of the viewport on its sheet (numbers restart on each sheet)",
  Grids: "Grid Name (vertical grids numeric, horizontal grids alphabetic)",
};

export type NumberingOrder = "x_then_y" | "y_then_x" | "current";

export interface NumberingRule {
  /** Kit prefix, e.g. "D". Empty means no prefix. */
  prefix: string;
  /** Between prefix and number. Used only when prefix is not empty. */
  separator: string;
  start: number;
  step: number;
  /** Zero pads the number to this many digits. 0 means no padding. */
  width: number;
  order: NumberingOrder;
  /** Each level starts this far apart (rooms 100 gives 1.., 101.., 201..). 0 means one run across levels. */
  level_block: number;
  /** Grids only. Letters never used in an alphabetic run. */
  alpha_skip: string;
}

export const DEFAULT_RULES: Record<NumberingCategory, NumberingRule> = {
  Doors: { prefix: "D", separator: "-", start: 1, step: 1, width: 2, order: "x_then_y", level_block: 0, alpha_skip: "" },
  Windows: { prefix: "W", separator: "-", start: 1, step: 1, width: 2, order: "x_then_y", level_block: 0, alpha_skip: "" },
  Rooms: { prefix: "", separator: "", start: 1, step: 1, width: 3, order: "x_then_y", level_block: 0, alpha_skip: "" },
  Sheets: { prefix: "A", separator: "-", start: 1, step: 1, width: 4, order: "current", level_block: 0, alpha_skip: "" },
  Views: { prefix: "", separator: "", start: 1, step: 1, width: 0, order: "current", level_block: 0, alpha_skip: "" },
  Grids: { prefix: "", separator: "", start: 1, step: 1, width: 0, order: "current", level_block: 0, alpha_skip: "IO" },
};

/** Every value above is a default, not a kit value. Listed for reports. */
export const DEFAULTS_NEED_CONFIRMATION =
  "Prefixes D (doors), W (windows), A (sheets), none for rooms, views and grids; separator '-'; widths 2/2/3/4/0/0; start 1, step 1; " +
  "order by level then x then y; sheets keep their current order; grid letters skip I and O; no level blocks. The kit has no numbering table.";

export const NUMBERING_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_numbering needs document, a title or a full path. The active document is not a guess.",
  "FMC-BATCH-LOCKED": "A write needs batch_lease from fmc_batch request.",
  "FMC-NUM-REFERENCES": "A write needs references.kit, references.standards and references.rulebook.",
  "FMC-NUM-DUPLICATE": "Two or more items would carry the same number. Nothing was written. Change the rule or the scope.",
  "FMC-NUM-BAD-RULE": "A numbering rule is not usable.",
  "FMC-NUM-NOTHING": "Nothing to rename: every item already carries its number.",
  "FMC-NUM-SKIPPED": "The item is not eligible for a number.",
};

export interface NumberingItem {
  id: string;
  /** Current value of the numbered property. */
  current?: string;
  level?: string;
  level_elev?: number;
  x?: number;
  y?: number;
  placed?: boolean;
  /** Views: the sheet that holds the viewport. */
  sheet_id?: string;
  sheet_number?: string;
  view_name?: string;
  /** Grids: vertical (runs along y), horizontal (runs along x) or other. */
  direction?: string;
  name?: string;
}

export interface NumberingSnapshot {
  title?: string;
  path?: string;
  is_central?: boolean;
  doors?: NumberingItem[];
  windows?: NumberingItem[];
  rooms?: NumberingItem[];
  sheets?: NumberingItem[];
  /** Viewports placed on sheets. */
  views?: NumberingItem[];
  grids?: NumberingItem[];
  /** Views that are not on a sheet have no detail number to set. */
  views_off_sheet?: NumberingItem[];
}

export type RowStatus = "rename" | "unchanged" | "skipped" | "error";

export interface NumberingRow {
  category: NumberingCategory;
  id: string;
  label: string;
  old: string;
  new: string;
  status: RowStatus;
  code?: string;
  reason?: string;
}

export interface NumberingDuplicate {
  category: NumberingCategory;
  number: string;
  scope: string;
  ids: string[];
}

export interface NumberingPlan {
  categories: NumberingCategory[];
  rules: Record<string, NumberingRule>;
  rows: NumberingRow[];
  duplicates: NumberingDuplicate[];
  counts: { total: number; rename: number; unchanged: number; skipped: number; error: number };
  by_category: Record<string, { total: number; rename: number; unchanged: number; skipped: number; error: number }>;
  can_write: boolean;
}

export interface NumberingOptions {
  categories?: string[];
  rules?: Partial<Record<NumberingCategory, Partial<NumberingRule>>>;
  /** Doors, windows and rooms on other levels are left as they are (their numbers still count for duplicates). */
  levels?: string[];
}

const BAD_NAME_CHARS = /[\\:{}\[\]|;<>?`~]/;

export function resolveRules(overrides: NumberingOptions["rules"], categories: NumberingCategory[]): Record<string, NumberingRule> {
  const out: Record<string, NumberingRule> = {};
  for (const category of categories) {
    const o = (overrides?.[category] ?? {}) as Partial<NumberingRule>;
    const rule: NumberingRule = { ...DEFAULT_RULES[category], ...stripUndefined(o) };
    rule.prefix = String(rule.prefix ?? "").trim();
    rule.separator = String(rule.separator ?? "");
    rule.alpha_skip = String(rule.alpha_skip ?? "").toUpperCase();
    const problem = ruleProblem(category, rule);
    if (problem) throw new Error(`[FMC-NUM-BAD-RULE] ${category}: ${problem}`);
    out[category] = rule;
  }
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function ruleProblem(category: string, rule: NumberingRule): string | null {
  if (!Number.isInteger(rule.start) || rule.start < 0) return "start must be a whole number, 0 or more.";
  if (!Number.isInteger(rule.step) || rule.step < 1) return "step must be a whole number, 1 or more.";
  if (!Number.isInteger(rule.width) || rule.width < 0 || rule.width > 8) return "width must be a whole number from 0 to 8.";
  if (!Number.isInteger(rule.level_block) || rule.level_block < 0) return "level_block must be a whole number, 0 or more.";
  if (!["x_then_y", "y_then_x", "current"].includes(rule.order)) return "order must be x_then_y, y_then_x or current.";
  if (BAD_NAME_CHARS.test(rule.prefix) || BAD_NAME_CHARS.test(rule.separator)) return "prefix and separator may not contain \\ : { } [ ] | ; < > ? ` ~ .";
  if (category === "Grids" && !/^[A-Z]*$/.test(rule.alpha_skip)) return "alpha_skip is letters only.";
  if (category === "Grids" && rule.alpha_skip.length >= 26) return "alpha_skip leaves no letters.";
  return null;
}

/** A, B, ... Z, AA, AB, ... with skipped letters left out. index is 1-based. */
export function alphaLabel(index: number, skip = ""): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter((c) => !skip.includes(c));
  const base = letters.length;
  let n = index;
  let out = "";
  while (n > 0) {
    n -= 1;
    out = letters[n % base] + out;
    n = Math.floor(n / base);
  }
  return out;
}

export function formatNumber(rule: NumberingRule, n: number, alpha = false): string {
  const body = alpha ? alphaLabel(n, rule.alpha_skip) : rule.width > 0 ? String(n).padStart(rule.width, "0") : String(n);
  return rule.prefix ? `${rule.prefix}${rule.separator}${body}` : body;
}

/** Natural order: "A-2" before "A-10". */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

function idCompare(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function byPosition(order: NumberingOrder): (a: NumberingItem, b: NumberingItem) => number {
  return (a, b) => {
    const level = (a.level_elev ?? Number.POSITIVE_INFINITY) - (b.level_elev ?? Number.POSITIVE_INFINITY);
    if (level !== 0 && !Number.isNaN(level)) return level;
    const ax = a.x ?? 0, ay = a.y ?? 0, bx = b.x ?? 0, by = b.y ?? 0;
    const first = order === "y_then_x" ? ay - by : ax - bx;
    if (first !== 0) return first;
    const second = order === "y_then_x" ? ax - bx : ay - by;
    if (second !== 0) return second;
    return idCompare(a.id, b.id);
  };
}

interface Work {
  item: NumberingItem;
  category: NumberingCategory;
  scope: string;
  row: NumberingRow;
  eligible: boolean;
}

function levelKey(item: NumberingItem): string {
  return item.level ?? "";
}

function label(category: NumberingCategory, item: NumberingItem): string {
  switch (category) {
    case "Doors": case "Windows": return `${category === "Doors" ? "Door" : "Window"} ${item.id}${item.level ? ` on ${item.level}` : ""}`;
    case "Rooms": return `Room ${item.name ?? ""} ${item.id}`.replace(/\s+/g, " ").trim();
    case "Sheets": return `Sheet ${item.name ?? ""} ${item.id}`.replace(/\s+/g, " ").trim();
    case "Views": return `View ${item.view_name ?? ""} on sheet ${item.sheet_number ?? item.sheet_id ?? ""} (viewport ${item.id})`.replace(/\s+/g, " ").trim();
    case "Grids": return `Grid ${item.name ?? ""} ${item.id}`.replace(/\s+/g, " ").trim();
  }
}

function itemsOf(snapshot: NumberingSnapshot, category: NumberingCategory): NumberingItem[] {
  switch (category) {
    case "Doors": return snapshot.doors ?? [];
    case "Windows": return snapshot.windows ?? [];
    case "Rooms": return snapshot.rooms ?? [];
    case "Sheets": return snapshot.sheets ?? [];
    case "Views": return [...(snapshot.views ?? []), ...(snapshot.views_off_sheet ?? [])];
    case "Grids": return snapshot.grids ?? [];
  }
}

export function normaliseCategories(requested: string[] | undefined): NumberingCategory[] {
  if (!requested || !requested.length) return [...NUMBERING_CATEGORIES];
  const out: NumberingCategory[] = [];
  for (const raw of requested) {
    const hit = NUMBERING_CATEGORIES.find((c) => c.toLowerCase() === String(raw).trim().toLowerCase());
    if (!hit) throw new Error(`[FMC-NUM-BAD-RULE] Unknown category "${raw}". Use ${NUMBERING_CATEGORIES.join(", ")}.`);
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Plan every category asked for. One row per item in the snapshot. */
export function planNumbering(snapshot: NumberingSnapshot, options: NumberingOptions = {}): NumberingPlan {
  const categories = normaliseCategories(options.categories);
  const rules = resolveRules(options.rules, categories);
  const levels = (options.levels ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);
  const rows: NumberingRow[] = [];
  const works: Work[] = [];

  for (const category of categories) {
    const rule = rules[category];
    const all = itemsOf(snapshot, category);
    const cw: Work[] = all.map((item) => {
      const old = (item.current ?? "").trim();
      const row: NumberingRow = { category, id: item.id, label: label(category, item), old, new: old, status: "unchanged" };
      return { item, category, scope: "", row, eligible: true };
    });
    for (const w of cw) {
      const item = w.item;
      if (category === "Views") {
        const onSheet = (snapshot.views ?? []).includes(item);
        w.scope = onSheet ? `sheet ${item.sheet_id ?? ""}` : "";
        if (!onSheet || !(item.sheet_id ?? "")) skip(w, "FMC-NUM-SKIPPED", "The view is not placed on a sheet, so it has no detail number.");
      } else if (category === "Grids") {
        if (item.direction !== "vertical" && item.direction !== "horizontal") skip(w, "FMC-NUM-SKIPPED", "The grid is not parallel to the x or y axis, so it has no row or column letter or number.");
      } else if (category === "Rooms") {
        if (item.placed === false) skip(w, "FMC-NUM-SKIPPED", "The room is unplaced or not enclosed.");
      }
      if (w.eligible && ["Doors", "Windows", "Rooms"].includes(category) && levels.length && !levels.includes(levelKey(item).trim().toLowerCase()))
        skip(w, "FMC-NUM-SKIPPED", "Outside the levels asked for. The number stays.");
    }
    assign(cw, category, rule);
    for (const w of cw) {
      works.push(w);
      rows.push(w.row);
    }
  }

  const duplicates = findDuplicates(works);
  const dupIds = new Set<string>();
  for (const d of duplicates) for (const id of d.ids) dupIds.add(`${d.category}:${id}`);
  for (const w of works) {
    if (dupIds.has(`${w.category}:${w.row.id}`)) {
      w.row.status = "error";
      w.row.code = "FMC-NUM-DUPLICATE";
      w.row.reason = `The number ${w.row.new || w.row.old} would be carried by more than one ${w.category.toLowerCase()} item.`;
    }
  }

  const counts = { total: rows.length, rename: 0, unchanged: 0, skipped: 0, error: 0 };
  const by_category: NumberingPlan["by_category"] = {};
  for (const category of categories) by_category[category] = { total: 0, rename: 0, unchanged: 0, skipped: 0, error: 0 };
  for (const r of rows) {
    counts[r.status] += 1;
    by_category[r.category].total += 1;
    by_category[r.category][r.status] += 1;
  }
  return { categories, rules, rows, duplicates, counts, by_category, can_write: counts.error === 0 && counts.rename > 0 };
}

function skip(w: Work, code: string, reason: string) {
  w.eligible = false;
  w.row.status = "skipped";
  w.row.code = code;
  w.row.reason = reason;
}

function assign(cw: Work[], category: NumberingCategory, rule: NumberingRule) {
  const eligible = cw.filter((w) => w.eligible);
  if (category === "Grids") {
    for (const direction of ["vertical", "horizontal"]) {
      // A vertical grid line is placed along x; a horizontal one along y.
      const run = eligible.filter((w) => w.item.direction === direction)
        .sort((a, b) => direction === "vertical"
          ? (a.item.x ?? 0) - (b.item.x ?? 0) || idCompare(a.item.id, b.item.id)
          : (a.item.y ?? 0) - (b.item.y ?? 0) || idCompare(a.item.id, b.item.id));
      run.forEach((w, i) => setNew(w, formatNumber(rule, rule.start + i * rule.step, direction === "horizontal")));
    }
    return;
  }
  if (category === "Views") {
    const groups = new Map<string, Work[]>();
    for (const w of eligible) (groups.get(w.scope) ?? groups.set(w.scope, []).get(w.scope)!).push(w);
    for (const group of groups.values()) {
      // Views keep the order they hold on the sheet when "current": by current detail number, then by position.
      const sorted = rule.order === "current"
        ? group.sort((a, b) => naturalCompare(a.row.old, b.row.old) || byPosition("x_then_y")(a.item, b.item))
        : group.sort((a, b) => (rule.order === "y_then_x" ? (a.item.y ?? 0) - (b.item.y ?? 0) || (a.item.x ?? 0) - (b.item.x ?? 0) : (a.item.x ?? 0) - (b.item.x ?? 0) || (a.item.y ?? 0) - (b.item.y ?? 0)) || idCompare(a.item.id, b.item.id));
      sorted.forEach((w, i) => setNew(w, formatNumber(rule, rule.start + i * rule.step)));
    }
    return;
  }
  if (category === "Sheets" || rule.order === "current") {
    eligible.sort((a, b) => naturalCompare(a.row.old, b.row.old) || idCompare(a.item.id, b.item.id))
      .forEach((w, i) => setNew(w, formatNumber(rule, rule.start + i * rule.step)));
    return;
  }
  const sorted = eligible.sort((a, b) => byPosition(rule.order)(a.item, b.item));
  const levelOrder: string[] = [];
  for (const w of sorted) { const k = levelKey(w.item); if (!levelOrder.includes(k)) levelOrder.push(k); }
  const perLevel = new Map<string, number>();
  let run = 0;
  for (const w of sorted) {
    const k = levelKey(w.item);
    const n = perLevel.get(k) ?? 0;
    perLevel.set(k, n + 1);
    const base = rule.level_block > 0 ? levelOrder.indexOf(k) * rule.level_block + rule.start + n * rule.step : rule.start + run * rule.step;
    run += 1;
    setNew(w, formatNumber(rule, base));
  }
}

function setNew(w: Work, value: string) {
  w.row.new = value;
  w.row.status = value === w.row.old ? "unchanged" : "rename";
}

/** Duplicates are counted over the numbers the items would carry after the write, skipped items included. */
function findDuplicates(works: Work[]): NumberingDuplicate[] {
  const groups = new Map<string, { category: NumberingCategory; number: string; scope: string; ids: string[] }>();
  for (const w of works) {
    const value = (w.eligible ? w.row.new : w.row.old).trim();
    if (!value) continue;
    const scope = w.category === "Views" ? (w.item.sheet_id ?? "") : "";
    const key = `${w.category}|${scope}|${value.toLowerCase()}`;
    const g = groups.get(key) ?? { category: w.category, number: value, scope, ids: [] };
    g.ids.push(w.row.id);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.ids.length > 1).map((g) => ({ ...g, scope: g.scope ? `sheet ${g.scope}` : "project" }));
}

export function referenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return NUMBERING_FIX["FMC-NUM-REFERENCES"];
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) return NUMBERING_FIX["FMC-NUM-REFERENCES"];
  }
  return null;
}
