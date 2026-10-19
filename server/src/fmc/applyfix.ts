/**
 * Mark & Review R6 (docs/PLAN_MARK_REVIEW.md): a ticket's planned fix applied, only after a person said yes to exactly
 * those steps. The dry run hands out the steps and their fingerprint (plan_hash); the real run plans again and refuses
 * when anything changed since the person saw it. Engineering values (rule 5), unclear words and a plan made without
 * the element's facts never reach the model. Applied, the ticket goes back to the person who raised it as Resolved
 * ("Fixed: check it"); they accept or reopen it as with any ticket.
 */
import { createHash } from "node:crypto";
import type { PlannedFix } from "./noteparse.js";
import type { ReviewItem } from "./review.js";
import { AI_OWNER, comment } from "./tickets.js";

export type ApplyStep = PlannedFix["steps"][number] & { unique_id: string };

/** The steps the command gets: each names its element (the ticket's first marked element unless the plan says). */
export function applySteps(item: ReviewItem, plan: PlannedFix): ApplyStep[] {
  const uid = item.where?.unique_ids[0] ?? "";
  return plan.steps.map((s) => ({ ...s, unique_id: s.unique_id || uid }));
}

/** A short fingerprint of the steps a person approves; the order and every value count. */
export function planHash(steps: ApplyStep[]): string {
  const canon = steps.map(({ sentence: _s, was: _w, ...rest }: Record<string, unknown>) => Object.keys(rest).sort().map((k) => [k, rest[k]]));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 12);
}

const NOT_A_PERSON = /^(ai|ai modeller|claude.*|assistant|bot|mcp|auto.*|system)$/i;

/**
 * Why this fix can't be applied (empty: it can). Without approval the check covers the plan only (the dry run);
 * with it, also who said yes and that they said yes to these very steps.
 */
export function applyProblems(item: ReviewItem, plan: PlannedFix, approval?: { approved_by: string; plan_hash: string }): string[] {
  const p: string[] = [];
  if (item.status === "Closed") p.push(`${item.id} is closed`);
  if (item.status === "Resolved") p.push(`${item.id} is already resolved and waits for the raiser's check`);
  if (plan.from_note_only) p.push("The plan was made from the note alone: open the model so Revit gives the element's facts, then plan again");
  if (plan.ask_engineer.length) p.push(...plan.ask_engineer.map((x) => `An engineer decides this (rule 5): ${x}`));
  if (plan.unclear.length) p.push(...plan.unclear.map((x) => `Unclear: ${x}`));
  if (!plan.steps.length) p.push(plan.notes.length ? `Nothing to change: ${plan.notes.join("; ")}` : "The plan has no steps");
  const steps = applySteps(item, plan);
  if (steps.some((s) => !s.unique_id)) p.push("The ticket marks no element: a step has nothing to act on");
  if (approval) {
    const who = approval.approved_by.trim();
    if (!who) p.push("A person's yes is required: approved_by names them");
    else if (NOT_A_PERSON.test(who) || who === AI_OWNER) p.push(`${who} isn't a person: the person who raised the ticket (or another person) says yes`);
    if (!approval.plan_hash.trim()) p.push("Pass the plan_hash from the dry run the person saw");
    else if (approval.plan_hash.trim() !== planHash(steps)) p.push("The plan changed since the person saw it (the model or the thread moved on): run the dry run again and show the new steps");
  }
  return p;
}

/** Applied: the steps become the ticket's solution, the thread says so, and the raiser checks it. */
export function fixApplied(item: ReviewItem, by: string, approvedBy: string, steps: ApplyStep[], now: Date) {
  const said = steps.map((s) => s.sentence).join("; ");
  item.solution = `Fixed: ${said}`;
  item.status = "Resolved";
  comment(item, { by, text: `Fixed: check it. ${said} (approved by ${approvedBy}; one Undo in Revit takes it back)` }, now);
  item.history.push({ at: now.toISOString(), by, what: `Fix applied (${steps.length} step${steps.length === 1 ? "" : "s"}), approved by ${approvedBy}; waiting for the raiser's check` });
}

/** Not applied: nothing changed in the model; the thread keeps why, so the next person (or the AI) starts from there. */
export function fixFailed(item: ReviewItem, by: string, step: number, reason: string, now: Date) {
  comment(item, { by, text: `The fix wasn't applied (step ${step}: ${reason}). Nothing in the model changed.` }, now);
}
