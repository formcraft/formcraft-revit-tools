import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { annotateInvalidOpErrors, registerTools } from "../tools/register.js";
import { enableSoftTimeout } from "../utils/SocketClient.js";
import { installContextNudges, registerContextPrompts, registerContextResources, serverOptions } from "./mcp_context.js";

/** One MCP server with every Formcraft tool, the kit context, and the same guards the stdio process uses. */
export async function createFormcraftServer(): Promise<McpServer> {
  const server = new McpServer({ name: "mcp-server-for-revit", version: "1.0.0" }, serverOptions());
  enableSoftTimeout();
  installContextNudges(server);
  await registerTools(server);
  if (!annotateInvalidOpErrors(server)) console.error("F-042: couldn't hook tools/call errors; invalid-op refusals won't name the build");
  registerContextResources(server);
  registerContextPrompts(server);
  return server;
}
