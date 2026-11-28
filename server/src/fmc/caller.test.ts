import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callerFor, noteMcpMessage, rememberCaller, runAsCaller, usageCallerFields } from "./caller.js";
import { readUsage, recordUsage } from "./usage.js";

test("initialize stores the client name, and usage keeps the session, transport and script head", () => {
  noteMcpMessage({ method: "initialize", params: { clientInfo: { name: "structure-bot" } } }, "stdio", "stdio");
  assert.equal(callerFor("stdio").client, "structure-bot");
  assert.equal(callerFor("stdio").transport, "stdio");
  rememberCaller({ client: "arch-bot", session: "sess-1", transport: "http" });
  const fields = runAsCaller(callerFor("sess-1"), () => usageCallerFields("send_code_to_revit", { code: "int n = 1;\nreturn n;" }));
  assert.deepEqual(fields, { client: "arch-bot", session: "sess-1", transport: "http", code_head: "int n = 1;\nreturn n;" });
  const env = { APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "fmc-caller-")) };
  recordUsage({ at: "2026-11-11T00:00:00.000Z", tool: "send_code_to_revit", action: "", ms: 10, ok: true, build: "abc", ...fields }, env);
  const line = readUsage(env)[0];
  assert.equal(line.client, "arch-bot");
  assert.equal(line.session, "sess-1");
  assert.equal(line.transport, "http");
  assert.match(line.code_head ?? "", /int n = 1/);
});
