import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLLBACK_DRY_RUNS, aiGate } from "./aigate.js";
import { WRITE_COMMANDS } from "./policy.js";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

test("X-01: rollback dry runs are write commands and go through sendCommand, not sendRaw", () => {
  for (const command of ROLLBACK_DRY_RUNS) assert.ok(WRITE_COMMANDS.has(command), command);
  const sites: Array<[string, string[]]> = [
    ["fmc_systems.ts", ["fmc_circuits_create"]],
    ["fmc_schedules.ts", ["fmc_schedules_apply"]],
    ["fmc_diagram.ts", ["fmc_diagram_draw"]],
  ];
  for (const [file, commands] of sites) {
    const text = fs.readFileSync(path.join(src, "tools", file), "utf8");
    for (const command of commands) {
      assert.doesNotMatch(text, new RegExp(`sendRaw\\("${command}"`), `${file} ${command}`);
      assert.match(text, new RegExp(`sendCommand\\("${command}"`), `${file} ${command}`);
    }
  }
  const ceiling = fs.readFileSync(path.join(src, "tools", "fmc_ceiling.ts"), "utf8");
  const helper = ceiling.slice(ceiling.indexOf("async function revit("), ceiling.indexOf("async function revit(") + 300);
  assert.doesNotMatch(helper, /sendRaw/);
  assert.match(helper, /sendCommand\(command, \{ \.\.\.params, dry_run: dry \}/);
});

test("X-01: at the AI gate a rollback dry run is a preview (no approval); the AI switch still decides", async () => {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-x01-"));
  const env = { ...process.env, APPDATA: appdata };
  const base = { live_model_lock: true, write_roots: [], library_roots: [], reports_dir: path.join(appdata, "r"), rulebooks_dir: path.join(appdata, "k") };
  const on = { ...base, ai_modeller: { on: true, mode: "testing", access: "full", projects: { "THE OGALA RESIDENCE": { general: true } } } } as any;
  const doc = { title: "OGL_A_MainHouse", path: path.win32.join("D:", "P", "THE OGALA RESIDENCE", "01_WIP", "OGL_A_MainHouse.rvt"), isFamily: false, isWorkshared: false } as any;
  for (const command of ROLLBACK_DRY_RUNS) {
    const g = await aiGate(command, { dry_run: true }, doc, on, async () => ({}), env);
    assert.equal(g.ok, true, `${command}: ${g.user ?? g.reason}`);
  }
  // not set up (no ai_modeller section): the lock's refusal stands for the dry run too
  const off = await aiGate("fmc_circuits_create", { dry_run: true }, doc, base as any, async () => ({}), env);
  assert.equal(off.ok, false);
  // the project's general switch off: refused
  const generalOff = { ...base, ai_modeller: { on: true, mode: "testing", access: "full", projects: { "THE OGALA RESIDENCE": { general: false } } } } as any;
  const shut = await aiGate("fmc_diagram_draw", { dry_run: true }, doc, generalOff, async () => ({}), env);
  assert.equal(shut.ok, false);
});