import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queueSnapshots } from "../fmc/fairqueue.js";

export const FMC_QUEUE_DESCRIPTION =
  "Where calls to Revit are waiting. One Revit runs one call at a time. Clients take turns, so a long batch does not " +
  "sit in front of every other bot. Read-only. A call that is still waiting answers [FMC-QUEUED] and has not failed.";

export function registerFmcQueueTool(server: McpServer) {
  server.tool("fmc_queue", FMC_QUEUE_DESCRIPTION, {}, () => ({
    content: [{ type: "text" as const, text: JSON.stringify({ queues: queueSnapshots() }, null, 2) }],
  }));
}
