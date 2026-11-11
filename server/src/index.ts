#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RUNNING_BUILD } from "./fmc/buildinfo.js";
import { createFormcraftServer } from "./fmc/boot.js";
import { bindHost, formcraftDir, httpPort, loadOrCreateToken, startHttpService, tokenPath } from "./fmc/httpservice.js";
import { appendCapped } from "./fmc/logrotate.js";
import { runStdioShim } from "./fmc/stdio_shim.js";
import path from "node:path";

type Mode = "stdio" | "http" | "shim";

function mode(): Mode {
  const args = process.argv.slice(2);
  if (args.includes("--http")) return "http";
  if (args.includes("--shim")) return "shim";
  const env = (process.env.FMC_MCP_MODE || "").toLowerCase();
  if (env === "http" || env === "shim" || env === "stdio") return env;
  return "stdio";
}

async function runStdio(): Promise<void> {
  const server = await createFormcraftServer();
  console.error(`Formcraft server build ${RUNNING_BUILD.commit} (built ${RUNNING_BUILD.built || "?"})`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Revit MCP Server start success");
}

async function runHttp(): Promise<void> {
  const logFile = path.win32.join(formcraftDir(), "mcp-http.service.log");
  const write = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const line = args.map((part) => (part instanceof Error ? part.message : String(part))).join(" ");
    try { appendCapped(logFile, line); } catch { /* the log must not stop the service */ }
    write(...args);
  };
  console.error(`Formcraft server build ${RUNNING_BUILD.commit} (built ${RUNNING_BUILD.built || "?"})`);
  const port = httpPort();
  const token = loadOrCreateToken(tokenPath());
  bindHost(process.env.FMC_HTTP_HOST);
  await startHttpService({ port, token, watchStamp: true });
}

async function main() {
  const selected = mode();
  if (selected === "http") await runHttp();
  else if (selected === "shim") await runStdioShim();
  else await runStdio();
}

main().catch((error) => {
  console.error("Error starting Revit MCP Server:", error instanceof Error ? error.message : error);
  process.exit(1);
});
