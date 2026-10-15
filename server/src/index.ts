#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/register.js";
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
