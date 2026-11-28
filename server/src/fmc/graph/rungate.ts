/**
 * The graph run gate (X-05, R-3, R-7; DT-59, DT-60, DT-65). Runs before Revit or DynamoCLI starts, after the plan.
 * Hard rules: Python graphs always need a person's approval (every mode), apply always needs one, offline always needs
 * one. access "full", allow_code and auto_approve do not change this. A changed kit graph (lock mismatch) never runs.
 */
import { appendGraphRunLog, claimGraphApproval, type GraphApproval } from "./approvals.js";
import type { GraphPlan } from "./plan.js";

export type GateResult =
  | { ok: true; approval: GraphApproval | null }
  | { ok: false; code: string; message: string; needs_approval?: boolean; plan_hash?: string };

export function graphRunGate(plan: Pick<GraphPlan, "plan_hash" | "needs_approval" | "approval_why" | "lock" | "graph" | "graph_sha256" | "mode" | "python">,
  approvalId: string | undefined, env: NodeJS.ProcessEnv = process.env, now = new Date(), caller = "fmc_dynamo"): GateResult {
  if (plan.lock === "mismatch" || plan.lock === "unlisted") {
    return { ok: false, code: "FMC-GRAPH-LOCK", message: `[FMC-GRAPH-LOCK] ${plan.graph} ${plan.lock === "mismatch" ? "changed since the kit lock (graphs.lock.json) pinned it" : "is not listed in the kit lock (graphs.lock.json)"}. Nothing ran.` };
  }
  if (!plan.needs_approval) {
    appendGraphRunLog({ caller, graph: plan.graph, graph_sha256: plan.graph_sha256, plan_hash: plan.plan_hash, mode: plan.mode, approval: null }, env, now);
    return { ok: true, approval: null };
  }
  const id = (approvalId ?? "").trim();
  if (!id) {
    return {
      ok: false, code: "FMC-GRAPH-APPROVAL-NEEDED", needs_approval: true, plan_hash: plan.plan_hash,
      message: `[FMC-GRAPH-APPROVAL-NEEDED] ${plan.approval_why.join(" ")} Call fmc_graph_guard request_approval with the same path, inputs and mode, ` +
        `wait for the person (fmc_graph_guard approval_status), then run again with approval_id. Plan ${plan.plan_hash}. Nothing ran.`,
    };
  }
  const claim = claimGraphApproval(id, plan.plan_hash, env, now);
  if (!claim.ok) return { ok: false, code: claim.code, message: `${claim.message} Nothing ran.`, plan_hash: plan.plan_hash };
  appendGraphRunLog({
    caller, graph: plan.graph, graph_sha256: plan.graph_sha256, plan_hash: plan.plan_hash, mode: plan.mode,
    event: "run", approval: claim.approval.id, requested_by: claim.approval.requested_by, approver: claim.approval.decided_by, python: plan.python,
  }, env, now);
  return { ok: true, approval: claim.approval };
}
