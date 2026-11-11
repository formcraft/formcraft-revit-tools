/**
 * The Formcraft MCP service: one long-running process on this PC, Streamable HTTP, 127.0.0.1 only.
 * Claude's stdio process is optional. Any MCP client that can send a bearer token can use the same server,
 * and a new build replaces it without restarting Claude (the supervisor reloads this process).
 *
 * The live-model lock, fail-closed routing, copy-only writes and the keynote rules run in the tools, so they
 * apply on this transport the same way they apply on stdio.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { BUILD_INFO_FILE, RUNNING_BUILD } from "./buildinfo.js";
import { createFormcraftServer } from "./boot.js";
import { HOST, ProbeVerdict, probePort, readInstances } from "./connect.js";
import { lastRegistration } from "../tools/register.js";
import { queueClient, queueSnapshots } from "./fairqueue.js";
import { addGrantListener, batchBoard, logBatchRestart, notifyBatchGranted } from "./batchline.js";
import { callerFor, clientNameFromInitialize, rememberCaller, runAsCaller } from "./caller.js";
import { memoryGate } from "./memory.js";

const win = path.win32;

/** Revit listens on 8080-8089. This service must not take one of those. */
export const REVIT_PORT_MIN = 8080;
export const REVIT_PORT_MAX = 8089;
export const DEFAULT_HTTP_PORT = 8787;

export function formcraftDir(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA || win.join(os.homedir(), "AppData", "Roaming");
  return win.join(appData, "Formcraft");
}

export function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return win.join(formcraftDir(env), "mcp-http.token");
}

export function httpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return win.join(formcraftDir(env), "fmc_http.json");
}

export function reloadPath(env: NodeJS.ProcessEnv = process.env): string {
  return win.join(formcraftDir(env), "mcp-http.reload");
}

/** 127.0.0.1 only. A config that asks for any other address is refused. */
export function bindHost(requested?: string): string {
  if (!requested || requested === "127.0.0.1" || requested === "localhost" || requested === "::1") return "127.0.0.1";
  throw new Error(`The Formcraft MCP service binds to 127.0.0.1 only, not ${requested}.`);
}

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** A fixed port, never one of Revit's. Port 0 is allowed only for tests that need an ephemeral port. */
export function assertHttpPort(port: number, allowEphemeral = false): number {
  if (allowEphemeral && port === 0) return 0;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(`Formcraft MCP port ${port} is not a usable port (1024-65535).`);
  if (port >= REVIT_PORT_MIN && port <= REVIT_PORT_MAX)
    throw new Error(`Port ${port} is reserved for Revit (${REVIT_PORT_MIN}-${REVIT_PORT_MAX}). Set another port in fmc_http.json.`);
  return port;
}

export function httpPort(env: NodeJS.ProcessEnv = process.env, read: (p: string) => string = (p) => fs.readFileSync(p, "utf8"), allowEphemeral = false): number {
  if (env.FMC_HTTP_PORT) return assertHttpPort(Number(env.FMC_HTTP_PORT), allowEphemeral);
  try {
    const port = Number(JSON.parse(read(httpConfigPath(env)).replace(/^\uFEFF/, "")).port);
    if (Number.isInteger(port)) return assertHttpPort(port, allowEphemeral);
  } catch { /* missing file: the default */ }
  return DEFAULT_HTTP_PORT;
}

export function tokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/** Write the bearer token so only the current user can read it. The token itself is never logged. */
export function writeTokenFile(file: string, token: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* Windows */ }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
  if (process.platform === "win32") {
    const user = process.env.USERNAME || "";
    if (user) {
      spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:(R)`], { windowsHide: true, stdio: "ignore" });
    }
  }
}

export function loadOrCreateToken(file: string, read: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): string {
  try {
    const token = read(file).replace(/^\uFEFF/, "").trim();
    if (token) return token;
  } catch { /* create it */ }
  const token = crypto.randomBytes(32).toString("base64url");
  writeTokenFile(file, token);
  return token;
}

export function bearerToken(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return false;
  return tokenEquals(match[1], expected);
}

export interface HealthReport {
  ok: boolean;
  build: string;
  built: string;
  server: { commit: string; built: string };
  addin: string[];
  uptime_s: number;
  listen: string;
  instances: Array<{ pid: number; port: number; revit: string; build: string; answering: boolean; verdict: ProbeVerdict }>;
  registration: { registered: number; skipped: number; failed: Array<{ file: string; error: string }> };
  queue: ReturnType<typeof queueSnapshots>;
  batches: ReturnType<ReturnType<typeof batchBoard>["snapshot"]>;
  memory: ReturnType<typeof memoryGate.view>;
}

export async function healthReport(listen: string, startedAt: number, env: NodeJS.ProcessEnv = process.env): Promise<HealthReport> {
  const instances = readInstances(env);
  const rows = [];
  for (const instance of instances) {
    const verdict = await probePort(HOST, instance.port, 300);
    rows.push({
      pid: instance.pid, port: instance.port, revit: instance.revit || "", build: instance.build || "",
      answering: verdict === "ok", verdict,
    });
  }
  const reg = lastRegistration;
  const addin = [...new Set(rows.map((row) => row.build).filter(Boolean))];
  return {
    ok: reg.failed.length === 0,
    build: RUNNING_BUILD.commit,
    built: RUNNING_BUILD.built,
    server: { commit: RUNNING_BUILD.commit, built: RUNNING_BUILD.built },
    addin,
    uptime_s: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    listen,
    instances: rows,
    registration: { registered: reg.registered.length, skipped: reg.skipped.length, failed: reg.failed },
    queue: queueSnapshots(),
    batches: batchBoard().snapshot(),
    memory: memoryGate.view(),
  };
}

/** installed.json, the updater's reload flag, and build-info.json, so a new stamp is visible. */
export function serviceStamp(env: NodeJS.ProcessEnv = process.env): string {
  const files = [win.join(formcraftDir(env), "installed.json"), reloadPath(env), BUILD_INFO_FILE];
  return files.map((file) => {
    try { return fs.statSync(file).mtimeMs + ":" + fs.readFileSync(file); } catch { return ""; }
  }).join("\n");
}

export function watchServiceStamp(env: NodeJS.ProcessEnv, onChange: () => void, intervalMs = 2000): () => void {
  let last = serviceStamp(env);
  const timer = setInterval(() => {
    const now = serviceStamp(env);
    if (now !== last) {
      last = now;
      onChange();
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export interface HttpService {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface HttpServiceOptions {
  port: number;
  token: string;
  /** Tests pass an ephemeral port. Production uses a fixed port outside 8080-8089. */
  allowEphemeral?: boolean;
  env?: NodeJS.ProcessEnv;
  /** When set, a change to the installed stamp calls this instead of exiting. */
  onStampChange?: () => void;
  watchStamp?: boolean;
}

export async function startHttpService(options: HttpServiceOptions): Promise<HttpService> {
  const host = bindHost("127.0.0.1");
  const requested = assertHttpPort(options.port, options.allowEphemeral === true);
  const token = options.token;
  const env = options.env ?? process.env;
  const sessions = new Map<string, Session>();
  const startedAt = Date.now();
  logBatchRestart();
  const stopGrants = addGrantListener((notice) => {
    const session = sessions.get(notice.client);
    if (!session) return;
    const low = (session.server as unknown as { server?: { notification?: (msg: unknown) => Promise<void> } }).server;
    if (!low?.notification) return;
    void notifyBatchGranted((method, params) => low.notification!({ method, params }), notice);
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket.remoteAddress)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      const pathOnly = (req.url || "/").split("?")[0];
      if (!bearerToken(req.headers.authorization, token)) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "www-authenticate": "Bearer realm=\"formcraft\"" });
        res.end("Unauthorized");
        return;
      }
      if (req.method === "GET" && pathOnly === "/health") {
        const address = server.address();
        const listen = typeof address === "object" && address ? `${host}:${address.port}` : `${host}:${requested}`;
        const body = JSON.stringify(await healthReport(listen, startedAt, env), null, 2);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
        return;
      }
      if (pathOnly !== "/mcp") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      await handleMcp(req, res, sessions);
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      console.error("Formcraft MCP HTTP request failed:", message);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("The Formcraft MCP service could not handle that request.");
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requested, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requested;
  if (typeof address === "object" && address && address.address !== host && address.address !== "127.0.0.1") {
    server.close();
    throw new Error(`Refusing to listen on ${address.address}. The service binds to 127.0.0.1 only.`);
  }

  let stopWatch = () => {};
  if (options.watchStamp) {
    stopWatch = watchServiceStamp(env, () => {
      if (options.onStampChange) options.onStampChange();
      else void close().then(() => process.exit(0));
    });
  }

  async function close() {
    stopWatch();
    stopGrants();
    for (const session of sessions.values()) {
      try { await session.transport.close(); } catch { /* already closed */ }
      try { await session.server.close(); } catch { /* already closed */ }
    }
    sessions.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.error(`Formcraft MCP service listening on http://${host}:${port}/mcp (token file, not logged)`);
  return { port, url: `http://${host}:${port}/mcp`, close };
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, Session>): Promise<void> {
  const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readJsonBody(req);
  const sid = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : "";
  if (sid) {
    const existing = sessions.get(sid);
    if (!existing) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown MCP session. Connect again." }, id: null }));
      return;
    }
    await runAsCaller(callerFor(sid), () => queueClient.run(sid, () => existing.transport.handleRequest(req, res, body)));
    return;
  }
  if (req.method === "POST" && isInitializeRequest(body)) {
    const initName = clientNameFromInitialize(body);
    const mcp = await createFormcraftServer();
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server: mcp });
        if (initName) rememberCaller({ client: initName, session: id, transport: "http" });
      },
      onsessionclosed: async (id) => {
        batchBoard().disconnect(id);
        const session = sessions.get(id);
        sessions.delete(id);
        try { await session?.server.close(); } catch { /* already closed */ }
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        batchBoard().disconnect(id);
        sessions.delete(id);
      }
    };
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }
  res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Expected an MCP initialize request, or a request with a session id." }, id: null }));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const limit = 4_000_000;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      const error = new Error("request body is too large");
      (error as NodeJS.ErrnoException).code = "ETOOBIG";
      throw error;
    }
    chunks.push(buf);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
