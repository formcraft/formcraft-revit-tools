/**
 * Rulebooks and QA (boards manage/PaneRules, manage/PaneQA, U16). Pure.
 *
 * Rule schema v1, as the boards describe it: each rule says how serious it is (Must, Should, Advice), where it applies
 * (scope), how it is tested (test), how to fix it (fix_hint), when it changed (version) and why. The kit holds the
 * rulebooks (one JSON file per book); rule content never lives in code (rule 7). A rule QA can run names a check kind
 * the plugin implements ("check": {"kind": …, …}); a rule without one shows as Not checked, never guessed.
 */
export type Severity = "Must" | "Should" | "Advice";
export type RuleStatus = "Standard" | "Proposed" | "Plugin";

export interface RuleCheck { kind: string; [param: string]: unknown }
export interface Rule {
  id: string; rule: string; severity: Severity; status: RuleStatus; book: string;
  scope: string; test: string; fix_hint: string; version: string; why: string;
  gates: string[]; check?: RuleCheck;
}
export interface RuleException { rule: string; where: string; approved_by: string; until: string; reason: string }
export interface Decision { text: string; state: string }
export interface Rulebooks { books: Array<{ name: string; version: string; count: number }>; rules: Rule[]; exceptions: RuleException[]; decisions: Decision[]; problems: string[] }

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const sev = (v: unknown): Severity => { const s = str(v).toLowerCase(); return s.startsWith("must") ? "Must" : s.startsWith("should") ? "Should" : "Advice"; };
const status = (v: unknown): RuleStatus => { const s = str(v).toLowerCase(); return s.startsWith("prop") ? "Proposed" : s.startsWith("plug") ? "Plugin" : "Standard"; };

/** Reads one rulebook file's JSON (tolerant of field-name variants: rule/title/text, fix_hint/fix, gate/gates). */
export function parseRulebook(fileName: string, json: any, problems: string[]): { name: string; version: string; rules: Rule[]; exceptions: RuleException[]; decisions: Decision[] } {
  const name = str(json?.rulebook ?? json?.name ?? fileName.replace(/^FMC_Rules_|\.json$/gi, ""));
  const version = str(json?.version);
  const rules: Rule[] = [];
  for (const r of Array.isArray(json?.rules) ? json.rules : []) {
    const id = str(r?.id).trim();
    if (!id) { problems.push(`${fileName}: a rule has no id`); continue; }
    const gates = Array.isArray(r?.gates) ? r.gates.map(str) : r?.gate ? [str(r.gate)] : [];
    rules.push({
      id, book: name, rule: str(r.rule ?? r.title ?? r.text), severity: sev(r.severity), status: status(r.status ?? r.source),
      scope: str(r.scope), test: str(r.test), fix_hint: str(r.fix_hint ?? r.fix), version: str(r.version ?? r.changed), why: str(r.why),
      gates, check: r?.check && typeof r.check.kind === "string" ? r.check : undefined,
    });
  }
  const exceptions = (Array.isArray(json?.exceptions) ? json.exceptions : []).map((e: any) => ({
    rule: str(e.rule), where: str(e.where), approved_by: str(e.approved_by ?? e.approver), until: str(e.until), reason: str(e.reason),
  }));
  const decisions = (Array.isArray(json?.decisions) ? json.decisions : []).map((d: any) => ({ text: str(d.text ?? d.decision), state: str(d.state ?? "decided") }));
  return { name, version, rules, exceptions, decisions };
}

export function mergeRulebooks(files: Array<{ name: string; json: any }>): Rulebooks {
  const problems: string[] = [];
  const out: Rulebooks = { books: [], rules: [], exceptions: [], decisions: [], problems };
  const seen = new Set<string>();
  for (const f of files) {
    const b = parseRulebook(f.name, f.json, problems);
    out.books.push({ name: b.name, version: b.version, count: b.rules.length });
    for (const r of b.rules) {
      if (seen.has(r.id)) { problems.push(`Rule ${r.id} is in more than one rulebook`); continue; }
      seen.add(r.id);
      out.rules.push(r);
    }
    out.exceptions.push(...b.exceptions);
    out.decisions.push(...b.decisions);
  }
  return out;
}

// ---------- QA: facts from Revit, checks from the rulebooks ----------

export interface QaFacts {
  model: string;
  views: Array<{ id: number; name: string; type: string; template: boolean }>;
  sheets: Array<{ id: number; number: string; name: string; parameters: Record<string, string> }>;
  types: Array<{ id: number; family: string; name: string; category: string; parameters: Record<string, string> }>;
  families: Array<{ id: number; name: string; in_place: boolean }>;
  links: Array<{ id: number; name: string; pinned: boolean }>;
  warnings: number;
}

export type ResultState = "Fail" | "Warning" | "Pass" | "Not applicable" | "Not checked";
export interface RuleResult { id: string; rule: string; severity: Severity; state: ResultState; where: string; element_ids: number[]; fix_hint: string; excepted?: string }

/** The parameters a check needs read from sheets and types, so Revit reads only those. */
export function neededParameters(rules: Rule[]): { sheet: string[]; type: string[] } {
  const sheet = new Set<string>(), type = new Set<string>();
  for (const r of rules) {
    if (r.check?.kind === "sheet_parameter_filled" && r.check.parameter) sheet.add(str(r.check.parameter));
    if (r.check?.kind === "type_parameter_filled" && r.check.parameter) type.add(str(r.check.parameter));
  }
  return { sheet: [...sheet], type: [...type] };
}

function fail(r: Rule, ids: number[], what: string): RuleResult {
  return { id: r.id, rule: r.rule, severity: r.severity, state: ids.length ? (r.severity === "Advice" ? "Warning" : "Fail") : "Pass",
    where: ids.length ? `${ids.length} ${what}` : "", element_ids: ids.slice(0, 500), fix_hint: r.fix_hint };
}

export function runRule(r: Rule, f: QaFacts): RuleResult {
  const c = r.check;
  if (!c) return { id: r.id, rule: r.rule, severity: r.severity, state: "Not checked", where: "No check kind in the rulebook yet", element_ids: [], fix_hint: r.fix_hint };
  const re = (p: unknown) => { try { return new RegExp(str(p)); } catch { return null; } };
  switch (c.kind) {
    case "view_name_pattern": {
      const pattern = re(c.pattern);
      if (!pattern) break;
      const types = Array.isArray(c.view_types) ? c.view_types.map(str) : null;
      const views = f.views.filter((v) => !v.template && (!types || types.includes(v.type)));
      if (!views.length) return { ...fail(r, [], ""), state: "Not applicable" };
      return fail(r, views.filter((v) => !pattern.test(v.name)).map((v) => v.id), "views");
    }
    case "sheet_parameter_filled": {
      if (!f.sheets.length) return { ...fail(r, [], ""), state: "Not applicable" };
      const p = str(c.parameter);
      return fail(r, f.sheets.filter((s) => !(s.parameters[p] ?? "").trim()).map((s) => s.id), "sheets");
    }
    case "type_parameter_filled": {
      const p = str(c.parameter);
      const cats = Array.isArray(c.categories) ? c.categories.map(str) : null;
      const types = f.types.filter((t) => !cats || cats.includes(t.category));
      if (!types.length) return { ...fail(r, [], ""), state: "Not applicable" };
      return fail(r, types.filter((t) => !(t.parameters[p] ?? "").trim()).map((t) => t.id), "types");
    }
    case "family_name_pattern": {
      const pattern = re(c.pattern);
      if (!pattern) break;
      return fail(r, f.families.filter((x) => !x.in_place && !pattern.test(x.name)).map((x) => x.id), "families");
    }
    case "links_pinned":
      if (!f.links.length) return { ...fail(r, [], ""), state: "Not applicable" };
      return fail(r, f.links.filter((l) => !l.pinned).map((l) => l.id), "links unpinned");
    case "max_count": {
      const metric = str(c.metric);
      const value = metric === "warnings" ? f.warnings : metric === "in_place_families" ? f.families.filter((x) => x.in_place).length : NaN;
      const max = Number(c.max);
      if (Number.isNaN(value) || Number.isNaN(max)) break;
      return { id: r.id, rule: r.rule, severity: r.severity, state: value > max ? (r.severity === "Advice" ? "Warning" : "Fail") : "Pass",
        where: `${value} ${metric.replace(/_/g, " ")} (max ${max})`, element_ids: [], fix_hint: r.fix_hint };
    }
  }
  return { id: r.id, rule: r.rule, severity: r.severity, state: "Not checked", where: `The plugin doesn't run check kind "${c.kind}" yet`, element_ids: [], fix_hint: r.fix_hint };
}

export const GATES: Record<string, string> = {
  wip_to_shared: "WIP → Shared (Discipline Lead)",
  shared_to_published: "Shared → Published (PIM)",
  weekly: "Weekly health",
};

/** Runs the gate's rules (rules with no gate run at every gate); exceptions in force mark a failure as excepted. */
export function runQa(books: Rulebooks, facts: QaFacts, gate: string, today: string) {
  const rules = books.rules.filter((r) => r.status !== "Proposed" && (!r.gates.length || r.gates.includes(gate)));
  const results = rules.map((r) => runRule(r, facts));
  for (const res of results) {
    const ex = books.exceptions.find((e) => e.rule === res.id && (!e.until || e.until >= today));
    if (ex && (res.state === "Fail" || res.state === "Warning")) res.excepted = `Exception: ${ex.where} · ${ex.approved_by}${ex.until ? " until " + ex.until : ""}`;
  }
  const order: Record<ResultState, number> = { Fail: 0, Warning: 1, "Not checked": 2, "Not applicable": 3, Pass: 4 };
  const sevOrder: Record<Severity, number> = { Must: 0, Should: 1, Advice: 2 };
  results.sort((a, b) => order[a.state] - order[b.state] || sevOrder[a.severity] - sevOrder[b.severity] || a.id.localeCompare(b.id));
  const count = (s: ResultState) => results.filter((x) => x.state === s).length;
  const blocking = results.filter((x) => x.state === "Fail" && x.severity === "Must" && !x.excepted);
  return {
    gate, gate_name: GATES[gate] ?? gate, model: facts.model, ran: results.length,
    pass: count("Pass"), fail: count("Fail"), warning: count("Warning"), not_applicable: count("Not applicable"), not_checked: count("Not checked"),
    blocking: blocking.map((b) => b.id),
    summary: blocking.length
      ? `${blocking.length} Must rule${blocking.length === 1 ? "" : "s"} block${blocking.length === 1 ? "s" : ""} the move: ${blocking.map((b) => `${b.id} (${b.where})`).join(", ")}.`
      : "No Must rule blocks the move.",
    results,
  };
}

/** New, recurring and resolved against the previous run of the same model and gate. */
export function trend(previous: string[] | null, failing: string[]) {
  const prev = new Set(previous ?? []);
  const now = new Set(failing);
  return {
    new: failing.filter((id) => !prev.has(id)).length,
    recurring: failing.filter((id) => prev.has(id)).length,
    resolved: [...prev].filter((id) => !now.has(id)).length,
  };
}

export function qaReport(r: ReturnType<typeof runQa>, when: Date): string {
  const lines = [
    `# QA · ${r.model} · ${r.gate_name}`, "", `Run ${when.toISOString()}. ${r.ran} checks: ${r.pass} pass, ${r.fail} fail, ${r.warning} warnings, ` +
      `${r.not_applicable} not applicable, ${r.not_checked} not checked.`, "", r.summary, "",
    "| Rule | What | Severity | Result | Where | Fix |", "|---|---|---|---|---|---|",
    ...r.results.map((x) => `| ${x.id} | ${x.rule} | ${x.severity} | ${x.state}${x.excepted ? " (excepted)" : ""} | ${x.where} | ${x.fix_hint} |`),
  ];
  return lines.join("\n") + "\n";
}
