#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { annotateInvalidOpErrors, registerTools } from "./tools/register.js";
import { RUNNING_BUILD } from "./fmc/buildinfo.js";
import { enableSoftTimeout } from "./utils/SocketClient.js";
import { installContextNudges, registerContextPrompts, registerContextResources, serverOptions } from "./fmc/mcp_context.js";

// 创建服务器实例
// The instructions every AI gets on connect: the kit first, then the hard rules (docs/AI_CONTEXT.md).
const server = new McpServer({
  name: "mcp-server-for-revit",
  version: "1.0.0",
}, serverOptions());

// 启动服务器
async function main() {
  // F-022: answer before the MCP client's 60 s cutoff; late results go to FMC_LateResults.jsonl.
  enableSoftTimeout();
  // The kit nudge on family- and material-making tools, before they register.
  installContextNudges(server);
  // 注册工具
  await registerTools(server);
  // F-042: the build this process runs is read once, now; an "invalid op" refusal names it (and a newer one on disk).
  console.error(`Formcraft server build ${RUNNING_BUILD.commit} (built ${RUNNING_BUILD.built || "?"})`);
  if (!annotateInvalidOpErrors(server)) console.error("F-042: couldn't hook tools/call errors; invalid-op refusals won't name the build");
  // The kit as MCP resources and prompts, where the SDK has them.
  const resources = registerContextResources(server);
  const prompts = registerContextPrompts(server);
  console.error(`FMC context: ${resources.length} resources, ${prompts.length} prompts`);

  // 连接到传输层
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Revit MCP Server start success");
}

main().catch((error) => {
  console.error("Error starting Revit MCP Server:", error);
  process.exit(1);
});
