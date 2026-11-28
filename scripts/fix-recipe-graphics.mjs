#!/usr/bin/env node
// FAM-044 (owner 26 Oct): rewrites the add_subcategory ops of every *.recipe.json under the given folders to black or
// dark-grey lines on the rule's pens (server/src/fmc/familygraphics.ts). Geometry, materials and names are untouched.
// Usage: node scripts/fix-recipe-graphics.mjs <folder> [<folder> ...] [--dry]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { fixSubcategory } = await import(pathToFileURL(path.join(here, "..", "server", "build", "fmc", "familygraphics.js")).href);
const dry = process.argv.includes("--dry");
const roots = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!roots.length) { console.error("give one or more folders"); process.exit(2); }

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (/^_?(Archive|Backup)/i.test(e.name) ? [] : walk(path.join(d, e.name))) : /\.recipe\.json$/i.test(e.name) ? [path.join(d, e.name)] : []);

let files = 0, changed = 0, subs = 0;
for (const root of roots) for (const f of walk(root)) {
  files++;
  const raw = fs.readFileSync(f, "utf8");
  let r; try { r = JSON.parse(raw.replace(/^﻿/, "")); } catch { console.log(`skip (not JSON): ${f}`); continue; }
  let n = 0;
  const fix = (ops) => (ops ?? []).map((o) => {
    if (o?.op !== "add_subcategory") return o;
    const x = fixSubcategory(o);
    if (JSON.stringify(x) !== JSON.stringify(o)) n++;
    return x;
  });
  r.ops = fix(r.ops);
  if (n === 0) continue;
  changed++; subs += n;
  if (!dry) fs.writeFileSync(f, JSON.stringify(r, null, 2) + "\n");
  console.log(`${dry ? "would fix" : "fixed"} ${n} subcategories: ${path.relative(process.cwd(), f)}`);
}
console.log(`${files} recipes, ${changed} ${dry ? "would change" : "changed"}, ${subs} subcategories`);
