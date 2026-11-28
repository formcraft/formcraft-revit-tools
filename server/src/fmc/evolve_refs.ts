/**
 * fmc_family_evolve, after an apply (tracker F127): repoint the library index and any staging catalogue to the new version,
 * and a read-only "where used" plan. Pure: every file read, write, lease and AI fact comes in through RefsIo, so the flow is
 * tested without Revit or a project.
 *
 * Rules (owner's narrow spec via Plugin Bot, 28 Nov):
 *  - the old version stays listed as superseded, never deleted;
 *  - where used reads only metadata: records the plugin itself wrote under a project's 01_WIP (room records, the recipe tree,
 *    placed records) and the list of open documents. It never opens a project file (.rvt) or any file that is not .json or
 *    .jsonl, and it writes nothing in a project. The reload itself is a person's step;
 *  - apply is a dry run unless asked, needs a confirm token from the dry run, a held batch lease and the AI gate
 *    (fmc_guard.json ai_modeller: on, and Stop AI off), and writes only inside the write roots under staging or the library.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { GuardConfig, checkWritePath, isInside } from "./policy.js";

const win = path.win32;

export const INDEX_SCHEMA = "fmc-evolve-index/1";
export const INDEX_NAME = "FMC_Evolve_Index.json";
export type EntryKind = "original" | "version";
export interface IndexEntry {
  version: string; file: string; name: string; sha256: string | null; kind: EntryKind; status: "current" | "superseded";
  at: string; token?: string; backup?: string; superseded_by?: string; superseded_at?: string;
}
export interface EvolveIndex {
  schema: string; updated: string;
  families: Record<string, { entries: IndexEntry[] }>;
  history: Array<{ at: string; family: string; version: string; file: string; token: string; lease: string; client: string }>;
}

/** The index sits in the staging root's _Evolve folder, which every staging scanner skips (F127). */
export const indexFile = (stagingRoot: string) => win.join(stagingRoot, "_Evolve", INDEX_NAME);

export interface RefsIo {
  config: GuardConfig;
  now(): Date;
  exists(p: string): boolean;
  sha256(p: string): string | null;
  readText(p: string): string | null;
  writeText(p: string, text: string): void;
  mkdir(dir: string): void;
  /** File names and folder names in one folder (not recursive). */
  files(dir: string): string[];
  dirs(dir: string): string[];
  /** The documents open in Revit (the instance files; no Revit call). */
  openDocuments(): Array<{ title: string; path: string; workshared?: boolean; family?: boolean }>;
  /** The batch lease this call carries (null: none) and the documents the board holds under it (empty: not held here). */
  lease(): { id: string; documents: string[] } | null;
  /** The AI gate's facts: null when fmc_guard.json has no valid ai_modeller section. */
  ai(): { on: boolean; stop: boolean } | null;
  client(): string;
}

const norm = (p: string) => win.normalize(p).toLowerCase();
const stem = (f: string) => win.basename(f).replace(/\.rfa$/i, "");
const parseJson = (t: string | null): any => { if (t == null) return null; try { return JSON.parse(t.replace(/^\uFEFF/, "")); } catch { return null; } };

// ---------------------------------------------------------------- the new version's facts

export interface NewVersion {
  file: string; name: string; version: string; sha256: string | null; of: string; family: string; backup: string; backupSha: string | null;
  token: string; at: string;
}

/** The new version, from the .evolve.json that fmc_family_evolve apply saved beside it. Problems when it isn't one. */
export function readNewVersion(file: string, io: RefsIo): { v: NewVersion | null; problems: string[] } {
  const problems: string[] = [];
  if (win.extname(file).toLowerCase() !== ".rfa") return { v: null, problems: ["Give the new version's .rfa (the file fmc_family_evolve apply saved)"] };
  if (!io.exists(file)) return { v: null, problems: [`Not found: ${file}`] };
  const m = parseJson(io.readText(file.replace(/\.rfa$/i, ".evolve.json")));
  if (!m || m.backup !== false || typeof m.of !== "string" || typeof m.version !== "string") return { v: null, problems: [`${win.basename(file)} has no version record (.evolve.json from apply): it isn't an evolve version`] };
  const sha = io.sha256(file);
  if (m.sha256 && sha !== m.sha256) problems.push(`${win.basename(file)} changed after apply saved it (sha256 differs from its version record): repoint only a version as saved`);
  const backup = typeof m.from_backup === "string" ? m.from_backup : "";
  return { v: { file, name: stem(file), version: m.version, sha256: sha, of: m.of, family: stem(m.of), backup, backupSha: backup ? io.sha256(backup) : null, token: String(m.token ?? ""), at: String(m.at ?? "") }, problems };
}

// ---------------------------------------------------------------- the library index

export function emptyIndex(now: Date): EvolveIndex { return { schema: INDEX_SCHEMA, updated: now.toISOString(), families: {}, history: [] }; }

/** The index on disk: none yet, a good one, or a file that isn't ours (never overwritten). */
export function readIndex(file: string, io: RefsIo): { index: EvolveIndex | null; invalid: boolean } {
  const t = io.readText(file);
  if (t == null) return { index: null, invalid: false };
  const j = parseJson(t);
  if (!j || j.schema !== INDEX_SCHEMA || typeof j.families !== "object" || j.families === null) return { index: null, invalid: true };
  return { index: { schema: j.schema, updated: String(j.updated ?? ""), families: j.families, history: Array.isArray(j.history) ? j.history : [] }, invalid: false };
}

export interface IndexChange {
  file: string; change: "create" | "update" | "skip"; family: string; current: string;
  superseded: Array<{ version: string; file: string; superseded_by: string }>; added: IndexEntry[];
}

/**
 * The index after the new version is current: the new version `current`, every earlier entry (the original, older versions)
 * `superseded` with a pointer to it. Nothing is removed. Idempotent: the same version again is a skip.
 */
export function repointIndex(index: EvolveIndex | null, v: NewVersion, now: Date): { next: EvolveIndex; change: Omit<IndexChange, "file"> } {
  const at = now.toISOString();
  const next: EvolveIndex = JSON.parse(JSON.stringify(index ?? emptyIndex(now)));
  const fam = (next.families[v.family] ??= { entries: [] });
  const added: IndexEntry[] = [];
  // the original is listed first time round: it is what the library holds until a person releases the new version
  if (!fam.entries.some((e) => e.kind === "original")) {
    const o: IndexEntry = { version: "original", file: v.of, name: v.family, sha256: v.backupSha, kind: "original", status: "current", at, ...(v.backup ? { backup: v.backup } : {}) };
    fam.entries.unshift(o); added.push(o);
  }
  const already = fam.entries.find((e) => norm(e.file) === norm(v.file));
  if (already && already.status === "current" && fam.entries.filter((e) => e.status === "current").length === 1)
    return { next: index ?? next, change: { change: "skip", family: v.family, current: v.file, superseded: [], added: [] } };
  const superseded: IndexChange["superseded"] = [];
  for (const e of fam.entries) {
    if (norm(e.file) === norm(v.file)) continue;
    if (e.status !== "superseded") { e.status = "superseded"; e.superseded_by = v.file; e.superseded_at = at; superseded.push({ version: e.version, file: e.file, superseded_by: v.file }); }
  }
  if (already) { already.status = "current"; delete already.superseded_by; delete already.superseded_at; }
  else {
    const n: IndexEntry = { version: v.version, file: v.file, name: v.name, sha256: v.sha256, kind: "version", status: "current", at, ...(v.token ? { token: v.token } : {}) };
    fam.entries.push(n); added.push(n);
  }
  next.updated = at;
  return { next, change: { change: index ? "update" : "create", family: v.family, current: v.file, superseded, added } };
}

// ---------------------------------------------------------------- staging catalogues

/** A catalogue is a .json beside the families named *catalogue.json or *catalog.json (rows keyed by family and file). */
export const CATALOGUE_NAME = /catalog(ue)?\.json$/i;
const ROW_LISTS = ["families", "entries", "rows", "items"];
const FILE_KEYS = ["file", "path", "rfa"];

export interface CatalogueChange { file: string; matched: number; repointed: number; change: "update" | "skip" | "none"; rows: Array<{ family: string; from: string; to: string }> }

function rowsOf(doc: any): { rows: any[]; set: (rows: any[]) => any } | null {
  if (Array.isArray(doc)) return { rows: doc, set: (r) => r };
  if (doc && typeof doc === "object") for (const k of ROW_LISTS) if (Array.isArray(doc[k])) return { rows: doc[k], set: (r) => ({ ...doc, [k]: r }) };
  return null;
}
const rowFamily = (r: any): string => stem(String(r?.family ?? r?.name ?? ""));
const rowFileKey = (r: any): string | null => FILE_KEYS.find((k) => typeof r?.[k] === "string" && /\.rfa$/i.test(r[k])) ?? null;

/**
 * Rows for this family (by name, or by a file that is one of its versions) are pointed at the new version; each repointed row
 * stays listed as a copy marked superseded. A catalogue with no row for the family is left alone.
 */
export function repointCatalogue(text: string, file: string, v: NewVersion): { next: string | null; change: CatalogueChange } {
  const doc = parseJson(text);
  const rl = rowsOf(doc);
  const none: CatalogueChange = { file, matched: 0, repointed: 0, change: "none", rows: [] };
  if (!rl) return { next: null, change: none };
  const names = new Set([v.family.toLowerCase(), v.name.toLowerCase()]);
  const out: any[] = [];
  const changes: CatalogueChange["rows"] = [];
  let matched = 0;
  for (const r of rl.rows) {
    const key = r && typeof r === "object" ? rowFileKey(r) : null;
    const isOurs = !!r && typeof r === "object" && (names.has(rowFamily(r).toLowerCase()) || (key != null && names.has(stem(r[key]).toLowerCase())));
    if (!isOurs || r.status === "superseded") { out.push(r); continue; }
    matched++;
    if (key && norm(r[key]) === norm(v.file)) { out.push(r); continue; }
    const to = { ...r, ...(key ? { [key]: v.file } : { file: v.file }), version: v.version, family: v.name };
    delete to.superseded_by;
    changes.push({ family: rowFamily(r), from: key ? r[key] : "", to: v.file });
    out.push(to, { ...r, status: "superseded", superseded_by: v.file });
  }
  if (!matched) return { next: null, change: none };
  if (!changes.length) return { next: null, change: { file, matched, repointed: 0, change: "skip", rows: [] } };
  return { next: JSON.stringify(rl.set(out), null, 2), change: { file, matched, repointed: changes.length, change: "update", rows: changes } };
}

/** The catalogues that can hold the family: the original's folder and the staging root (never into _Evolve). */
export function catalogueFiles(v: NewVersion, io: RefsIo): string[] {
  const staging = io.config.family_staging_root;
  const at = v.file.toLowerCase().indexOf("\\_evolve\\");
  const roleDir = at >= 0 ? v.file.slice(0, at) : win.dirname(v.file);
  const dirs = [...new Set([win.dirname(v.of), roleDir, staging].filter(Boolean).map((d) => win.normalize(d)))];
  const out: string[] = [];
  for (const d of dirs) for (const f of io.files(d)) if (CATALOGUE_NAME.test(f)) { const p = win.join(d, f); if (!out.some((x) => norm(x) === norm(p))) out.push(p); }
  return out;
}

// ---------------------------------------------------------------- where used (read only)

export const WHERE_USED_DIRS = ["_Tree", "_Ceilings\\_Placed", "_Casework", "_Placed"];
const READABLE = /\.(json|jsonl)$/i;
const NEVER_OPEN = /\.(rvt|rfa|rte|rft|rws|nwc|nwd|nwf|dwg|ifc)$/i;
const FAMILY_KEYS = new Set(["family", "family_name", "familyname"]);
export const PROTECTED_MODEL = /(?<![A-Za-z0-9])A-0001(?!\d)|hebert[\s_-]*hostels/i;

export interface Evidence { source: string; file: string; key: string; count: number }
export interface ReloadRow {
  project: string; document: string | null; path: string; open: boolean; workshared: boolean | null; listed_only: boolean;
  evidence: Evidence[]; reload_plan: string[];
}
/** Plain sentence on every where_used reply: hand-placed instances are not in the list. */
export const HAND_PLACED_NOTE = "Hand-placed instances aren't covered: this list is only what the plugin's own records show, not every use in a model.";

export interface WhereUsed {
  families: string[]; new_version: string; read_only: true; projects: number; files_read: number; rows: ReloadRow[];
  summary: string; sources: string[]; not_covered: string[]; refused: string[];
}

/** Every string under a key named family (any depth) that is the family, or "family: type". */
function countFamily(node: unknown, wanted: Set<string>, key = ""): { count: number; key: string } {
  let count = 0, found = "";
  const walk = (n: unknown, path: string) => {
    if (typeof n === "string") {
      const k = path.split(".").pop() ?? "";
      if (FAMILY_KEYS.has(k.toLowerCase())) { const f = n.split(":")[0].trim().replace(/\.rfa$/i, "").toLowerCase(); if (wanted.has(f)) { count++; found ||= path; } }
    } else if (Array.isArray(n)) n.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (n && typeof n === "object") for (const [k, x] of Object.entries(n)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(node, key);
  return { count, key: found };
}

const SOURCE_LABEL = (rel: string) => /\\_Tree\\rooms\\/i.test(rel) ? "room record" : /_Recipe_Tree/i.test(rel) ? "recipe tree" : /_Placed\\/i.test(rel) || /\\_Placed$/i.test(rel) ? "placed record" : /\\_Casework\\/i.test(rel) ? "casework record" : "plugin record";

function projectOf(p: string): string | null {
  const m = /^(.*?)\\01_WIP(\\|$)/i.exec(win.normalize(p));
  return m ? m[1] : null;
}

export function reloadSteps(row: { document: string | null; open: boolean; workshared: boolean | null; listed_only: boolean }, newFile: string): string[] {
  if (row.listed_only) return ["Listed only: this model is protected. This tool takes no action on it; a person decides whether it needs the new version."];
  const doc = row.document ?? "the project's local model";
  return [
    `Confirm ${win.basename(newFile)} passed Gate A (fmc_recipe gate) and was released by a person (or load it from staging to try it).`,
    row.open
      ? `In ${doc} (open${row.workshared ? ", workshared local" : ""}): Insert > Load Family > ${newFile}, then answer "Overwrite the existing version and its parameter values".`
      : `${doc} is not open. A person opens it (the local, in 01_WIP), then loads ${newFile} with "Overwrite the existing version and its parameter values". This tool never opens a project file.`,
    "Check the placed instances, their types, tags and schedules; if the type names changed, retype by hand.",
    ...(row.workshared ? ["A person synchronises with central after the check. The tool does not save or sync."] : []),
  ];
}

export function whereUsed(families: string[], newFile: string, projectFolders: string[], io: RefsIo): WhereUsed {
  const wanted = new Set(families.map((f) => f.toLowerCase()));
  const refused: string[] = [];
  const docs = io.openDocuments().filter((d) => !d.family && d.path && !/\.rfa$/i.test(d.path));
  const folders = new Map<string, string>();
  for (const f of projectFolders) { const n = f.trim().replace(/[\\/]+$/, ""); if (n) folders.set(norm(n), n); }
  for (const d of docs) { const p = projectOf(d.path); if (p) folders.set(norm(p), folders.get(norm(p)) ?? p); }
  let filesRead = 0;
  const rows: ReloadRow[] = [];
  for (const proj of folders.values()) {
    const evidence: Evidence[] = [];
    for (const sub of WHERE_USED_DIRS) {
      const base = win.join(proj, "01_WIP", sub);
      const stack: Array<[string, number]> = [[base, 0]];
      while (stack.length) {
        const [dir, depth] = stack.pop()!;
        for (const name of io.files(dir)) {
          const p = win.join(dir, name);
          if (NEVER_OPEN.test(name) || !READABLE.test(name)) continue;
          if (NEVER_OPEN.test(p)) { refused.push(p); continue; }
          const text = io.readText(p);
          if (text == null) continue;
          filesRead++;
          const docs2 = /\.jsonl$/i.test(name) ? text.split(/\r?\n/).filter(Boolean).map((l) => parseJson(l)).filter(Boolean) : [parseJson(text)];
          let count = 0, key = "";
          for (const d of docs2) { const r = countFamily(d, wanted); count += r.count; key ||= r.key; }
          if (count) evidence.push({ source: SOURCE_LABEL(p.slice(proj.length)), file: p, key, count });
        }
        if (depth < 3) for (const d of io.dirs(dir)) stack.push([win.join(dir, d), depth + 1]);
      }
    }
    if (!evidence.length) continue;
    const mine = docs.filter((d) => { const p = projectOf(d.path); return p != null && norm(p) === norm(proj); });
    const targets = mine.length ? mine.map((d) => ({ title: d.title, path: d.path, open: true, workshared: d.workshared ?? null })) : [{ title: null as string | null, path: "", open: false, workshared: null as boolean | null }];
    for (const t of targets) {
      const listed = PROTECTED_MODEL.test(`${t.title ?? ""} ${t.path} ${proj}`);
      const row = { document: t.title, open: t.open, workshared: t.workshared, listed_only: listed };
      rows.push({ project: proj, document: t.title, path: t.path, open: t.open, workshared: t.workshared, listed_only: listed, evidence, reload_plan: reloadSteps(row, newFile) });
    }
  }
  return {
    families, new_version: newFile, read_only: true, projects: folders.size, files_read: filesRead, rows, refused,
    summary: HAND_PLACED_NOTE,
    sources: WHERE_USED_DIRS.map((d) => `<project>\\01_WIP\\${d} (.json, .jsonl)`).concat("the documents open in Revit (instance files)"),
    not_covered: [
      HAND_PLACED_NOTE,
      "A project that isn't open and wasn't named in project_folders is not looked at.",
      "No project file (.rvt) is opened, so instance counts are the records' counts, not the model's.",
    ],
  };
}

// ---------------------------------------------------------------- plan, token, gate

export interface RepointPlan {
  version: NewVersion; index: IndexChange; indexText: string; catalogues: Array<CatalogueChange & { text: string | null }>;
  where_used: WhereUsed; problems: string[];
}

export function planRepoint(file: string, projectFolders: string[], io: RefsIo): RepointPlan | { problems: string[] } {
  const { v, problems } = readNewVersion(file, io);
  if (!v) return { problems };
  const staging = io.config.family_staging_root;
  const idxFile = indexFile(staging);
  const existing = readIndex(idxFile, io);
  if (existing.invalid) problems.push(`${idxFile} isn't a ${INDEX_SCHEMA} file: not touched. A person looks at it`);
  const { next, change } = repointIndex(existing.index, v, io.now());
  const catalogues = catalogueFiles(v, io).map((c) => {
    const r = repointCatalogue(io.readText(c) ?? "", c, v);
    return { ...r.change, text: r.next };
  });
  return { version: v, index: { file: idxFile, ...change }, indexText: JSON.stringify(next, null, 2), catalogues, where_used: whereUsed([v.family, v.name], v.file, projectFolders, io), problems };
}

export function repointToken(p: RepointPlan): string {
  const h = createHash("sha256").update(JSON.stringify([norm(p.version.file), p.version.sha256, p.index.change, p.index.superseded, p.catalogues.map((c) => [norm(c.file), c.rows])])).digest("hex");
  return "RP-" + h.slice(0, 16);
}

/** Problems that stop a real repoint: no lease held, a protected model leased, or the library-write AI gate (ai_modeller; refuses if missing or off). This library-write gate is separate from the project-model AI gate in aigate.ts. [] when it may run. */
export function gateProblems(io: Pick<RefsIo, "lease" | "ai">): string[] {
  const out: string[] = [];
  const lease = io.lease();
  if (!lease || !lease.id) out.push("A real repoint needs a batch lease: fmc_batch request, wait until it is granted, then send this call with batch_lease");
  else if (!lease.documents.length) out.push(`Lease ${lease.id} isn't held by this session (the board has no document under it): request one with fmc_batch request`);
  else if (lease.documents.some((d) => PROTECTED_MODEL.test(d))) out.push(`Lease ${lease.id} holds a protected model (${lease.documents.join(", ")}): use a lease on other documents; this tool never acts on A-0001 or HEBERT HOSTELS`);
  const ai = io.ai();
  if (!ai) out.push("AI is off: fmc_guard.json has no valid ai_modeller section (the AI switch creates it)");
  else if (ai.stop) out.push("AI is stopped: Stop AI is on, so every AI change is refused until it is switched off");
  else if (!ai.on) out.push("AI is off: the firm-wide AI switch is off");
  return out;
}

/** Each file a repoint would write must be inside the write roots, and inside staging or the library roots. */
export function writeProblems(file: string, cfg: GuardConfig): string[] {
  const v = checkWritePath(file, cfg, { checkName: false });
  const out = v.ok ? [] : v.reasons;
  const roots = [cfg.family_staging_root, ...cfg.library_roots].filter(Boolean);
  if (!roots.some((r) => isInside(file, r))) out.push(`${file} isn't in staging or the library roots: a repoint writes only there`);
  return out;
}