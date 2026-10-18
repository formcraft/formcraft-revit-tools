/**
 * F-063 / F-064 #5 (QG4): fmc_recipe batch, the pure part. Which recipes to build (skip what is already staged, passed
 * Gate A and built from the same recipe revision, unless asked to rebuild), and what the results file says.
 */
import crypto from "node:crypto";
import fs from "node:fs";

/** A short, stable tag for a recipe's content (template and ops): two builds of the same revision make the same family. */
export function recipeRevision(recipe: { template: string; ops: unknown[] }): string {
  return crypto.createHash("sha1").update(JSON.stringify({ template: recipe.template, ops: recipe.ops })).digest("hex").slice(0, 12);
}

export interface BatchCandidate {
  family: string;
  revision: string;
  /** What staging holds now: the family, the revision of the recipe beside it, and its last Gate A verdict. */
  staged: { exists: boolean; revision?: string | null; verdict?: string | null };
}

export interface BatchPlan { build: string[]; skip: Array<{ family: string; why: string }> }

/** Build everything that isn't staged, passed and current; rebuild = true or a list of families forces those. */
export function planBatch(cands: BatchCandidate[], rebuild: boolean | string[] = false): BatchPlan {
  const force = new Set(Array.isArray(rebuild) ? rebuild : []);
  const plan: BatchPlan = { build: [], skip: [] };
  for (const c of cands) {
    if (rebuild === true || force.has(c.family)) { plan.build.push(c.family); continue; }
    const s = c.staged;
    if (s.exists && s.revision === c.revision && s.verdict === "Pass") {
      plan.skip.push({ family: c.family, why: `already staged from this recipe revision (${c.revision}) and Gate A passed` });
      continue;
    }
    plan.build.push(c.family);
  }
  return plan;
}

export interface BatchLine { family: string; at?: string; ok?: boolean; error?: string; s?: number; gate?: string; gate_fails?: string[]; [k: string]: unknown }

/** The results file: the last line per family (a rebuild or a later gate replaces the earlier one) and the totals. */
export function readBatchResults(file: string): { lines: BatchLine[]; built: number; failed: number; gated: number; passed: number } {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return { lines: [], built: 0, failed: 0, gated: 0, passed: 0 }; }
  const last = new Map<string, BatchLine>();
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim()) continue;
    try {
      const j = JSON.parse(l.replace(/^﻿/, "")) as BatchLine;
      if (!j.family) continue;
      last.set(j.family, { ...(last.get(j.family) ?? {}), ...j });
    } catch { /* a torn line */ }
  }
  const lines = [...last.values()];
  return {
    lines,
    built: lines.filter((l) => l.ok === true).length,
    failed: lines.filter((l) => l.ok === false).length,
    gated: lines.filter((l) => l.gate).length,
    passed: lines.filter((l) => l.gate === "Pass").length,
  };
}

/** A batch id from the time, e.g. B-20261018-0930 (local time; one per minute is plenty). */
export function batchId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `B-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
