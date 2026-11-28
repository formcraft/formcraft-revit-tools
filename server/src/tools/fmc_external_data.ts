import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { loadConfig } from "../fmc/policy.js";
import { kitPaths } from "../fmc/context.js";
import { rootsOf, summarise } from "../fmc/extdata.js";

export const FMC_EXTERNAL_DATA_DESCRIPTION =
  "Read-only. What the open model pulls in from outside, as Manage Links shows it (Revit 2025 API): every external file " +
  "(Revit link, CAD link, keynote table, assembly code table, decal, systems analysis report) with type, path kind, load state " +
  "and path; the elements fed by external resource servers with server, version and display path; the registered servers. " +
  "Each path says whether it sits in the Formcraft kit or a CDE gate folder (02_Shared, 03_Published ...); those roots are reported, never changed. " +
  "Anything credential-shaped is shown as [redacted]. Nothing is loaded, reloaded, unloaded or repathed, and it is not a write command. " +
  "Revit 2027's External Data Manager and Extended Properties are not in R25 and are not listed. " +
  "Pass document (title or full path) when several projects are open. check_versions asks each resource's own server for its version status (off by default: a server may reach the network). " +
  "Needs the add-in DLL and a Revit restart.";

export const FMC_EXTERNAL_DATA_SHAPE = {
  check_versions: z.boolean().optional().default(false).describe("Ask each external resource's server whether the loaded version is current. Off by default; a server may reach the network."),
};

export type FmcExternalDataArgs = z.infer<z.ZodObject<typeof FMC_EXTERNAL_DATA_SHAPE>>;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

/** The add-in's facts for the document the call names. Injected in tests. */
export type ExtDataIo = (checkVersions: boolean) => Promise<Record<string, unknown>>;

export function defaultExtDataIo(): ExtDataIo {
  return async (checkVersions) => {
    const r = await withRevitConnection((client) => client.sendRaw("fmc_external_data", { check_versions: checkVersions }, 60000));
    return r && typeof r === "object" && !Array.isArray(r) ? r as Record<string, unknown> : {};
  };
}

export async function runFmcExternalData(args: FmcExternalDataArgs, io?: ExtDataIo) {
  try {
    const { config } = loadConfig();
    const facts = await (io ?? defaultExtDataIo())(args.check_versions === true);
    return reply(summarise(facts, rootsOf(config, kitPaths(config).root)));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, error: msg, message: msg }, true);
  }
}

export function registerFmcExternalDataTool(server: McpServer) {
  server.tool("fmc_external_data", FMC_EXTERNAL_DATA_DESCRIPTION, FMC_EXTERNAL_DATA_SHAPE, (args) => runFmcExternalData(args));
}