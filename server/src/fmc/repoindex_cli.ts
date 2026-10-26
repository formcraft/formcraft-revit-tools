#!/usr/bin/env node
/**
 * The repo index from a terminal (docs/INDEX.md).
 *
 *   node build/fmc/repoindex_cli.js find <key or words> [--n 5] [--json] [--kinds tool,cmd]
 *   node build/fmc/repoindex_cli.js ship        writes build/index/repo-index.json for the plugin's AI (npm run build)
 *   node build/fmc/repoindex_cli.js stats       counts per kind, build time, size
 *
 * scripts/index/find.mjs at the repo root is the short way to call `find`.
 */
import fs from "node:fs";
import path from "node:path";
import { buildIndex, describe, loadIndex, queryIndex, repoRoot } from "./repoindex.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bool = (name: string) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };

const cmd = argv.shift();
if (cmd === "ship") {
  const root = repoRoot();
  const out = new URL("../index/repo-index.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  if (!root) { console.error("repo index: not in a git work tree, nothing shipped"); process.exit(0); }
  const index = buildIndex(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(index));
  console.error(`repo index: ${index.entries.length} entries from ${index.files} files in ${index.ms} ms -> ${out}`);
} else if (cmd === "find") {
  const n = Number(flag("--n") ?? 5);
  const kinds = flag("--kinds")?.split(",").map((k) => ({ cmd: "command", sec: "section" } as Record<string, string>)[k] ?? k);
  const json = bool("--json");
  const q = argv.join(" ").trim();
  if (!q) { console.error("Usage: find <key or words>"); process.exit(2); }
  const { index } = loadIndex();
  const r = queryIndex(index, q, n, kinds);
  if (json) process.stdout.write(JSON.stringify({ ...r, results: r.results.map((h) => ({ ...h.entry, score: Number(h.score.toFixed(2)), cover: Number(h.cover.toFixed(2)) })) }, null, 1) + "\n");
  else process.stdout.write(describe(index, repoRoot(), r) + "\n");
  process.exit(r.results.length && r.strong ? 0 : 1);
} else if (cmd === "stats") {
  const t = Date.now();
  const { index, cached, source } = loadIndex();
  const kinds: Record<string, number> = {};
  for (const e of index.entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  console.log(JSON.stringify({ entries: index.entries.length, words: Object.keys(index.postings).length, files: index.files,
    build_ms: index.ms, load_ms: Date.now() - t, cached, bytes: fs.statSync(source).size, kinds }, null, 1));
} else {
  console.error("Usage: repoindex_cli.js <find|ship|stats> ...");
  process.exit(2);
}
