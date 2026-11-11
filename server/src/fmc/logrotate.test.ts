import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendCapped, rotateIfLarge } from "./logrotate.js";

test("a log past the cap is moved aside and the new lines start a fresh file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-log-"));
  const file = path.join(dir, "mcp-http.log");
  fs.writeFileSync(file, "x".repeat(50));
  assert.equal(rotateIfLarge(file, 40), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(file + ".1", "utf8").length, 50);
  appendCapped(file, "next", 4);
  assert.equal(fs.readFileSync(file, "utf8"), "next\n");
  appendCapped(file, "y".repeat(20), 4);
  assert.equal(fs.readFileSync(file + ".1", "utf8"), "next\n");
  assert.ok(fs.readFileSync(file, "utf8").startsWith("y"));
});
