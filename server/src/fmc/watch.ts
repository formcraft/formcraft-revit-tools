/**
 * fmc_watch: the change ledger's server side. Pure functions for the ledger lines the add-in appends (FmcWatch.cs), the
 * summary by user, category, change type, transaction and time, and the file rules. No Revit, no network, and never a
 * review register: a ledger is a .jsonl in a folder called Watch, and nothing under _Reviews.
 */
import fs from "node:fs";
import path from "node:path";

export const CHANGE_TYPES = ["added", "deleted", "geometry", "parameter", "modified"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface LedgerRow {
  t: string;
  user?: string;
  doc?: string;
  op?: string;
  tx?: string;
  id?: number | string;
  cat?: string;
  type: string;
  note?: string;
  not_listed?: number;
}

export function isChange(row: LedgerRow): boolean { return (CHANGE_TYPES as readonly string[]).includes(row.type); }

/** Never a review folder or register, whatever the caller passes. */
export function isReviewPath(p: string): boolean {
  return /(^|[\\/])_reviews([\\/]|$)/i.test(p) || /review_register/i.test(p);
}

/** The add-in's own rule, kept here too: an absolute .jsonl inside a folder called Watch, not a review path. */
export function ledgerFileProblem(file: string): string {
  const f = (file ?? "").trim();
  if (!f) return "file is required";
  if (!path.win32.isAbsolute(f) && !path.posix.isAbsolute(f)) return "file must be an absolute path";
  if (!/\.jsonl$/i.test(f)) return "a ledger is a .jsonl file";
  const dir = path.win32.basename(path.win32.dirname(f.replace(/\//g, "\\")));
  if (dir.toLowerCase() !== "watch") return "a ledger is in a folder called Watch";
  if (isReviewPath(f)) return "a review folder or register is never read or written";
  return "";
}

/** Join in the style of the base: Windows paths (a drive or a backslash) with win32, anything else natively. */
export function joinLike(base: string, ...parts: string[]): string {
  return /^[A-Za-z]:|\\/.test(base) ? path.win32.join(base, ...parts) : path.join(base, ...parts);
}

const two = (n: number) => String(n).padStart(2, "0");

export function modelSlug(document: string): string {
  const base = path.win32.basename(document.trim().replace(/\.rv[tf]$/i, "")) || "model";
  return base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "model";
}

/** FMC_Watch_<model>_<yyyyMMdd-HHmm>.jsonl in local time. */
export function ledgerName(document: string, now: Date): string {
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
  return `FMC_Watch_${modelSlug(document)}_${stamp}.jsonl`;
}

export function ledgerFilesFor(dir: string, document: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const prefix = `FMC_Watch_${modelSlug(document)}_`.toLowerCase();
  return fs.readdirSync(dir).filter((n) => n.toLowerCase().startsWith(prefix) && /\.jsonl$/i.test(n)).sort().map((n) => path.join(dir, n));
}

/** Tolerant: a half-written last line or a stray line is counted in bad, never a reason to lose the rest. */
export function parseLedger(text: string): { rows: LedgerRow[]; bad: number } {
  const rows: LedgerRow[] = [];
  let bad = 0;
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const r = JSON.parse(line) as LedgerRow;
      if (r && typeof r === "object" && typeof r.t === "string" && typeof r.type === "string") rows.push(r); else bad++;
    } catch { bad++; }
  }
  return { rows, bad };
}

export interface LedgerFilter { since?: string; until?: string; user?: string; category?: string; change_type?: string; element_id?: string }

const same = (a: string | undefined, b: string | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export function filterLedger(rows: LedgerRow[], f: LedgerFilter): LedgerRow[] {
  const since = f.since ? Date.parse(f.since) : NaN;
  const until = f.until ? Date.parse(f.until) : NaN;
  if (f.since && Number.isNaN(since)) throw new Error(`since "${f.since}" is not a date (use 2026-11-28 or 2026-11-28T09:00:00+03:00)`);
  if (f.until && Number.isNaN(until)) throw new Error(`until "${f.until}" is not a date`);
  return rows.filter((r) => {
    if (!isChange(r)) return false;
    const at = Date.parse(r.t);
    if (!Number.isNaN(since) && at < since) return false;
    if (!Number.isNaN(until) && at >= until) return false;
    if (f.user && !same(r.user, f.user)) return false;
    if (f.category && !same(r.cat, f.category)) return false;
    if (f.change_type && !same(r.type, f.change_type)) return false;
    if (f.element_id && String(r.id ?? "") !== String(f.element_id).trim()) return false;
    return true;
  });
}

export interface Group {
  key: string;
  changes: number;
  elements: number;
  added: number;
  deleted: number;
  geometry: number;
  parameter: number;
  modified: number;
}

function groupBy(rows: LedgerRow[], keyOf: (r: LedgerRow) => string, top: number): Group[] {
  const map = new Map<string, { g: Group; ids: Set<string> }>();
  for (const r of rows) {
    const key = keyOf(r) || "(none)";
    let slot = map.get(key);
    if (!slot) { slot = { g: { key, changes: 0, elements: 0, added: 0, deleted: 0, geometry: 0, parameter: 0, modified: 0 }, ids: new Set() }; map.set(key, slot); }
    slot.g.changes++;
    if ((CHANGE_TYPES as readonly string[]).includes(r.type)) slot.g[r.type as ChangeType]++;
    if (r.id !== undefined) slot.ids.add(String(r.id));
  }
  return [...map.values()].map(({ g, ids }) => ({ ...g, elements: ids.size })).sort((a, b) => b.changes - a.changes || a.key.localeCompare(b.key)).slice(0, top);
}

export type Bucket = "hour" | "day";

/** The bucket comes from the wall-clock text the add-in wrote (local time with its offset), so no time-zone guessing. */
export function bucketOf(t: string, bucket: Bucket): string {
  return bucket === "day" ? t.slice(0, 10) : `${t.slice(0, 13)}:00`;
}

export interface Summary {
  changes: number;
  elements: number;
  first?: string;
  last?: string;
  by_user: Group[];
  by_category: Group[];
  by_type: Array<{ key: string; changes: number }>;
  by_transaction: Group[];
  by_time: Array<{ bucket: string; changes: number }>;
  not_listed: number;
  watch_starts: number;
  watch_stops: number;
  advice: string[];
}

export function summarize(all: LedgerRow[], filter: LedgerFilter = {}, opts: { top?: number; bucket?: Bucket } = {}): Summary {
  const top = Math.max(1, Math.min(opts.top ?? 15, 100));
  const bucket = opts.bucket ?? "hour";
  const rows = filterLedger(all, filter);
  const times = new Map<string, number>();
  for (const r of rows) { const b = bucketOf(r.t, bucket); times.set(b, (times.get(b) ?? 0) + 1); }
  const types = new Map<string, number>();
  for (const r of rows) types.set(r.type, (types.get(r.type) ?? 0) + 1);
  const ids = new Set(rows.filter((r) => r.id !== undefined).map((r) => String(r.id)));
  const out: Summary = {
    changes: rows.length, elements: ids.size,
    first: rows[0]?.t, last: rows[rows.length - 1]?.t,
    by_user: groupBy(rows, (r) => r.user ?? "", top),
    by_category: groupBy(rows, (r) => r.cat ?? "", top),
    by_type: [...types].map(([key, changes]) => ({ key, changes })).sort((a, b) => b.changes - a.changes || a.key.localeCompare(b.key)),
    by_transaction: groupBy(rows, (r) => r.tx ?? "", top),
    by_time: [...times].map(([b, changes]) => ({ bucket: b, changes })).sort((a, b) => a.bucket.localeCompare(b.bucket)),
    not_listed: all.filter((r) => r.type === "summary").reduce((n, r) => n + (r.not_listed ?? 0), 0),
    watch_starts: all.filter((r) => r.type === "watch_started").length,
    watch_stops: all.filter((r) => r.type === "watch_stopped").length,
    advice: [],
  };
  if (!rows.length) { out.advice.push("No changes in the ledger for this filter."); return out; }
  const u = out.by_user[0];
  if (u) out.advice.push(`${u.key} made ${u.changes} of ${rows.length} changes (${Math.round((u.changes / rows.length) * 100)}%).`);
  const c = out.by_category.find((g) => g.key !== "(none)" && g.key !== "(unknown)");
  if (c) out.advice.push(`Most changed category: ${c.key} (${c.changes}).`);
  const busy = [...out.by_time].sort((a, b) => b.changes - a.changes)[0];
  if (busy) out.advice.push(`Busiest ${bucket}: ${busy.bucket} (${busy.changes}).`);
  const deletes = out.by_type.find((x) => x.key === "deleted");
  if (deletes && deletes.changes >= 20) out.advice.push(`${deletes.changes} deletions: check them with fmc_undo status or the transaction names.`);
  if (out.not_listed > 0) out.advice.push(`${out.not_listed} change(s) were counted but not listed (a very large transaction or elements with no category).`);
  return out;
}
