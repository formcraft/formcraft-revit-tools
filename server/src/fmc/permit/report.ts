/**
 * The fmc_permit_check report: a DRAFT for the responsible registered professional. Markdown plus the run JSON,
 * written under the permit report folder. No word that reads as a determination ("compliant", "complies",
 * "permit granted"), no penalty amounts.
 */
import fs from "node:fs";
import path from "node:path";
import type { Derived } from "./derive.js";
import type { Finding } from "./finding.js";
import type { CategoryResult } from "./evaluate.js";
import { ROOM_USE_NOTE } from "./roomuse.js";

export interface PermitRun {
  tool: "fmc_permit_check"; version: 1; created: string;
  document: { title: string; path: string };
  ruleset: Record<string, unknown>;
  defaults: string[];
  derived: Derived; category: CategoryResult;
  counts: Record<string, number>; findings: Finding[];
  data_gaps: string[]; notes: string[];
}

export const DRAFT_BANNER = "DRAFT for the responsible registered professional. Not a determination of the Building Committee or the National Building Review Board.";
export const FOOTER = "Nothing in the model was changed. Nothing was submitted to BIMS.";
export const BANNED_WORDS = [/\bcompliant\b/i, /\bcomplies\b/i, /permit granted/i];

const ORDER = ["FAIL", "REVIEW", "NOT_CHECKED", "ADVICE", "PASS", "NOT_APPLICABLE", "INFO"];

function cell(s: unknown): string { return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " "); }

export function renderReport(run: PermitRun): string {
  const L: string[] = [];
  L.push(`# Permit pre-check (draft): ${run.document.title || "untitled model"}`, "", `> ${DRAFT_BANNER}`, "");
  L.push(`Run ${run.created}. Model: ${run.document.path || run.document.title}.`, "");
  L.push("## Counts", "", ORDER.map((s) => `${s} ${run.counts[s] ?? 0}`).join(" · "), "");
  const d = run.derived;
  L.push("## Building as read from the model", "");
  L.push(`- Derived category: ${run.category.derived ?? "unknown"} (${run.category.reasons.join("; ") || "no reason"})`);
  L.push(`- Ground level: ${d.ground?.name ?? "none"} (${d.ground_source}); storeys at or above ground: ${d.storeys}`);
  L.push(`- Height: ${d.height_m ?? "unknown"} m (from ${d.height_source}); top floor: ${d.top_floor_height_m ?? "unknown"} m`);
  L.push(`- Floor area: ${d.gfa_m2} m2 (from ${d.gfa_source}); ground-floor footprint: ${d.footprint_m2} m2; basement depth: ${d.basement_depth_m ?? "none"}`);
  for (const n of d.notes) L.push(`- Note: ${n}`);
  L.push("");
  L.push("## Findings", "", "| State | Rule | Clause | Finding | Elements |", "|---|---|---|---|---|");
  const sorted = [...run.findings].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  for (const f of sorted) if (f.rule !== "DOCS.attach") {
    const cav = f.caveats.length ? ` Caveat: ${f.caveats.map((c) => `${c.id} ${c.what}`).join("; ")}` : "";
    L.push(`| ${f.state} | ${cell(f.topic)} | ${cell(`${f.instrument} ${f.clause}`)} | ${cell(f.message + cav)} | ${cell(f.ids.slice(0, 10).join(", "))}${f.ids.length > 10 ? " ..." : ""} |`);
  }
  L.push("", "## Documents to attach (not visible in a model)", "");
  const docs = run.findings.filter((f) => f.rule === "DOCS.attach");
  for (const f of docs) L.push(`- [ ] ${f.message.replace(/^Attach: /, "")}`);
  if (!docs.length) L.push("- (none listed)");
  L.push("", "## Rule set", "");
  for (const [k, v] of Object.entries(run.ruleset)) L.push(`- ${k}: ${cell(v)}`);
  L.push("", "## Interim defaults in force", "");
  for (const x of run.defaults) L.push(`- ${x}`);
  L.push(`- ${ROOM_USE_NOTE}`);
  L.push("", "## Data gaps", "");
  for (const g of run.data_gaps) L.push(`- ${g}`);
  if (!run.data_gaps.length) L.push("- none");
  if (run.notes.length) { L.push("", "## Notes", ""); for (const n of run.notes) L.push(`- ${n}`); }
  L.push("", "## Sign-off", "", "Reviewed by (registered professional): ____________________  Registration no.: __________", "", "Signature: ____________________  Date: __________", "");
  L.push(`_${FOOTER}_`, "");
  return L.join("\n");
}

export function runBaseName(created: string, title: string): string {
  const stamp = created.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const t = (title || "model").replace(/\.rvt$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "model";
  return `permit-${stamp}-${t}`;
}

export function writeRun(dir: string, run: PermitRun): { json: string; markdown: string } {
  fs.mkdirSync(dir, { recursive: true });
  const base = runBaseName(run.created, run.document.title);
  const json = path.join(dir, `${base}.json`);
  const markdown = path.join(dir, `${base}.md`);
  fs.writeFileSync(json, JSON.stringify(run, null, 2), "utf8");
  fs.writeFileSync(markdown, renderReport(run), "utf8");
  return { json, markdown };
}

/** Only a plain run name inside the report folder: no folders, no "..". */
export function safeRunFile(dir: string, name: string): string | null {
  const n = (name || "").trim().replace(/\.(json|md)$/i, "");
  if (!/^permit-[A-Za-z0-9_-]+$/.test(n)) return null;
  const file = path.join(dir, `${n}.json`);
  return path.dirname(path.resolve(file)) === path.resolve(dir) ? file : null;
}
