#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/register.js";
import { enableSoftTimeout } from "./utils/SocketClient.js";

// 创建服务器实例
const server = new McpServer({
  name: "mcp-server-for-revit",
  version: "1.0.0",
});

// 启动服务器
async function main() {
  // F-022: answer before the MCP client's 60 s cutoff; late results go to FMC_LateResults.jsonl.
  enableSoftTimeout();
  // 注册工具
  await registerTools(server);

  // 连接到传输层
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Revit MCP Server start success");
}

main().catch((error) => {
  console.error("Error starting Revit MCP Server:", error);
  process.exit(1);
});
