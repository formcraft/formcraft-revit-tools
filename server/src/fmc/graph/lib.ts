/**
 * fmc_graph_lib core (DT-42 list, DT-45 version, DT-47 lock). The kit is read-only: nothing here writes under the kit.
 * Versions and the proposed lock go in the project's drafts folder (<project>\00_Formcraft\Graphs, D4).
 */
import fs from "node:fs";
import { pathOf, readDyn, scriptRoots } from "../dynamo.js";
import { isInside } from "../policy.js";
import { sha256File, sha256Text, stableJson } from "./hash.js";
import { graphsDir, jailCheck } from "./jail.js";
import { scanGraph } from "./scan.js";

export type LockState = "match" | "absent" | "mismatch" | "unlisted";

export interface GraphsLock {
  v: 1;
  created_at: string;
  kit: string;
  graphs: Record<string, { sha256: string }>;
  custom_nodes: Record<string, { sha256: string }>;
  packages: Record<string, { version: string; folder_sha256: string }>;
}

export interface GraphEntry {
  id: string;
  version: number | null;
  file: string;
  sha256: string;
  tier: "K" | "P";
  status: "kit" | "draft" | "version" | "retired";
  runner: "dynamo";
  packages: string[];
  python: boolean;
  writes_model: boolean;
  lock: LockState;
  problem?: string;
}

export interface GraphVersion {
  id: string;
  version: number;
  file: string;
  sha256: string;
  parent_sha256: string | null;
  author: "person" | "ai";
  author_name: string;
  reason: string;
  created_at: string;
}

export function lockFile(kit: string): string {
  const p = pathOf(kit);
  return p.join(kit, "05_Scripts", "graphs.lock.json");
}

export function lockKey(kit: string, file: string): string {
  const p = pathOf(kit);
  return p.relative(kit, file).split(/[\\/]+/).join("\\").toLowerCase();
}

export function readLock(kit: string): GraphsLock | null {
  try {
    const o = JSON.parse(fs.readFileSync(lockFile(kit), "utf8").replace(/^\uFEFF/, "")) as GraphsLock;
    return o && typeof o === "object" && o.graphs && typeof o.graphs === "object" ? o : null;
  } catch {
    return null;
  }
}

/** match: listed with this hash. absent: no lock file in the kit. mismatch: listed with another hash. unlisted: not in it. */
export function lockCheck(kit: string, file: string, sha256: string, lock: GraphsLock | null = readLock(kit)): LockState {
  if (!lock) return "absent";
  const row = lock.graphs[lockKey(kit, file)];
  if (!row) return "unlisted";
  return row.sha256.toLowerCase() === sha256.toLowerCase() ? "match" : "mismatch";
}

function dynFiles(dir: string, depth = 4): string[] {
  const out: string[] = [];
  const p = pathOf(dir);
  const walk = (d: string, level: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = p.join(d, e.name);
      if (e.isDirectory() && level < depth) walk(full, level + 1);
      else if (e.isFile() && /\.dyn$/i.test(e.name)) out.push(full);
    }
  };
  walk(dir, 0);
  return out.sort();
}

const VERSION_NAME = /^(.+)@(\d+)\.dyn$/i;

function entryFor(file: string, tier: "K" | "P", status: GraphEntry["status"], kit: string, lock: GraphsLock | null): GraphEntry {
  const p = pathOf(file);
  const base = p.basename(file);
  const m = VERSION_NAME.exec(base);
  const id = m ? m[1] : base.replace(/\.dyn$/i, "");
  let sha = "";
  try { sha = sha256File(file); } catch { /* reported below */ }
  const parsed = readDyn(file);
  if (!parsed.ok) return { id, version: m ? Number(m[2]) : null, file, sha256: sha, tier, status, runner: "dynamo", packages: [], python: false, writes_model: false, lock: "absent", problem: parsed.message };
  const scan = scanGraph(file);
  const i = parsed.inspect;
  return {
    id, version: m ? Number(m[2]) : null, file, sha256: sha, tier, status, runner: "dynamo",
    packages: i.packages.map((x) => (x.version ? `${x.name} ${x.version}` : x.name)),
    python: scan.python || i.python_nodes.length > 0,
    writes_model: i.revit_nodes || i.python_revit_refs.length > 0,
    lock: tier === "K" ? lockCheck(kit, file, sha, lock) : "unlisted",
  };
}

function retiredSet(dir: string): Set<string> {
  try {
    const o = JSON.parse(fs.readFileSync(pathOf(dir).join(dir, "retired.json"), "utf8")) as { retired?: unknown };
    return new Set(Array.isArray(o.retired) ? o.retired.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : []);
  } catch { return new Set(); }
}

/** Every graph in the kit (both script places, R-9) and the project's drafts and versions. */
export function listGraphs(args: { kit: string; projectRoot: string; draftsFolder?: string }): { graphs: GraphEntry[]; lock: "present" | "absent"; drafts_dir: string } {
  const lock = readLock(args.kit);
  const graphs: GraphEntry[] = [];
  for (const root of scriptRoots(args.kit)) for (const f of dynFiles(root)) graphs.push(entryFor(f, "K", "kit", args.kit, lock));
  let drafts = "";
  if (args.projectRoot) {
    drafts = graphsDir(args.projectRoot, args.draftsFolder);
    const retired = retiredSet(drafts);
    for (const f of dynFiles(drafts, 2)) {
      const p = pathOf(f);
      const version = VERSION_NAME.test(p.basename(f));
      const row = entryFor(f, "P", version ? "version" : "draft", args.kit, lock);
      if (retired.has(p.basename(f).toLowerCase())) row.status = "retired";
      graphs.push(row);
    }
  }
  return { graphs, lock: lock ? "present" : "absent", drafts_dir: drafts };
}

/**
 * Save a draft as the next version <id>@<n>.dyn with its record <id>@<n>.json. Never overwrites: a name that exists
 * is skipped to the next number. The draft must be inside the project's drafts folder.
 */
export function versionDraft(args: { projectRoot: string; draft: string; id: string; reason: string; author: "person" | "ai"; authorName?: string; draftsFolder?: string; now?: Date }):
  { ok: true; version: GraphVersion } | { ok: false; code: string; message: string } {
  const id = args.id.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(id) || id.includes("..")) return { ok: false, code: "FMC-GRAPH-ID", message: `[FMC-GRAPH-ID] id must be letters, digits, '_', '-' or '.', got ${JSON.stringify(args.id)}.` };
  if (!args.reason.trim()) return { ok: false, code: "FMC-GRAPH-REASON", message: "[FMC-GRAPH-REASON] A version needs a reason." };
  const dir = graphsDir(args.projectRoot, args.draftsFolder);
  const inJail = jailCheck(args.draft, dir);
  if (!inJail.ok) return { ok: false, code: inJail.code, message: inJail.message };
  const parsed = readDyn(inJail.real);
  if (!parsed.ok) return { ok: false, code: "FMC-DYNAMO-PARSE", message: parsed.message };
  const p = pathOf(dir);
  const versions = p.join(dir, "versions");
  fs.mkdirSync(versions, { recursive: true });
  const existing = (() => { try { return fs.readdirSync(versions); } catch { return []; } })()
    .map((f) => VERSION_NAME.exec(f)).filter((m): m is RegExpExecArray => !!m && m[1].toLowerCase() === id.toLowerCase()).map((m) => Number(m[2]));
  let n = existing.length ? Math.max(...existing) + 1 : 1;
  const bytes = fs.readFileSync(inJail.real);
  let parentSha: string | null = null;
  if (existing.length) {
    try { parentSha = sha256File(p.join(versions, `${id}@${Math.max(...existing)}.dyn`)); } catch { parentSha = null; }
  }
  for (;; n++) {
    const target = p.join(versions, `${id}@${n}.dyn`);
    try {
      fs.writeFileSync(target, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const version: GraphVersion = {
      id, version: n, file: target, sha256: sha256Text(bytes), parent_sha256: parentSha,
      author: args.author, author_name: (args.authorName ?? (args.author === "ai" ? "AI" : "")).slice(0, 100),
      reason: args.reason.trim().slice(0, 500), created_at: (args.now ?? new Date()).toISOString(),
    };
    fs.writeFileSync(p.join(versions, `${id}@${n}.json`), JSON.stringify(version, null, 2), { flag: "wx" });
    return { ok: true, version };
  }
}

/**
 * Propose the hash register for the kit (graphs, custom nodes and the packages they use). Written to the project's
 * drafts folder as graphs.lock.proposed.json; a person or the release process copies it into the kit.
 */
export function proposeLock(args: { kit: string; projectRoot: string; packages?: Array<{ name: string; version: string; folder_sha256: string | null }>; draftsFolder?: string; now?: Date }):
  { ok: true; file: string; lock: GraphsLock; target: string } | { ok: false; code: string; message: string } {
  if (!args.projectRoot) return { ok: false, code: "FMC-GRAPH-JAIL", message: "[FMC-GRAPH-JAIL] The target model is not in a project's 01_WIP, so there is no drafts folder to write the proposal to." };
  const lock: GraphsLock = { v: 1, created_at: (args.now ?? new Date()).toISOString(), kit: args.kit, graphs: {}, custom_nodes: {}, packages: {} };
  for (const root of scriptRoots(args.kit)) {
    for (const f of dynFiles(root)) lock.graphs[lockKey(args.kit, f)] = { sha256: sha256File(f) };
    const p = pathOf(root);
    const walk = (d: string, level: number) => {
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = p.join(d, e.name);
        if (e.isDirectory() && level < 4) walk(full, level + 1);
        else if (e.isFile() && /\.dyf$/i.test(e.name)) lock.custom_nodes[lockKey(args.kit, full)] = { sha256: sha256File(full) };
      }
    };
    walk(root, 0);
  }
  for (const pkg of args.packages ?? []) if (pkg.folder_sha256) lock.packages[pkg.name] = { version: pkg.version, folder_sha256: pkg.folder_sha256 };
  const dir = graphsDir(args.projectRoot, args.draftsFolder);
  const p = pathOf(dir);
  if (isInside(dir, args.kit)) return { ok: false, code: "FMC-KIT-READONLY", message: "[FMC-KIT-READONLY] The drafts folder is inside the kit; the kit is read-only." };
  fs.mkdirSync(dir, { recursive: true });
  const file = p.join(dir, "graphs.lock.proposed.json");
  // Archive before overwrite: an older proposal is kept beside it.
  if (fs.existsSync(file)) {
    const stamp = (args.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    fs.renameSync(file, p.join(dir, `graphs.lock.proposed.${stamp}.json`));
  }
  fs.writeFileSync(file, JSON.stringify(lock, null, 2));
  return { ok: true, file, lock, target: lockFile(args.kit) };
}

export function lockDigest(lock: GraphsLock): string {
  return sha256Text(stableJson({ graphs: lock.graphs, custom_nodes: lock.custom_nodes, packages: lock.packages }));
}
