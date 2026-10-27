import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Probe, appStatuses, readSwitches, toolsOff, writeSwitch } from "./apps.js";

/** A stand-in PC: these files exist, these processes run. */
function pc(files: string[], procs: string[] = [], appData = "C:\\Users\\U\\AppData\\Roaming"): Probe {
  const have = new Set(files.map((f) => f.toLowerCase()));
  return { exists: (f) => have.has(f.toLowerCase()), running: (n) => procs.map((p) => p.toLowerCase()).includes(n.toLowerCase()),
    appData, serverDir: "C:\\Users\\U\\mcp\\revit-fmc", env: {} };
}

const REVIT = "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe";
const ROBOT = "C:\\Program Files\\Autodesk\\Robot Structural Analysis Professional 2025\\Exe\\robot.exe";
const RHINO = "C:\\Program Files\\Rhino 8\\System\\Rhino.exe";

test("H0: each app is installed when its program exists, running when its process runs, and its connector is found", () => {
  const s = appStatuses(pc([REVIT, ROBOT, RHINO, "C:\\Users\\U\\mcp\\revit-fmc\\robot\\fmc-robot.exe"], ["Rhino.exe"]), {});
  const by = Object.fromEntries(s.map((a) => [a.id, a]));
  assert.equal(by.revit.installed, true);
  assert.equal(by.navisworks.installed, false);
  assert.deepEqual([by.robot.connector.built, by.robot.connector.note], [true, "built"]);
  assert.equal(by.rhino.running, true);
  assert.match(by.rhino.connector.note, /not installed: it travels with the next build/, "H1 built: installed with the next build");
  assert.match(by.powerbi.connector.note, /not built yet \(plan step H2\)/);
});

test("H0: by default an installed app is on; a person's switch wins; Revit is always on", () => {
  const probe = pc([REVIT, ROBOT, RHINO]);
  let s = appStatuses(probe, {});
  assert.deepEqual(s.filter((a) => a.on).map((a) => a.id), ["revit", "robot", "rhino"]);
  s = appStatuses(probe, { rhino: false, navisworks: true, revit: false });
  assert.deepEqual(s.filter((a) => a.on).map((a) => a.id), ["revit", "navisworks", "robot"]);
  // the tools of apps that are off don't load
  assert.deepEqual([...toolsOff(s)].sort(), ["fmc_blender", "fmc_powerbi", "fmc_rhino"]);
});

test("H0: the switches are kept per PC in %APPDATA%\\Formcraft\\apps.json", () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-apps-"));
  assert.deepEqual(readSwitches(appData), {});
  writeSwitch(appData, "rhino", false);
  writeSwitch(appData, "powerbi", true);
  assert.deepEqual(readSwitches(appData), { rhino: false, powerbi: true });
  fs.writeFileSync(path.join(appData, "Formcraft", "apps.json"), "not json");
  assert.deepEqual(readSwitches(appData), {}, "a broken file switches nothing off");
});
