import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertHttpPort, bearerToken, bindHost, isLoopback, startHttpService, tokenEquals, writeTokenFile } from "./httpservice.js";
import { bridgeStdio } from "./stdio_shim.js";

test("the HTTP service stays on loopback, off Revit's ports, and the token is not a prefix match", () => {
  assert.equal(bindHost(undefined), "127.0.0.1");
  assert.equal(bindHost("localhost"), "127.0.0.1");
  assert.throws(() => bindHost("0.0.0.0"), /127\.0\.0\.1 only/);
  assert.throws(() => assertHttpPort(8080), /reserved for Revit/);
  assert.throws(() => assertHttpPort(8089), /reserved for Revit/);
  assert.equal(assertHttpPort(8787), 8787);
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true);
  assert.equal(isLoopback("192.168.1.2"), false);
  assert.equal(tokenEquals("abc", "abc"), true);
  assert.equal(tokenEquals("abc", "abcd"), false);
  assert.equal(bearerToken("Bearer secret", "secret"), true);
  assert.equal(bearerToken("Bearer secret-extra", "secret"), false);
  assert.equal(bearerToken(undefined, "secret"), false);
});

test("the token file is readable by the owner only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-token-"));
  const file = path.join(dir, "mcp-http.token");
  writeTokenFile(file, "not-a-secret-in-a-log");
  const text = fs.readFileSync(file, "utf8").trim();
  assert.equal(text, "not-a-secret-in-a-log");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("the service requires the bearer token, reports health, lists fmc_review, and the shim can reach it", { timeout: 180_000 }, async () => {
  const token = "test-token-not-logged";
  const service = await startHttpService({ port: 0, token, allowEphemeral: true, watchStamp: false });
  try {
    const denied = await fetch(`http://127.0.0.1:${service.port}/health`);
    assert.equal(denied.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${service.port}/health`, { headers: { Authorization: "Bearer no" } });
    assert.equal(wrong.status, 401);
    const health = await fetch(`http://127.0.0.1:${service.port}/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200);
    const body = await health.json() as { ok: boolean; listen: string; uptime_s: number; instances: unknown[]; build: string; server?: { commit: string }; registration?: { failed?: unknown[] } };
    assert.equal(body.ok, true);
    assert.equal(body.listen, `127.0.0.1:${service.port}`);
    assert.ok(Array.isArray((body as { registration?: { failed?: unknown[] } }).registration?.failed));
    assert.equal(body.server?.commit, body.build);
    assert.equal(typeof body.build, "string");
    assert.ok(body.uptime_s >= 0);
    assert.ok(Array.isArray(body.instances));
    const care = (body as { batches?: { approval?: string; sync?: string; approval_does_not_cover?: string[] } }).batches;
    assert.ok(care?.approval === "auto" || care?.approval === "manual");
    assert.equal(care?.sync, "managed");
    const memory = (body as { memory?: { pause_below_mb?: number; resume_above_mb?: number; free_mb?: number; paused?: boolean } }).memory;
    assert.equal(memory?.pause_below_mb, 1024);
    assert.equal(memory?.resume_above_mb, 1536);
    assert.equal(typeof memory?.free_mb, "number");
    assert.equal(typeof memory?.paused, "boolean");
    assert.match((care?.approval_does_not_cover ?? []).join(" "), /references/);
    assert.equal(JSON.stringify(body).includes(token), false);

    const client = new Client({ name: "formcraft-test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(service.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "fmc_review"), "fmc_review is not in tools/list");
    await client.close();

    const input = new PassThrough();
    const output = new PassThrough();
    const stdio = new StdioServerTransport(input, output);
    const httpTransport = new StreamableHTTPClientTransport(new URL(service.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const bridged = bridgeStdio(stdio, httpTransport);
    input.write(JSON.stringify({
      jsonrpc: "2.0", id: 7, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shim-test", version: "0" } },
    }) + "\n");
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("shim produced no answer")), 20000);
      let buf = "";
      output.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl >= 0) { clearTimeout(timer); resolve(buf.slice(0, nl)); }
      });
    });
    const message = JSON.parse(line) as { id?: number; result?: { serverInfo?: { name?: string } } };
    assert.equal(message.id, 7);
    assert.equal(message.result?.serverInfo?.name, "mcp-server-for-revit");
    input.end();
    await Promise.race([bridged, new Promise((resolve) => setTimeout(resolve, 500))]);
  } finally {
    await service.close();
  }
});
