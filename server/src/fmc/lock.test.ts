import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";

// the server's TypeScript source, beside this build
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...sources(p));
    else if (/\.ts$/.test(d.name) && !/\.test\.ts$/.test(d.name)) out.push(p);
  }
  return out;
}

test("the live-model lock: every command a tool sends through sendCommand is a known write (locked) or a known read", () => {
  const unknown: string[] = [];
  for (const f of sources(SRC)) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/sendCommand\(\s*"([a-z_]+)"/g)) {
      if (!WRITE_COMMANDS.has(m[1]) && !READ_VIA_SEND_COMMAND.has(m[1])) unknown.push(`${path.relative(SRC, f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(unknown, [], "add each to WRITE_COMMANDS (it changes the model) or READ_VIA_SEND_COMMAND (it only reads), in fmc/policy.ts");
});

test("the lock covers the room builds and applied fixes; a read is never on both lists", () => {
  assert.ok(WRITE_COMMANDS.has("fmc_room_build") && WRITE_COMMANDS.has("fmc_element_apply"));
  for (const c of READ_VIA_SEND_COMMAND) assert.ok(!WRITE_COMMANDS.has(c), c);
});
