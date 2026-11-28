/**
 * The fingerprint of a write plan. The dry run hands it out with the plan the person sees; the real run plans again from
 * the model and refuses when the fingerprint differs (the model, the scope or the ops moved on since the dry run).
 */
import { createHash } from "node:crypto";

function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canon(v);
    }
    return out;
  }
  return value;
}

/** sha256 over the document (trimmed, lower case) and the plan, keys sorted; 16 hex characters. */
export function planHashOf(document: string, plan: unknown): string {
  const text = JSON.stringify(canon({ document: document.trim().toLowerCase(), plan }));
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** null when the passed hash matches the rebuilt plan, else the reason to refuse. */
export function planHashProblem(passed: string | undefined, rebuilt: string): string | null {
  const given = (passed ?? "").trim();
  if (!given) return "[FMC-PLAN-HASH] Pass plan_hash from the dry run the person saw. Nothing was changed.";
  if (given !== rebuilt) return "[FMC-PLAN-HASH] The plan changed since the dry run (the model, the scope or the ops moved on). Run the dry run again and show the new plan. Nothing was changed.";
  return null;
}