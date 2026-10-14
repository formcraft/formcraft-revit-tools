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
  /** Kit schema v0.1: RIBA stages the rule applies at (empty: all stages). */
  stages: string[];
  /** Kit schema v0.1: the kit's own check type, kept as written (the check above is what the plugin runs for it). */
  kit_check?: string;
  /** Kit schema v0.1: the check's params as written, for tools that read the kit's data from a rule (PST-002's tree). */
  kit_params?: Record<string, unknown>;
  /** Why the plugin can't run this rule (shown as Not checked), when it has no check. */
  not_runnable?: string;
  /** A person confirms this rule (kit check type human_gate): never a model check. */
  human?: boolean;
}
export interface RuleException { rule: string; where: string; approved_by: string; until: string; reason: string }
export interface Decision { text: string; state: string }
export interface Rulebooks { books: Array<{ name: string; version: string; count: number }>; rules: Rule[]; exceptions: RuleException[]; decisions: Decision[]; problems: string[] }

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
/** Severity as the kit writes it: error / warning / info (kit schema v0.1), or Must / Should / Advice. */
const sev = (v: unknown): Severity => {
  const s = str(v).toLowerCase();
  return s.startsWith("must") || s === "error" ? "Must" : s.startsWith("should") || s === "warning" ? "Should" : "Advice";
};
/** Status as the kit writes it: from_standard / proposed (kit schema v0.1), or Standard / Proposed / Plugin. */
const status = (v: unknown): RuleStatus => { const s = str(v).toLowerCase(); return s.startsWith("prop") ? "Proposed" : s.startsWith("plug") ? "Plugin" : "Standard"; };
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : v == null || v === "" ? [] : [str(v)]);

/** Kit metrics (count_min "metric") the plugin measures, and what it measures them with. */
const METRICS: Record<string, string> = { "warnings total": "warnings", "in-place families": "in_place_families" };

/**
 * Binds a kit check (schema v0.1: {"type": …, "params": {…}} with the rule's applies_to) to a check kind the plugin
 * runs. Only bindings the kit's own data makes unambiguous: a naming pattern runs where the rule names one collection
 * the plugin reads AND its params show what it names (example, examples or roles), so a pattern meant for a subset
 * (working views, logistics sheets) or for a parameter is never run against everything. The rest is Not checked with
 * the reason; human gates say a person confirms.
 */
export function bindKitCheck(type: string, params: Record<string, unknown>, appliesTo: string[]): { check?: RuleCheck; reason?: string; human?: boolean } {
  const p = params ?? {};
  const one = appliesTo.length === 1 ? appliesTo[0].toLowerCase() : "";
  const shows = list(p.example).length > 0 || list(p.examples).length > 0 || list(p.roles).length > 0;
  const categories = appliesTo.filter((a) => /^OST_/.test(a));
  switch (type) {
    case "human_gate":
      return { human: true, reason: "A person confirms this (human gate)" };
    case "naming_regex": {
      const regex = str(p.regex);
      if (!regex && p.forbidden_regex && appliesTo.every((a) => /types$/i.test(a)))
        return { check: { kind: "type_name_forbidden", pattern: str(p.forbidden_regex) } };
      if (!regex) return { reason: "No regex in the rule's params" };
      const kind = one === "views" ? "view_name_pattern" : one === "view templates" ? "view_template_name_pattern" : one === "sheets" ? "sheet_number_pattern" : "";
      if (!kind) return { reason: `The plugin doesn't read names of ${appliesTo.join(", ") || "this"} yet` };
      if (!shows) return { reason: "The rule doesn't show what its pattern names (no example): not run, so a pattern for a subset or a parameter never fails everything" };
      return { check: { kind, pattern: regex } };
    }
    case "parameter_present": {
      const names = [...list(p.required), ...list(p.parameter)];
      if (!names.length) return { reason: "The rule's params name no required parameter" };
      if (one === "sheets") return { check: { kind: "sheet_parameters_filled", parameters: names } };
      if (categories.length && categories.length === appliesTo.length) return { check: { kind: "type_parameters_filled", parameters: names, categories } };
      return { reason: `The plugin doesn't read parameters of ${appliesTo.join(", ")} yet` };
    }
    case "count_min": {
      const metric = METRICS[str(p.metric).toLowerCase()];
      if (!metric) return { reason: p.metric ? `The plugin doesn't measure "${str(p.metric)}" yet` : `The plugin doesn't run this count yet` };
      return { check: { kind: "health_count", metric, amber_at: Number(p.amber_at), red_at: Number(p.red_at) } };
    }
  }
  return { reason: `The plugin doesn't run check type "${type || "?"}" yet` };
}

/** Reads one rulebook file's JSON: the kit's schema v0.1 as written, and the earlier plugin schema (rule schema v1). */
export function parseRulebook(fileName: string, json: any, problems: string[]): { name: string; version: string; rules: Rule[]; exceptions: RuleException[]; decisions: Decision[] } {
  const name = str(json?.feature ?? json?.rulebook ?? json?.name ?? fileName.replace(/^FMC_(Rules|Rulebook)_|\.json$/gi, ""));
  const version = str(json?.rulebook_version ?? json?.version);
  const rules: Rule[] = [];
  for (const r of Array.isArray(json?.rules) ? json.rules : []) {
    const id = str(r?.id).trim();
    if (!id) { problems.push(`${fileName}: a rule has no id`); continue; }
    const gates = Array.isArray(r?.gates) ? r.gates.map(str) : r?.gate ? [str(r.gate)] : [];
    const stages = Array.isArray(r?.stages) ? r.stages.map(str) : [];  // "all" or missing: every stage
    const appliesTo = list(r?.applies_to);
    let check: RuleCheck | undefined, notRunnable: string | undefined, human = false, kitCheck: string | undefined;
    const kitParams = r?.check && typeof r.check.params === "object" && r.check.params ? r.check.params as Record<string, unknown> : undefined;
    if (r?.check && typeof r.check.kind === "string") check = r.check;
    else if (r?.check && typeof r.check.type === "string") {
      kitCheck = r.check.type;
      const b = bindKitCheck(r.check.type, r.check.params ?? {}, appliesTo);
      check = b.check; notRunnable = b.reason; human = !!b.human;
    }
    const title = str(r.title);
    rules.push({
      id, book: name, rule: str(title || r.rule || r.text), severity: sev(r.severity), status: status(r.status ?? r.source),
      scope: str(r.scope) || [appliesTo.join(", "), stages.length ? `stages ${stages.join(", ")}` : ""].filter(Boolean).join(" · "),
      test: str(r.test) || (title ? str(r.rule) : ""),
      fix_hint: str(r.fix_hint ?? r.fix) || (r.auto_fix === true ? "A safe fix can do this (auto_fix in the kit)" : ""),
      version: str(r.version ?? r.changed) || version, why: str(r.why) || (r.clause ? str(r.clause) : ""),
      gates, check, stages, kit_check: kitCheck, kit_params: kitParams, not_runnable: notRunnable, human,
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
  /** bic: the BuiltInCategory name (OST_Walls), which kit rules use in applies_to. */
  types: Array<{ id: number; family: string; name: string; category: string; bic?: string; parameters: Record<string, string> }>;
  families: Array<{ id: number; name: string; in_place: boolean }>;
  links: Array<{ id: number; name: string; pinned: boolean }>;
  warnings: number;
}

/**
 * The add-in's reply made safe to check: every list present (empty when Revit sent none), so a partial reply from an
 * older add-in never turns into a crash. A reply with none of the parts is refused with the reason, not guessed at.
 */
export function qaFacts(raw: unknown): QaFacts {
  const f = (raw ?? {}) as Partial<QaFacts>;
  if (!["views", "sheets", "types", "families", "links"].some((k) => Array.isArray((f as any)[k])))
    throw new Error("Revit's reply has no views, sheets or types: the add-in in Revit is older than this server. Install the latest build.");
  const arr = <T>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  return {
    model: String(f.model ?? ""), views: arr(f.views), warnings: Number(f.warnings ?? 0) || 0, links: arr(f.links), families: arr(f.families),
    sheets: arr(f.sheets).map((s) => ({ ...s, parameters: s?.parameters ?? {} })),
    types: arr(f.types).map((t) => ({ ...t, parameters: t?.parameters ?? {} })),
  };
}

export type ResultState = "Fail" | "Warning" | "Pass" | "Not applicable" | "Not checked";
export interface RuleResult { id: string; rule: string; severity: Severity; state: ResultState; where: string; element_ids: number[]; fix_hint: string; excepted?: string; human?: boolean }

/** The parameters a check needs read from sheets and types, so Revit reads only those. */
export function neededParameters(rules: Rule[]): { sheet: string[]; type: string[] } {
  const sheet = new Set<string>(), type = new Set<string>();
  for (const r of rules) {
    if (r.check?.kind === "sheet_parameter_filled" && r.check.parameter) sheet.add(str(r.check.parameter));
    if (r.check?.kind === "type_parameter_filled" && r.check.parameter) type.add(str(r.check.parameter));
    if (r.check?.kind === "sheet_parameters_filled") list(r.check.parameters).forEach((x) => sheet.add(x));
    if (r.check?.kind === "type_parameters_filled") list(r.check.parameters).forEach((x) => type.add(x));
  }
  return { sheet: [...sheet], type: [...type] };
}

function fail(r: Rule, ids: number[], what: string): RuleResult {
  return { id: r.id, rule: r.rule, severity: r.severity, state: ids.length ? (r.severity === "Advice" ? "Warning" : "Fail") : "Pass",
    where: ids.length ? `${ids.length} ${what}` : "", element_ids: ids.slice(0, 500), fix_hint: r.fix_hint };
}

export function runRule(r: Rule, f: QaFacts): RuleResult {
  const c = r.check;
  if (!c) return { id: r.id, rule: r.rule, severity: r.severity, state: "Not checked", where: r.not_runnable ?? "No check kind in the rulebook yet", element_ids: [], fix_hint: r.fix_hint,
    ...(r.human ? { human: true } : {}) };
  const inCats = (t: QaFacts["types"][number], cats: string[]) => cats.includes(t.bic ?? "") || cats.includes(t.category);
  switch (c.kind) {
    case "view_template_name_pattern": {
      const pattern = (() => { try { return new RegExp(str(c.pattern)); } catch { return null; } })();
      if (!pattern) break;
      const templates = f.views.filter((v) => v.template);
      if (!templates.length) return { ...fail(r, [], ""), state: "Not applicable" };
      return fail(r, templates.filter((v) => !pattern.test(v.name)).map((v) => v.id), "view templates");
    }
    case "sheet_number_pattern": {
      const pattern = (() => { try { return new RegExp(str(c.pattern)); } catch { return null; } })();
      if (!pattern) break;
      if (!f.sheets.length) return { ...fail(r, [], ""), state: "Not applicable" };
      return fail(r, f.sheets.filter((s) => !pattern.test(s.number)).map((s) => s.id), "sheets");
    }
    case "type_name_forbidden": {
      const pattern = (() => { try { return new RegExp(str(c.pattern)); } catch { return null; } })();
      if (!pattern) break;
      return fail(r, f.types.filter((t) => pattern.test(t.name)).map((t) => t.id), "types");
    }
    case "sheet_parameters_filled": {
      if (!f.sheets.length) return { ...fail(r, [], ""), state: "Not applicable" };
      const ps = list(c.parameters);
      return fail(r, f.sheets.filter((s) => ps.some((p) => !(s.parameters[p] ?? "").trim())).map((s) => s.id), "sheets with an empty " + ps.join(" / "));
    }
    case "type_parameters_filled": {
      const ps = list(c.parameters), cats = list(c.categories);
      const types = f.types.filter((t) => !cats.length || inCats(t, cats));
      if (!types.length) return { ...fail(r, [], ""), state: "Not applicable" };
      return fail(r, types.filter((t) => ps.some((p) => !(t.parameters[p] ?? "").trim())).map((t) => t.id), "types with an empty " + ps.join(" / "));
    }
    case "health_count": {
      const metric = str(c.metric);
      const value = metric === "warnings" ? f.warnings : metric === "in_place_families" ? f.families.filter((x) => x.in_place).length : NaN;
      const amber = Number(c.amber_at), red = Number(c.red_at);
      if (Number.isNaN(value)) break;
      const isRed = !Number.isNaN(red) && value >= red, isAmber = !Number.isNaN(amber) && value >= amber;
      return { id: r.id, rule: r.rule, severity: r.severity, state: isRed ? (r.severity === "Advice" ? "Warning" : "Fail") : isAmber ? "Warning" : "Pass",
        where: `${value} ${metric.replace(/_/g, " ")} (amber at ${amber}, red at ${red})`, element_ids: [], fix_hint: r.fix_hint };
    }
  }
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
export function runQa(books: Rulebooks, facts: QaFacts, gate: string, today: string, stage = "") {
  const rules = books.rules.filter((r) => r.status !== "Proposed" && (!r.gates.length || r.gates.includes(gate)));
  // Kit rules name RIBA stages ("all" = every stage): a stage rule runs only at its stages, so it needs the project's stage.
  const results = rules.map((r): RuleResult => {
    if (r.stages.length && !(stage && r.stages.includes(stage)))
      return { id: r.id, rule: r.rule, severity: r.severity, state: "Not applicable", element_ids: [], fix_hint: r.fix_hint,
        where: stage ? `Only at stage ${r.stages.join(", ")} (this project: ${stage})` : `Only at stage ${r.stages.join(", ")}: no project stage given` };
    return runRule(r, facts);
  });
  for (const res of results) {
    const ex = books.exceptions.find((e) => e.rule === res.id && (!e.until || e.until >= today));
    if (ex && (res.state === "Fail" || res.state === "Warning")) res.excepted = `Exception: ${ex.where} · ${ex.approved_by}${ex.until ? " until " + ex.until : ""}`;
  }
  const order: Record<ResultState, number> = { Fail: 0, Warning: 1, "Not checked": 2, "Not applicable": 3, Pass: 4 };
  const sevOrder: Record<Severity, number> = { Must: 0, Should: 1, Advice: 2 };
  results.sort((a, b) => order[a.state] - order[b.state] || sevOrder[a.severity] - sevOrder[b.severity] || a.id.localeCompare(b.id));
  const count = (s: ResultState) => results.filter((x) => x.state === s).length;
  const blocking = results.filter((x) => x.state === "Fail" && x.severity === "Must" && !x.excepted);
  // F-018: a gate is clear only when every Must rule that applies was checked. Not checked never reads as a pass.
  const mustOpen = results.filter((x) => x.severity === "Must" && x.state === "Not checked");
  const humans = mustOpen.filter((x) => x.human).length;
  const checked = count("Pass") + count("Fail") + count("Warning");
  const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const verdict: "Blocked" | "Not clear" | "Clear" = blocking.length ? "Blocked" : mustOpen.length || checked === 0 ? "Not clear" : "Clear";
  const summary = blocking.length
    ? `${blocking.length} Must rule${blocking.length === 1 ? "" : "s"} block${blocking.length === 1 ? "s" : ""} the move: ${blocking.slice(0, 8).map((b) => `${b.id} (${b.where})`).join(", ")}${blocking.length > 8 ? "…" : ""}.`
      + (mustOpen.length ? ` ${s(mustOpen.length, "Must rule wasn't", "Must rules weren't")} checked either.` : "")
    : checked === 0
      ? `Not clear: nothing was checked. ${s(results.length, "rule has", "rules have")} no check the plugin can run on this model; this is not a pass.`
      : mustOpen.length
        ? `Not clear: no Must rule failed, but ${s(mustOpen.length, "Must rule wasn't", "Must rules weren't")} checked (${humans} need a person, ${mustOpen.length - humans} have no check the plugin runs yet). Review them before the move.`
        : "Clear: every Must rule that applies was checked and none blocks the move.";
  return {
    gate, gate_name: GATES[gate] ?? gate, model: facts.model, ran: results.length,
    pass: count("Pass"), fail: count("Fail"), warning: count("Warning"), not_applicable: count("Not applicable"), not_checked: count("Not checked"),
    blocking: blocking.map((b) => b.id), verdict, clear: verdict === "Clear", must_not_checked: mustOpen.length, need_a_person: humans,
    summary,
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
