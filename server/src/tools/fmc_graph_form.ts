/**
 * fmc_graph_form (Builder 7, DT-29). First action: spec. Reads a .dyn and returns the Player-style form for staff and
 * the pane (D6). Read-only: no Revit, no Dynamo, no DynamoCLI, no writes. Later actions (player_audit, DT-31) go here.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { kitRootFrom } from "../fmc/dynamo.js";
import { loadConfig } from "../fmc/policy.js";
import { callDocument, namedDocument } from "../fmc/scriptexec.js";
import { inputTooLarge, withResolved } from "../fmc/scriptlib.js";
import { bindFormValues, graphFormSpec } from "../fmc/graph/form.js";
import { approvalStep, paneForm, planRequest, runCheck } from "../fmc/graph/paneform.js";
import { readGraphApproval } from "../fmc/graph/approvals.js";
import type { GraphPlan } from "../fmc/graph/plan.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_GRAPH_FORM_DESCRIPTION =
  "The form for a Dynamo graph, like Dynamo Player's, for staff and the Formcraft pane. action spec reads the .dyn file only: " +
  "it never starts Revit, Dynamo or DynamoCLI and never writes. path is a .dyn in the kit (05_Scripts/library or 05_Scripts/Dynamo) " +
  "or a draft in <project>\\00_Formcraft\\Graphs of the target document (name document by title or full path; the project is the folder above 01_WIP). " +
  "Anything else, a '..' or network path, or a junction or link that leads out is FMC-GRAPH-JAIL. A file that is not Dynamo JSON is FMC-GRAPH-NOT-GRAPH. " +
  "Returns fields (id, name, kind, widget, default, slider min/max/step, dropdown options, file/folder pickers, element pickers marked needs_revit), " +
  "outputs (Watch and output nodes), graph sha256, has_python, packages from NodeLibraryDependencies with the installed-package check, the kit lock state, the scan summary and what a run will need: " +
  "a graph with Python (or a package DLL) needs a person's approval for every run (preview, apply, offline); every apply and offline run needs one too. " +
  "values (optional) checks form values given by input name or node id and returns inputs_by_id; unknown names are refused, not dropped. " +
  "form returns the pane's controls; bind turns the pane's text values into the fmc_dynamo plan request; approval says whether a person must approve " +
  "(and the fmc_graph_guard request); run_check says whether Run may go (approved by a person, unused, unexpired, same plan_hash). " +
  "A person decides approvals in the pane only (graph_approve / graph_refuse). To run, use fmc_dynamo; the form itself runs nothing.";

export const FMC_GRAPH_FORM_SHAPE = {
  action: z.enum(["spec", "form", "bind", "approval", "run_check"]),
  path: z.string().optional().default("").describe("spec: the .dyn file (kit 05_Scripts/library or 05_Scripts/Dynamo, or <project>\\00_Formcraft\\Graphs)"),
  values: z.record(z.unknown()).optional().describe("spec: form values by input name or node id, to check and bind. At most 50."),
  texts: z.record(z.string()).optional().describe("bind: the pane's values as text, by field id. Blank keeps the graph's saved value."),
  mode: z.enum(["preview", "apply", "offline"]).optional().default("preview").describe("bind: the run mode to plan"),
  plan: z.record(z.unknown()).optional().describe("approval, run_check: the GraphPlan fmc_dynamo plan returned"),
  reason: z.string().optional().default("").describe("approval: why, in a line the person reads"),
  approval_id: z.string().optional().default("").describe("run_check: the approval from fmc_graph_guard request_approval"),
  check_packages: z.boolean().optional().default(true).describe("spec: compare the graph's packages with the installed ones (read-only). Default true."),
  kit_folder: z.string().optional().default("").describe("Kit root. Default: the folder above the guard's specs_path, or FMC_KIT."),
};

export type FmcGraphFormArgs = z.infer<z.ZodObject<typeof FMC_GRAPH_FORM_SHAPE>>;

const PLAN_KEYS = ["graph", "inputs_by_id", "mode", "plan_hash", "needs_approval", "approval_kind", "approval_why", "python", "lock"] as const;

function planView(raw: Record<string, unknown> | undefined): Pick<GraphPlan, typeof PLAN_KEYS[number]> | null {
  if (!raw || typeof raw.plan_hash !== "string" || typeof raw.graph !== "string") return null;
  const mode = raw.mode === "apply" || raw.mode === "offline" ? raw.mode : "preview";
  return {
    graph: raw.graph, plan_hash: raw.plan_hash, mode,
    inputs_by_id: raw.inputs_by_id && typeof raw.inputs_by_id === "object" ? raw.inputs_by_id as Record<string, unknown> : {},
    needs_approval: raw.needs_approval !== false, python: raw.python === true,
    approval_kind: (typeof raw.approval_kind === "string" ? raw.approval_kind : "graph_run") as GraphPlan["approval_kind"],
    approval_why: Array.isArray(raw.approval_why) ? raw.approval_why.map(String) : [],
    lock: (typeof raw.lock === "string" ? raw.lock : "absent") as GraphPlan["lock"],
  };
}

export async function runFmcGraphForm(args: FmcGraphFormArgs) {
  try {
    if (args.action === "approval" || args.action === "run_check") {
      const plan = planView(args.plan);
      if (!plan) return reply({ refused: true, code: "FMC-GRAPH-FORM-ARGS", message: `[FMC-GRAPH-FORM-ARGS] ${args.action} needs plan, the GraphPlan from fmc_dynamo plan.` }, true);
      if (args.action === "approval") return reply({ action: "approval", ...approvalStep(plan, args.reason) });
      const id = args.approval_id.trim();
      const approval = id ? readGraphApproval(id) : null;
      if (id && !approval) return reply({ action: "run_check", ok: false, code: "FMC-GRAPH-APPROVAL-NOT-FOUND", message: `[FMC-GRAPH-APPROVAL-NOT-FOUND] No approval ${id}.` }, true);
      const verdict = runCheck(plan, approval);
      return reply({ action: "run_check", ...verdict }, !verdict.ok);
    }
    const { config } = loadConfig();
    const kit = kitRootFrom(config, process.env, args.kit_folder);
    const named = namedDocument();
    const doc = named ? callDocument("fmc_graph_form") : { ok: true as const, document: null };
    if (!doc.ok) return reply(withResolved({ refused: true, code: doc.code, message: doc.message }, null), true);
    const big = inputTooLarge(args.values ?? args.texts);
    if (big) return reply(withResolved({ refused: true, code: "FMC-SCRIPT-LIMIT", message: big }, doc.document), true);
    const result = graphFormSpec({ file: args.path, kit, documentPath: doc.document?.path ?? "", cfg: config, env: process.env, checkPackages: args.check_packages });
    if (!result.ok) return reply(withResolved({ refused: true, code: result.code, message: result.message }, doc.document), true);
    if (args.action === "form") return reply(withResolved({ action: "form", form: paneForm(result.spec, { documentOpen: !!doc.document }), spec: result.spec }, doc.document));
    if (args.action === "bind") {
      const made = planRequest(result.spec, args.texts ?? {}, args.mode);
      return reply(withResolved({ action: "bind", ...made }, doc.document), !made.ok);
    }
    if (!args.values) return reply(withResolved({ ...result.spec }, doc.document));
    const binding = bindFormValues(result.spec, args.values);
    return reply(withResolved({ ...result.spec, binding }, doc.document), !binding.ok);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error), resolved_document: null }, true);
  }
}

export function registerFmcGraphFormTool(server: McpServer) {
  server.tool("fmc_graph_form", FMC_GRAPH_FORM_DESCRIPTION, FMC_GRAPH_FORM_SHAPE, (args) => runFmcGraphForm(args));
}
