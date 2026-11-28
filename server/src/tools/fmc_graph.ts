import { z } from "zod";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../fmc/policy.js";
import { callDocument } from "../fmc/scriptexec.js";
import { withResolved } from "../fmc/scriptlib.js";
import { graphDecisions } from "../fmc/graph/decisions.js";
import { graphsDir, jailCheck, projectRootOf } from "../fmc/graph/jail.js";
import { generateGraph, scaffoldGraph, TEMPLATES, validateGraphText, writeDraft, type GraphSpec } from "../fmc/graph/author.js";
import { packageFolders } from "../fmc/graph/packages.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_GRAPH_DESCRIPTION =
  "Author Dynamo graphs as drafts (no Revit, nothing runs). scaffold makes a draft .dyn from a template " +
  `(${Object.keys(TEMPLATES).join(", ")}) with inputs and outputs marked. generate compiles a JSON spec ` +
  "{name, description, nodes:[{key, kind: number|string|boolean|watch|code_block|function|python, name, value, code, function, inputs, outputs, is_input, is_output}], " +
  "wires:[{from:'key[:out]', to:'key:in'}], packages:[{name, version}]} into a draft; there is no free-text graph. validate checks a draft: schema, loose wires, " +
  "unmarked inputs and outputs, unknown nodes, packages, Revit needed or not, size, and the Python/file scan. Drafts go only in the target model's project " +
  "folder (<project>\\00_Formcraft\\Graphs\\drafts), never in the kit, and never overwrite. A draft runs only after it is versioned and promoted (fmc_graph_lib); " +
  "a graph with Python always needs a person's approval to run.";

export const FMC_GRAPH_SHAPE = {
  action: z.enum(["scaffold", "generate", "validate"]),
  template: z.string().optional().default("").describe("scaffold: the template name"),
  name: z.string().optional().default("").describe("scaffold, generate: the draft name"),
  spec: z.record(z.unknown()).optional().describe("generate: the graph spec"),
  path: z.string().optional().default("").describe("validate: a draft .dyn in the project drafts folder (or a kit graph, read-only)"),
  kit_folder: z.string().optional().default(""),
};

export type FmcGraphArgs = z.infer<z.ZodObject<typeof FMC_GRAPH_SHAPE>>;

/** Shared with fmc_dynamo author: write a draft from a template or a spec, then validate it. */
export function authorDraft(args: { template?: string; name?: string; spec?: Record<string, unknown> }, projectRoot: string, draftsFolder?: string) {
  const name = (args.name || (args.spec?.name as string) || "").trim();
  if (!name) return { ok: false as const, body: { refused: true, code: "FMC-GRAPH-NAME", message: "[FMC-GRAPH-NAME] A draft needs name." } };
  const made = args.template?.trim()
    ? scaffoldGraph(args.template.trim(), name)
    : args.spec ? generateGraph({ ...(args.spec as unknown as GraphSpec), name }) : { ok: false as const, problems: ["Pass template or spec."] };
  if (!made.ok) return { ok: false as const, body: { refused: true, code: "FMC-GRAPH-SPEC", problems: made.problems } };
  const written = writeDraft(projectRoot, name, made.text, draftsFolder);
  if (!written.ok) return { ok: false as const, body: { refused: true, code: written.code, message: written.message } };
  const validation = validateGraphText(written.file, made.text, packageFolders());
  return {
    ok: true as const,
    body: {
      draft: written.file, tier: "P", validation,
      next: "Draft only: it does not run from here. fmc_graph_lib version saves it as <id>@<n>; a person promotes it into the kit." +
        (validation.python ? " It has Python: every run needs a person's approval." : ""),
    },
  };
}

export async function runFmcGraph(args: FmcGraphArgs) {
  const { config } = loadConfig();
  const decisions = graphDecisions(config);
  try {
    const doc = callDocument("fmc_graph");
    if (!doc.ok) return reply(withResolved({ refused: true, code: doc.code, message: doc.message }, null), true);
    const root = projectRootOf(doc.document?.path ?? "");
    if (args.action === "validate") {
      const file = args.path.trim();
      if (!file) return reply({ refused: true, message: "validate needs path." }, true);
      const inDrafts = root ? jailCheck(file, graphsDir(root, decisions.drafts_folder)) : null;
      if (!inDrafts?.ok && !/[\\/]05_Scripts[\\/](library|Dynamo)[\\/]/i.test(file)) {
        return reply(withResolved({ refused: true, code: "FMC-GRAPH-JAIL", message: inDrafts && !inDrafts.ok ? inDrafts.message : "[FMC-GRAPH-JAIL] validate reads drafts in the project folder or kit graphs only." }, doc.document), true);
      }
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch (error) { return reply({ refused: true, message: error instanceof Error ? error.message : String(error) }, true); }
      const v = validateGraphText(file, text, packageFolders());
      return reply(withResolved({ action: "validate", file, ...v }, doc.document), !v.ok);
    }
    const out = authorDraft({ template: args.action === "scaffold" ? args.template || "read_only_report" : "", name: args.name, spec: args.action === "generate" ? args.spec : undefined }, root, decisions.drafts_folder);
    return reply(withResolved({ action: args.action, ...out.body }, doc.document), !out.ok);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcGraphTool(server: McpServer) {
  server.tool("fmc_graph", FMC_GRAPH_DESCRIPTION, FMC_GRAPH_SHAPE, (args) => runFmcGraph(args));
}
