/**
 * select_by filter engine, server side (build plan item 32, FILTER_TOOL_SPEC.md; Emlyn 28 Nov 09:57 decisions).
 *
 * select_by is upgraded in place, in line with the hub's revit_select_by (decision 5; ai_element_filter retires).
 * A flat call (category, level, param... and no engine argument) answers exactly as before. With an action:
 *   preview | run | page | explain   -> the add-in's fmc_select_by (reads: no lease, no AI gate)
 *   show                              -> fmc_select_by_show (Revit's selection only), refused while another bot holds
 *                                        the document's lease (decision 3)
 *   export                            -> CSV or JSON, streamed from the add-in in 500-row chunks
 *   save_set | sets | delete_set      -> the sidecar store; sets shared read-only via the project exchange (decision 2)
 *   history                           -> past queries (counts and the query only)
 */
import fs from "node:fs";
import path from "node:path";
import { FilterStore, FilterStoreError, filterDocKey, stamp, type FilterQuery, type SavedSet } from "./filterstore.js";
import { checkWritePath, csvLine, expandEnv, type GuardConfig } from "./policy.js";

export const ENGINE_KEYS = ["action", "criteria", "cursor", "result_set", "scope", "invert", "set", "history_id"] as const;
export const ACTIONS = ["preview", "run", "page", "show", "export", "save_set", "sets", "delete_set", "history", "explain"] as const;
export type FilterAction = typeof ACTIONS[number];

export const EXPORT_ROWS_MAX = 100_000;
export const EXPORT_BYTES_MAX = 50 * 1024 * 1024;
export const EXPORT_COLUMNS_MAX = 500;
export const CHUNK = 500;

export type Send = (command: string, params: Record<string, unknown>) => Promise<any>;

export interface FilterDeps {
  send: Send;
  config: GuardConfig;
  /** The calling bot (MCP client name): owner of the sets it saves. */
  caller: () => string;
  /** The session asking (the lease's client id). */
  client: () => string;
  /** Who holds a document's batch lease now, or null. */
  leaseHolder: (document: string) => { lease: string; client: string } | null;
  /** The kit's filter.* standards (key_params, scan_cap), or null. */
  kit?: () => Record<string, unknown> | null;
  storeRoot?: string;
  now?: () => Date;
  /** Project folder above 01_WIP for a document path ("" when none). */
  projectOf?: (docPath: string) => string;
}

export function isEngineCall(args: Record<string, unknown>): boolean {
  return ENGINE_KEYS.some((k) => args[k] !== undefined);
}

export class FilterError extends Error {
  constructor(readonly code: string, message: string, readonly hint = "", readonly extra: Record<string, unknown> = {}) {
    super(`[${code}] ${message}`);
    this.name = "FilterError";
  }
}

function errorReply(action: string, e: unknown): Record<string, unknown> {
  if (e instanceof FilterError) return { ok: false, action, code: e.code, message: e.message, hint: e.hint, ...e.extra };
  if (e instanceof FilterStoreError) return { ok: false, action, code: e.code, message: e.message, hint: e.hint };
  const message = e instanceof Error ? e.message : String(e);
  const code = /\[(FMC-[A-Z0-9-]+)\]/.exec(message)?.[1] ?? "FMC-TOOL-FAILED";
  return { ok: false, action, code, message };
}

/** The flat select_by keys of a call, as the add-in takes them (they become leaves of one all node). */
const FLAT = ["ids", "category", "level", "type_name", "family", "comment", "mark", "workset", "phase", "view", "room", "box", "box_mm", "near", "hosted_by", "host_of", "param", "exclude", "not", "types"];

function queryOf(args: Record<string, unknown>): FilterQuery & Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const k of ["criteria", "scope", "invert", "missing", ...FLAT]) if (args[k] !== undefined) q[k] = args[k];
  return q;
}

function hasQuery(q: Record<string, unknown>): boolean {
  return q.criteria !== undefined || FLAT.some((k) => k !== "types" && q[k] !== undefined);
}

/** filter.* from the kit's FMC_Standards_Building.json: { value } entries, as joins.* and phase.* are read. */
function kitValue(kit: Record<string, unknown> | null | undefined, key: string): unknown {
  const row = kit?.[key];
  if (row && typeof row === "object" && !Array.isArray(row) && "value" in (row as Record<string, unknown>)) return (row as Record<string, unknown>).value;
  return undefined;
}

export class FilterTool {
  private readonly now: () => Date;
  /** result_set -> the query that made it (save_set and export by result set; history keeps it across restarts). */
  private readonly made = new Map<string, FilterQuery & Record<string, unknown>>();

  constructor(private readonly deps: FilterDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async docOf(args: Record<string, unknown>): Promise<{ title: string; path: string; active?: boolean }> {
    const r = await this.deps.send("fmc_select_by", { action: "doc", ...(args.document ? { document: args.document } : {}) });
    if (!r || r.ok === false) throw new FilterError(r?.code ?? "FMC-DOC-NOT-FOUND", r?.message ?? "the document could not be resolved", r?.hint ?? "pass document with the title or full path");
    return { title: String(r.title ?? ""), path: String(r.path ?? ""), active: r.active === true };
  }

  private storeFor(doc: { title: string; path: string }, global = false): FilterStore {
    const key = global ? "_global" : filterDocKey(doc.title, doc.path);
    const project = this.deps.projectOf ? this.deps.projectOf(doc.path) : "";
    const exchange = project ? path.join(project, "01_WIP", "_Exchange") : "";
    return new FilterStore(key, {
      root: this.deps.storeRoot,
      exchange,
      canShare: (file) => checkWritePath(file, this.deps.config, { checkName: false }),
      now: this.now,
    });
  }

  private isGlobal(q: Record<string, unknown>): boolean {
    const scope = q.scope as Record<string, unknown> | undefined;
    return scope?.documents === "all_open" || Array.isArray(scope?.documents);
  }

  /** set / history_id sources become the stored query (a set re-runs live, so it is never stale). */
  private resolveSource(args: Record<string, unknown>, store: FilterStore): { q: Record<string, unknown>; set?: SavedSet } {
    if (typeof args.set === "string") {
      const set = store.find(args.set, this.deps.caller());
      if (!set) throw new FilterError("FMC-FILTER-SET-NOT-FOUND", `no set "${args.set}"`, "sets lists them");
      return { q: stored(set), set };
    }
    if (typeof args.history_id === "string") {
      const h = store.historyById(args.history_id);
      if (!h) throw new FilterError("FMC-FILTER-SET-NOT-FOUND", `no history entry ${args.history_id}`, "history lists them");
      return { q: stored(h) };
    }
    return { q: queryOf(args) };
  }

  private passThrough(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of ["document", "fields", "params", "page_size", "on_change", "allow_stale"]) if (args[k] !== undefined) out[k] = args[k];
    const kit = this.deps.kit?.() ?? null;
    const keyParams = kitValue(kit, "filter.key_params");
    if (keyParams && typeof keyParams === "object") out.key_params = keyParams;
    const scanCap = kitValue(kit, "filter.scan_cap");
    if (typeof scanCap === "number") out.scan_cap = scanCap;
    return out;
  }

  async run(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = (typeof args.action === "string" ? args.action : (args.cursor ? "page" : "preview")) as FilterAction;
    try {
      if (!(ACTIONS as readonly string[]).includes(action)) throw new FilterError("FMC-FILTER-BAD-CRITERIA", `unknown action "${action}"`, ACTIONS.join(", "));
      switch (action) {
        case "preview": case "run": case "explain": return await this.query(action, args);
        case "page": return await this.page(args);
        case "show": return await this.show(args);
        case "export": return await this.export(args);
        case "save_set": return await this.saveSet(args);
        case "sets": return await this.sets(args);
        case "delete_set": return await this.deleteSet(args);
        case "history": return await this.history(args);
      }
    } catch (e) {
      return errorReply(action, e);
    }
    return { ok: false, action, code: "FMC-FILTER-BAD-CRITERIA", message: "unreachable" };
  }

  private sources(args: Record<string, unknown>): number {
    const q = queryOf(args);
    return [hasQuery(q), typeof args.set === "string", typeof args.history_id === "string", typeof args.result_set === "string"].filter(Boolean).length;
  }

  private async query(action: "preview" | "run" | "explain", args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const n = this.sources(args);
    if (n === 0) throw new FilterError("FMC-FILTER-BAD-CRITERIA", `${action} needs a source: criteria (or flat keys), set, history_id or result_set`, "e.g. {\"action\":\"preview\",\"criteria\":{\"category\":\"OST_Doors\"}}");
    if (n > 1) throw new FilterError("FMC-FILTER-BAD-CRITERIA", "give exactly one source: criteria (or flat keys), set, history_id or result_set");
    const started = this.now().getTime();
    const doc = await this.docOf(args);
    const probe = queryOf(args);
    const store = this.storeFor(doc, this.isGlobal(probe));
    let q: Record<string, unknown> = {};
    let set: SavedSet | undefined;
    if (typeof args.result_set === "string" && action !== "explain") {
      q = {};
    } else {
      ({ q, set } = this.resolveSource(args, store));
    }
    const params: Record<string, unknown> = { action, ...q, ...this.passThrough(args) };
    if (typeof args.result_set === "string") params.result_set = args.result_set;
    const r = await this.deps.send("fmc_select_by", params);
    if (!r || r.ok === false) return { ...(r ?? {}), ok: false, action };
    if (action !== "explain" && hasQuery(q)) {
      if (typeof r.result_set === "string") this.made.set(r.result_set, q);
      try {
        const h = store.addHistory({
          action, query_hash: String(r.query_hash ?? ""), result_set: typeof r.result_set === "string" ? r.result_set : undefined,
          criteria: q.criteria ?? flatCriteria(q), scope: q.scope, invert: q.invert === true, missing: typeof q.missing === "string" ? q.missing : undefined,
          types: q.types === true ? true : undefined,
          total: Number(r.total ?? 0), undetermined: num(r.undetermined_total ?? r.undetermined), skipped: num(r.skipped_total ?? r.skipped),
          ms: this.now().getTime() - started, by: this.deps.caller(),
        });
        r.history_id = h.id;
        if (set) store.touchSet(set.name, Number(r.total ?? 0));
      } catch (e) {
        (r.warnings ??= []).push(`history not written: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (set) r.set = { name: set.name, id: set.id, shared: set.shared === true, by: set.by };
    return r;
  }

  private async page(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof args.cursor !== "string") throw new FilterError("FMC-FILTER-BAD-CRITERIA", "page needs cursor (from the previous answer)", "follow the cursor until it is null");
    const params: Record<string, unknown> = { action: "page", cursor: args.cursor, ...queryOf(args), ...this.passThrough(args) };
    let r = await this.deps.send("fmc_select_by", params);
    if (r && r.ok === false && r.code === "FMC-FILTER-CURSOR-EXPIRED" && !hasQuery(queryOf(args))) {
      // spec 5.6: the snapshot was dropped; the query comes back from history and the add-in resumes after the last id
      const doc = await this.docOf(args);
      const h = this.storeFor(doc).latestFor({ query_hash: String(r.query_hash ?? "") }) ?? this.storeFor(doc, true).latestFor({ query_hash: String(r.query_hash ?? "") });
      if (!h) return { ...r, action: "page", hint: "the query is not in history: run it again" };
      const again: Record<string, unknown> = { ...params, ...stored(h) };
      r = await this.deps.send("fmc_select_by", again);
    }
    if (r && r.ok !== false && typeof r.result_set === "string" && !this.made.has(r.result_set) && hasQuery(queryOf(args))) this.made.set(r.result_set, queryOf(args));
    return { ...(r ?? {}), action: "page" };
  }

  private async show(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof args.result_set !== "string" && !Array.isArray(args.ids))
      throw FilterException("show needs result_set (from run or preview) or ids");
    const doc = await this.docOf(args);
    if (!doc.active) throw new FilterError("FMC-FILTER-UI-NEEDS-ACTIVE", `${doc.title} is open in the background; selecting needs the active document`, "ask the person to activate the model");
    // decision 3: refused while another bot holds the lease on this document
    for (const name of [doc.path, doc.title].filter(Boolean)) {
      let holder: { lease: string; client: string } | null = null;
      try { holder = this.deps.leaseHolder(name); } catch { holder = null; }
      if (holder && holder.client !== this.deps.client())
        throw new FilterError("FMC-FILTER-SHOW-BUSY", `another bot holds the batch lease on ${doc.title} (lease ${holder.lease}); the selection is not changed under its batch`, "wait for the lease to be released, then show again");
    }
    const show = (args.show ?? {}) as Record<string, unknown>;
    const params: Record<string, unknown> = { document: doc.path || doc.title, show };
    if (typeof args.result_set === "string") params.result_set = args.result_set;
    if (Array.isArray(args.ids)) params.ids = args.ids;
    if (args.allow_stale === true) params.allow_stale = true;
    const r = await this.deps.send("fmc_select_by_show", params);
    return { ...(r ?? {}), action: "show", activity: "ui" };
  }

  private async resultSetFor(args: Record<string, unknown>): Promise<{ rs: string; q?: Record<string, unknown>; total: number; doc: { title: string; path: string } }> {
    const doc = await this.docOf(args);
    if (typeof args.result_set === "string") return { rs: args.result_set, q: this.made.get(args.result_set), total: -1, doc };
    const r = await this.query("preview", { ...args, action: "preview" });
    if (r.ok === false) throw new FilterError(String(r.code ?? "FMC-TOOL-FAILED"), String(r.message ?? "preview failed"), String(r.hint ?? ""));
    if (typeof r.result_set !== "string") throw new FilterError("FMC-FILTER-TOO-BROAD", `${r.total} matches: no result set to export`, "narrow it: add a category, level or view");
    return { rs: r.result_set, q: this.made.get(r.result_set), total: Number(r.total ?? 0), doc };
  }

  /** spec 8: <reports_dir>\Filters\<docKey>\<yyyyMMdd-HHmmss>_<set or query>.<ext>, or a path that passes checkWritePath. */
  exportPath(args: Record<string, unknown>, doc: { title: string; path: string }, label: string, ext: string): string {
    const exp = (args.export ?? {}) as Record<string, unknown>;
    if (typeof exp.path === "string" && exp.path.trim()) {
      const target = expandEnv(exp.path.trim());
      const v = checkWritePath(target, this.deps.config, { checkName: false });
      if (!v.ok) throw new FilterError("FMC-FILTER-EXPORT-PATH", `the export path is refused: ${v.reasons.join("; ")}`, "leave path out (the reports folder is used) or give a path inside write_roots", { reasons: v.reasons });
      return target;
    }
    const n = this.now();
    const pad = (x: number) => String(x).padStart(2, "0");
    const ts = `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}`;
    const safe = label.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").slice(0, 80);
    return path.join(expandEnv(this.deps.config.reports_dir), "Filters", filterDocKey(doc.title, doc.path), `${ts}_${safe}.${ext}`);
  }

  private async export(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const exp = (args.export ?? {}) as Record<string, unknown>;
    const format = exp.format === "json" ? "json" : "csv";
    const params = exp.params ?? args.params ?? "all";
    const { rs, q, doc } = await this.resultSetFor(args);
    const label = typeof args.set === "string" ? args.set : rs;
    const file = this.exportPath(args, doc, label, format);
    const rows: Record<string, unknown>[] = [];
    let meta: Record<string, unknown> = {};
    let undetermined: unknown[] = [];
    let skipped: unknown[] = [];
    const warnings: string[] = [];
    let total = 0;
    let bytes = 0;
    for (let from = 0; ; from += CHUNK) {
      const r = await this.deps.send("fmc_select_by", { action: "rows", result_set: rs, from, count: CHUNK, params, fields: args.fields, on_change: args.on_change, ...(args.document ? { document: args.document } : {}) });
      if (!r || r.ok === false) return { ...(r ?? {}), ok: false, action: "export" };
      total = Number(r.total ?? 0);
      if (from === 0) {
        if (total > EXPORT_ROWS_MAX) throw new FilterError("FMC-FILTER-EXPORT-TOO-LARGE", `${total} rows, over the export cap ${EXPORT_ROWS_MAX}`, "narrow the set");
        meta = (r.meta ?? {}) as Record<string, unknown>;
        undetermined = Array.isArray(r.all_undetermined) ? r.all_undetermined : [];
        skipped = Array.isArray(r.all_skipped) ? [...r.all_skipped] : [];
      }
      for (const e of (Array.isArray(r.elements) ? r.elements : [])) {
        rows.push(e);
        bytes += Buffer.byteLength(JSON.stringify(e), "utf8");
      }
      if (Array.isArray(r.skipped)) skipped.push(...r.skipped);
      for (const w of (Array.isArray(r.warnings) ? r.warnings : [])) if (!warnings.includes(String(w))) warnings.push(String(w));
      if (bytes > EXPORT_BYTES_MAX) throw new FilterError("FMC-FILTER-EXPORT-TOO-LARGE", `over ${EXPORT_BYTES_MAX / 1024 / 1024} MB`, "export fewer params, or narrow the set");
      if (r.done === true || !Array.isArray(r.elements) || r.elements.length === 0) break;
    }
    const written: string[] = [];
    if (format === "json") {
      const body = { meta: { ...meta, query: meta.query ?? q, total, skipped_by_reason: byReason(skipped), exported_at: stamp(this.now()) }, elements: rows, skipped, undetermined };
      writeFileAtomic(file, JSON.stringify(body, null, 2));
      written.push(file);
    } else {
      const { text, dropped } = toCsv(rows);
      if (dropped.length) warnings.push(`over ${EXPORT_COLUMNS_MAX} columns: left out ${dropped.length} (${dropped.slice(0, 10).join(", ")}${dropped.length > 10 ? ", ..." : ""})`);
      writeFileAtomic(file, text);
      written.push(file);
      const side = file.replace(/\.csv$/i, "_skipped.csv");
      writeFileAtomic(side, reasonsCsv(undetermined, skipped));
      written.push(side);
    }
    return {
      ok: true, action: "export", result_set: rs, format, rows: rows.length, total, files: written,
      undetermined: undetermined.length, skipped: skipped.length, skipped_by_reason: byReason(skipped), warnings,
    };
  }

  private async saveSet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const spec = (typeof args.set === "object" && args.set !== null ? args.set : {}) as Record<string, unknown>;
    const name = typeof spec.name === "string" ? spec.name : typeof args.name === "string" ? args.name : "";
    if (!name.trim()) throw new FilterError("FMC-FILTER-BAD-CRITERIA", "save_set needs set: {name}", "e.g. {\"action\":\"save_set\",\"result_set\":\"rs_...\",\"set\":{\"name\":\"Ext walls L2\"}}");
    const doc = await this.docOf(args);
    let q: Record<string, unknown> | undefined;
    let total: number | undefined;
    if (typeof args.result_set === "string") {
      q = this.made.get(args.result_set);
      const probeStore = this.storeFor(doc);
      const h = q ? undefined : probeStore.latestFor({ result_set: args.result_set }) ?? this.storeFor(doc, true).latestFor({ result_set: args.result_set });
      if (!q && h) { q = stored(h); total = h.total; }
      if (!q) throw new FilterError("FMC-FILTER-SET-NOT-FOUND", `result set ${args.result_set} is not known to this server`, "save_set with criteria, or run the query again");
    } else {
      q = queryOf(args);
      if (!hasQuery(q)) throw new FilterError("FMC-FILTER-BAD-CRITERIA", "save_set needs result_set or criteria");
      if (!q.criteria) q = { ...q, criteria: flatCriteria(q) };
    }
    const store = this.storeFor(doc, this.isGlobal(q));
    const share = spec.share !== false;
    const saved = store.save({ name, note: typeof spec.note === "string" ? spec.note : undefined, criteria: q.criteria ?? flatCriteria(q), scope: q.scope, invert: q.invert === true, missing: q.missing as string | undefined, types: q.types === true ? true : undefined, total }, this.deps.caller(), spec.overwrite === true, share);
    return { ok: true, action: "save_set", set: saved.set, shared: saved.shared, share_note: saved.share_note, store: store.setsFile };
  }

  private async sets(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const doc = await this.docOf(args);
    const me = this.deps.caller();
    const here = this.storeFor(doc).list(me);
    const global = this.storeFor(doc, true).list(me).map((s) => ({ ...s, global: true }));
    return { ok: true, action: "sets", doc: doc.title, sets: [...here, ...global].map(view), count: here.length + global.length };
  }

  private async deleteSet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = typeof args.set === "string" ? args.set : typeof (args.set as Record<string, unknown>)?.name === "string" ? String((args.set as Record<string, unknown>).name) : "";
    if (!name) throw new FilterError("FMC-FILTER-BAD-CRITERIA", "delete_set needs set: the name or id");
    const doc = await this.docOf(args);
    const me = this.deps.caller();
    for (const store of [this.storeFor(doc), this.storeFor(doc, true)]) {
      if (store.find(name, me)) return { ok: true, action: "delete_set", ...store.remove(name, me) };
    }
    throw new FilterError("FMC-FILTER-SET-NOT-FOUND", `no set "${name}"`, "sets lists them");
  }

  private async history(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const doc = await this.docOf(args);
    const limit = Math.max(1, Math.min(Number(args.limit ?? 20) || 20, 200));
    const lines = [...this.storeFor(doc).historyLines(), ...this.storeFor(doc, true).historyLines()].sort((a, b) => a.at.localeCompare(b.at));
    return { ok: true, action: "history", doc: doc.title, history: lines.slice(-limit).reverse(), count: lines.length };
  }
}

/** A stored query back as call arguments: a flat select_by query was kept as {flat: {...}} and comes back flat. */
function stored(s: FilterQuery): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const c = s.criteria as Record<string, unknown> | undefined;
  if (c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 1 && c.flat && typeof c.flat === "object") Object.assign(q, c.flat);
  else if (c !== undefined) q.criteria = c;
  if (s.scope !== undefined) q.scope = s.scope;
  if (s.invert === true) q.invert = true;
  if (typeof s.missing === "string") q.missing = s.missing;
  if (s.types === true) q.types = true;
  return q;
}

/** A flat query kept for history and sets as {flat: {...}} (the add-in maps the flat keys to leaves when it runs). */
function flatCriteria(q: Record<string, unknown>): unknown {
  const flat: Record<string, unknown> = {};
  for (const k of FLAT) if (q[k] !== undefined && k !== "types") flat[k] = q[k];
  return Object.keys(flat).length ? { flat } : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : Array.isArray(v) ? v.length : undefined;
}

function view(s: SavedSet & { global?: boolean }) {
  return { id: s.id, name: s.name, note: s.note, by: s.by, created: s.created, updated: s.updated, last_total: s.last_total, last_run: s.last_run, shared: s.shared === true, read_only: s.read_only === true, global: s.global === true, criteria: s.criteria, scope: s.scope, invert: s.invert };
}

export function byReason(rows: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const reason = String((r as Record<string, unknown>)?.reason ?? "UNKNOWN");
    out[reason] = (out[reason] ?? 0) + 1;
  }
  return out;
}

function cell(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("name" in o && ("id" in o || "instance_id" in o)) return String(o.name ?? "");
    return JSON.stringify(v);
  }
  return String(v);
}

const BASE_COLUMNS = ["id", "unique_id", "name", "category", "bic", "family", "type", "type_id", "level", "doc", "doc_path", "link"];

/** Rows as CSV: the fixed fields, then the union of parameter names (capped at 500 columns, overflow named). */
export function toCsv(rows: Record<string, unknown>[]): { text: string; dropped: string[] } {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys((r.params ?? {}) as Record<string, unknown>)) if (!seen.has(k)) { seen.add(k); names.push(k); }
  const room = Math.max(0, EXPORT_COLUMNS_MAX - BASE_COLUMNS.length);
  const kept = names.slice(0, room);
  const dropped = names.slice(room);
  let text = csvLine([...BASE_COLUMNS, ...kept]);
  for (const r of rows) {
    const ps = (r.params ?? {}) as Record<string, unknown>;
    text += csvLine([...BASE_COLUMNS.map((c) => cell(r[c])), ...kept.map((k) => cell(ps[k]))]);
  }
  return { text, dropped };
}

export function reasonsCsv(undetermined: unknown[], skipped: unknown[]): string {
  let text = csvLine(["bucket", "id", "doc", "link", "category", "reason", "param", "detail"]);
  const line = (bucket: string, r: Record<string, unknown>) =>
    csvLine([bucket, cell(r.id), cell(r.doc), cell(r.link), cell(r.category), cell(r.reason), cell(r.param), cell(r.detail)]);
  for (const r of undetermined) text += line("undetermined", r as Record<string, unknown>);
  for (const r of skipped) text += line("skipped", r as Record<string, unknown>);
  return text;
}

function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function FilterException(message: string): FilterError {
  return new FilterError("FMC-FILTER-BAD-CRITERIA", message);
}
