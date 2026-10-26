// Repo index: a hashtable of everything the repo names (findings, decisions, work items, PRs, docs, code files,
// symbols, MCP tools, Revit commands), with links between entries and a keyword table on top.
//
// Why: a session should find "where is X and what is it linked to" in one lookup, then open only those lines,
// instead of reading docs and code to rediscover it. Built by this script (never by hand, never by AI), cached in
// .cache/repo-index.json and rebuilt automatically when git HEAD or the working tree changes. Entries store anchor
// text, not line numbers, so the live line is found at lookup time and ordinary edits never make the index wrong.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const SCHEMA = "fmc-repo-index/1";
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
export const repoRoot = (cwd = process.cwd()) => git(["rev-parse", "--show-toplevel"], cwd).trim();

// ---------------------------------------------------------------- sources

const CODE = /\.(ts|mjs|cs|ps1|py)$/i;
const SKIP = [/^server\/build\//, /^server\/node_modules\//, /\.test\.ts$/, /\.g\.cs$/, /\/bin\//, /\/obj\//, /^TestResults\//];
const ARCHIVE = /^docs\/history\//;
// Where each ID kind is defined (first cell of a table row). Elsewhere the same token is only a mention.
const ID_HOMES = [
  { kind: "finding", file: "docs/TEST_FEEDBACK.md", re: /^\| *\**(F-\d{2,3})\b/ },
  { kind: "work", file: "docs/STATUS.md", re: /^\| *\**(U\d{2,3})\b/ },
  { kind: "decision", file: "docs/DECISIONS.md", re: /^\| *\**(D\d{1,2})\b/ },
];
const STOP = new Set(("a an and are as at be by can do does for from has have if in into is it its not of on or so " +
  "that the then this to was when which with without will what where who how all any each every no new one two " +
  "use used uses using get set via per only also than more most other same see true false null").split(" "));

const cells = (line) => line.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
const clip = (s, n) => { s = s.replace(/\s+/g, " ").replace(/\*\*/g, "").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

/** Words for the keyword table: lower case, camelCase and snake_case split, short plurals folded. */
export function words(text) {
  const out = [];
  for (let w of String(text).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue;
    if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

/** The leading comment of a code file: its own description of itself. */
function headerComment(text) {
  const lines = text.split("\n").slice(0, 40);
  const got = [];
  for (const l of lines) {
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

export function build(root = repoRoot()) {
  const started = Date.now();
  const files = git(["ls-files", "-z"], root).split("\0").filter(Boolean).map((f) => f.replace(/\\/g, "/"))
    .filter((f) => (f.endsWith(".md") || CODE.test(f)) && !SKIP.some((r) => r.test(f)));
  const text = new Map();
  for (const f of files) { try { text.set(f, fs.readFileSync(path.join(root, f), "utf8").replace(/\r/g, "")); } catch { /* deleted in tree */ } }

  const E = new Map(); // key -> entry
  const add = (key, e) => { if (!E.has(key)) E.set(key, { key, links: {}, mentions: {}, ...e }); return E.get(key); };

  // 1 IDs at their homes
  for (const h of ID_HOMES) {
    const t = text.get(h.file); if (!t) continue;
    for (const line of t.split("\n")) {
      const id = line.match(h.re)?.[1]; if (!id) continue;
      const c = cells(line);
      const first = c[0].replace(/\**/g, "").replace(id, "").trim();
      if (E.has(id)) { E.get(id).updates = (E.get(id).updates ?? 0) + 1; E.get(id).status = clip(c[c.length - 1].split(/[:.]/)[0], 40); continue; }
      add(id, { kind: h.kind, title: clip([first, ...c.slice(1, -1)].filter(Boolean).join(" · "), 220),
        status: clip(c[c.length - 1].split(/[:.]/)[0], 40), where: h.file, anchor: line.slice(0, 80) });
    }
  }

  // 2 docs and code files
  const base = new Map(); // basename -> file (unique only)
  for (const f of text.keys()) { const b = path.posix.basename(f); base.set(b, base.has(b) ? null : f); }
  for (const [f, t] of text) {
    if (f.endsWith(".md")) {
      const h1 = t.match(/^# (.+)$/m)?.[1] ?? path.posix.basename(f);
      const para = t.split("\n\n").map((p) => p.trim()).find((p) => p && !p.startsWith("#") && !p.startsWith("|") && !p.startsWith("```")) ?? "";
      const heads = [...t.matchAll(/^#{2,3} (.+)$/gm)].map((m) => clip(m[1], 60));
      add("doc:" + f, { kind: ARCHIVE.test(f) ? "archive" : "doc", title: clip(h1, 120), summary: clip(para, 240), heads: heads.slice(0, 40), where: f, anchor: "# " + h1 });
    } else {
      add("file:" + f, { kind: "file", title: path.posix.basename(f), summary: headerComment(t), where: f });
    }
  }

  // 3 symbols, MCP tools, Revit commands
  for (const [f, t] of text) {
    if (!CODE.test(f)) continue;
    const lines = t.split("\n");
    lines.forEach((line, i) => {
      let m;
      if (f.endsWith(".ts") || f.endsWith(".mjs")) m = line.match(/^export (?:async )?(?:function\*?|const|let|class|interface|type|enum) ([A-Za-z_]\w*)/);
      else if (f.endsWith(".cs")) m = line.match(/^\s*(?:public|internal)\s+(?:(?:sealed|static|abstract|partial|readonly)\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/);
      else if (f.endsWith(".py")) m = line.match(/^(?:def|class) ([A-Za-z_]\w*)/);
      else if (f.endsWith(".ps1")) m = line.match(/^function ([A-Za-z][\w-]*)/i);
      if (m) {
        const key = "sym:" + m[1];
        const doc = (lines.slice(Math.max(0, i - 6), i).join(" ").match(/\/\*\*(.*?)\*\//s)?.[1] ?? lines.slice(Math.max(0, i - 4), i).filter((l) => /^\s*(\/\/\/|\/\/|#)/.test(l)).join(" "))
          .replace(/[*\/#]|<\/?summary>/g, " ");
        if (E.has(key)) (E.get(key).also ??= []).push(f);
        else add(key, { kind: "symbol", title: m[1], summary: clip(doc, 200), where: f, anchor: line.trim().slice(0, 80) });
      }
      const cmd = line.match(/CommandName\s*=>\s*"([a-z0-9_]+)"/);
      if (cmd) add("cmd:" + cmd[1], { kind: "command", title: cmd[1], summary: clip(lines.slice(Math.max(0, i - 8), i).join(" ").match(/<summary>(.*?)<\/summary>/s)?.[1] ?? "", 200), where: f, anchor: line.trim().slice(0, 80) });
    });
    if (/^server\/src\/tools\/fmc_\w+\.ts$/.test(f)) {
      const name = path.posix.basename(f, ".ts");
      const desc = t.match(/_DESCRIPTION\s*=\s*\n?\s*"([^"]+)/)?.[1] ?? t.match(/server\.tool\(\s*"[^"]+",\s*"([^"]+)/)?.[1] ?? "";
      add("tool:" + name, { kind: "tool", title: name, summary: clip(desc, 240), where: f, anchor: (t.match(/^export async function run\w+.*$/m)?.[0] ?? "").slice(0, 80) });
    }
  }

  // 4 PRs from history, with the files each one touched
  try {
    const log = git(["log", "--format=@@%h\t%cs\t%s", "--name-only", "-n", "600"], root);
    for (const chunk of log.split("@@").slice(1)) {
      const [head, ...rest] = chunk.split("\n");
      const [sha, date, subject] = head.split("\t");
      const n = subject?.match(/\(#(\d+)\)\s*$/)?.[1] ?? subject?.match(/^Merge pull request #(\d+)/)?.[1];
      if (!n) continue;
      const pr = add("PR-" + n, { kind: "pr", title: clip(subject.replace(/\s*\(#\d+\)\s*$/, ""), 200), status: date, where: "git:" + sha });
      for (const f of rest.map((s) => s.trim()).filter(Boolean).slice(0, 40)) {
        const fk = (f.endsWith(".md") ? "doc:" : "file:") + f;
        if (E.has(fk)) { pr.links[fk] = (pr.links[fk] ?? 0) + 2; E.get(fk).links[pr.key] = (E.get(fk).links[pr.key] ?? 0) + 2; }
      }
    }
  } catch { /* shallow clone: no history */ }

  // 5 mentions and links: keys named on the same line link to each other
  const tools = new Set([...E.keys()].filter((k) => k.startsWith("tool:")).map((k) => k.slice(5)));
  const cmds = new Set([...E.keys()].filter((k) => k.startsWith("cmd:")).map((k) => k.slice(4)));
  const tokenRe = /\b(F-\d{2,3}|U\d{2,3}|D\d{1,2})\b|#(\d{2,4})\b|\b(fmc_[a-z0-9_]+|[a-z]+_[a-z0-9_]+)\b|\b([\w.-]+\.(?:ts|mjs|cs|ps1|py|md))\b/g;
  for (const [f, t] of text) {
    const md = f.endsWith(".md");
    const self = (md ? "doc:" : "file:") + f;
    for (const line of t.split("\n")) {
      const keys = new Set();
      for (const m of line.matchAll(tokenRe)) {
        let k = null;
        if (m[1] && (md || m[1].startsWith("F-"))) k = E.has(m[1]) ? m[1] : null;
        else if (m[2] && md) k = E.has("PR-" + m[2]) ? "PR-" + m[2] : null;
        else if (m[3]) k = tools.has(m[3]) ? "tool:" + m[3] : cmds.has(m[3]) ? "cmd:" + m[3] : null;
        else if (m[4]) { const g = base.get(m[4]); if (g) k = (g.endsWith(".md") ? "doc:" : "file:") + g; }
        if (k && k !== self) keys.add(k);
      }
      for (const k of keys) {
        const e = E.get(k); e.mentions[f] = (e.mentions[f] ?? 0) + 1;
        e.links[self] = (e.links[self] ?? 0) + 1;
        E.get(self) && (E.get(self).links[k] = (E.get(self).links[k] ?? 0) + 1);
        for (const o of keys) if (o !== k) e.links[o] = (e.links[o] ?? 0) + 2; // same line: stronger than same file
      }
    }
  }
  // a file's symbols, tools and commands link to the file
  for (const e of E.values()) if (["symbol", "tool", "command"].includes(e.kind)) {
    const fk = (e.where.endsWith(".md") ? "doc:" : "file:") + e.where;
    if (E.has(fk)) { e.links[fk] = (e.links[fk] ?? 0) + 3; }
  }

  // 6 keep the strongest links, then the keyword table
  const entries = [...E.values()].map((e) => {
    const links = Object.entries(e.links).filter(([k]) => k !== e.key).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k);
    const mentions = Object.entries(e.mentions).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { ...e, links, mentions };
  });
  const postings = {};
  entries.forEach((e, i) => {
    const w = new Map();
    for (const x of words(e.key.replace(/^\w+:/, "") + " " + e.title)) w.set(x, 3);
    for (const x of words((e.summary ?? "") + " " + (e.heads ?? []).join(" "))) if (!w.has(x)) w.set(x, 1);
    for (const [x, s] of w) (postings[x] ??= []).push(i, s);
  });
  return { schema: SCHEMA, built: new Date().toISOString(), ms: Date.now() - started, files: text.size, entries, postings };
}

// ---------------------------------------------------------------- cache

function fingerprint(root) {
  const h = crypto.createHash("sha1");
  h.update(git(["rev-parse", "HEAD"], root));
  h.update(git(["status", "--porcelain"], root));
  h.update(fs.readFileSync(new URL(import.meta.url)));
  return h.digest("hex");
}

/** The index, from the cache when git hasn't changed, otherwise rebuilt (and cached). */
export function load(root = repoRoot(), { rebuild = false } = {}) {
  const file = path.join(root, ".cache", "repo-index.json");
  const fp = fingerprint(root);
  if (!rebuild) {
    try { const c = JSON.parse(fs.readFileSync(file, "utf8")); if (c.schema === SCHEMA && c.fingerprint === fp) return { index: c, cached: true }; } catch { /* none yet */ }
  }
  const index = { ...build(root), fingerprint: fp };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index));
  return { index, cached: false };
}

// ---------------------------------------------------------------- lookup

const ID_LIKE = /^(F-\d{1,3}|U\d{1,3}|D\d{1,2}|#\d+|PR-\d+)$/i;

/** Turns what a person types into a key when it names one exactly. */
export function asKey(index, q) {
  const s = q.trim();
  const byKey = (k) => (index._byKey ??= new Map(index.entries.map((e, i) => [e.key, i]))).has(k) ? k : null;
  if (/^F-\d{1,3}$/i.test(s)) return byKey("F-" + s.slice(2).padStart(3, "0"));
  if (/^[UD]\d+$/i.test(s)) return byKey(s.toUpperCase());
  if (/^(#|PR-)\d+$/i.test(s)) return byKey("PR-" + s.replace(/^(#|PR-)/i, ""));
  for (const k of [s, "tool:" + s, "cmd:" + s, "sym:" + s, "doc:" + s, "file:" + s]) if (byKey(k)) return k;
  const b = index.entries.find((e) => (e.kind === "file" || e.kind === "doc" || e.kind === "archive") && e.where.endsWith("/" + s));
  return b ? b.key : null;
}

/**
 * Exact key first (a hashtable hit); an ID that isn't defined is "not found", never a guess. Otherwise words are
 * scored against the keyword table (rarer words count more, title words three times), archive docs count half.
 * `strong` is false when the best match covers under half of the question's weight: treat that as no answer.
 */
export function query(index, q, n = 5) {
  const key = asKey(index, q);
  const at = (k) => index.entries[(index._byKey ??= new Map(index.entries.map((e, i) => [e.key, i]))).get(k)];
  if (key) return { exact: true, strong: true, results: [{ entry: at(key), score: 1 }] };
  if (ID_LIKE.test(q.trim())) return { exact: true, strong: false, results: [] };
  const qw = [...new Set(words(q))];
  const N = index.entries.length;
  const idf = (w) => { const p = index.postings[w]; return p ? Math.log(1 + N / (p.length / 2)) : 0; };
  const total = qw.reduce((s, w) => s + Math.log(1 + N), 0) || 1;
  const score = new Map(), cover = new Map();
  for (const w of qw) {
    const p = index.postings[w]; if (!p) continue;
    const wi = idf(w);
    for (let j = 0; j < p.length; j += 2) {
      const i = p[j];
      score.set(i, (score.get(i) ?? 0) + wi * p[j + 1]);
      cover.set(i, (cover.get(i) ?? 0) + wi);
    }
  }
  const ranked = [...score.entries()].map(([i, s]) => {
    const e = index.entries[i];
    const k = e.kind === "archive" ? 0.5 : e.kind === "symbol" ? 0.8 : 1;
    return { entry: e, score: s * k, cover: (cover.get(i) ?? 0) / total };
  }).sort((a, b) => b.score - a.score).slice(0, n);
  return { exact: false, strong: (ranked[0]?.cover ?? 0) >= 0.5, results: ranked };
}

/** The entry's live line: its anchor searched in the file now (null when the anchor moved away). */
export function liveLine(root, e) {
  if (!e.where || e.where.startsWith("git:")) return null;
  if (!e.anchor) return 1;
  try {
    const lines = fs.readFileSync(path.join(root, e.where), "utf8").replace(/\r/g, "").split("\n");
    const i = lines.findIndex((l) => l.trim().startsWith(e.anchor.trim().slice(0, 60)) || l.startsWith(e.anchor.slice(0, 60)));
    return i >= 0 ? i + 1 : null;
  } catch { return null; }
}
