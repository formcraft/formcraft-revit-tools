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
  "To run, use fmc_dynamo; the form itself runs nothing.";

export const FMC_GRAPH_FORM_SHAPE = {
  action: z.enum(["spec"]),
  path: z.string().optional().default("").describe("spec: the .dyn file (kit 05_Scripts/library or 05_Scripts/Dynamo, or <project>\\00_Formcraft\\Graphs)"),
  values: z.record(z.unknown()).optional().describe("spec: form values by input name or node id, to check and bind. At most 50."),
  check_packages: z.boolean().optional().default(true).describe("spec: compare the graph's packages with the installed ones (read-only). Default true."),
  kit_folder: z.string().optional().default("").describe("Kit root. Default: the folder above the guard's specs_path, or FMC_KIT."),
};

export type FmcGraphFormArgs = z.infer<z.ZodObject<typeof FMC_GRAPH_FORM_SHAPE>>;

export async function runFmcGraphForm(args: FmcGraphFormArgs) {
  try {
    const { config } = loadConfig();
    const kit = kitRootFrom(config, process.env, args.kit_folder);
    const named = namedDocument();
    const doc = named ? callDocument("fmc_graph_form") : { ok: true as const, document: null };
    if (!doc.ok) return reply(withResolved({ refused: true, code: doc.code, message: doc.message }, null), true);
    const big = inputTooLarge(args.values);
    if (big) return reply(withResolved({ refused: true, code: "FMC-SCRIPT-LIMIT", message: big }, doc.document), true);
    const result = graphFormSpec({ file: args.path, kit, documentPath: doc.document?.path ?? "", cfg: config, env: process.env, checkPackages: args.check_packages });
    if (!result.ok) return reply(withResolved({ refused: true, code: result.code, message: result.message }, doc.document), true);
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
