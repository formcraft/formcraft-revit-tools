/** One fmc_permit_check finding, and the helpers every evaluator uses to build one from the rule table and the bank. */
import type { Bank, Cited, SourcesIndex } from "./bank.js";
import { cite } from "./bank.js";
import type { PermitDefaults, PermitState } from "./defaults.js";
import type { PermitRule } from "./rules.js";
import { ruleById } from "./rules.js";

export interface Finding {
  rule: string; state: PermitState; topic: string; instrument: string; clause: string; message: string;
  values: Array<{ key: string; value: unknown; status: string; clause: string }>;
  ids: string[]; caveats: Array<{ id: string; what: string }>;
}

export interface Ctx { bank: Bank; sources: SourcesIndex; defaults: PermitDefaults; missingKeys: Set<string> }

export function caveatsFor(rule: PermitRule, sources: SourcesIndex): Finding["caveats"] {
  return rule.caveats.map((id) => ({ id, what: sources.gaps[id]?.what || "(not in the sources register)" }));
}

/** Cites a key for a rule, remembering any key the bank does not have. */
export function citeFor(ctx: Ctx, rule: PermitRule, key: string, use?: string): Cited {
  const c = cite(ctx.bank, key, rule.clause, use);
  if (!c.found) ctx.missingKeys.add(key);
  return c;
}

export function make(ctx: Ctx, ruleId: string, state: PermitState, message: string, cited: Cited[] = [], ids: string[] = []): Finding {
  const rule = ruleById(ruleId);
  const caveats = caveatsFor(rule, ctx.sources);
  let s = state;
  let msg = message;
  const proposed = cited.filter((c) => c.found && !/^approved/i.test(c.status));
  if (s === "FAIL" && proposed.length) {
    if (!ctx.defaults.proposedMayFail) { s = "REVIEW"; msg += " (FAIL held at REVIEW: the bank value is still proposed.)"; }
    else caveats.push({ id: "bank-status", what: `Bank value status is "${proposed[0].status}", not approved (interim default Q1: may still produce FAIL).` });
  }
  if (s === "PASS") msg = `${msg} (${ctx.defaults.passWording})`;
  return {
    rule: rule.id, state: s, topic: rule.topic, instrument: rule.instrument,
    clause: cited.find((c) => c.found && c.clause)?.clause || rule.clause, message: msg,
    values: cited.map((c) => ({ key: c.key, value: c.value, status: c.status, clause: c.clause })), ids, caveats,
  };
}

export function missing(ctx: Ctx, ruleId: string, cited: Cited[]): Finding {
  return make(ctx, ruleId, "NOT_CHECKED", `Bank key ${cited.filter((c) => !c.found).map((c) => c.key).join(", ")} is missing from the standards bank; nothing was checked.`, cited);
}
