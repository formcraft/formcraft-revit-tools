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
import { ageSyncRows, buildMatch, healthView } from "./healthview.js";
import type { HealthReport } from "./httpservice.js";
import { runFmcHealth } from "../tools/fmc_health.js";

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
  // Isolated tests start with an empty Formcraft tree, and an empty guard is not testing mode, so sync stays off.
  // This test writes its own guard into that temp tree. It does not read a live fmc_guard.json.
  const guard = path.join(process.env.APPDATA || os.tmpdir(), "Formcraft", "fmc_guard.json");
  fs.mkdirSync(path.dirname(guard), { recursive: true });
  fs.writeFileSync(guard, JSON.stringify({
    ai_modeller: { on: true, mode: "testing", auto_approve: true },
    sync_minutes: 15,
    sync_on_batch_end: true,
  }));
  const previousGuard = process.env.FMC_GUARD_CONFIG;
  process.env.FMC_GUARD_CONFIG = guard;
  let service: Awaited<ReturnType<typeof startHttpService>> | undefined;
  try {
    service = await startHttpService({ port: 0, token, allowEphemeral: true, watchStamp: false });
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
    if (previousGuard === undefined) delete process.env.FMC_GUARD_CONFIG;
    else process.env.FMC_GUARD_CONFIG = previousGuard;
    await service?.close();
  }
});
function fakeHealth(over: Partial<HealthReport> = {}): HealthReport {
  return {
    ok: true, build: "cfc56f5", built: "", server: { commit: "cfc56f5", built: "" }, addin: ["cf71214"], uptime_s: 10, listen: "x",
    instances: [{
      pid: 1, port: 8080, revit: "2025", build: "cf71214", answering: true, verdict: "ok", busy: null, busy_reason: null,
      documents: [{ title: "plumbing_USER", path: "C:\\M\\plumbing_USER.rvt", active: true, family: false }, { title: "electrical_USER", path: "C:\\M\\electrical_USER.rvt", active: false, family: false }],
      resolved_document: null,
    }],
    resolved_document: null,
    registration: { registered: 110, skipped: 15, failed: [] },
    queue: [] as unknown as HealthReport["queue"],
    busy_reason: null,
    batches: { syncs: [
      { document: "plumbing_USER", last_error: null, last_sync_at: "2026-11-28T06:00:00Z" },
      { document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", last_error: "[FMC-DOC-NOT-FOUND] No open document", last_sync_at: null },
    ] },
    schedule: [],
    memory: { free_mb: 3000, tier: "ok", paused: false } as unknown as HealthReport["memory"],
    hw: {} as HealthReport["hw"],
    coordination: {} as HealthReport["coordination"],
    jobs: { queued: 0, running: 0, last_finished: null },
    ...over,
  };
}

test("fmc_health: stale sync errors age out, build mismatch is a warning, ok stays true", () => {
  assert.equal(buildMatch("cfc56f5", ["cf71214"]), false);
  assert.equal(buildMatch("cfc56f5+dirty", ["cfc56f5"]), true);
  assert.equal(buildMatch("cfc56f5", []), null);
  const rows = ageSyncRows([{ document: "Gone", last_error: "boom" }], ["plumbing_USER"]);
  assert.equal(rows[0].last_error, null);
  assert.equal(rows[0].stale_error, "boom");
  const view = healthView(fakeHealth());
  assert.equal(view.ok, true);
  assert.equal(view.server_ok, true);
  assert.equal(view.build_match, false);
  const warnings = view.warnings as Array<{ code: string }>;
  assert.deepEqual(warnings.map((w) => w.code), ["FMC-HEALTH-BUILD-MISMATCH"]);
});

test("fmc_health: a dialog, a hard memory pause or an open-document sync error make ok false", () => {
  const base = fakeHealth();
  const dialog = healthView(fakeHealth({ instances: [{ ...base.instances[0], verdict: "waiting_for_idle", busy: { job: "j", command: "fmc_revit_file", since_s: 60, dialog: "TaskDialog_Save_Changes_To_Local_File" } }] }));
  assert.equal(dialog.ok, false);
  assert.ok((dialog.warnings as Array<{ code: string }>).some((w) => w.code === "FMC-HEALTH-REVIT-DIALOG"));
  const mem = healthView(fakeHealth({ memory: { free_mb: 900, tier: "hard", paused: true, reason: "low" } as unknown as HealthReport["memory"] }));
  assert.equal(mem.ok, false);
  const sync = healthView(fakeHealth({ batches: { syncs: [{ document: "plumbing_USER", last_error: "central busy" }] } }));
  assert.equal(sync.ok, false);
  assert.equal(sync.server_ok, true);
});

test("fmc_health: document narrows the reply and summary is short", async () => {
  const one = healthView(fakeHealth(), { document: "plumbing_USER", summary: true });
  assert.deepEqual(one.resolved_document, { title: "plumbing_USER", path: "C:\\M\\plumbing_USER.rvt" });
  assert.equal(one.summary, true);
  assert.equal("batches" in one, false);
  assert.deepEqual((one.syncs as Array<{ document: string }>).map((s) => s.document), ["plumbing_USER"]);
  const missing = healthView(fakeHealth(), { document: "Nope" });
  assert.equal(missing.ok, false);
  assert.match(String(missing.note), /FMC-DOC-NOT-FOUND/);
  const reply = await runFmcHealth({ summary: true }, async () => fakeHealth({ memory: { free_mb: 900, tier: "hard", paused: true } as unknown as HealthReport["memory"] }));
  assert.equal(reply.isError, false);
  assert.ok(reply.content[0].text.length < 2000);
});