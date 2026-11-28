/**
 * fmc_qa run helpers (QA-5, QA-6, QA-7): pick rules to run, compare a picked run with the last full run, and name the
 * Formcraft tool that fixes a failing rule where one exists. Pure functions; the tool reads and writes nothing here.
 */
import type { Rule, RuleResult, Rulebooks } from "./rules.js";

export interface RulePick { rules?: string[]; book?: string; severity?: "Must" | "Should" | "Advice" }

/** QA-6: the rulebooks with only the picked rules (by id, book name and/or severity); every filter given must match. */
export function pickRules(books: Rulebooks, pick: RulePick): { books: Rulebooks; picked: boolean; unknown: string[] } {
  const ids = (pick.rules ?? []).map((id) => id.trim().toUpperCase()).filter(Boolean);
  const book = (pick.book ?? "").trim().toLowerCase();
  const picked = ids.length > 0 || !!book || !!pick.severity;
  if (!picked) return { books, picked, unknown: [] };
  const known = new Set(books.rules.map((r) => r.id.toUpperCase()));
  const unknown = ids.filter((id) => !known.has(id));
  const rules = books.rules.filter((r) => (!ids.length || ids.includes(r.id.toUpperCase()))
    && (!book || r.book.toLowerCase() === book || r.book.toLowerCase().includes(book))
    && (!pick.severity || r.severity === pick.severity));
  return { books: { ...books, rules }, picked, unknown };
}

/** QA-6: a picked run against the last full run of the same model and gate, for the picked rules only. */
export function compareWithLast(lastFailing: string[] | null, failingNow: string[], pickedIds: string[]) {
  if (!lastFailing) return { last_run: false, fixed: [] as string[], still_failing: failingNow, new_failing: [] as string[] };
  const scope = new Set(pickedIds);
  const before = new Set(lastFailing.filter((id) => scope.has(id)));
  const now = new Set(failingNow);
  return {
    last_run: true,
    fixed: [...before].filter((id) => !now.has(id)).sort(),
    still_failing: failingNow.filter((id) => before.has(id)).sort(),
    new_failing: failingNow.filter((id) => !before.has(id)).sort(),
  };
}

const BY_CHECK: Record<string, string> = {
  sheet_number_pattern: "fmc_sheets",
  sheet_parameter_filled: "fmc_sheets",
  sheet_parameters_filled: "fmc_sheets",
  view_template_name_pattern: "fmc_viewstyle",
  links_pinned: "fmc_links",
  type_parameter_filled: "fmc_family_params",
  type_parameters_filled: "fmc_family_params",
};

const BY_WORD: Array<[RegExp, string]> = [
  [/keynote legend/i, "fmc_keynote_legend"],
  [/keynote/i, "fmc_keynote_place"],
  [/\bsheet/i, "fmc_sheets"],
  [/view template|filter|colour fill|color fill/i, "fmc_viewstyle"],
  [/\blink/i, "fmc_links"],
  [/workset|central|workshar/i, "fmc_workshare"],
  [/material/i, "fmc_material"],
  [/purge|unused/i, "fmc_memory"],
  [/\bjoin/i, "fmc_joins"],
  [/\bphase/i, "fmc_phase"],
  [/north|shared coordinate|survey point|project base/i, "fmc_north"],
  [/schedule/i, "fmc_schedules"],
  [/\btag/i, "fmc_tags"],
  [/dimension/i, "fmc_dims"],
  [/\broom/i, "fmc_room"],
];

/** QA-7: the tool that fixes a rule, from its check kind, else words in the rule; null when no tool fits. Every named tool dry-runs first. */
export function fixTool(rule: Pick<Rule, "check" | "rule" | "book" | "kit_check"> | undefined): string | null {
  if (!rule) return null;
  const kind = String(rule.check?.kind ?? rule.kit_check ?? "");
  if (BY_CHECK[kind]) return BY_CHECK[kind];
  const text = `${rule.rule} ${rule.book}`;
  for (const [re, tool] of BY_WORD) if (re.test(text)) return tool;
  return null;
}

/** QA-5: why rules were not checked, ordered by how many Must rules each missing reader would unlock. */
export function unlockOrder(results: RuleResult[]) {
  const groups = new Map<string, { must: number; total: number; rules: string[] }>();
  for (const r of results.filter((x) => x.state === "Not checked" && !x.human)) {
    const key = r.where.replace(/"[^"]*"/g, '"…"');
    const g = groups.get(key) ?? { must: 0, total: 0, rules: [] };
    g.total += 1; if (r.severity === "Must") g.must += 1;
    if (g.rules.length < 10) g.rules.push(r.id);
    groups.set(key, g);
  }
  return [...groups.entries()].sort((a, b) => b[1].must - a[1].must || b[1].total - a[1].total)
    .map(([reason, g]) => ({ reason, must_unlocked: g.must, rules_unlocked: g.total, rules: g.rules }));
}
