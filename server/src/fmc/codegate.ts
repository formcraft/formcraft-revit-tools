/**
 * send_code_to_revit, permission first (Emlyn 28 Nov 2026, 13:12 EAT via Plugin Bot; plan §4.1 / Q8).
 *
 * Every call of the send_code_to_revit TOOL needs, before anything reaches Revit:
 *  1. a reason: "no_tool" (no tool does this) or "tool_error" plus failing_tool (the tool that failed);
 *  2. Stop AI off and, when the AI modeller is set up, the admin's "AI may run code" switch on;
 *  3. this session's batch lease on the target document (the same lease sendCommand checks);
 *  4. a person's approval for exactly this call (code, usings, parameters, mode, reason, document), used once.
 * The approval goes through the existing queue (%APPDATA%\Formcraft\ai_queue): only the pane (a person, CLI only)
 * sets "approved"; no MCP tool can. Access "full" does not skip it and testing auto-approve does not apply: this gate
 * runs before the AI gate and does not read either. While it waits, the reply suggests tools that may do the job.
 * The live-model lock, writeGuard, the memory gate and the AI gate still run after it in sendCommand.
 * Fixed server scripts (fmc_new_local, fmc_grids_from_link, connect_fixture, keynote, property_line, scripts) do not
 * come through this tool and are not changed here (Phase 6 / Q8 for fmc_scripts, fmc_script_run, fmc_dynamo, fmc_library run).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { AiModellerConfig } from "./aiuse.js";
import type { QueueItem } from "./aiuse_io.js";

export const CODE_REASONS = ["no_tool", "tool_error"] as const;
export type CodeReason = typeof CODE_REASONS[number];

export const CODE_GATE = {
  REASON: "FMC-CODE-REASON",
  STOPPED: "FMC-CODE-STOPPED",
  SWITCH: "FMC-CODE-SWITCH-OFF",
  NO_LEASE: "FMC-CODE-NO-LEASE",
  NO_DOC: "FMC-CODE-NO-DOCUMENT",
  APPROVAL: "FMC-CODE-APPROVAL-NEEDED",
  REJECTED: "FMC-CODE-REJECTED",
  USED: "FMC-CODE-APPROVAL-USED",
  MISMATCH: "FMC-CODE-APPROVAL-MISMATCH",
} as const;

/** The person-approved call running now (set only by the send_code_to_revit tool after its gate passed). */
export const codeApproval = new AsyncLocalStorage<{ id: string; by: string } | undefined>();

export interface CodeCall {
  code: string;
  parameters?: string[];
  usings?: string[];
  transactionMode?: string;
  allow_full_scan?: boolean;
  reason?: string;
  failing_tool?: string;
  failing_error?: string;
}

/** What the approval is bound to. The document is bound by the queue key. */
export function boundParams(c: CodeCall): Record<string, unknown> {
  return {
    code: c.code, parameters: c.parameters ?? [], usings: c.usings ?? [], transactionMode: c.transactionMode ?? "read_only",
    allow_full_scan: c.allow_full_scan === true, reason: c.reason ?? "", failing_tool: (c.failing_tool ?? "").trim(),
  };
}

export function codeSha(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function stable(v: unknown): unknown {
  return Array.isArray(v) ? v.map(stable)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).filter(([k]) => k !== "document").sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]))
    : v;
}

/** Exactly the same call (the queue key is a 32-bit hash, so the stored call is compared in full as well). */
export function sameCall(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

const HINTS: Array<[RegExp, string]> = [
  [/\b(Wall|Floor|Ceiling)\.Create\b|FootPrintRoof|ExtrusionRoof/, "create_line_based_element or create_surface_based_element (walls, floors, ceilings, roofs)"],
  [/NewFamilyInstance/, "create_point_based_element (doors, windows, fixtures, furniture)"],
  [/\.Delete\s*\(/, "delete_element"],
  [/ElementTransformUtils|MoveElement|CopyElement|RotateElement|MirrorElement/, "operate_element (move, copy, rotate, mirror)"],
  [/LookupParameter|get_Parameter|\.Set\s*\(/, "modify_model (parameter ops)"],
  [/ViewSheet|Viewport\.Create/, "fmc_sheets"],
  [/IndependentTag|RoomTag|NewTag/, "fmc_tags, tag_all_rooms or tag_all_walls"],
  [/NewDimension|Dimension\b/, "create_dimensions or fmc_dims"],
  [/TextNote/, "fmc_annotate"],
  [/NewRoom|\bRoom\b/, "create_room or fmc_room"],
  [/Level\.Create|Grid\.Create/, "create_level or create_grid"],
  [/LoadFamily|EditFamily|FamilyManager|SaveAs/, "modify_model family ops, new_family or fmc_family (their own path and overwrite gates)"],
  [/OpenDocumentFile|\.Save\s*\(|SynchronizeWithCentral/, "revit_file, fmc_file or fmc_save_project (saves, opens and syncs stay on their own gated tools)"],
  [/ImageExport|ExportImage/, "see_view"],
  [/FilteredElementCollector/, "get_current_view_elements, ai_element_filter, fmc_find or fmc_select (reads)"],
];

/** Tools to try while the person decides. Always ends with the saved add-ons list. */
export function codeAlternatives(c: CodeCall): string[] {
  const out: string[] = [];
  const failing = (c.failing_tool ?? "").trim();
  if (c.reason === "tool_error" && failing) out.push(`${failing} again with corrected arguments (the error text says what it needs), and report the tool error with fmc_issue`);
  for (const [re, tool] of HINTS) if (re.test(c.code ?? "") && !out.includes(tool)) out.push(tool);
  if ((c.transactionMode ?? "read_only") === "read_only" && !out.some((x) => x.includes("reads"))) out.push("get_current_view_elements, ai_element_filter, fmc_find or model_check (reads)");
  out.push("fmc_scripts addon_list: a saved add-on may already do this");
  return out.slice(0, 6);
}

export interface GateInput {
  call: CodeCall;
  /** The call's document: its full path, else its title. "" when no single document could be named. */
  document: string;
  documentProblem?: string;
  lease?: string;
  /** Documents this session's lease holds (batchline.leaseHeldDocuments). */
  leaseDocuments: string[];
  leaseCovers: (held: string, asked: string) => boolean;
  ai: AiModellerConfig | null;
  /** The queue item for exactly this call, if any (approvalFor reads only "approved"; this reads any status). */
  queued: (QueueItem & { params?: unknown }) | null;
}

export type GateResult =
  | { ok: true; approvalId: string; by: string }
  | { ok: false; code: string; message: string; enqueue?: boolean; alternatives?: string[] };

/** The decision, pure. The tool does the IO (queue, claim) around it. */
export function codeGate(g: GateInput): GateResult {
  const c = g.call;
  const alternatives = codeAlternatives(c);
  if (!CODE_REASONS.includes(c.reason as CodeReason))
    return { ok: false, code: CODE_GATE.REASON, alternatives,
      message: `[${CODE_GATE.REASON}] send_code_to_revit needs reason: "no_tool" (no tool does this) or "tool_error" with failing_tool (the tool that failed). Nothing was sent.` };
  if (c.reason === "tool_error" && !(c.failing_tool ?? "").trim())
    return { ok: false, code: CODE_GATE.REASON, alternatives, message: `[${CODE_GATE.REASON}] reason "tool_error" needs failing_tool: the name of the tool that failed. Nothing was sent.` };
  if (g.ai?.stop) return { ok: false, code: CODE_GATE.STOPPED, message: `[${CODE_GATE.STOPPED}] Stop AI is on: no code runs. Nothing was sent.` };
  if (g.ai && g.ai.allow_code !== true)
    return { ok: false, code: CODE_GATE.SWITCH, alternatives, message: `[${CODE_GATE.SWITCH}] The admin's "AI may run code" switch is off (ai_modeller.allow_code). Nothing was sent.` };
  if (!g.document)
    return { ok: false, code: CODE_GATE.NO_DOC, message: `[${CODE_GATE.NO_DOC}] ${g.documentProblem || "Name the document this code is for"}: an approval is bound to one document. Nothing was sent.` };
  const lease = (g.lease ?? "").trim();
  if (!lease || !g.leaseDocuments.length)
    return { ok: false, code: CODE_GATE.NO_LEASE, alternatives,
      message: `[${CODE_GATE.NO_LEASE}] send_code_to_revit needs this session's batch lease (fmc_batch request, then pass batch_lease) for ${g.document}. Nothing was sent and nothing was queued.` };
  if (!g.leaseDocuments.some((held) => g.leaseCovers(held, g.document)))
    return { ok: false, code: CODE_GATE.NO_LEASE, alternatives,
      message: `[${CODE_GATE.NO_LEASE}] Lease ${lease} holds ${g.leaseDocuments.join(", ")}, not ${g.document}. Nothing was sent.` };
  const q = g.queued;
  const waitLine = (id: string) => `[${CODE_GATE.APPROVAL}] A person must approve this exact code first (approval ${id}). ` +
    `Call fmc_ai wait with id ${id}; when it says approved, send the same send_code_to_revit call again (same code, reason, document and batch_lease); it runs once. ` +
    `While you wait, try: ${alternatives.join("; ")}.`;
  if (!q || (q.status !== "approved" && q.status !== "pending" && q.status !== "rejected"))
    return { ok: false, code: CODE_GATE.APPROVAL, enqueue: true, alternatives, message: waitLine("(new)") };
  if (q.status === "rejected") return { ok: false, code: CODE_GATE.REJECTED, alternatives, message: `[${CODE_GATE.REJECTED}] The person rejected approval ${q.id}. Ask what to change, or use: ${alternatives.join("; ")}.` };
  if (q.status === "pending") return { ok: false, code: CODE_GATE.APPROVAL, alternatives, message: waitLine(q.id) };
  if (!sameCall(q.params, boundParams(c)))
    return { ok: false, code: CODE_GATE.MISMATCH, message: `[${CODE_GATE.MISMATCH}] Approval ${q.id} was given for different code or arguments. Nothing was sent.` };
  if (!q.by || /^auto-approved/i.test(q.by))
    return { ok: false, code: CODE_GATE.APPROVAL, enqueue: false, alternatives, message: `[${CODE_GATE.APPROVAL}] Approval ${q.id} was not given by a person. Nothing was sent.` };
  return { ok: true, approvalId: q.id, by: q.by };
}

/** The approval card's plain lines. */
export function codeDetails(c: CodeCall, document: string): string[] {
  const lines = (c.code ?? "").split(/\r?\n/);
  return [
    `Run C# code in Revit on ${document} (send_code_to_revit, mode ${c.transactionMode ?? "read_only"}${(c.transactionMode ?? "read_only") === "read_only" ? ": preview, rolled back" : ": WRITES the model"}).`,
    c.reason === "tool_error" ? `Why: ${c.failing_tool} failed${c.failing_error ? `: ${c.failing_error.slice(0, 200)}` : ""}.` : "Why: no tool does this.",
    `Code: ${lines.length} lines, SHA-256 ${codeSha(c.code ?? "").slice(0, 12)}. The full code is in this approval's params.`,
    ...lines.slice(0, 8).map((l) => `  ${l.slice(0, 160)}`),
    `Tools that may do it instead: ${codeAlternatives(c).join("; ")}.`,
    "Approving lets this exact code run once, under the AI's batch lease. Code can save, load families or write files: approve only what you have read.",
  ];
}
