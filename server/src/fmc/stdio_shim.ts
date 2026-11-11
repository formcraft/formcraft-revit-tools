/**
 * Optional stdio MCP endpoint that forwards to the shared Formcraft HTTP service.
 * Claude Desktop can keep a tiny command (`node index.js --shim`) while the tools live in the long-running process.
 * The bearer token is read from the token file. It is not printed and it is not taken from the command line.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadOrCreateToken, tokenPath, httpPort } from "./httpservice.js";

export async function runStdioShim(opts?: { url?: string; token?: string; port?: number }): Promise<void> {
  const port = opts?.port ?? httpPort();
  const token = opts?.token ?? loadOrCreateToken(tokenPath());
  const url = opts?.url ?? `http://127.0.0.1:${port}/mcp`;
  const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const stdio = new StdioServerTransport();
  await bridgeStdio(stdio, httpTransport);
}

export async function bridgeStdio(stdio: StdioServerTransport, httpTransport: StreamableHTTPClientTransport): Promise<void> {
  let closed = false;
  const fail = (where: string, error: unknown) => {
    if (closed) return;
    const message = error instanceof Error ? error.message : "the service did not answer";
    console.error(`Formcraft stdio shim: ${where}: ${message}`);
  };
  httpTransport.onmessage = (message) => { void stdio.send(message).catch((error) => fail("writing to the MCP client", error)); };
  stdio.onmessage = (message) => { void httpTransport.send(message).catch((error) => fail("the Formcraft MCP service", error)); };
  httpTransport.onerror = (error) => fail("the Formcraft MCP service", error);
  stdio.onerror = (error) => fail("the MCP client", error);
  const done = new Promise<void>((resolve) => {
    const end = () => { if (!closed) { closed = true; resolve(); } };
    httpTransport.onclose = end;
    stdio.onclose = end;
  });
  await httpTransport.start();
  await stdio.start();
  await done;
}
