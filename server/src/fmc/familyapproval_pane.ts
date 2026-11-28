/**
 * F134: the pane's side of family_overwrite approvals. A person approves or rejects a pending record here (fmc/cli.ts
 * family_overwrite_approve / family_overwrite_reject / family_overwrite_list). Never imported by an MCP tool: the
 * static test in familyapproval.test.ts fails if a file under tools/ imports this module.
 */
import { readApprovals, writeApprovals, type ApprovalDeps, type FamilyApproval } from "./familyapproval.js";

/** A person sets a pending record to approved or rejected. Expired, used or already-decided records don't change. */
export function setStatus(id: string, status: "approved" | "rejected", by: string, d: ApprovalDeps = {}): { record?: FamilyApproval; error?: string } {
  const now = (d.now ?? (() => new Date()))();
  const who = by.trim();
  if (!who) return { error: "The pane names the person who decides" };
  const records = readApprovals(d);
  const rec = records.find((r) => r.id === id.trim());
  if (!rec) return { error: `No family_overwrite approval ${id}` };
  if (rec.status !== "pending") return { error: `Approval ${id} is ${rec.status}, not pending` };
  if (Date.parse(rec.expires_at) <= now.getTime()) return { error: `Approval ${id} expired at ${rec.expires_at}` };
  rec.status = status;
  rec.approved_by = who;
  rec.approved_at = now.toISOString();
  writeApprovals(records, d);
  return { record: rec };
}

export function paneFamilyApproval(command: string, input: Record<string, unknown>, by: string, d: ApprovalDeps = {}) {
  if (command === "family_overwrite_list") {
    const now = (d.now ?? (() => new Date()))().getTime();
    return { approvals: readApprovals(d).filter((r) => r.status === "pending" && Date.parse(r.expires_at) > now) };
  }
  const id = String(input.approval_id ?? input.id ?? "");
  const r = setStatus(id, command === "family_overwrite_approve" ? "approved" : "rejected", by, d);
  return r.error ? { error: r.error } : { approval: r.record };
}
