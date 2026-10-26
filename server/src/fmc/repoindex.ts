/**
 * Repo index (docs/INDEX.md): a hashtable of everything Formcraft Revit Tools names, so a person, Claude Code or the
 * AI inside the plugin finds "where is X, what is it, what is it linked to" in one lookup and then opens only those
 * lines, instead of reading docs and code to rediscover it.
 *
 * Keys: findings F-NNN, work items Unn, decisions Dn, PRs PR-n, docs doc:<path>, doc sections sec:<path>#<heading>,
 * code files file:<path>, symbols sym:<name>, MCP tools tool:<name> (with their actions), Revit commands cmd:<name>,
 * pane parts ui:<...> (sections.json) and hub apps app:<id> (hub/apps.ts). Each entry links to its strongest
 * neighbours (named on the same line, touched by the same PR, defined in the same file); a keyword table sits on top.
 *
 * Built by script only (never by hand, never by AI). In the repo it is cached in .cache/repo-index.json and rebuilt
 * when git HEAD or the working tree changes; the server package ships a copy (build/index/repo-index.json) for the
 * plugin's AI, where there is no repo. Entries keep anchor text, not line numbers: the live line is found at lookup.
 * Node built-ins only.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const INDEX_SCHEMA = "fmc-repo-index/1";

export interface IndexEntry {
  key: string;
  kind: string;
  title: string;
  summary?: string;
  status?: string;
  where: string;
  anchor?: string;
  actions?: string[];
  heads?: string[];
  also?: string[];
  links: string[];
  mentions: Array<[string, number]>;
}

export interface RepoIndex {
  schema: string;
  built: string;
  ms: number;
  files: number;
  fingerprint?: string;
  entries: IndexEntry[];
  /** word -> [entry index, weight, entry index, weight, ...] */
  postings: Record<string, number[]>;
}

interface Draft extends Omit<IndexEntry, "links" | "mentions"> {
  links: Record<string, number>;
  mentions: Record<string, number>;
  updates?: number;
  body?: string;
}

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** The git work tree that holds `from`, or null outside a repo (the installed plugin). */
export function repoRoot(from: string = process.cwd()): string | null {
  try { return git(["rev-parse", "--show-toplevel"], from).trim(); } catch { return null; }
}

// ---------------------------------------------------------------- sources

const CODE = /\.(ts|mjs|cs|ps1|py)$/i;
const SKIP = [/^server\/build\//, /node_modules\//, /\.test\.ts$/, /\.g\.cs$/, /\/bin\//, /\/obj\//, /^TestResults\//,
  // the index's own question set and impact reports hold the test questions: they must never answer them
  /^scripts\/index\//, /^results\/index_impact_/];
const ARCHIVE = /^docs\/history\//;
/** The home of each ID kind is checked first; findings and work items may also be defined in any doc heading or table. */
const ID_HOMES: Array<{ kind: string; file: string; re: RegExp; anywhere: boolean }> = [
  { kind: "finding", file: "docs/TEST_FEEDBACK.md", re: /^(?:\| *\**|#{2,4} +(?:\[[ xX~]\] +)?\**|[-*] +\[[ xX~]\] +\**)(F-\d{2,3})\b/, anywhere: true },
  { kind: "work", file: "docs/STATUS.md", re: /^(?:\| *\**|#{2,4} +(?:\[[ xX~]\] +)?\**|[-*] +\[[ xX~]\] +\**)(U\d{2,3})\b/, anywhere: true },
  // Other docs keep local D1, D2 lists of their own: only DECISIONS.md defines the firm's decisions.
  { kind: "decision", file: "docs/DECISIONS.md", re: /^(?:\| *\**|#{2,4} +(?:\[[ xX~]\] +)?\**|[-*] +\[[ xX~]\] +\**)(D\d{1,2})\b/, anywhere: false },
];
const STOP = new Set(("a an and are as at be by can do does for from has have if in into is it its not of on or so " +
  "that the then this to was when which with without will what where who how all any each every no new one two " +
  "use used uses using get set via per only also than more most other same see true false null").split(" "));

const cells = (line: string) => line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
const clip = (s: string, n: number) => { s = s.replace(/\s+/g, " ").replace(/\*\*|`/g, "").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const slug = (h: string) => h.toLowerCase().replace(/[`*]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Words for the keyword table: lower case, camelCase and snake_case split, short plurals folded. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (let w of String(text).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue;
    if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

/** The leading comment of a code file: its own description of itself. */
function headerComment(text: string): string {
  const got: string[] = [];
  for (const l of text.split("\n").slice(0, 40)) {
    const t = l.trim();
    if (!got.length && (t === "" || /^(import|using|namespace|#!|"use|package|param\(|\[)/.test(t))) continue;
    const m = t.match(/^(?:\/\/\/?|#|\*|\/\*\*?|<#)\s?(.*)$/);
    if (!m) break;
    const s = m[1].replace(/<\/?summary>|\*\/$|#>$/g, "").trim();
    if (s) got.push(s);
    if (got.join(" ").length > 400) break;
  }
  return clip(got.join(" "), 300);
}

// ---------------------------------------------------------------- build

export function buildIndex(root: string): RepoIndex {
  const started = Date.now();
  const files = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root).split("\0").filter(Boolean).map((f) => f.replace(/\\/g, "/"))
    .filter((f) => (f.endsWith(".md") || CODE.test(f) || f.endsWith("sections.json")) && !SKIP.some((r) => r.test(f)));
  const text = new Map<string, string>();
  for (const f of files) { try { text.set(f, fs.readFileSync(path.join(root, f), "utf8").replace(/\r/g, "")); } catch { /* deleted in the tree */ } }

  const E = new Map<string, Draft>();
  const add = (key: string, e: Omit<Draft, "key" | "links" | "mentions">): Draft => {
    if (!E.has(key)) E.set(key, { key, links: {}, mentions: {}, ...e });
    return E.get(key)!;
  };
  const link = (a: string, b: string, w: number) => { const e = E.get(a); if (e && a !== b && E.has(b)) e.links[b] = (e.links[b] ?? 0) + w; };

  // 1 IDs: at their home first, then (findings, work items) in any other doc's heading or table
  const defineIds = (f: string, t: string, h: (typeof ID_HOMES)[number]) => {
    const all = t.split("\n");
    let stateCol = -1; // the current table's State or Status column, from its header row
    for (const [n, line] of all.entries()) {
      if (line.startsWith("|") && /^\|\s*:?-{3}/.test(all[n + 1] ?? "")) {
        stateCol = cells(line).findIndex((c) => /^(state|status)$/i.test(c.replace(/\*/g, "")));
        continue;
      }
      if (!line.startsWith("|")) stateCol = -1;
      const id = line.match(h.re)?.[1];
      if (!id) continue;
      const isRow = line.startsWith("|");
      const c = isRow ? cells(line) : [line.replace(/^(?:#+|[-*])\s*(?:\[[ xX~]\]\s*)?/, "")];
      const first = c[0].replace(/\**/g, "").replace(id, "").replace(/^[\s:·—-]+/, "").trim();
      const box = line.match(/^(?:#+|[-*]) +\[([ xX~])\]/)?.[1];
      const sc = isRow && stateCol > 0 && stateCol < c.length ? stateCol : c.length - 1;
      const status = isRow && c.length > 1 ? clip(c[sc].split(/[:.]/)[0], 40)
        : box ? ({ " ": "Open", "~": "In progress" } as Record<string, string>)[box] ?? "Done" : undefined;
      const e = E.get(id);
      if (e) { if (e.where === f) { e.updates = (e.updates ?? 0) + 1; if (status && (sc === stateCol || !isRow)) e.status = status; } continue; }
      const rest = isRow ? c.slice(1).filter((_, j) => j + 1 !== sc) : [];
      add(id, { kind: h.kind, title: clip([first, ...rest].filter(Boolean).join(" · "), 220), status, where: f, anchor: line.slice(0, 80) });
    }
  };
  for (const h of ID_HOMES) { const t = text.get(h.file); if (t) defineIds(h.file, t, h); }
  for (const h of ID_HOMES.filter((x) => x.anywhere))
    for (const [f, t] of text) if (f.endsWith(".md") && f !== h.file && !ARCHIVE.test(f)) defineIds(f, t, h);

  // 2 docs, their sections, and code files
  const base = new Map<string, string | null>();
  for (const f of text.keys()) { const b = path.posix.basename(f); base.set(b, base.has(b) ? null : f); }
  for (const [f, t] of text) {
    if (f.endsWith(".md")) {
      const h1 = t.match(/^# (.+)$/m)?.[1] ?? path.posix.basename(f);
      const firstPara = (s: string) => s.split("\n\n").map((p) => p.trim()).find((p) => p && !p.startsWith("#") && !p.startsWith("|") && !p.startsWith("```")) ?? "";
      const heads = [...t.matchAll(/^#{2,3} (.+)$/gm)].map((m) => clip(m[1], 60));
      const archive = ARCHIVE.test(f);
      const doc = add("doc:" + f, { kind: archive ? "archive" : "doc", title: clip(h1, 120), summary: clip(firstPara(t), 240), heads: heads.slice(0, 40), where: f, anchor: "# " + h1 });
      if (archive) continue;
      // One entry per section, so a lookup lands on the section, not the whole doc.
      const parts = t.split(/^(?=#{2,3} )/m);
      for (const part of parts) {
        const h = part.match(/^#{2,3} (.+)$/m)?.[1];
        if (!h) continue;
        const key = `sec:${f}#${slug(h)}`;
        if (E.has(key)) continue;
        const body = part.slice(part.indexOf("\n") + 1);
        add(key, { kind: "section", title: clip(h, 120) + " (" + path.posix.basename(f) + ")", summary: clip(firstPara(body), 240), where: f, anchor: part.split("\n")[0].slice(0, 80), body });
        link(key, doc.key, 3); link(doc.key, key, 1);
      }
    } else if (!f.endsWith(".json")) {
      const exported = [...t.matchAll(/^export (?:async )?(?:function\*?|const|class|interface|type) ([A-Za-z_]\w*)|^\s*public\s+(?:(?:sealed|static|abstract|partial)\s+)*class\s+([A-Za-z_]\w*)/gm)]
        .map((m) => m[1] ?? m[2]);
      add("file:" + f, { kind: "file", title: path.posix.basename(f), summary: headerComment(t), where: f, body: exported.join(" ") });
    }
  }

  // 3 symbols, MCP tools (with actions), Revit commands
  for (const [f, t] of text) {
    if (!CODE.test(f)) continue;
    const lines = t.split("\n");
    lines.forEach((line, i) => {
      let m: RegExpMatchArray | null = null;
      if (f.endsWith(".ts") || f.endsWith(".mjs")) m = line.match(/^export (?:async )?(?:function\*?|const|let|class|interface|type|enum) ([A-Za-z_]\w*)/);
      else if (f.endsWith(".cs")) m = line.match(/^\s*(?:public|internal)\s+(?:(?:sealed|static|abstract|partial|readonly)\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/);
      else if (f.endsWith(".py")) m = line.match(/^(?:def|class) ([A-Za-z_]\w*)/);
      else if (f.endsWith(".ps1")) m = line.match(/^function ([A-Za-z][\w-]*)/i);
      if (m) {
        const key = "sym:" + m[1];
        const before = lines.slice(Math.max(0, i - 6), i).join("\n");
        const doc = (before.match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? lines.slice(Math.max(0, i - 4), i).filter((l) => /^\s*(\/\/\/|\/\/|#)/.test(l)).join(" "))
          .replace(/[*\/#]|<\/?summary>/g, " ");
        const e = E.get(key);
        if (e) (e.also ??= []).push(f);
        else add(key, { kind: "symbol", title: m[1], summary: clip(doc, 200), where: f, anchor: line.trim().slice(0, 80) });
      }
      const cmd = line.match(/CommandName\s*=>\s*"([a-z0-9_]+)"/);
      if (cmd) {
        const sum = lines.slice(Math.max(0, i - 8), i).join(" ").match(/<summary>(.*?)<\/summary>/)?.[1] ?? "";
        add("cmd:" + cmd[1], { kind: "command", title: cmd[1], summary: clip(sum, 200), where: f, anchor: line.trim().slice(0, 80) });
      }
    });
    if (/^server\/src\/tools\/fmc_\w+\.ts$/.test(f)) {
      const name = path.posix.basename(f, ".ts");
      const desc = t.match(/_DESCRIPTION\s*=\s*\n?\s*"([^"]+)/)?.[1] ?? t.match(/server\.tool\(\s*"[^"]+",\s*"([^"]+)/)?.[1] ?? "";
      const actions = t.match(/action:\s*z\.enum\(\[([^\]]+)\]/)?.[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
      add("tool:" + name, { kind: "tool", title: name, summary: clip(desc, 300), actions, where: f, anchor: (t.match(/^export async function run\w+.*$/m)?.[0] ?? "").slice(0, 80) });
    }
  }

  // 4 the pane (sections.json) and the hub's apps (hub/apps.ts)
  const sj = [...text.keys()].find((f) => f.endsWith("Services/sections.json"));
  if (sj) {
    try {
      const o = JSON.parse(text.get(sj)!.replace(/^﻿/, ""));
      for (const g of o.groups ?? []) {
        const gk = `ui:${g.name}`;
        add(gk, { kind: "ui", title: `${g.name} (pane group)`, summary: clip((g.sections ?? []).map((s: { name: string }) => s.name).join(", "), 240), where: sj, anchor: `"name": "${g.name}"` });
        for (const s of g.sections ?? []) {
          const sk = `ui:${g.name}/${s.name}`;
          add(sk, { kind: "ui", title: `${s.name} (pane section in ${g.name})`, summary: clip(`module ${s.module ?? ""} · ${s.phase ?? ""} · board ${s.board ?? ""}`, 240), where: sj, anchor: `"name": "${s.name}"` });
          link(sk, gk, 3); link(gk, sk, 2);
        }
      }
      for (const q of o.quickTools ?? []) add(`ui:quick/${q.name}`, { kind: "ui", title: `${q.name} (quick tool)`, summary: clip((q.parts ?? []).join(", "), 200), where: sj, anchor: `"name": "${q.name}"` });
      for (const s of o.search ?? []) add(`ui:search/${s.title}`, { kind: "ui", title: `${s.title} (${s.kind} in ${s.module ?? ""})`, summary: clip(`opens ${s.opens ?? ""} · ${(s.words ?? []).join(" ")} · ${s.detail ?? ""}`, 240), where: sj, anchor: `"title": "${s.title}"` });
    } catch { /* not JSON: skip, the build reports nothing for the pane */ }
  }
  const apps = text.get("server/src/hub/apps.ts");
  if (apps) {
    for (const m of apps.matchAll(/\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*kind:\s*"([^"]+)"([\s\S]*?)\}\s*,?\s*(?=\{|\];)/g)) {
      const tools = m[4].match(/tools:\s*\[([^\]]*)\]/)?.[1].match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
      const planned = m[4].match(/planned:\s*"([^"]+)"/)?.[1];
      const a = add(`app:${m[1]}`, { kind: "app", title: `${m[2]} (hub app, ${m[3]})`, summary: clip(`tools ${tools.join(", ") || "none"}${planned ? ` · planned ${planned}` : ""}`, 200), where: "server/src/hub/apps.ts", anchor: `{ id: "${m[1]}"` });
      for (const tl of tools) { link(a.key, "tool:" + tl, 4); link("tool:" + tl, a.key, 4); }
    }
  }

  // 5 PRs from history, with the files each one touched (needs full history: CI checks out with fetch-depth 0)
  try {
    const log = git(["log", "--format=@@%h\t%cs\t%s", "--name-only", "-n", "800"], root);
    for (const chunk of log.split("@@").slice(1)) {
      const [head, ...rest] = chunk.split("\n");
      const [sha, date, subject = ""] = head.split("\t");
      const n = subject.match(/\(#(\d+)\)\s*$/)?.[1] ?? subject.match(/^Merge pull request #(\d+)/)?.[1];
      if (!n) continue;
      const pr = add("PR-" + n, { kind: "pr", title: clip(subject.replace(/\s*\(#\d+\)\s*$/, ""), 200), status: date, where: "git:" + sha });
      for (const f of rest.map((s) => s.trim()).filter(Boolean).slice(0, 40)) {
        const fk = (f.endsWith(".md") ? "doc:" : "file:") + f;
        link(pr.key, fk, 2); link(fk, pr.key, 2);
      }
    }
  } catch { /* no history */ }

  // 6 mentions and links: keys named on the same line link to each other
  const has = (k: string) => E.has(k);
  const tokenRe = /\b(F-\d{2,3}|U\d{2,3}|D\d{1,2})\b|#(\d{2,4})\b|\b(fmc_[a-z0-9_]+|[a-z]+_[a-z0-9_]+)\b|\b([\w.-]+\.(?:ts|mjs|cs|ps1|py|md))\b/g;
  for (const [f, t] of text) {
    const md = f.endsWith(".md");
    const self = (md ? "doc:" : "file:") + f;
    let section = self;
    for (const line of t.split("\n")) {
      if (md && /^#{2,3} /.test(line)) { const k = `sec:${f}#${slug(line.replace(/^#+\s*/, ""))}`; section = has(k) ? k : self; }
      const keys = new Set<string>();
      for (const m of line.matchAll(tokenRe)) {
        let k: string | null = null;
        if (m[1] && (md || m[1].startsWith("F-"))) k = has(m[1]) ? m[1] : null;
        else if (m[2] && md) k = has("PR-" + m[2]) ? "PR-" + m[2] : null;
        else if (m[3]) k = has("tool:" + m[3]) ? "tool:" + m[3] : has("cmd:" + m[3]) ? "cmd:" + m[3] : null;
        else if (m[4]) { const g = base.get(m[4]); if (g) k = (g.endsWith(".md") ? "doc:" : "file:") + g; }
        if (k && k !== self) keys.add(k);
      }
      for (const k of keys) {
        const e = E.get(k)!;
        e.mentions[f] = (e.mentions[f] ?? 0) + 1;
        link(k, section, 1); link(section, k, 1);
        for (const o of keys) if (o !== k) link(k, o, 2); // same line: stronger than same file
      }
    }
  }
  for (const e of E.values()) if (["symbol", "tool", "command"].includes(e.kind)) {
    const fk = (e.where.endsWith(".md") ? "doc:" : "file:") + e.where;
    link(e.key, fk, 3);
  }

  // 7 strongest links only, then the keyword table (title x3, summary and headings x1, section and file bodies x1)
  const entries: IndexEntry[] = [...E.values()].map(({ updates, body, ...e }) => ({
    ...e,
    links: Object.entries(e.links).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k),
    mentions: Object.entries(e.mentions).sort((a, b) => b[1] - a[1]).slice(0, 8) as Array<[string, number]>,
  }));
  const bodies = new Map([...E.values()].map((e) => [e.key, e.body ?? ""]));
  const postings: Record<string, number[]> = {};
  entries.forEach((e, i) => {
    const w = new Map<string, number>();
    for (const x of words(e.key.replace(/^\w+:/, "") + " " + e.title + " " + (e.actions ?? []).join(" "))) w.set(x, 3);
    for (const x of words((e.summary ?? "") + " " + (e.heads ?? []).join(" "))) if (!w.has(x)) w.set(x, 2);
    for (const x of words(bodies.get(e.key) ?? "")) if (!w.has(x)) w.set(x, 1);
    for (const [x, s] of w) (postings[x] ??= []).push(i, s);
  });
  return { schema: INDEX_SCHEMA, built: new Date().toISOString(), ms: Date.now() - started, files: text.size, entries, postings };
}

// ---------------------------------------------------------------- cache and loading

function fingerprint(root: string): string {
  const h = crypto.createHash("sha1");
  h.update(git(["rev-parse", "HEAD"], root));
  h.update(git(["status", "--porcelain", "--", ".", ":!.cache"], root));
  h.update(INDEX_SCHEMA + fs.statSync(new URL(import.meta.url)).size);
  return h.digest("hex");
}

/** In a repo: the cached index, rebuilt when git changed. Elsewhere: the copy shipped with the server. */
export function loadIndex(opts: { root?: string | null; shipped?: string; rebuild?: boolean } = {}): { index: RepoIndex; cached: boolean; source: string } {
  const root = opts.root === undefined ? repoRoot() : opts.root;
  if (root) {
    const file = path.join(root, ".cache", "repo-index.json");
    const fp = fingerprint(root);
    if (!opts.rebuild) {
      try { const c = JSON.parse(fs.readFileSync(file, "utf8")) as RepoIndex; if (c.schema === INDEX_SCHEMA && c.fingerprint === fp) return { index: c, cached: true, source: file }; } catch { /* none yet */ }
    }
    const index = { ...buildIndex(root), fingerprint: fp };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(index));
    return { index, cached: false, source: file };
  }
  const shipped = opts.shipped ?? new URL("../index/repo-index.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  return { index: JSON.parse(fs.readFileSync(shipped, "utf8")) as RepoIndex, cached: true, source: shipped };
}

// ---------------------------------------------------------------- lookup

const ID_LIKE = /^(F-\d{1,3}|U\d{1,3}|D\d{1,2}|#\d+|PR-\d+)$/i;
const byKeyCache = new WeakMap<RepoIndex, Map<string, number>>();
function byKey(index: RepoIndex): Map<string, number> {
  let m = byKeyCache.get(index);
  if (!m) { m = new Map(index.entries.map((e, i) => [e.key, i])); byKeyCache.set(index, m); }
  return m;
}
export const entryOf = (index: RepoIndex, key: string): IndexEntry | undefined => { const i = byKey(index).get(key); return i === undefined ? undefined : index.entries[i]; };

/** Turns what a person types into a key when it names one exactly. */
export function asKey(index: RepoIndex, q: string): string | null {
  const s = q.trim();
  const k = (x: string) => (byKey(index).has(x) ? x : null);
  if (/^F-\d{1,3}$/i.test(s)) return k("F-" + s.slice(2).padStart(3, "0"));
  if (/^[UD]\d+$/i.test(s)) return k(s.toUpperCase());
  if (/^(#|PR-)\d+$/i.test(s)) return k("PR-" + s.replace(/^(#|PR-)/i, ""));
  for (const x of [s, "tool:" + s, "cmd:" + s, "app:" + s, "ui:" + s, "sym:" + s, "doc:" + s, "file:" + s]) if (k(x)) return x;
  const b = index.entries.find((e) => (e.kind === "file" || e.kind === "doc") && e.where.endsWith("/" + s));
  return b ? b.key : null;
}

export interface Hit { entry: IndexEntry; score: number; cover: number }
export interface QueryResult { exact: boolean; strong: boolean; results: Hit[] }

/**
 * Exact key first (a hashtable hit); an ID that isn't defined is "not found", never a guess. Otherwise the words are
 * scored on the keyword table (rarer words count more; title words x3). `strong` is false when the best match covers
 * under half of the question's weight, where a word the index doesn't know counts fully against it: treat that as
 * "no answer" rather than trusting the top hit.
 */
export function queryIndex(index: RepoIndex, q: string, n = 5, kinds?: string[]): QueryResult {
  const key = asKey(index, q);
  if (key && (!kinds || kinds.includes(entryOf(index, key)!.kind))) return { exact: true, strong: true, results: [{ entry: entryOf(index, key)!, score: 1, cover: 1 }] };
  if (ID_LIKE.test(q.trim())) return { exact: true, strong: false, results: [] };
  const qw = [...new Set(words(q))];
  const N = index.entries.length;
  const unknown = Math.log(1 + N);
  const idf = (w: string) => { const p = index.postings[w]; return p ? Math.log(1 + N / (p.length / 2)) : 0; };
  const total = qw.reduce((s, w) => s + (index.postings[w] ? idf(w) : unknown), 0) || 1;
  const score = new Map<number, number>(), cover = new Map<number, number>();
  for (const w of qw) {
    const p = index.postings[w];
    if (!p) continue;
    const wi = idf(w);
    for (let j = 0; j < p.length; j += 2) {
      score.set(p[j], (score.get(p[j]) ?? 0) + wi * p[j + 1]);
      cover.set(p[j], (cover.get(p[j]) ?? 0) + wi);
    }
  }
  const factor: Record<string, number> = { archive: 0.5, symbol: 0.7, pr: 0.8 };
  const ranked = [...score.entries()]
    .map(([i, s]) => ({ entry: index.entries[i], score: s * (factor[index.entries[i].kind] ?? 1), cover: (cover.get(i) ?? 0) / total }))
    .filter((h) => !kinds || kinds.includes(h.entry.kind))
    .sort((a, b) => b.score - a.score).slice(0, n);
  return { exact: false, strong: (ranked[0]?.cover ?? 0) >= 0.5, results: ranked };
}

/** The entry's live line: its anchor searched in the file now (null when there is no repo or the anchor moved away). */
export function liveLine(root: string | null, e: IndexEntry): number | null {
  if (!root || !e.where || e.where.startsWith("git:")) return null;
  if (!e.anchor) return 1;
  try {
    const want = e.anchor.trim().slice(0, 60);
    const lines = fs.readFileSync(path.join(root, e.where), "utf8").replace(/\r/g, "").split("\n");
    const i = lines.findIndex((l) => l.trim().startsWith(want) || l.includes(want));
    return i >= 0 ? i + 1 : null;
  } catch { return null; }
}

/** The compact text a reader (person or AI) gets: the entry, where to open, its neighbours. */
export function describe(index: RepoIndex, root: string | null, r: QueryResult, withLinks = true): string {
  if (!r.results.length) return r.exact ? "Not found: no entry has that key." : "No match.";
  const out: string[] = [];
  if (!r.strong) out.push("Weak match (under half the question's words): treat as no answer.");
  r.results.forEach((h, n) => {
    const e = h.entry;
    const line = liveLine(root, e);
    out.push(`${n === 0 ? "" : "\n"}${e.key}  [${e.kind}${e.status ? " · " + e.status : ""}]  ${e.title}`);
    if (e.summary) out.push(`  ${e.summary}`);
    if (e.actions?.length) out.push(`  actions: ${e.actions.join(", ")}`);
    out.push(`  at ${e.where}${line ? ":" + line : ""}`);
    if (withLinks && n === 0 && e.links.length) out.push(`  links: ${e.links.slice(0, 10).join(" · ")}`);
    if (withLinks && n === 0 && e.mentions.length) out.push(`  mentioned in: ${e.mentions.slice(0, 5).map(([f, c]) => `${f} (${c})`).join(", ")}`);
  });
  return out.join("\n");
}
