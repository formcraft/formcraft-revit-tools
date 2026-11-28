/**
 * Shared pieces for the gap-analysis tools (fmc_transfer, fmc_cad_audit, fmc_carbon, fmc_view_audit).
 * A write needs a dry run first: the dry run returns plan_hash, and the write must send the same hash back
 * with confirm true. A changed model gives a different hash, so the write is refused until a new dry run.
 */
import crypto from "node:crypto";
import { saveBlocked } from "./savepolicy.js";
import type { GuardConfig } from "./policy.js";

export function gapReply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

/** JSON with sorted keys, so the same plan always hashes the same. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return "{" + Object.keys(row).sort().filter((k) => row[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableJson(row[k])).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
}

export function planHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 16);
}

export interface WriteGate {
  dry_run: boolean;
  confirm: boolean;
  plan_hash: string;
  lease: string;
}

/**
 * Why a write is refused, or null. Order: dry run, confirm, plan hash, document guards, lease.
 * `tool` names the tool in the message. `doc` is the document that would change.
 */
export function writeRefusal(tool: string, gate: WriteGate, expectedHash: string,
  doc: { title: string; path: string; is_central?: boolean }, guard: GuardConfig | null, guardProblem?: string): { code: string; message: string } | null {
  if (gate.dry_run) return null;
  if (!gate.confirm) return { code: "FMC-GAP-CONFIRM", message: `${tool} writes only with confirm true, after a dry run the person has seen.` };
  if (!gate.plan_hash.trim()) return { code: "FMC-GAP-DRY-RUN-FIRST", message: `Run ${tool} with dry_run true first, show the plan, then send its plan_hash with confirm true.` };
  if (gate.plan_hash.trim() !== expectedHash) return { code: "FMC-GAP-PLAN-CHANGED", message: `The plan changed since the dry run (plan_hash ${gate.plan_hash.trim()} is now ${expectedHash}). Run the dry run again.` };
  const blob = `${doc.title} ${doc.path}`;
  if (/hebert hostels/i.test(blob)) return { code: "FMC-GAP-GUARD", message: `HEBERT HOSTELS is not written by ${tool}.` };
  if (doc.is_central) return { code: "FMC-GAP-GUARD", message: `A central model is not written by ${tool}. Work in a local.` };
  if (guardProblem) return { code: "FMC-GAP-GUARD", message: guardProblem };
  const blocked = guard ? saveBlocked(doc, guard) : null;
  if (blocked) return { code: "FMC-GAP-GUARD", message: blocked };
  if (!gate.lease.trim()) return { code: "FMC-BATCH-LOCKED", message: "A write needs batch_lease from fmc_batch request, on the document that changes." };
  return null;
}

export function sameName(a: unknown, b: unknown): boolean {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

export function errorCode(error: unknown, fallback: string): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return { code: message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? fallback, message };
}
