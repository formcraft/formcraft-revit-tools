/**
 * The change record and sync feed (F19, L011 tools row 10, for NBRB and DITACO): one read-only timeline of what changed,
 * who changed it and when, over
 *
 *   ledger     the hub's call ledger (%APPDATA%\Formcraft\ledger\calls-YYYY-MM.jsonl): every Formcraft tool call, its
 *              result and who started it (ai, pane, job, schedule, cli). Never a person's name (rule 9).
 *   external   runs outside the server from the one-line hooks (external-YYYY-MM.jsonl)
 *   created    the batches' created elements (FMC_Created.jsonl), one entry per batch and document
 *   syncs      the sync log (01_WIP\FMC_Sync_Log.csv, else the reports folder) and the managed save and sync clocks
 *              (fmc_sync_state.json): when a model was last synced, saved and changed
 *   revit      fmc_model_changes in the add-in: the session journal of committed, undone and redone transactions, saves
 *              and syncs Revit reported, and with since_version the elements created, modified and deleted since a
 *              document version, with Revit's creator, last changed by and owner
 *   flows      fmc_changes: what a change in one app makes out of date in the others (a snapshot of now)
 *
 * Read only, decision 5 and CLAUDE.md rule 6: a "sync feed" reports syncs; it never runs one. Nothing here saves,
 * synchronises with central, reloads latest, relinquishes, checks out, starts a transaction or writes a file. The
 * only add-in command it sends is fmc_model_changes (READ_VIA_SEND_COMMAND). Pure apart from the readers it is given.
 */
import type { CreatedRow } from "./createdlog.js";
import type { DocClock } from "./docschedule.js";

export const FEED_SOURCES = ["ledger", "external", "created", "syncs", "revit", "flows"] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];
/** flows is a snapshot of now and reads the staging tree, so it is asked for by name. */
export const DEFAULT_SOURCES: FeedSource[] = ["ledger", "external", "created", "syncs", "revit"];

/** The add-in commands this feature may send. Each is a read (policy.ts READ_VIA_SEND_COMMAND); a test holds it. */
export const CHANGE_FEED_COMMANDS = ["fmc_model_changes"] as const;

export interface FeedEntry {
  /** ISO time, UTC. */
  at: string;
  source: FeedSource;
  /** call, external, created, synced, saved, changed, sync_message, change, undo, redo, closed, element_created, element_modified, element_deleted, flag */
  kind: string;
  /** One line: what changed. */
  what: string;
  /** Who: the ledger's starter (ai, pane, job, schedule, cli, person), or the Revit user Revit reports. "" when no source says. */
  who: string;
  project?: string;
  document?: string;
  ok?: boolean;
  detail?: Record<string, unknown>;
}

export interface SourceStatus { source: FeedSource; read: boolean; count: number; note: string }

const iso = (v: unknown): string => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === "string" && v.trim()) { const t = Date.parse(v); return Number.isNaN(t) ? "" : new Date(t).toISOString(); }
  return "";
};
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** The model's key for matching: its file name without folder and .rvt, lower case (A-0001_user.rvt → a-0001_user). */
export function docKey(name: string): string {
  const base = str(name).trim().replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/\.(rvt|rfa)$/i, "").toLowerCase();
}

export function sameDocument(a: string, b: string): boolean {
  const x = docKey(a), y = docKey(b);
  return !!x && !!y && x === y;
}

/** Ledger call lines as entries. The call is the change record: tool, action, ok, time, project and who started it. */
export function ledgerEntries(lines: unknown[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const l of lines) {
    if (!l || typeof l !== "object") continue;
    const o = l as Record<string, unknown>;
    const at = iso(o.at);
    const tool = str(o.tool);
    if (!at || !tool) continue;
    const action = str(o.action);
    const detail: Record<string, unknown> = { ms: Number(o.ms) || 0 };
    if (o.purpose) detail.purpose = str(o.purpose);
    if (o.code_hash) detail.code_hash = str(o.code_hash);
    if (o.addon) detail.addon = str(o.addon);
    out.push({ at, source: "ledger", kind: "call", what: action ? `${tool} ${action}` : tool, who: str(o.started_by), project: str(o.project),
      ok: o.ok !== false, detail });
  }
  return out;
}

/** Hook lines (pyRevit, Dynamo, scripts) as entries. */
export function externalEntries(lines: unknown[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const l of lines) {
    if (!l || typeof l !== "object") continue;
    const o = l as Record<string, unknown>;
    const at = iso(o.at);
    const script = str(o.script);
    if (!at || !script) continue;
    out.push({ at, source: "external", kind: "external", what: `${str(o.kind) || "script"} ${script}`, who: str(o.started_by) || "person",
      project: str(o.project), ok: o.ok !== false, detail: { ms: Number(o.ms) || 0 } });
  }
  return out;
}

/** Created ids grouped by batch and document: one entry per batch, at its first row's time, with counts per category. */
export function createdEntries(rows: CreatedRow[]): FeedEntry[] {
  const groups = new Map<string, CreatedRow[]>();
  for (const r of rows) {
    if (!r || !r.batch_id) continue;
    const k = `${r.batch_id}|${docKey(r.document)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out: FeedEntry[] = [];
  for (const list of groups.values()) {
    const first = list.reduce((a, b) => (Date.parse(a.at) <= Date.parse(b.at) ? a : b));
    const at = iso(first.at);
    if (!at) continue;
    const categories: Record<string, number> = {};
    for (const r of list) { const c = r.category || "(no category)"; categories[c] = (categories[c] ?? 0) + 1; }
    out.push({ at, source: "created", kind: "created", what: `${list.length} element${list.length === 1 ? "" : "s"} created by batch ${first.batch_id}`,
      who: first.source || "", document: first.document, detail: { batch_id: first.batch_id, categories, ids: list.slice(0, 50).map((r) => r.id) } });
  }
  return out;
}

/** One CSV line into fields (quotes and doubled quotes, as policy.csvLine writes them). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Split CSV text into records, keeping line breaks inside quoted fields. */
export function csvRecords(text: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (const c of text.replace(/^\uFEFF/, "")) {
    if (c === '"') q = !q;
    if (!q && (c === "\n" || c === "\r")) { if (cur.trim()) out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** FMC_Sync_Log.csv (timestamp, model, user, message): one entry per recorded sync message. */
export function syncLogEntries(text: string, file = ""): FeedEntry[] {
  const recs = csvRecords(text);
  if (!recs.length) return [];
  const head = parseCsvLine(recs[0]).map((h) => h.trim().toLowerCase());
  const col = (n: string, d: number) => { const i = head.indexOf(n); return i >= 0 ? i : d; };
  const hasHead = head.includes("timestamp");
  const [ti, mi, ui, gi] = [col("timestamp", 0), col("model", 1), col("user", 2), col("message", 3)];
  const out: FeedEntry[] = [];
  for (const r of hasHead ? recs.slice(1) : recs) {
    const f = parseCsvLine(r);
    const at = iso(f[ti]);
    if (!at) continue;
    out.push({ at, source: "syncs", kind: "sync_message", what: `Sync message recorded for ${f[mi] ?? ""}: ${f[gi] ?? ""}`.trim(), who: f[ui] ?? "",
      document: f[mi] ?? "", detail: file ? { file } : undefined });
  }
  return out;
}

/** The managed save and sync clocks: last sync, last save and last change per model. Who ran them is not recorded there. */
export function syncStateEntries(clocks: DocClock[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const c of clocks) {
    const doc = str(c.document);
    if (c.lastSyncAt != null && iso(c.lastSyncAt)) out.push({ at: iso(c.lastSyncAt), source: "syncs", kind: "synced", what: `${doc} last synced with central`, who: "", document: doc });
    if (c.lastSaveAt != null && iso(c.lastSaveAt)) out.push({ at: iso(c.lastSaveAt), source: "syncs", kind: "saved", what: `${doc} last saved`, who: "", document: doc });
    if (c.changedAt != null && iso(c.changedAt)) out.push({ at: iso(c.changedAt), source: "syncs", kind: "changed", what: `${doc} last changed by a Formcraft batch`, who: "", document: doc,
      detail: c.lastError ? { last_error: c.lastError } : undefined });
  }
  return out;
}

/** The sync picture for one model: last sync, last save, and whether it changed after its last sync. Reported, never acted on. */
export function syncSummary(entries: FeedEntry[], document: string) {
  const mine = entries.filter((e) => !document || sameDocument(e.document ?? "", document));
  const latest = (kinds: string[]) => mine.filter((e) => kinds.includes(e.kind)).map((e) => e.at).sort().pop() ?? null;
  const lastSync = latest(["synced"]);
  const lastSave = latest(["saved"]);
  const lastChange = latest(["change", "undo", "redo", "changed", "created"]);
  return {
    last_sync_at: lastSync,
    last_save_at: lastSave,
    last_change_at: lastChange,
    changed_since_last_sync: lastChange == null ? false : lastSync == null ? null : lastChange > lastSync,
    action: "None taken: a person syncs in Revit (CLAUDE.md rule 6). This feed never syncs, saves or reloads latest.",
  };
}

/** fmc_model_changes' reply as entries: the journal, then the version diff. */
export function revitEntries(reply: Record<string, unknown>, now: Date): FeedEntry[] {
  const out: FeedEntry[] = [];
  const doc = str((reply.resolved_document as Record<string, unknown> | undefined)?.title);
  const journal = (reply.journal ?? {}) as Record<string, unknown>;
  for (const e of (Array.isArray(journal.entries) ? journal.entries : []) as Array<Record<string, unknown>>) {
    const at = iso(e.at);
    if (!at) continue;
    const kind = str(e.kind) || "change";
    const counts = kind === "change" || kind === "undo" || kind === "redo"
      ? ` (+${Number(e.added) || 0} ~${Number(e.modified) || 0} -${Number(e.deleted) || 0})` : "";
    const verb = kind === "change" ? "" : kind === "undo" ? "Undo: " : kind === "redo" ? "Redo: " : kind === "saved" ? "Saved " : kind === "synced" ? "Synced with central " : kind === "closed" ? "Closed " : "";
    const label = str(e.label);
    out.push({ at, source: "revit", kind, what: `${verb}${label || (kind === "change" ? "(unnamed transaction)" : "")}${counts}`.trim(),
      who: [str(e.user), str(e.by)].filter(Boolean).join(" · "), document: str(e.document) || doc,
      detail: { seq: e.seq, added_ids: e.added_ids, modified_ids: e.modified_ids, deleted_ids: e.deleted_ids, ids_truncated: e.ids_truncated } });
  }
  const diff = reply.diff as Record<string, unknown> | null | undefined;
  if (diff && !diff.code) {
    const at = now.toISOString();
    const base = str(diff.base_version);
    const add = (rows: unknown, kind: string, verb: string) => {
      for (const r of (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>) {
        const name = [str(r.category), str(r.name)].filter(Boolean).join(": ") || `element ${str(r.id)}`;
        out.push({ at, source: "revit", kind, what: `${verb} since version ${base.slice(0, 8)}: ${name} (${str(r.id)})${r.exists === false ? ", no longer in the model" : ""}`,
          who: str(r.last_changed_by) || str(r.creator), document: doc,
          detail: { id: r.id, unique_id: r.unique_id, creator: r.creator, last_changed_by: r.last_changed_by, owner: r.owner, since_version: base, as_of: true } });
      }
    };
    add(diff.created, "element_created", "Created");
    add(diff.modified, "element_modified", "Modified");
    for (const id of (Array.isArray(diff.deleted_ids) ? diff.deleted_ids : []) as unknown[])
      out.push({ at, source: "revit", kind: "element_deleted", what: `Deleted since version ${base.slice(0, 8)}: element ${str(id)}`, who: "", document: doc,
        detail: { id, since_version: base, as_of: true } });
  }
  return out;
}

/** fmc_changes flags as entries, stamped with the time of the check (they are a snapshot, not a past event). */
export function flowEntries(flags: unknown[], now: Date): FeedEntry[] {
  return (flags as Array<Record<string, unknown>>).filter((f) => f && typeof f === "object").map((f) => ({
    at: now.toISOString(), source: "flows" as const, kind: "flag", what: `${str(f.what)}${f.why ? ": " + str(f.why) : ""}`, who: "",
    detail: { flag_kind: f.kind, affects: f.affects, update: f.update, as_of: true },
  }));
}

export interface FeedWindow { since?: string; until?: string; project?: string; document?: string }

/** Keeps entries in the time window, for the project (when one is given and the entry names one) and the document. */
export function filterFeed(entries: FeedEntry[], w: FeedWindow): FeedEntry[] {
  const since = w.since ? Date.parse(w.since) : NaN;
  const until = w.until ? Date.parse(w.until) : NaN;
  const project = (w.project ?? "").trim().toUpperCase();
  return entries.filter((e) => {
    const t = Date.parse(e.at);
    if (!Number.isNaN(since) && t < since) return false;
    if (!Number.isNaN(until) && t > until) return false;
    if (project && e.project && e.project.toUpperCase() !== project) return false;
    if (w.document && e.document && !sameDocument(e.document, w.document)) return false;
    return true;
  });
}

/** Newest first; ties keep the source order. */
export function sortFeed(entries: FeedEntry[]): FeedEntry[] {
  return entries.map((e, i) => ({ e, i })).sort((a, b) => (a.e.at < b.e.at ? 1 : a.e.at > b.e.at ? -1 : a.i - b.i)).map((x) => x.e);
}

/** The cursor is the offset into the sorted feed, as text ("o:100"). */
export function pageFeed(entries: FeedEntry[], limit: number, cursor = ""): { entries: FeedEntry[]; next_cursor: string | null; offset: number } {
  const m = /^o:(\d+)$/.exec(cursor.trim());
  const offset = m ? Number(m[1]) : 0;
  const page = entries.slice(offset, offset + limit);
  const next = offset + page.length < entries.length ? `o:${offset + page.length}` : null;
  return { entries: page, next_cursor: next, offset };
}

/** Counts per source and kind. Never per person (rule 9: activity is never used to rank people). */
export function feedCounts(entries: FeedEntry[]): { by_source: Record<string, number>; by_kind: Record<string, number> } {
  const by_source: Record<string, number> = {};
  const by_kind: Record<string, number> = {};
  for (const e of entries) { by_source[e.source] = (by_source[e.source] ?? 0) + 1; by_kind[e.kind] = (by_kind[e.kind] ?? 0) + 1; }
  return { by_source, by_kind };
}
