/**
 * model_check verdict. The Revit side (FmcModelCheckHandler) now reports status "error" when a check threw, but an older
 * add-in, or a reply that lost its fields, must never read as "No problems found" either. This is the second guard.
 * Pure: no Revit, no I/O.
 */
export type ModelCheckStatus = "ok" | "problems" | "partial" | "error";

export interface FailedCheck { check: string; error: string }

export interface ModelCheckVerdict {
  status: ModelCheckStatus;
  complete: boolean;
  isError: boolean;
  checks_failed: FailedCheck[];
  skipped: number;
}

const CLEAN = /no problems found/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Work out the verdict from the reply alone (checks.*.check_failed / failed / skipped, and counts). */
export function judgeModelCheck(result: unknown): ModelCheckVerdict {
  const body = asRecord(result);
  const checks = asRecord(body?.checks);
  const failed: FailedCheck[] = [];
  let skipped = 0;
  let problems = 0;
  for (const [name, raw] of Object.entries(checks ?? {})) {
    const one = asRecord(raw);
    if (!one) { failed.push({ check: name, error: "the check returned no result" }); continue; }
    const why = typeof one.check_failed === "string" && one.check_failed.trim() ? one.check_failed : one.failed === true ? "the check failed" : "";
    if (why) failed.push({ check: name, error: why });
    if (typeof one.skipped === "number" && one.skipped > 0) skipped += one.skipped;
    if (typeof one.count === "number") problems += one.count;
  }
  // The add-in's own list wins when it names more (a check that threw is always listed there).
  for (const row of Array.isArray(body?.checks_failed) ? body!.checks_failed as unknown[] : []) {
    const r = asRecord(row);
    const name = String(r?.check ?? "");
    if (name && !failed.some((f) => f.check === name)) failed.push({ check: name, error: String(r?.error ?? "the check failed") });
  }
  const none = !body || !checks || Object.keys(checks).length === 0;
  const status: ModelCheckStatus = failed.length > 0 || none ? "error" : skipped > 0 ? "partial" : problems > 0 || (typeof body?.problems === "number" && body.problems > 0) ? "problems" : "ok";
  return { status, complete: status === "ok" || status === "problems", isError: status === "error", checks_failed: failed, skipped };
}

/** The reply to hand the AI: the add-in's JSON plus a status that cannot be misread. Idempotent. */
export function guardModelCheck(result: unknown): { body: Record<string, unknown>; isError: boolean } {
  const verdict = judgeModelCheck(result);
  const original = asRecord(result) ?? {};
  const body: Record<string, unknown> = { ...original, status: verdict.status, complete: verdict.complete, checks_failed: verdict.checks_failed, skipped: verdict.skipped };
  const next = typeof original.next === "string" ? original.next : "";
  if (verdict.status === "error") {
    const names = verdict.checks_failed.map((f) => f.check).join(", ");
    body.next = verdict.checks_failed.length
      ? `ERROR: ${verdict.checks_failed.length} check(s) threw and did not finish (${names}). Their problems are unknown: this is NOT "no problems". See checks_failed, then rerun those checks.`
      : "ERROR: no check ran. This is NOT a clean model.";
  } else if (verdict.status === "partial") {
    body.next = `INCOMPLETE: ${verdict.skipped} element(s) could not be checked. This is NOT proof the model is clean.${next && !CLEAN.test(next) ? " " + next : ""}`;
  } else if (CLEAN.test(next) && verdict.status !== "ok") {
    body.next = "Look at each with see_view ids [...]; fix with modify_model";
  }
  return { body, isError: verdict.isError };
}