import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUsage, recordUsage, summariseUsage } from "./usage.js";

test("tool calls are recorded and summarised per build, newest build first, for an AI's own report", () => {
  const env = { APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "fmc-usage-")) };
  const at = (m: number) => new Date(Date.UTC(2026, 9, 26, 9, m)).toISOString();
  recordUsage({ at: at(0), tool: "create_line_based_element", action: "", ms: 41000, ok: true, build: "038d15f" }, env);
  recordUsage({ at: at(1), tool: "create_line_based_element", action: "", ms: 39000, ok: false, build: "038d15f" }, env);
  recordUsage({ at: at(5), tool: "create_line_based_element", action: "", ms: 12000, ok: true, build: "e1ddc12" }, env);
  recordUsage({ at: at(6), tool: "fmc_ai", action: "queue", ms: 300, ok: true, build: "e1ddc12" }, env);
  const s = summariseUsage(readUsage(env));
  assert.equal(s.calls, 4);
  assert.deepEqual(s.by_build.map((b) => b.build), ["e1ddc12", "038d15f"]);
  assert.equal(s.by_build[1].failures, 1);
  assert.equal(s.by_build[0].tools.find((t) => t.tool === "create_line_based_element")?.median_ms, 12000);
  assert.equal(s.by_build[0].tools.find((t) => t.tool === "fmc_ai queue")?.calls, 1);
  assert.equal(summariseUsage(readUsage(env), at(5)).calls, 2, "since");
  assert.deepEqual(readUsage({ APPDATA: path.join(env.APPDATA, "none") }), [], "nothing recorded yet");
});
