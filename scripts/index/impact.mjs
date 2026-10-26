#!/usr/bin/env node
// Impact report for the repo index (docs/INDEX.md). Judges the index on the fixed question set made before it existed
// (scripts/index/questions.json), against the realistic way of finding things without it:
//
//   index    : the lookup's text, then the 30 lines it points to
//   baseline : `git grep` for the question (capped at 250 lines, like the agent's search tool), then reading the
//              answer file (capped at 2000 lines, like the agent's file reader); on a miss, the first two files it named
//
// Tokens are estimated as characters / 4. A hit means the expected entry or file was reached; a planted question
// (no answer exists) is a hit only when nothing confident came back. Every miss is listed.
//
//   node scripts/index/impact.mjs                 report to results/index_impact_<date>.md and .json
//   node scripts/index/impact.mjs --ci            exit 1 if an ID, tool or command is missed or a planted question "hits"
//   node scripts/index/impact.mjs --module <file> judge another index build (e.g. an earlier version)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
const CI = args.includes("--ci");
const label = opt("--label") ?? "current";
const modFile = opt("--module") ?? path.join(ROOT, "server/build/fmc/repoindex.js");
if (!fs.existsSync(modFile)) { console.error(`No index module at ${modFile}: build the server first (cd server && npm run build)`); process.exit(2); }
const mod = await import(pathToFileURL(modFile).href);
const current = await import(pathToFileURL(path.join(ROOT, "server/build/fmc/repoindex.js")).href);
// Adapter: the first version exported load/query/liveLine; the server module exports loadIndex/queryIndex/liveLine.
const load = mod.loadIndex ? () => mod.loadIndex({ root: ROOT, rebuild: true }) : () => mod.load(ROOT, { rebuild: true });
const query = mod.queryIndex ?? mod.query;
const describe = current.describe;
const liveLine = mod.liveLine;

const tok = (s) => Math.ceil(String(s).length / 4);
const readCapped = (rel, maxLines = 2000) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n").slice(0, maxLines).join("\n"); } catch { return ""; } };
const windowAt = (rel, line, n = 30) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n").slice(Math.max(0, line - 3), Math.max(0, line - 3) + n).join("\n"); } catch { return ""; } };
const grep = (pattern, flags) => {
  try { return execFileSync("git", ["grep", "-n", "-I", ...flags, "-e", pattern, "--", ".", ":!server/build", ":!*.json", ":!scripts/index", ":!results"], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }); }
  catch (e) { return e.status === 1 ? "" : String(e.stdout ?? ""); }
};
const capLines = (s, n = 250) => s.split("\n").filter(Boolean).slice(0, n).join("\n");
const filesIn = (out) => [...new Set(out.split("\n").filter(Boolean).map((l) => l.split(":")[0]))];
const words = (s) => s.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2);

const qs = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/index/questions.json"), "utf8")).questions;
const t0 = Date.now();
const { index } = load();
const buildMs = Date.now() - t0;

const rows = [];
for (const q of qs) {
  // ---- index
  const t1 = performance.now();
  const r = query(index, q.ask, 5);
  const ms = performance.now() - t1;
  const top = r.results[0]?.entry;
  let hit;
  if (q.kind === "planted") hit = !r.results.length || r.strong === false;
  else if (q.kind === "topic") hit = r.strong !== false && r.results.slice(0, 3).some((h) => q.expect_files.includes(h.entry.where));
  else hit = !!top && top.key === q.expect_key;
  const text = describe(index, ROOT, r);
  const line = top ? liveLine(ROOT, top) : null;
  const idxCost = tok(text) + (top && line && q.kind !== "planted" ? tok(windowAt(top.where, line)) : 0);

  // ---- baseline: grep, then read
  let out;
  if (q.kind === "topic" || q.kind === "planted" && /\s/.test(q.ask)) {
    // the agent greps its most specific word: the one with the fewest matching lines
    const tries = words(q.ask).map((w) => ({ w, out: grep(w, ["-i", "-w"]) })).sort((a, b) => a.out.split("\n").length - b.out.split("\n").length);
    out = tries.find((t) => t.out)?.out ?? "";
  } else out = grep(q.ask, ["-w", "-F"]);
  const shown = capLines(out);
  const files = filesIn(shown);
  const expect = q.expect_files ?? (q.expect_file ? [q.expect_file] : []);
  const found = expect.find((f) => files.includes(f));
  const baseHit = q.kind === "planted" ? !shown : !!found;
  const baseCost = tok(shown) + (q.kind === "planted" ? files.slice(0, 2).reduce((s, f) => s + tok(readCapped(f)), 0)
    : found ? tok(readCapped(found)) : files.slice(0, 2).reduce((s, f) => s + tok(readCapped(f)), 0));

  rows.push({ kind: q.kind, ask: q.ask, hit, top: top?.key ?? "", strong: r.strong, idx_tokens: idxCost, idx_ms: Number(ms.toFixed(2)),
    base_hit: baseHit, base_tokens: baseCost, grep_lines: out.split("\n").filter(Boolean).length });
}

// ---- summary
const kinds = [...new Set(rows.map((r) => r.kind))];
const sum = (a) => a.reduce((s, x) => s + x, 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const byKind = kinds.map((k) => {
  const rs = rows.filter((r) => r.kind === k);
  return { kind: k, n: rs.length, idx_hits: rs.filter((r) => r.hit).length, base_hits: rs.filter((r) => r.base_hit).length,
    idx_median: median(rs.map((r) => r.idx_tokens)), base_median: median(rs.map((r) => r.base_tokens)) };
});
const total = { n: rows.length, idx_hits: rows.filter((r) => r.hit).length, base_hits: rows.filter((r) => r.base_hit).length,
  idx_tokens: sum(rows.map((r) => r.idx_tokens)), base_tokens: sum(rows.map((r) => r.base_tokens)),
  idx_median: median(rows.map((r) => r.idx_tokens)), base_median: median(rows.map((r) => r.base_tokens)),
  idx_ms_median: median(rows.map((r) => r.idx_ms)) };
const docsAll = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean).reduce((s, f) => s + tok(readCapped(f, 1e9)), 0);

const result = { label, date: new Date().toISOString().slice(0, 10), module: path.relative(ROOT, modFile).replace(/\\/g, "/"),
  build_ms: buildMs, entries: index.entries.length, read_all_docs_tokens: docsAll, total, byKind, rows };

if (CI) {
  const bad = rows.filter((r) => !r.hit && ["finding", "work", "decision", "tool", "command", "planted"].includes(r.kind));
  for (const b of bad) console.error(`MISS ${b.kind} ${b.ask} -> ${b.top || "(none)"}`);
  console.log(`index impact: ${total.idx_hits}/${total.n} hits (grep ${total.base_hits}/${total.n}); ${bad.length} required misses`);
  process.exit(bad.length ? 1 : 0);
}

const outDir = path.join(ROOT, "results");
fs.mkdirSync(outDir, { recursive: true });
const stem = `index_impact_${result.date}${label === "current" ? "" : "_" + label}`;
fs.writeFileSync(path.join(outDir, stem + ".json"), JSON.stringify(result, null, 1) + "\n");
const pct = (a, b) => (b ? Math.round((1 - a / b) * 100) : 0);
const md = [
  `# Repo index impact (${label}, ${result.date})`, "",
  `Questions: ${total.n}, fixed before the index was built (scripts/index/questions.json). Index: ${result.entries} entries, built in ${buildMs} ms.`,
  `Reading every doc once would cost about ${docsAll.toLocaleString("en")} tokens (reference only).`, "",
  "| | Index | Grep + read (baseline) |", "|---|---|---|",
  `| Answers reached | ${total.idx_hits}/${total.n} | ${total.base_hits}/${total.n} |`,
  `| Tokens per question (median) | ${total.idx_median} | ${total.base_median} |`,
  `| Tokens, all ${total.n} questions | ${total.idx_tokens.toLocaleString("en")} | ${total.base_tokens.toLocaleString("en")} (index uses ${pct(total.idx_tokens, total.base_tokens)}% less) |`,
  "", "| Kind | n | Index | Baseline | Median tokens index / baseline |", "|---|---|---|---|---|",
  ...byKind.map((k) => `| ${k.kind} | ${k.n} | ${k.idx_hits} | ${k.base_hits} | ${k.idx_median} / ${k.base_median} |`),
  "", "## Every miss", "",
  ...rows.filter((r) => !r.hit || !r.base_hit).map((r) => `- ${r.kind} \`${r.ask}\`: index ${r.hit ? "hit" : "MISS"} (top ${r.top || "none"}, ${r.strong ? "strong" : "weak"}), baseline ${r.base_hit ? "hit" : "MISS"}`),
  "",
];
fs.writeFileSync(path.join(outDir, stem + ".md"), md.join("\n"));
console.log(JSON.stringify({ label, entries: result.entries, build_ms: buildMs, total, byKind }, null, 1));
