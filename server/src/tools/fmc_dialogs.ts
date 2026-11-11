import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../fmc/policy.js";
import { dialogStatus } from "../fmc/dialogs.js";

export const FMC_DIALOGS_DESCRIPTION =
  "Read-only. The dialog allow and deny lists from fmc_guard.json, the hard refusals (corrupt-model, sync, relinquish, " +
  "delete, overwrite, and the rest of the built-in deny), and the recent dialog lines in FMC_Jobs_Revit.jsonl. " +
  "Nothing is sent to Revit and nothing is answered. The add-in is what closes an allowlisted prompt; this tool only reports.";

const shape = {
  limit: z.number().int().min(1).max(200).optional().describe("How many recent dialog lines to return. Default 30."),
};

function reply(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError: false };
}

export function runFmcDialogs(args: { limit?: number } = {}, env: NodeJS.ProcessEnv = process.env) {
  const { config } = loadConfig();
  return reply(dialogStatus(config, env, args.limit ?? 30));
}

export function registerFmcDialogsTool(server: McpServer) {
  server.tool("fmc_dialogs", FMC_DIALOGS_DESCRIPTION, shape, (args) => runFmcDialogs(args));
}
