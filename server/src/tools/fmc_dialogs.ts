import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../fmc/policy.js";
import { dialogStatus } from "../fmc/dialogs.js";

export const FMC_DIALOGS_DESCRIPTION =
  "Read-only. The dialog allow and deny lists from fmc_guard.json, the hard refusals (corrupt-model, sync, relinquish, " +
  "delete, overwrite, and the rest of the built-in deny), and the recent dialog lines in FMC_Jobs_Revit.jsonl. " +
  "Nothing is sent to Revit and nothing is answered. The add-in is what closes an allowlisted prompt; this tool only reports. " +
  "These are the guard lists (tier 1). Dialog boxes are also answered from the rules file: fmc_dialog_rules list shows it " +
  "(rules_file says whether it exists). Filter the recent lines with since (ISO time), job and only_left_for_person; counts tally them.";

const shape = {
  limit: z.number().int().min(1).max(200).optional().describe("How many recent dialog lines to return. Default 30."),
  since: z.string().optional().describe("Only lines at or after this ISO time, e.g. 2026-11-28T06:00:00Z."),
  job: z.string().optional().describe("Only lines of this job id."),
  only_left_for_person: z.boolean().optional().describe("Only prompts that were left for a person (not answered)."),
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export function runFmcDialogs(
  args: { limit?: number; since?: string; job?: string; only_left_for_person?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
  load: () => { config: Parameters<typeof dialogStatus>[0] } = loadConfig,
) {
  const { config } = load();
  try {
    return reply(dialogStatus(config, env, args.limit ?? 30, { since: args.since, job: args.job, only_left_for_person: args.only_left_for_person }));
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcDialogsTool(server: McpServer) {
  server.tool("fmc_dialogs", FMC_DIALOGS_DESCRIPTION, shape, (args) => runFmcDialogs(args));
}
