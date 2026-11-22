/**
 * One sentence on every wait or refusal, so a stuck Revit is not a silent queue.
 * The phrases are fixed: a running job, a lease, a modal, the RAM gate, an open transaction, or Revit not idle.
 */

export const RAM_BUSY = "RAM gate";
export const TX_BUSY = "transaction open";
export const IDLE_BUSY = "Revit not idle";

export function jobBusyReason(tool: string, ageS: number): string {
  const name = (tool || "a command").trim() || "a command";
  const age = Number.isFinite(ageS) && ageS >= 0 ? Math.round(ageS) : 0;
  return `job running ${name} for ${age} s`;
}

export function leaseBusyReason(who: string, doc: string): string {
  return `lease held by ${(who || "another session").trim()} on doc ${(doc || "the document").trim()}`;
}

export function dialogBusyReason(title: string): string {
  return `modal dialog ${(title || "untitled").trim()}`;
}

/** Append busy_reason once. Existing sentences that already name it are left as they are. */
export function withBusy(sentence: string, reason: string): string {
  if (/busy_reason:/i.test(sentence)) return sentence;
  const text = sentence.trim();
  const body = text.endsWith(".") ? text : `${text}.`;
  return `${body} busy_reason: ${reason}.`;
}

/** The most specific reason a call is waiting. */
export function pickBusyReason(facts: {
  dialog?: string;
  tool?: string;
  age_s?: number;
  lease_holder?: string;
  document?: string;
  ram?: boolean;
  transaction?: boolean;
  running?: boolean;
}): string {
  const dialog = (facts.dialog ?? "").trim();
  if (dialog) return dialogBusyReason(dialog);
  if (facts.ram) return RAM_BUSY;
  if (facts.transaction) return TX_BUSY;
  if (facts.lease_holder) return leaseBusyReason(facts.lease_holder, facts.document ?? "");
  if (facts.running || facts.tool) return jobBusyReason(facts.tool ?? "a command", facts.age_s ?? 0);
  return IDLE_BUSY;
}
