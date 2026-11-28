/**
 * fmc_warnings: triage and trend of Revit's warnings by failure id, level, workset and owner, a CSV for Power BI, and
 * review-ticket DRAFTS. Pure functions plus a small JSON store for the trend. No Revit here: the add-in only reads the
 * rows (FmcWarningsHandler). Nothing in this file changes a model, calls a network, or writes a review register.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const NONE = "(none)";
export const DEFAULT_ID_CAP = 20;

export interface WarningElement {
  id: number | string;
  category?: string;
  level?: string;
  workset?: string;
  owner?: string;
  creator?: string;
  role?: string;
  missing?: boolean;
  unread?: boolean;
}

export interface WarningRow {
  failure_id: string;
  severity?: string;
  description: string;
  element_count?: number;
  elements: WarningElement[];
}

export type Dimension = "failure" | "level" | "workset" | "owner" | "creator";

/** One group. Counts are of distinct elements read; the id lists are capped (failing_count says how many there are). */
export interface Counted {
  key: string;
  warnings: number;
  failing_count: number;
  additional_count: number;
  failing_ids: Array<number | string>;
  additional_ids: Array<number | string>;
}
export interface FailureGroup extends Counted {
  failure_id: string;
  description: string;
  severity: string;
  share_percent: number;
  levels: Counted[];
  worksets: Counted[];
  owners: Counted[];
}
export interface DimGroup extends Counted {
  share_percent: number;
  top_failures: Array<{ failure_id: string; description: string; warnings: number }>;
}

export interface Triage {
  total: number;
  by_severity: Array<{ key: string; warnings: number }>;
  by_failure: FailureGroup[];
  by_level: DimGroup[];
  by_workset: DimGroup[];
  by_owner: DimGroup[];
  by_creator?: DimGroup[];
  advice: string[];
}

export interface Filter { failure_id?: string; level?: string; workset?: string; owner?: string; severity?: string }

const same = (a: string | undefined, b: string | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
const isRole = (el: WarningElement, only: string) => (el.role ?? "failing") === only;

function valueOfElement(el: WarningElement, dim: Dimension): string {
  const v = ((dim === "level" ? el.level : dim === "workset" ? el.workset : dim === "owner" ? el.owner : dim === "creator" ? el.creator : "") ?? "").trim();
  return v || NONE;
}

/** The elements that decide where and whose a warning is: the failing ones, else the additional ones. */
export function owningElements(row: WarningRow): WarningElement[] {
  const failing = row.elements.filter((e) => isRole(e, "failing"));
  return failing.length ? failing : row.elements;
}

/** The distinct values of one dimension over a warning's owning elements. A warning counts once per distinct value. */
export function valuesOf(row: WarningRow, dim: Dimension): string[] {
  if (dim === "failure") return [row.failure_id || "unknown"];
  const seen = new Set(owningElements(row).map((e) => valueOfElement(e, dim)));
  if (seen.size === 0) seen.add(NONE);
  return [...seen].sort();
}

export function filterRows(rows: WarningRow[], f: Filter): WarningRow[] {
  return rows.filter((row) => {
    if (f.failure_id && !same(row.failure_id, f.failure_id)) return false;
    if (f.severity && !same(row.severity ?? "Warning", f.severity)) return false;
    if (f.level && !valuesOf(row, "level").some((v) => same(v, f.level))) return false;
    if (f.workset && !valuesOf(row, "workset").some((v) => same(v, f.workset))) return false;
    if (f.owner && !valuesOf(row, "owner").some((v) => same(v, f.owner))) return false;
    return true;
  });
}

export function hasFilter(f: Filter): boolean { return Boolean(f.failure_id || f.level || f.workset || f.owner || f.severity); }

interface Slot { warnings: number; failing: Set<string>; additional: Set<string>; failingOrder: Array<number | string>; additionalOrder: Array<number | string> }

function tally(rows: WarningRow[], dim: Dimension): Map<string, Slot> {
  const map = new Map<string, Slot>();
  const slotOf = (key: string) => {
    let s = map.get(key);
    if (!s) { s = { warnings: 0, failing: new Set(), additional: new Set(), failingOrder: [], additionalOrder: [] }; map.set(key, s); }
    return s;
  };
  for (const row of rows) {
    for (const key of valuesOf(row, dim)) {
      const slot = slotOf(key);
      slot.warnings += 1;
      for (const el of row.elements) {
        if (dim !== "failure" && valueOfElement(el, dim) !== key) continue;
        const id = String(el.id);
        // an element is "failing" when it is one of the warning's failing elements; every other element is "additional"
        const failing = isRole(el, "failing");
        const set = failing ? slot.failing : slot.additional;
        if (!set.has(id)) { set.add(id); (failing ? slot.failingOrder : slot.additionalOrder).push(el.id); }
      }
    }
  }
  return map;
}

function counted(key: string, s: Slot, cap: number): Counted {
  return {
    key, warnings: s.warnings, failing_count: s.failing.size, additional_count: s.additional.size,
    failing_ids: s.failingOrder.slice(0, cap), additional_ids: s.additionalOrder.slice(0, cap),
  };
}

function ranked(rows: WarningRow[], dim: Dimension, top: number, cap: number): Counted[] {
  return [...tally(rows, dim)].map(([key, s]) => counted(key, s, cap))
    .sort((a, b) => b.warnings - a.warnings || a.key.localeCompare(b.key)).slice(0, top);
}

const pct = (n: number, total: number) => total ? Math.round((n / total) * 1000) / 10 : 0;

function dimGroups(rows: WarningRow[], dim: Dimension, top: number, cap: number): DimGroup[] {
  const total = rows.length;
  return ranked(rows, dim, top, cap).map((c) => {
    const inGroup = rows.filter((r) => valuesOf(r, dim).includes(c.key));
    const names = new Map<string, string>();
    for (const r of inGroup) if (!names.has(r.failure_id)) names.set(r.failure_id, r.description);
    return {
      ...c, share_percent: pct(c.warnings, total),
      top_failures: ranked(inGroup, "failure", 3, 0).map((f) => ({ failure_id: f.key, description: names.get(f.key) ?? "", warnings: f.warnings })),
    };
  });
}

export function triage(rows: WarningRow[], opts: { top?: number; id_cap?: number } = {}): Triage {
  const top = Math.max(1, Math.min(opts.top ?? 15, 100));
  const cap = Math.max(0, Math.min(opts.id_cap ?? DEFAULT_ID_CAP, 200));
  const total = rows.length;
  const text = new Map<string, { description: string; severity: string }>();
  for (const r of rows) if (!text.has(r.failure_id)) text.set(r.failure_id, { description: r.description, severity: r.severity ?? "Warning" });
  const by_failure: FailureGroup[] = ranked(rows, "failure", top, cap).map((c) => {
    const inGroup = rows.filter((r) => r.failure_id === c.key);
    return {
      ...c, failure_id: c.key, description: text.get(c.key)?.description ?? "", severity: text.get(c.key)?.severity ?? "Warning",
      share_percent: pct(c.warnings, total),
      levels: ranked(inGroup, "level", 3, cap), worksets: ranked(inGroup, "workset", 3, cap), owners: ranked(inGroup, "owner", 3, cap),
    };
  });
  const sev = new Map<string, number>();
  for (const r of rows) { const s = r.severity ?? "Warning"; sev.set(s, (sev.get(s) ?? 0) + 1); }
  const out: Triage = {
    total, by_failure, by_level: dimGroups(rows, "level", top, cap), by_workset: dimGroups(rows, "workset", top, cap), by_owner: dimGroups(rows, "owner", top, cap),
    by_severity: [...sev].map(([key, n]) => ({ key, warnings: n })).sort((a, b) => b.warnings - a.warnings || a.key.localeCompare(b.key)), advice: [],
  };
  if (rows.some((r) => r.elements.some((e) => (e.creator ?? "").trim()))) out.by_creator = dimGroups(rows, "creator", top, cap);
  out.advice = advise(out);
  return out;
}

function advise(t: Triage): string[] {
  const lines: string[] = [];
  if (!t.total) return ["No warnings in the model."];
  const errors = t.by_severity.find((s) => s.key.toLowerCase() === "error");
  if (errors) lines.push(`${errors.warnings} item(s) are errors, not warnings: look at them first.`);
  const f = t.by_failure[0];
  if (f) lines.push(`Fix "${f.description}" first (${f.failure_id}): ${f.warnings} of ${t.total} warnings (${f.share_percent}%).`);
  const lv = t.by_level.find((l) => l.key !== NONE);
  if (lv && lv.share_percent >= 30) lines.push(`Level ${lv.key} holds ${lv.share_percent}% of the warnings.`);
  const ws = t.by_workset.find((l) => l.key !== NONE);
  if (ws && ws.share_percent >= 30) lines.push(`Workset ${ws.key} holds ${ws.share_percent}% of the warnings.`);
  const ow = t.by_owner.find((l) => l.key !== NONE);
  if (ow && ow.share_percent >= 30) lines.push(`${ow.key} has ${ow.share_percent}% of the warning elements checked out.`);
  return lines;
}

// ---- trend ---------------------------------------------------------------------------------------------------------

export interface Snapshot {
  at: string;
  total: number;
  by_severity: Record<string, number>;
  by_failure: Record<string, number>;
  by_level: Record<string, number>;
  by_workset: Record<string, number>;
  by_owner: Record<string, number>;
}

export interface History { version: 1; document: string; history: Snapshot[]; keys: string[] }

export const MAX_HISTORY = 60;

const record = (rows: WarningRow[], dim: Dimension): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of tally(rows, dim)) out[k] = v.warnings;
  return out;
};

export function snapshotOf(rows: WarningRow[], at: string): Snapshot {
  const by_severity: Record<string, number> = {};
  for (const r of rows) { const s = r.severity ?? "Warning"; by_severity[s] = (by_severity[s] ?? 0) + 1; }
  return { at, total: rows.length, by_severity, by_failure: record(rows, "failure"), by_level: record(rows, "level"), by_workset: record(rows, "workset"), by_owner: record(rows, "owner") };
}

/** One warning's identity across runs: its kind and the elements it fails on. */
export function warningKey(row: WarningRow): string {
  const ids = row.elements.filter((e) => isRole(e, "failing")).map((e) => String(e.id)).sort();
  const all = ids.length ? ids : row.elements.map((e) => String(e.id)).sort();
  return crypto.createHash("sha1").update(`${row.failure_id}|${all.join(",")}`).digest("hex").slice(0, 12);
}

export interface Delta { key: string; before: number; after: number; delta: number }

function deltas(before: Record<string, number>, after: Record<string, number>, top: number): Delta[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].map((key) => ({ key, before: before[key] ?? 0, after: after[key] ?? 0, delta: (after[key] ?? 0) - (before[key] ?? 0) }))
    .filter((d) => d.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key)).slice(0, top);
}

export interface Trend {
  has_previous: boolean;
  since?: string;
  total_before?: number;
  total_after: number;
  total_delta?: number;
  direction?: "up" | "down" | "flat";
  new_warnings?: number;
  resolved_warnings?: number;
  by_failure?: Delta[];
  by_level?: Delta[];
  by_workset?: Delta[];
  by_owner?: Delta[];
  series: Array<{ at: string; total: number }>;
  advice: string[];
}

/** Compare the current run with the PREVIOUS snapshot (the last one saved for this model). */
export function trend(history: History | undefined, current: Snapshot, currentKeys: string[], opts: { top?: number } = {}): Trend {
  const top = Math.max(1, Math.min(opts.top ?? 15, 100));
  const past = history?.history ?? [];
  const prev = past.length ? past[past.length - 1] : undefined;
  const series = [...past, current].slice(-20).map((s) => ({ at: s.at, total: s.total }));
  if (!prev) return { has_previous: false, total_after: current.total, series, advice: ["First snapshot of this model. The next run shows what changed."] };
  const before = new Set(history?.keys ?? []);
  const after = new Set(currentKeys);
  let added = 0, gone = 0;
  for (const k of after) if (!before.has(k)) added++;
  for (const k of before) if (!after.has(k)) gone++;
  const delta = current.total - prev.total;
  const out: Trend = {
    has_previous: true, since: prev.at, total_before: prev.total, total_after: current.total, total_delta: delta,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat", new_warnings: added, resolved_warnings: gone,
    by_failure: deltas(prev.by_failure, current.by_failure, top), by_level: deltas(prev.by_level, current.by_level, top),
    by_workset: deltas(prev.by_workset, current.by_workset, top), by_owner: deltas(prev.by_owner, current.by_owner, top), series, advice: [],
  };
  out.advice.push(delta === 0 ? `Warnings unchanged at ${current.total} since ${prev.at}.` : `Warnings went ${delta > 0 ? "up" : "down"} by ${Math.abs(delta)} (${prev.total} to ${current.total}) since ${prev.at}; ${added} new, ${gone} resolved.`);
  const worst = out.by_failure?.find((d) => d.delta > 0);
  if (worst) out.advice.push(`Growing most: failure ${worst.key} (+${worst.delta}).`);
  const owner = out.by_owner?.find((d) => d.delta > 0 && d.key !== NONE);
  if (owner) out.advice.push(`Owner ${owner.key} gained ${owner.delta} warning(s).`);
  return out;
}

// ---- store ---------------------------------------------------------------------------------------------------------

/** Never a review register: a warnings file is never written under _Reviews, whatever the caller passes. */
export function isReviewPath(p: string): boolean {
  return /(^|[\\/])_reviews([\\/]|$)/i.test(p) || /review_register/i.test(p);
}

export function historyFile(dir: string, title: string, docPath: string): string {
  const slug = (title || "model").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "model";
  const id = crypto.createHash("sha1").update((docPath || title).toLowerCase()).digest("hex").slice(0, 8);
  return path.join(dir, `warnings-${slug}-${id}.json`);
}

export function readHistory(file: string): { history?: History; problem?: string } {
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as History;
    if (raw && raw.version === 1 && Array.isArray(raw.history) && Array.isArray(raw.keys)) return { history: raw };
    return { problem: "the saved snapshots have an unknown shape and were ignored" };
  } catch (e) {
    return { problem: `the saved snapshots could not be read (${e instanceof Error ? e.message : String(e)}) and were ignored` };
  }
}

export function writeHistory(file: string, document: string, prior: History | undefined, current: Snapshot, keys: string[]): void {
  if (isReviewPath(file)) throw new Error(`Refusing to write ${file}: warnings never go in a review folder or register.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: History = { version: 1, document, history: [...(prior?.history ?? []), current].slice(-MAX_HISTORY), keys };
  fs.writeFileSync(file, JSON.stringify(body));
}

// ---- CSV (Power BI friendly, local file only) -----------------------------------------------------------------------

export const CSV_HEADER = ["snapshot_at", "model", "failure_id", "severity", "description", "element_id", "role", "category", "level", "workset", "owner", "creator"];

const cell = (v: string | number | boolean | undefined) => {
  const s = String(v ?? "");
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // no spreadsheet formulas from a warning's text
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** One row per warning and element (a warning with no element gets one row with an empty element). Long format for Power BI. */
export function warningsCsv(rows: WarningRow[], model: string, at: string): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) {
    const els = r.elements.length ? r.elements : [undefined];
    for (const e of els) {
      lines.push([at, model, r.failure_id, r.severity ?? "Warning", r.description, e?.id ?? "", e?.role ?? "", e?.category ?? "", e?.level ?? "", e?.workset ?? "", e?.owner ?? "", e?.creator ?? ""].map(cell).join(","));
    }
  }
  return lines.join("\r\n") + "\r\n";
}

// ---- review-ticket drafts (never written to a register) ------------------------------------------------------------

export interface TicketDraft {
  draft: true;
  raised: false;
  source: "warnings";
  failure_id: string;
  title: string;
  description: string;
  priority: "High" | "Medium" | "Low";
  suggested_owner: string;
  suggested_lead: "";
  needs: string[];
  model: string;
  element_ids: Array<number | string>;
  element_count: number;
  warnings: number;
}

/** Drafts for the biggest failure groups. They are text for a person to confirm; nothing here writes or raises anything. */
export function ticketDrafts(t: Triage, model: string, limit: number): TicketDraft[] {
  return t.by_failure.slice(0, Math.max(0, Math.min(limit, 20))).map((f) => {
    const owner = f.owners.find((o) => o.key !== NONE)?.key ?? "";
    const level = f.levels.find((l) => l.key !== NONE)?.key;
    const priority = f.severity.toLowerCase() === "error" || f.share_percent >= 30 ? "High" : f.share_percent >= 10 ? "Medium" : "Low";
    return {
      draft: true, raised: false, source: "warnings", failure_id: f.failure_id,
      title: `Clear ${f.warnings} Revit warning(s): ${f.description}`.slice(0, 120),
      description: `${f.warnings} warning(s) of "${f.description}" (failure id ${f.failure_id}, ${f.share_percent}% of the model's warnings)` +
        `${level ? `, mostly on ${level}` : ""}. ${f.failing_count} failing element(s)${f.additional_count ? ` and ${f.additional_count} additional` : ""}; ids listed are capped. Fix or accept each; do not delete warnings blindly.`,
      priority, suggested_owner: owner, suggested_lead: "", needs: ["lead discipline", "one named owner", "a person to confirm before it is raised"],
      model, element_ids: f.failing_ids.slice(0, 200), element_count: f.failing_count, warnings: f.warnings,
    };
  });
}