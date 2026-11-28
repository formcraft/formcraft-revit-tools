/**
 * fmc_match (gap-analysis proposal 10): copy the type, instance parameters and view graphic overrides from one
 * element to others of the same category, like pyRevit Match. This file is the pure planner. The model is read and
 * written by the add-in (fmc_match, fmc_match_apply). A dry run returns the per-target diff and plan_hash; an apply
 * plans again and refuses when the hash differs, so a person's yes is tied to these very steps.
 */
import { createHash } from "node:crypto";

export const MATCH_WHAT = ["type", "parameters", "overrides"] as const;
export type MatchWhat = typeof MATCH_WHAT[number];
export const MATCH_MAX_TARGETS = 200;

export type Storage = "String" | "Double" | "Integer" | "ElementId";
export interface ParamVal { key: string; name: string; storage: Storage; value: string | number | null; display?: string }
export interface ElemSnap {
  id: string;
  exists?: boolean;
  category?: string;
  type_id?: string;
  type_name?: string;
  /** false when another user owns it in a workshared model */
  editable?: boolean;
  owner?: string;
  /** the target can take the source's type (Element.IsValidType) */
  accepts_source_type?: boolean;
  params?: ParamVal[];
  override?: Record<string, unknown> | null;
}

export type MatchStep =
  | { kind: "source"; id: string; view?: string }
  | { kind: "type"; target: string; from_type: string; to_type: string; to_type_name?: string; was?: string; sentence?: string }
  | { kind: "param"; target: string; key: string; name: string; storage: Storage; to: string | number | null; was?: string; sentence?: string }
  | { kind: "override"; target: string; view: string; to: Record<string, unknown>; was?: string; sentence?: string };

export interface TargetDiff {
  target: string;
  status: "will_change" | "no_change" | "refused";
  reasons: string[];
  changes: Array<{ kind: string; name?: string; from?: unknown; to?: unknown }>;
  not_on_target: string[];
}

export interface MatchPlan {
  ok: boolean;
  code: string;
  message: string;
  steps: MatchStep[];
  targets: TargetDiff[];
  totals: { targets: number; will_change: number; no_change: number; refused: number; steps: number };
  plan_hash: string;
}

export function normId(value: unknown): string {
  const s = String(value ?? "").trim();
  return /^-?\d+$/.test(s) ? s : "";
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9;
  return String(a ?? "") === String(b ?? "");
}

/** Same fingerprint rule as applyfix.planHash: sentence and was are not part of it. */
export function matchHash(steps: MatchStep[]): string {
  const canon = steps.map((s) => {
    const { sentence: _s, was: _w, ...rest } = s as Record<string, unknown>;
    return Object.keys(rest).sort().map((k) => [k, rest[k]]);
  });
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 12);
}

function fail(code: string, message: string): MatchPlan {
  return { ok: false, code, message: `[${code}] ${message}`, steps: [], targets: [], totals: { targets: 0, will_change: 0, no_change: 0, refused: 0, steps: 0 }, plan_hash: "" };
}

export interface MatchInput {
  source: ElemSnap | null;
  targets: ElemSnap[];
  what: MatchWhat[];
  view?: string;
  parameters?: string[];
  exclude_parameters?: string[];
}

function same(list: string[] | undefined, name: string): boolean {
  return (list ?? []).some((n) => n.trim().toLowerCase() === name.toLowerCase());
}

export function planMatch(input: MatchInput): MatchPlan {
  const { source } = input;
  if (!source || source.exists === false || !source.category) return fail("FMC-MATCH-SOURCE", "The source element was not found in the document. Nothing was planned.");
  if (input.targets.length === 0) return fail("FMC-MATCH-TARGETS", "No target elements. Nothing was planned.");
  if (input.targets.length > MATCH_MAX_TARGETS) return fail("FMC-MATCH-CAP", `At most ${MATCH_MAX_TARGETS} targets per call (${input.targets.length} given). Split the list.`);
  const what = input.what.length ? input.what : (["type", "parameters"] as MatchWhat[]);
  if (what.includes("overrides") && !(input.view ?? "").trim()) return fail("FMC-MATCH-VIEW", "overrides needs view: the id of the view whose graphic overrides are copied.");
  const steps: MatchStep[] = [{ kind: "source", id: source.id, ...(what.includes("overrides") ? { view: String(input.view) } : {}) }];
  const diffs: TargetDiff[] = [];
  const seen = new Set<string>();
  const only = (input.parameters ?? []).filter((n) => n.trim());
  for (const t of input.targets) {
    const diff: TargetDiff = { target: t.id, status: "no_change", reasons: [], changes: [], not_on_target: [] };
    diffs.push(diff);
    if (seen.has(t.id)) { diff.status = "refused"; diff.reasons.push("Listed twice."); continue; }
    seen.add(t.id);
    if (t.id === source.id) { diff.status = "refused"; diff.reasons.push("This is the source element."); continue; }
    if (t.exists === false) { diff.status = "refused"; diff.reasons.push("Not found in the document."); continue; }
    if ((t.category ?? "") !== source.category) {
      diff.status = "refused";
      diff.reasons.push(`Category ${t.category || "(none)"} is not the source's ${source.category}. Same category only.`);
      continue;
    }
    if (t.editable === false) { diff.status = "refused"; diff.reasons.push(`Owned by ${t.owner || "another user"}.`); continue; }
    const mine: MatchStep[] = [];
    if (what.includes("type") && source.type_id && t.type_id !== source.type_id) {
      if (t.accepts_source_type === false) {
        diff.status = "refused";
        diff.reasons.push(`The source type "${source.type_name ?? source.type_id}" is not valid for this element.`);
        continue;
      }
      mine.push({ kind: "type", target: t.id, from_type: t.type_id ?? "", to_type: source.type_id, to_type_name: source.type_name, was: t.type_name,
        sentence: `Type ${t.type_name ?? t.type_id ?? "?"} → ${source.type_name ?? source.type_id}` });
      diff.changes.push({ kind: "type", from: t.type_name ?? t.type_id, to: source.type_name ?? source.type_id });
    }
    if (what.includes("parameters")) {
      const theirs = new Map((t.params ?? []).map((p) => [p.key, p]));
      for (const p of source.params ?? []) {
        if (only.length && !same(only, p.name)) continue;
        if (same(input.exclude_parameters, p.name)) continue;
        const o = theirs.get(p.key);
        if (!o) { diff.not_on_target.push(p.name); continue; }
        if (o.storage !== p.storage) { diff.not_on_target.push(`${p.name} (storage ${o.storage} vs ${p.storage})`); continue; }
        if (sameValue(o.value, p.value)) continue;
        mine.push({ kind: "param", target: t.id, key: p.key, name: p.name, storage: p.storage, to: p.value, was: String(o.display ?? o.value ?? ""),
          sentence: `${p.name}: ${o.display ?? o.value ?? ""} → ${p.display ?? p.value ?? ""}` });
        diff.changes.push({ kind: "parameter", name: p.name, from: o.display ?? o.value, to: p.display ?? p.value });
      }
    }
    if (what.includes("overrides")) {
      const want = source.override ?? {};
      const have = t.override ?? {};
      if (JSON.stringify(sortKeys(want)) !== JSON.stringify(sortKeys(have))) {
        mine.push({ kind: "override", target: t.id, view: String(input.view), to: sortKeys(want), was: JSON.stringify(have), sentence: "Graphic overrides copied in the view" });
        diff.changes.push({ kind: "override", from: have, to: want });
      }
    }
    if (mine.length) { diff.status = "will_change"; steps.push(...mine); }
  }
  const totals = {
    targets: diffs.length,
    will_change: diffs.filter((d) => d.status === "will_change").length,
    no_change: diffs.filter((d) => d.status === "no_change").length,
    refused: diffs.filter((d) => d.status === "refused").length,
    steps: steps.length - 1,
  };
  return { ok: true, code: "", message: "", steps, targets: diffs, totals, plan_hash: matchHash(steps) };
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** Why a plan can't be applied (empty: it can). */
export function applyProblems(plan: MatchPlan, givenHash: string): string[] {
  const p: string[] = [];
  if (!plan.ok) { p.push(plan.message); return p; }
  if (!givenHash.trim()) p.push("[FMC-MATCH-HASH] Apply needs plan_hash from the dry run the person saw.");
  else if (givenHash.trim() !== plan.plan_hash) p.push("[FMC-MATCH-PLAN-CHANGED] The plan changed since the dry run (the model moved on): run the dry run again and show the new diff.");
  if (plan.totals.steps === 0) p.push("[FMC-MATCH-NOTHING] Nothing differs, so there is nothing to apply.");
  return p;
}
