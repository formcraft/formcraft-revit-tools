/**
 * Summaries for AI callers (F-009): "summaries, not element dumps" (CLAUDE.md). A scan of 346 families or a QA run of
 * 344 rules is far too big for a model's context, so tools answer with counts and the worst few by default; the pane,
 * which shows every row, asks for detail "full". Pure.
 */
import { FamilyVerdict } from "./library.js";
import { RuleResult, Rulebooks } from "./rules.js";

export const DEFAULT_LIMIT = 15;

/** The families that need the most work first, each with only the checks it fails. */
export function worstFamilies(verdicts: FamilyVerdict[], limit = DEFAULT_LIMIT) {
  return [...verdicts]
    .filter((v) => v.state !== "Compliant")
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((v) => ({ name: v.name, category: v.category, state: v.state, score: v.score,
      failing: v.checks.filter((c) => c.state === "fail").map((c) => `${c.check}: ${c.detail}`) }));
}

/** QA results that need attention (Fail, then Warning), compact; and why rules weren't checked, grouped. */
export function qaDigest(results: RuleResult[], limit = DEFAULT_LIMIT) {
  const attention = results.filter((r) => (r.state === "Fail" || r.state === "Warning"))
    .slice(0, limit)
    .map((r) => ({ id: r.id, rule: r.rule, severity: r.severity, state: r.state, where: r.where, ...(r.excepted ? { excepted: r.excepted } : {}),
      elements: r.element_ids.length }));
  const reasons = new Map<string, { count: number; must: number; examples: string[] }>();
  for (const r of results.filter((x) => x.state === "Not checked")) {
    const key = r.where.replace(/"[^"]*"/g, '"…"');
    const e = reasons.get(key) ?? { count: 0, must: 0, examples: [] };
    e.count++; if (r.severity === "Must") e.must++;
    if (e.examples.length < 5) e.examples.push(r.id);
    reasons.set(key, e);
  }
  const not_checked_by_reason = [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)
    .map(([reason, e]) => ({ reason, count: e.count, must: e.must, examples: e.examples }));
  return { attention, more_attention: Math.max(0, results.filter((r) => r.state === "Fail" || r.state === "Warning").length - limit), not_checked_by_reason };
}

/** The rulebooks in brief: books, counts by severity and status, what can run. */
export function rulebooksDigest(books: Rulebooks) {
  const count = <T extends string>(f: (r: Rulebooks["rules"][number]) => T) =>
    books.rules.reduce((m, r) => { const k = f(r); m[k] = (m[k] ?? 0) + 1; return m; }, {} as Record<string, number>);
  return {
    books: books.books, rules: books.rules.length,
    by_severity: count((r) => r.severity), by_status: count((r) => r.status),
    runs: count((r) => (r.status === "Proposed" ? "proposed (listed, not run)" : r.check ? "runs" : r.human ? "a person confirms" : "not checked yet")),
    exceptions: books.exceptions.length, decisions: books.decisions.length, problems: books.problems,
  };
}
