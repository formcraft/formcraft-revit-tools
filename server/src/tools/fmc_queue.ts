import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queueSnapshots } from "../fmc/fairqueue.js";
import { batchBoard } from "../fmc/batchline.js";

export const FMC_QUEUE_DESCRIPTION =
  "Where calls to Revit are waiting, and who holds each document's batch lease. One Revit runs one call at a time. " +
  "Clients take turns, so a long batch does not sit in front of every other bot. batches lists the holder, the line, " +
  "the last 20 batches, batches with more than 3 attempts (struggling, not blocked), and per-bot totals (batches, failures, retries, " +
  "average wait, average duration, last references) and the existing auto-save and auto-approve settings. " +
  "Read-only. A call that is still waiting answers [FMC-QUEUED] and has not failed.";

export function registerFmcQueueTool(server: McpServer) {
  server.tool("fmc_queue", FMC_QUEUE_DESCRIPTION, {}, () => ({
    content: [{ type: "text" as const, text: JSON.stringify({ queues: queueSnapshots(), batches: batchBoard().snapshot() }, null, 2) }],
  }));
}
