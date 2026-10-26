#!/usr/bin/env node
// Writes scripts/index/questions.json: the fixed question set the index impact report is judged on.
// Run once, before the index exists, and commit the result: the questions must not be tuned to the index.
// Most questions are real IDs picked at random with a fixed seed (no hand-picking); topic questions carry the answer
// a person expects; planted questions have no answer, so a search that "finds" something for them is wrong.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// Small seeded PRNG (mulberry32) so the pick is reproducible.
let seed = 20261026;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (list, n) => { const a = [...new Set(list)]; const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rand() * a.length), 1)[0]); return out; };

const firstCellIds = (file, re) => read(file).split("\n").map((l) => l.match(re)?.[1]).filter(Boolean);
const findings = firstCellIds("docs/TEST_FEEDBACK.md", /^\| *\**(F-\d{2,3})\b/);
const work = firstCellIds("docs/STATUS.md", /^\| *\**(U\d{2,3})\b/);
const decisions = firstCellIds("docs/DECISIONS.md", /^\| *\**(D\d{1,2})\b/);

const toolFiles = fs.readdirSync(path.join(ROOT, "server/src/tools")).filter((f) => /^fmc_.*\.ts$/.test(f) && !f.endsWith(".test.ts"));
const commands = [];
const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
  const p = `${d}/${e.name}`;
  if (e.isDirectory()) walk(p);
  else if (p.endsWith(".cs")) for (const m of read(p).matchAll(/CommandName\s*=>\s*"([a-z0-9_]+)"/g)) commands.push({ name: m[1], file: p });
} };
walk("commandset");

const q = [];
for (const id of pick(findings, 15)) q.push({ kind: "finding", ask: id, expect_key: id, expect_file: "docs/TEST_FEEDBACK.md" });
for (const id of pick(work, 10)) q.push({ kind: "work", ask: id, expect_key: id, expect_file: "docs/STATUS.md" });
for (const id of [...new Set(decisions)]) q.push({ kind: "decision", ask: id, expect_key: id, expect_file: "docs/DECISIONS.md" });
for (const f of pick(toolFiles, 6)) q.push({ kind: "tool", ask: f.replace(/\.ts$/, ""), expect_key: "tool:" + f.replace(/\.ts$/, ""), expect_file: "server/src/tools/" + f });
for (const c of pick(commands.map((c) => c.name), 6)) q.push({ kind: "command", ask: c, expect_key: "cmd:" + c, expect_file: commands.find((x) => x.name === c).file });

// Topic questions: words a person would type, and the files a person would accept as the answer (any one of them).
const topics = [
  ["ai_modeller section in the guard", ["server/src/fmc/aiuse.ts", "server/src/fmc/aiuse_io.ts"]],
  ["stop ai switch", ["server/src/fmc/aiuse_io.ts", "server/src/tools/fmc_ai.ts", "docs/AI_ASSISTED_MODELLER.md"]],
  ["ai involvement bands", ["server/src/fmc/aiuse.ts", "docs/AI_ASSISTED_MODELLER.md"]],
  ["ai approval queue", ["server/src/fmc/aiuse_io.ts", "server/src/tools/fmc_ai.ts"]],
  ["live model lock verdict", ["server/src/fmc/policy.ts"]],
  ["mock licence service", ["shell/Formcraft.Shell/Services/MockLicenceService.cs"]],
  ["updater installs when revit is closed", ["scripts/fmc-update.ps1", "scripts/fmc-updater-task.ps1"]],
  ["selftest rulebook line", ["server/src/fmc/selftest.ts", "server/src/tools/fmc_selftest.ts"]],
];
for (const [ask, files] of topics) q.push({ kind: "topic", ask, expect_files: files });

// Planted: no answer exists. A confident hit here is a false positive.
for (const ask of ["F-999", "D99", "zebra quantum flux capacitor"]) q.push({ kind: "planted", ask, expect_none: true });

const out = { made: new Date().toISOString().slice(0, 10), seed: 20261026, count: q.length, questions: q };
fs.writeFileSync(path.join(ROOT, "scripts/index/questions.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`${q.length} questions:`, Object.entries(q.reduce((a, x) => ((a[x.kind] = (a[x.kind] ?? 0) + 1), a), {})).map(([k, n]) => `${k} ${n}`).join(", "));
