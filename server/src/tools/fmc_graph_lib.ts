import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../fmc/policy.js";
import { kitRootFrom } from "../fmc/dynamo.js";
import { callDocument } from "../fmc/scriptexec.js";
import { withResolved } from "../fmc/scriptlib.js";
import { graphDecisions } from "../fmc/graph/decisions.js";
import { projectRootOf } from "../fmc/graph/jail.js";
import { listGraphs, proposeLock, versionDraft } from "../fmc/graph/lib.js";
import { installedPackages, packageFolders } from "../fmc/graph/packages.js";
import { sha256Folder } from "../fmc/graph/hash.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_GRAPH_LIB_DESCRIPTION =
  "The versioned Dynamo graph library. list: every graph in the kit (05_Scripts/library and 05_Scripts/Dynamo, tier K) and the target model's " +
  "project drafts and versions (tier P): id, version, SHA-256, status, runner, packages, Python or not, writes the model or not, kit-lock state. " +
  "version: save a draft from <project>\\00_Formcraft\\Graphs as the next <id>@<n>.dyn with SHA-256, parent hash, author and reason; never overwrites. " +
  "lock: propose the hash register (graphs.lock.json: one SHA-256 per kit graph, custom node and package folder) as " +
  "<project>\\00_Formcraft\\Graphs\\graphs.lock.proposed.json; a person or the release copies it into the kit. When the kit has graphs.lock.json, " +
  "a changed or unlisted kit graph does not run. The kit is never written.";

export const FMC_GRAPH_LIB_SHAPE = {
  action: z.enum(["list", "version", "lock"]),
  path: z.string().optional().default("").describe("version: the draft .dyn in the project drafts folder"),
  id: z.string().optional().default("").describe("version: the graph id (letters, digits, '_', '-', '.')"),
  reason: z.string().optional().default("").describe("version: why this version"),
  kit_folder: z.string().optional().default(""),
};

export type FmcGraphLibArgs = z.infer<z.ZodObject<typeof FMC_GRAPH_LIB_SHAPE>>;

export async function runFmcGraphLib(args: FmcGraphLibArgs) {
  const { config } = loadConfig();
  const decisions = graphDecisions(config);
  const kit = kitRootFrom(config, process.env, args.kit_folder);
  try {
    const doc = callDocument("fmc_graph_lib");
    if (!doc.ok) return reply(withResolved({ refused: true, code: doc.code, message: doc.message }, null), true);
    const root = projectRootOf(doc.document?.path ?? "");
    if (args.action === "list") {
      const out = listGraphs({ kit, projectRoot: root, draftsFolder: decisions.drafts_folder });
      return reply(withResolved({ action: "list", kit, ...out, count: out.graphs.length }, doc.document));
    }
    if (args.action === "version") {
      if (!root) return reply(withResolved({ refused: true, code: "FMC-GRAPH-JAIL", message: "[FMC-GRAPH-JAIL] The target model is not in a project's 01_WIP." }, doc.document), true);
      const out = versionDraft({ projectRoot: root, draft: args.path.trim(), id: args.id, reason: args.reason, author: "ai", authorName: "AI", draftsFolder: decisions.drafts_folder });
      if (!out.ok) return reply(withResolved({ refused: true, code: out.code, message: out.message }, doc.document), true);
      return reply(withResolved({ action: "version", ...out.version }, doc.document));
    }
    const pkgs = installedPackages(packageFolders()).map((p) => ({ name: p.name, version: p.version, folder_sha256: sha256Folder(p.folder) }));
    const out = proposeLock({ kit, projectRoot: root, packages: pkgs, draftsFolder: decisions.drafts_folder });
    if (!out.ok) return reply(withResolved({ refused: true, code: out.code, message: out.message }, doc.document), true);
    return reply(withResolved({
      action: "lock", proposed: out.file, kit_target: out.target,
      graphs: Object.keys(out.lock.graphs).length, custom_nodes: Object.keys(out.lock.custom_nodes).length, packages: Object.keys(out.lock.packages).length,
      next: `A person (D11) reviews it and copies it to ${out.target}. The AI never writes the kit.`,
    }, doc.document));
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcGraphLibTool(server: McpServer) {
  server.tool("fmc_graph_lib", FMC_GRAPH_LIB_DESCRIPTION, FMC_GRAPH_LIB_SHAPE, (args) => runFmcGraphLib(args));
}
