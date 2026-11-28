/**
 * select_by filter engine, storage (build plan item 32, FILTER_TOOL_SPEC.md section 7).
 *
 * Saved sets and history live in a JSON sidecar per document under %LOCALAPPDATA%\Formcraft\filters\<docKey>\
 * (no model change, so it works on live models and detached copies). Emlyn 28 Nov, decision 2: saved sets are also
 * shared through the project's exchange folder (<project>\01_WIP\_Exchange\filters\<docKey>\<set>.json), read-only
 * for other bots: only the bot that saved a shared set may replace or delete it, and the file is marked read-only.
 * Writes go through a temp file and a rename. A file that doesn't parse is moved aside, never overwritten.
 * History holds counts and the query only (the ledger rule: no model content).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { readDocumentKey } from "./readcache.js";

export const HISTORY_MAX = 200;
export const SETS_MAX = 500;
export const SET_BYTES_MAX = 64 * 1024;

export class FilterStoreError extends Error {
  constructor(readonly code: string, message: string, readonly hint = "") {
    super(`[${code}] ${message}`);
    this.name = "FilterStoreError";
  }
}

export interface FilterQuery {
  criteria?: unknown;
  scope?: unknown;
  invert?: boolean;
  missing?: string;
  types?: boolean;
}

export interface SavedSet extends FilterQuery {
  id: string;
  name: string;
  note?: string;
  created: string;
  updated?: string;
  by: string;
  last_total?: number;
  last_run?: string;
  /** Where a listed set came from: this machine, or the project's exchange folder. */
  shared?: boolean;
  read_only?: boolean;
  shared_path?: string;
}

export interface HistoryLine extends FilterQuery {
  id: string;
  at: string;
  query_hash: string;
  result_set?: string;
  action: string;
  total: number;
  undetermined?: number;
  skipped?: number;
  ms?: number;
  by: string;
}

/** EAT-style local time with its offset (the user's clock is Africa/Nairobi, +03:00). */
export function stamp(now: Date = new Date()): string {
  const off = -now.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const local = new Date(now.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

/** readDocumentKey(title or path) + "-" + 8 hex of the full path, so two models with one title don't share sets. */
export function filterDocKey(title: string, docPath: string): string {
  const full = (docPath || title || "active").trim().toLowerCase().replace(/\//g, "\\");
  const base = readDocumentKey(docPath || title || "active").replace(/[^a-z0-9._-]+/gi, "_");
  return `${base}-${createHash("sha1").update(full).digest("hex").slice(0, 8)}`;
}

export function filtersRoot(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || env.HOME || ".", "AppData", "Local");
  return path.join(local, "Formcraft", "filters");
}

/** A set name as a file name: unsafe characters replaced, case kept, trimmed. */
export function safeName(name: string): string {
  const s = name.trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/\s+/g, " ").slice(0, 120);
  return s || "set";
}

function newId(prefix: string): string {
  return prefix + randomBytes(6).toString("hex");
}

/** Write through a temp file and a rename (no half-written JSON). A read-only target is made writable first. */
export function atomicWrite(file: string, text: string, readOnly = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmp, text, "utf8");
  if (fs.existsSync(file)) { try { fs.chmodSync(file, 0o644); } catch { /* the rename reports it */ } }
  fs.renameSync(tmp, file);
  if (readOnly) { try { fs.chmodSync(file, 0o444); } catch { /* best effort */ } }
}

/** Parse a JSON file; a broken one is moved aside to <file>.bad-<time> and FMC-FILTER-STORE-CORRUPT is thrown. */
export function readJson<T>(file: string, empty: T, now: Date = new Date()): T {
  if (!fs.existsSync(file)) return empty;
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  try {
    return JSON.parse(text) as T;
  } catch {
    const aside = `${file}.bad-${stamp(now).replace(/[:]/g, "").replace(/\+.*/, "")}`;
    try { fs.chmodSync(file, 0o644); } catch { /* ignore */ }
    fs.renameSync(file, aside);
    throw new FilterStoreError("FMC-FILTER-STORE-CORRUPT", `${path.basename(file)} did not parse; it was moved aside to ${path.basename(aside)}`,
      "tell the person; the sets can be rebuilt from history");
  }
}

export interface StoreOptions {
  root?: string;
  /** <project>\01_WIP\_Exchange (decision 2); empty: the document is not in a project, so sets stay on this machine. */
  exchange?: string;
  /** May the tool write into the exchange folder? (checkWritePath with checkName false). Reasons when not. */
  canShare?: (file: string) => { ok: boolean; reasons: string[] };
  now?: () => Date;
}

export class FilterStore {
  readonly dir: string;
  readonly sharedDir: string;
  private readonly now: () => Date;

  constructor(readonly docKey: string, private readonly opts: StoreOptions = {}) {
    this.dir = path.join(opts.root ?? filtersRoot(), docKey);
    this.sharedDir = opts.exchange ? path.join(opts.exchange, "filters", docKey) : "";
    this.now = opts.now ?? (() => new Date());
  }

  get setsFile() { return path.join(this.dir, "sets.json"); }
  get historyFile() { return path.join(this.dir, "history.jsonl"); }

  private localSets(): SavedSet[] {
    const doc = readJson<{ version: number; sets: SavedSet[] }>(this.setsFile, { version: 1, sets: [] }, this.now());
    return Array.isArray(doc.sets) ? doc.sets : [];
  }

  private writeLocal(sets: SavedSet[]): void {
    atomicWrite(this.setsFile, JSON.stringify({ version: 1, sets }, null, 2));
  }

  /** Sets in the project's exchange folder (every bot's), each read-only unless this bot saved it. */
  sharedSets(me: string): SavedSet[] {
    if (!this.sharedDir || !fs.existsSync(this.sharedDir)) return [];
    const out: SavedSet[] = [];
    for (const f of fs.readdirSync(this.sharedDir).filter((n) => n.toLowerCase().endsWith(".json"))) {
      const file = path.join(this.sharedDir, f);
      try {
        const s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as SavedSet;
        if (!s || typeof s.name !== "string") continue;
        out.push({ ...s, shared: true, read_only: s.by !== me, shared_path: file });
      } catch {
        // a broken shared file belongs to another bot: listed, never moved or overwritten by this one
        out.push({ id: "", name: f.replace(/\.json$/i, ""), created: "", by: "?", shared: true, read_only: true, shared_path: file, note: "does not parse" });
      }
    }
    return out;
  }

  /** Local sets, then shared sets not already here (by name). */
  list(me: string): SavedSet[] {
    const local = this.localSets().map((s) => ({ ...s, shared: false, read_only: false }));
    const names = new Set(local.map((s) => s.name.toLowerCase()));
    return [...local, ...this.sharedSets(me).filter((s) => !names.has(s.name.toLowerCase()))];
  }

  find(nameOrId: string, me: string): SavedSet | undefined {
    const key = nameOrId.trim().toLowerCase();
    return this.list(me).find((s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key);
  }

  /**
   * Save a set. Names are unique per document, case-insensitive; overwrite is needed to replace one.
   * Shared copy: written to the exchange folder when allowed, read-only for other bots (decision 2).
   */
  save(input: FilterQuery & { name: string; note?: string; total?: number }, me: string, overwrite = false, share = true): { set: SavedSet; shared: boolean; share_note: string } {
    const name = input.name.trim();
    if (!name) throw new FilterStoreError("FMC-FILTER-BAD-CRITERIA", "a set needs a name");
    const sets = this.localSets();
    const clash = sets.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    const sharedClash = this.sharedSets(me).find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (sharedClash && sharedClash.read_only)
      throw new FilterStoreError("FMC-FILTER-SET-READONLY", `the shared set "${sharedClash.name}" belongs to ${sharedClash.by}; other bots may read it, not replace it`, "save under another name");
    if ((clash >= 0 || sharedClash) && !overwrite)
      throw new FilterStoreError("FMC-FILTER-SET-EXISTS", `a set named "${name}" exists`, "use overwrite: true, or another name");
    if (clash < 0 && sets.length >= SETS_MAX) throw new FilterStoreError("FMC-FILTER-TOO-BROAD", `${SETS_MAX} sets is the limit for one document`, "delete_set some first");
    const at = stamp(this.now());
    const prev = clash >= 0 ? sets[clash] : undefined;
    const set: SavedSet = {
      id: prev?.id ?? newId("set_"), name, note: input.note ?? prev?.note, created: prev?.created ?? at, updated: prev ? at : undefined, by: me,
      criteria: input.criteria, scope: input.scope ?? {}, invert: input.invert === true, missing: input.missing ?? "report", types: input.types,
      last_total: input.total, last_run: input.total === undefined ? undefined : at,
    };
    const text = JSON.stringify(set);
    if (Buffer.byteLength(text, "utf8") > SET_BYTES_MAX) throw new FilterStoreError("FMC-FILTER-TOO-BROAD", `the set is over ${SET_BYTES_MAX / 1024} KB`, "save a smaller query (ids lists belong in a result set, not a set)");
    if (clash >= 0) sets[clash] = set; else sets.push(set);
    this.writeLocal(sets);
    let shared = false;
    let note = "kept on this machine";
    if (share && this.sharedDir) {
      const file = path.join(this.sharedDir, `${safeName(name)}.json`);
      const verdict = this.opts.canShare ? this.opts.canShare(file) : { ok: true, reasons: [] };
      if (verdict.ok) {
        atomicWrite(file, JSON.stringify(set, null, 2), true);
        shared = true;
        note = `shared, read-only for other bots: ${file}`;
      } else note = `not shared (${verdict.reasons.join("; ")}): kept on this machine`;
    } else if (share) note = "not shared: the model is not in a project folder (no 01_WIP), kept on this machine";
    return { set, shared, share_note: note };
  }

  /** Delete a set: a local one, and the shared copy when this bot saved it. Another bot's shared set is refused. */
  remove(nameOrId: string, me: string): { removed: string; shared_removed: boolean } {
    const key = nameOrId.trim().toLowerCase();
    const sets = this.localSets();
    const i = sets.findIndex((s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key);
    const shared = this.sharedSets(me).find((s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key);
    if (i < 0 && !shared) throw new FilterStoreError("FMC-FILTER-SET-NOT-FOUND", `no set "${nameOrId}"`, "sets lists them");
    if (shared && shared.read_only)
      throw new FilterStoreError("FMC-FILTER-SET-READONLY", `the shared set "${shared.name}" belongs to ${shared.by}; other bots may read it, not delete it`, "ask that bot or the person");
    const name = i >= 0 ? sets[i].name : shared!.name;
    if (i >= 0) { sets.splice(i, 1); this.writeLocal(sets); }
    let sharedRemoved = false;
    if (shared?.shared_path && fs.existsSync(shared.shared_path)) {
      // never deleted: moved to _Archive beside it (CLAUDE.md rule 2, nothing is deleted)
      const archive = path.join(path.dirname(shared.shared_path), "_Archive");
      fs.mkdirSync(archive, { recursive: true });
      try { fs.chmodSync(shared.shared_path, 0o644); } catch { /* ignore */ }
      fs.renameSync(shared.shared_path, path.join(archive, `${stamp(this.now()).replace(/[:]/g, "").slice(0, 15)}_${path.basename(shared.shared_path)}`));
      sharedRemoved = true;
    }
    return { removed: name, shared_removed: sharedRemoved };
  }

  /** One line per preview or run; the last 200 are kept. */
  addHistory(line: Omit<HistoryLine, "id" | "at"> & { at?: string }): HistoryLine {
    const full: HistoryLine = { id: newId("h_"), at: line.at ?? stamp(this.now()), ...line } as HistoryLine;
    const lines = this.historyLines();
    lines.push(full);
    const kept = lines.slice(-HISTORY_MAX);
    atomicWrite(this.historyFile, kept.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return full;
  }

  /** History, oldest first. A line that doesn't parse is skipped and counted, never silently: see historyProblems. */
  historyLines(): HistoryLine[] {
    if (!fs.existsSync(this.historyFile)) return [];
    const out: HistoryLine[] = [];
    this.badLines = 0;
    for (const raw of fs.readFileSync(this.historyFile, "utf8").split(/\r?\n/)) {
      if (!raw.trim()) continue;
      try { out.push(JSON.parse(raw) as HistoryLine); } catch { this.badLines++; }
    }
    return out;
  }

  badLines = 0;

  historyById(id: string): HistoryLine | undefined {
    return this.historyLines().find((l) => l.id === id);
  }

  /** The newest history line for a query hash or a result set (cursor resume, save_set from a result set). */
  latestFor(key: { query_hash?: string; result_set?: string }): HistoryLine | undefined {
    const lines = this.historyLines();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (key.result_set && lines[i].result_set === key.result_set) return lines[i];
      if (key.query_hash && lines[i].query_hash === key.query_hash) return lines[i];
    }
    return undefined;
  }

  /** Records the last total on a local set after a live re-run. */
  touchSet(name: string, total: number): void {
    const sets = this.localSets();
    const s = sets.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s) return;
    s.last_total = total;
    s.last_run = stamp(this.now());
    this.writeLocal(sets);
  }
}
