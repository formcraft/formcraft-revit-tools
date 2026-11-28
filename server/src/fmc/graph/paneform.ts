/**
 * The staff form for a graph (pane section Check > Graphs, DT-30, D6, Builder 7). Offline-testable logic only: the C#
 * pane (shell GraphsPage + plugin RevitGraphTools) renders what this returns and calls the server CLI with the requests
 * it builds. It never runs a graph, never decides an approval and never writes.
 *
 * Flow (INTERFACES-builder6.md v1.1 section 6):
 *   1. fmc_graph_form form  -> PaneForm (controls from the spec).
 *   2. fmc_graph_form bind  -> pane text values -> typed values -> bindFormValues (validate, then Builder 6
 *      bindInputsByName) -> the fmc_dynamo plan request (dry run).
 *   3. fmc_dynamo plan      -> GraphPlan: plan_hash, needs_approval, approval_kind, why.
 *   4. approvalStep(plan)   -> fmc_graph_guard request_approval when needed; a person decides in the pane through the
 *      CLI only (graph_approve / graph_refuse). Python graphs always need a person, in every mode.
 *   5. fmc_graph_form run_check -> runCheck: the run request with approval_id, or why not yet. The server's run gate
 *      (graphRunGate) checks and claims the approval again when the run starts.
 */
import type { GraphApproval } from "./approvals.js";
import type { GraphPlan, RunMode } from "./plan.js";
import { bindFormValues, type FormField, type GraphFormSpec } from "./form.js";

export type PaneControlKind = "text" | "number" | "slider" | "toggle" | "choice" | "file" | "folder" | "element" | "date";

export interface PaneControl {
  id: string;
  label: string;
  control: PaneControlKind;
  /** The value shown, as text (the pane edits text). */
  value: string;
  /** choice: the labels shown; option_values: what each label sends. */
  options?: string[];
  option_values?: unknown[];
  min?: number;
  max?: number;
  step?: number;
  /** A rule the person reads, e.g. "1 to 10, step 1". */
  rule: string;
  disabled: boolean;
  disabled_why: string;
  hint: string;
}

export interface PaneForm {
  title: string;
  graph: { file: string; sha256: string; tier: "K" | "P" };
  banners: Array<{ kind: "warn" | "info"; text: string }>;
  controls: PaneControl[];
  outputs: string[];
  person_required_for: RunMode[];
  spec_hash: string;
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(show).join(", ");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function controlKind(field: FormField): PaneControlKind {
  switch (field.widget) {
    case "slider": return "slider";
    case "number": return "number";
    case "checkbox": return "toggle";
    case "dropdown": return field.options ? "choice" : "text";
    case "file_picker": return "file";
    case "folder_picker": return "folder";
    case "element_picker": return "element";
    case "date": return "date";
    default: return "text";
  }
}

function ruleOf(field: FormField): string {
  const parts: string[] = [];
  if (field.kind === "integer") parts.push("whole number");
  if (field.kind === "number") parts.push("number");
  if (field.min !== undefined && field.max !== undefined) parts.push(`${field.min} to ${field.max}`);
  else if (field.min !== undefined) parts.push(`at least ${field.min}`);
  else if (field.max !== undefined) parts.push(`at most ${field.max}`);
  if (field.step !== undefined) parts.push(`step ${field.step}`);
  if (field.kind === "dropdown" && field.options) parts.push("one of the list");
  if (field.kind === "dropdown" && !field.options) parts.push("the list comes from the open model");
  if (field.path_like) parts.push("a path inside the project or the kit");
  return parts.join(", ");
}

/** The controls the pane draws, in graph order. Element pickers and Revit lists are disabled with no open model. */
export function paneForm(spec: GraphFormSpec, opts: { documentOpen: boolean }): PaneForm {
  const controls = spec.fields.map((field): PaneControl => {
    const control = controlKind(field);
    const needsModel = field.needs_revit && !opts.documentOpen;
    const options = field.options ? field.options.map((o) => o.label) : undefined;
    const current = field.options ? field.options.find((o) => o.value === field.default)?.label ?? "" : show(field.default);
    return {
      id: field.id, label: field.name, control, value: current,
      ...(options ? { options, option_values: field.options!.map((o) => o.value) } : {}),
      ...(field.min !== undefined ? { min: field.min } : {}), ...(field.max !== undefined ? { max: field.max } : {}), ...(field.step !== undefined ? { step: field.step } : {}),
      rule: ruleOf(field),
      disabled: needsModel,
      disabled_why: needsModel ? "Open the model: this input is picked in Revit." : "",
      // Builder 6 jail v1.2: path inputs must already exist; a new output file is given as its existing folder.
      hint: control === "file" || control === "folder"
        ? [field.description, "Must already exist inside the project; for a new output file, pick the folder it goes in."].filter(Boolean).join(" ")
        : field.description,
    };
  });
  const banners: PaneForm["banners"] = [];
  if (spec.has_python) banners.push({ kind: "warn", text: "This graph has Python. A person approves every run (preview, apply, offline); the code and findings show before you approve." });
  if (spec.python_policy === "off" && spec.has_python) banners.push({ kind: "warn", text: "Python graphs are switched off (D1). This graph can't run." });
  if (spec.needs_revit && !opts.documentOpen) banners.push({ kind: "info", text: "This graph needs the open model." });
  if (spec.package_check && !spec.package_check.ok) banners.push({ kind: "warn", text: `Missing or older packages: ${[...spec.package_check.missing, ...spec.package_check.older].join(", ")}.` });
  for (const w of spec.warnings) banners.push({ kind: "info", text: w });
  return {
    title: spec.graph.name, graph: { file: spec.graph.file, sha256: spec.graph.sha256, tier: spec.graph.tier },
    banners, controls, outputs: spec.outputs.map((o) => o.name), person_required_for: spec.approval.person_required_for, spec_hash: spec.spec_hash,
  };
}

/**
 * Pane text (by field id) to typed values. Blank keeps the graph's saved value (nothing sent). Numbers and switches are
 * parsed; a choice label becomes its option value. Text that doesn't parse is a problem, not a guess.
 */
export function valuesFromPane(spec: Pick<GraphFormSpec, "fields">, texts: Record<string, string>): { values: Record<string, unknown>; problems: string[] } {
  const values: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [id, raw] of Object.entries(texts ?? {})) {
    const field = spec.fields.find((f) => f.id === id);
    const text = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
    if (!field) { values[id] = text; continue; }
    if (text === "") continue;
    if (field.kind === "number" || field.kind === "integer") {
      const n = Number(text.replace(",", "."));
      if (!Number.isFinite(n)) { problems.push(`${field.name}: "${text}" is not a number`); continue; }
      values[id] = n;
    } else if (field.kind === "boolean") {
      if (!/^(true|false|yes|no|on|off)$/i.test(text)) { problems.push(`${field.name}: "${text}" is not on or off`); continue; }
      values[id] = /^(true|yes|on)$/i.test(text);
    } else if (field.kind === "dropdown" && field.options) {
      const hit = field.options.find((o) => o.label === text) ?? field.options.find((o) => String(o.value) === text);
      if (!hit) { problems.push(`${field.name}: "${text}" is not in the list`); continue; }
      values[id] = hit.value;
    } else if (field.kind === "element") {
      problems.push(`${field.name}: pick it in Revit (element selection isn't typed)`);
    } else {
      values[id] = text;
    }
  }
  return { values, problems };
}

export interface PlanRequest { tool: "fmc_dynamo"; args: { action: "plan"; path: string; inputs: Record<string, unknown>; mode: RunMode } }

export type PlanRequestResult =
  | { ok: true; request: PlanRequest; binding: Array<{ given: string; id: string; name: string }> }
  | { ok: false; code: string; message: string; problems: string[] };

/** Validate and bind the form, then the fmc_dynamo plan (dry run) request. Inputs go by node id, as bound. */
export function planRequest(spec: GraphFormSpec, texts: Record<string, string>, mode: RunMode): PlanRequestResult {
  const parsed = valuesFromPane(spec, texts);
  if (parsed.problems.length) return { ok: false, code: "FMC-GRAPH-FORM-INPUT", message: `[FMC-GRAPH-FORM-INPUT] ${parsed.problems.join("; ")}.`, problems: parsed.problems };
  const bound = bindFormValues(spec, parsed.values);
  if (!bound.ok) return { ok: false, code: bound.code, message: bound.message, problems: [...bound.unknown.map((u) => `unknown ${u}`), ...bound.ambiguous.map((a) => `ambiguous ${a}`), ...bound.invalid] };
  return { ok: true, binding: bound.binding, request: { tool: "fmc_dynamo", args: { action: "plan", path: spec.graph.file, inputs: bound.inputs_by_id, mode } } };
}

type PlanView = Pick<GraphPlan, "graph" | "inputs_by_id" | "mode" | "plan_hash" | "needs_approval" | "approval_kind" | "approval_why" | "python" | "lock">;

export interface ApprovalStep {
  needs_approval: boolean;
  kind: GraphPlan["approval_kind"];
  why: string[];
  plan_hash: string;
  /** The request the pane sends when a person asks for approval; null when none is needed. */
  request_approval: { tool: "fmc_graph_guard"; args: { action: "request_approval"; path: string; inputs: Record<string, unknown>; mode: RunMode; reason: string } } | null;
  /** A person decides through these server CLI commands only, never an MCP tool. */
  decide_via: ["graph_approve", "graph_refuse"];
}

/** What the pane shows after a plan: the hash and whether a person must approve before Run. Python: always yes. */
export function approvalStep(plan: PlanView, reason: string): ApprovalStep {
  const needs = plan.needs_approval || plan.python || plan.mode !== "preview";
  const why = [...plan.approval_why];
  if (plan.python && !why.some((w) => /Python/i.test(w))) why.push("The graph has Python: a person approves every run.");
  return {
    needs_approval: needs, kind: plan.approval_kind, why, plan_hash: plan.plan_hash,
    request_approval: needs ? { tool: "fmc_graph_guard", args: { action: "request_approval", path: plan.graph, inputs: plan.inputs_by_id, mode: plan.mode, reason: reason.trim() || "Staff run from the Formcraft pane" } } : null,
    decide_via: ["graph_approve", "graph_refuse"],
  };
}

export type RunCheck =
  | { ok: true; request: { tool: "fmc_dynamo"; args: { action: "run"; path: string; inputs: Record<string, unknown>; mode: RunMode; approval_id?: string } } }
  | { ok: false; code: string; message: string };

/**
 * May the pane press Run now? Mirrors Builder 6's run gate without claiming: a needed approval must exist, be approved
 * by a person (not auto*), unused, unexpired, and bound to this plan_hash. Python with no person's approval is refused.
 */
export function runCheck(plan: PlanView, approval: GraphApproval | null, now = new Date()): RunCheck {
  const base = { action: "run" as const, path: plan.graph, inputs: plan.inputs_by_id, mode: plan.mode };
  if (plan.lock === "mismatch" || plan.lock === "unlisted") return { ok: false, code: "FMC-GRAPH-LOCK", message: `[FMC-GRAPH-LOCK] ${plan.graph} is ${plan.lock} in the kit lock. It can't run.` };
  const needs = plan.needs_approval || plan.python || plan.mode !== "preview";
  if (!needs) return { ok: true, request: { tool: "fmc_dynamo", args: base } };
  const label = plan.python ? "This graph has Python: a person must approve this run." : `${plan.mode} needs a person's approval.`;
  if (!approval) return { ok: false, code: "FMC-GRAPH-APPROVAL-NEEDED", message: `[FMC-GRAPH-APPROVAL-NEEDED] ${label} Ask for approval first.` };
  if (approval.plan_hash !== plan.plan_hash) return { ok: false, code: "FMC-GRAPH-APPROVAL-MISMATCH", message: "[FMC-GRAPH-APPROVAL-MISMATCH] The approval is for another plan (the graph, inputs, mode or model changed). Plan again and ask again." };
  if (approval.status === "pending") return { ok: false, code: "FMC-GRAPH-APPROVAL-PENDING", message: "[FMC-GRAPH-APPROVAL-PENDING] Waiting for a person to approve." };
  if (approval.status === "refused") return { ok: false, code: "FMC-GRAPH-APPROVAL-REFUSED", message: "[FMC-GRAPH-APPROVAL-REFUSED] A person refused this run." };
  if (approval.status === "used") return { ok: false, code: "FMC-GRAPH-APPROVAL-USED", message: "[FMC-GRAPH-APPROVAL-USED] This approval was already used (single use). Ask again." };
  if (approval.status === "expired" || (approval.expires_at && Date.parse(approval.expires_at) <= now.getTime())) return { ok: false, code: "FMC-GRAPH-APPROVAL-EXPIRED", message: "[FMC-GRAPH-APPROVAL-EXPIRED] The approval expired. Ask again." };
  const by = (approval.decided_by ?? "").trim();
  if (!by || /^auto/i.test(by)) return { ok: false, code: "FMC-GRAPH-APPROVAL-AUTO", message: "[FMC-GRAPH-APPROVAL-AUTO] Only a person can approve this run." };
  if (approval.status !== "approved") return { ok: false, code: "FMC-GRAPH-APPROVAL-NEEDED", message: `[FMC-GRAPH-APPROVAL-NEEDED] Approval is ${approval.status}.` };
  return { ok: true, request: { tool: "fmc_dynamo", args: { ...base, approval_id: approval.id } } };
}
