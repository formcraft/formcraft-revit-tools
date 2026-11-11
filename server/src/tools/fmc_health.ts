import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { healthReport } from "../fmc/httpservice.js";

const started = Date.now();

export const FMC_HEALTH_DESCRIPTION =
  "Formcraft health, read-only. The server build this process is running, the add-in build each open Revit announced, " +
  "whether each announced port accepts a connection, any tool module that failed to register, and the batch line " +
  "(holder, queue, history, struggling batches, per-bot stats), free memory, and per-document sync. Nothing is changed.";

/** Same facts as HTTP GET /health. Does not send a model command. */
export async function runFmcHealth() {
  const body = await healthReport("revit-bridge", started);
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError: !body.ok };
}

export function registerFmcHealthTool(server: McpServer) {
  server.tool("fmc_health", FMC_HEALTH_DESCRIPTION, {}, () => runFmcHealth());
}
