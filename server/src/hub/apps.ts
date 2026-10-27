/**
 * The engineering hub (docs/PLAN_ENGINEERING_HUB.md, H0): one MCP server, a connector per app. This is the registry:
 * which apps Formcraft knows, how each is detected (installed, running, connector built), which of the server's tools
 * belong to it, and whether a person has switched it on. Pure apart from the Probe it is given.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type AppId = "revit" | "navisworks" | "robot" | "rhino" | "powerbi" | "blender";
export type ConnectorKind = "bridge" | "process" | "gateway";

export interface AppDef {
  id: AppId;
  name: string;
  kind: ConnectorKind;
  /** The app's program: installed when it exists (an env var FMC_APP_<ID>_EXE overrides). */
  exe: string;
  /** Its process name, to tell whether it is running. */
  process: string;
  /** The server's tools that belong to this app; they load only while the app is switched on. */
  tools: string[];
  /** Where its connector lives (relative paths are under %APPDATA%); empty when there is none yet. */
  connector: string[];
  /** The plan step that builds the connector when there is none yet. */
  planned?: string;
  /** Revit carries the whole Formcraft toolset: it is never switched off. */
  core?: boolean;
}

export const APPS: AppDef[] = [
  { id: "revit", name: "Revit 2025", kind: "bridge", exe: "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe", process: "Revit.exe",
    tools: [], connector: ["Autodesk\\Revit\\Addins\\2025\\Formcraft.addin"], core: true },
  { id: "navisworks", name: "Navisworks Manage 2025", kind: "bridge", exe: "C:\\Program Files\\Autodesk\\Navisworks Manage 2025\\Roamer.exe", process: "Roamer.exe",
    tools: ["fmc_navis"], connector: ["Autodesk Navisworks Manage 2025\\Plugins\\Formcraft.Navis\\Formcraft.Navis.dll"] },
  { id: "robot", name: "Robot Structural Analysis 2025", kind: "process",
    exe: "C:\\Program Files\\Autodesk\\Robot Structural Analysis Professional 2025\\Exe\\robot.exe", process: "robot.exe",
    tools: ["fmc_robot"], connector: ["<server>\\robot\\fmc-robot.exe"] },
  { id: "rhino", name: "Rhino 8", kind: "bridge", exe: "C:\\Program Files\\Rhino 8\\System\\Rhino.exe", process: "Rhino.exe",
    tools: ["fmc_rhino"], connector: ["McNeel\\Rhinoceros\\packages\\8.0\\Formcraft.Rhino\\1.0.0\\Formcraft.Rhino.rhp"] },
  // owner 27 Oct: renders. The connector is the Blender Lab MCP add-on; the server sends only its own scripts (hub/blender.ts)
  { id: "blender", name: "Blender 5.2", kind: "bridge", exe: "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe", process: "blender.exe",
    tools: ["fmc_blender"], connector: ["Blender Foundation\\Blender\\5.2\\extensions\\user_default\\mcp\\__init__.py"] },
  { id: "powerbi", name: "Power BI Desktop", kind: "gateway", exe: "C:\\Program Files\\Microsoft Power BI Desktop\\bin\\PBIDesktop.exe", process: "PBIDesktop.exe",
    tools: ["fmc_powerbi"], connector: [], planned: "H2" },
];

/** What the registry needs from the PC: files, running processes, and the connector's own state file. */
export interface Probe {
  exists(file: string): boolean;
  running(processName: string): boolean;
  appData: string;
  serverDir: string;
  env: NodeJS.ProcessEnv;
}

export interface AppStatus {
  id: AppId;
  name: string;
  kind: ConnectorKind;
  installed: boolean;
  running: boolean;
  connector: { built: boolean; where: string; note: string };
  on: boolean;
  tools: string[];
}

/** %APPDATA%\Formcraft\apps.json: the apps a person switched off or on ({ "rhino": false }). */
export function settingsFile(appData: string) { return path.join(appData, "Formcraft", "apps.json"); }

export function readSwitches(appData: string): Partial<Record<AppId, boolean>> {
  try {
    const j = JSON.parse(fs.readFileSync(settingsFile(appData), "utf8").replace(/^\uFEFF/, ""));
    return j && typeof j === "object" && j.switches && typeof j.switches === "object" ? j.switches : {};
  } catch {
    return {};
  }
}

export function writeSwitch(appData: string, id: AppId, on: boolean) {
  const file = settingsFile(appData);
  const switches = { ...readSwitches(appData), [id]: on };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ switches, changed: new Date().toISOString() }, null, 2));
}

function exeOf(app: AppDef, env: NodeJS.ProcessEnv) {
  return env[`FMC_APP_${app.id.toUpperCase()}_EXE`] || app.exe;
}

function connectorPath(rel: string, probe: Probe) {
  if (rel.startsWith("<server>")) return path.join(probe.serverDir, rel.slice("<server>\\".length));
  return path.isAbsolute(rel) ? rel : path.join(probe.appData, rel);
}

/**
 * Each app's state. An app is on when a person switched it on, or, by default, when it is installed (Revit always):
 * so nothing changes for a PC until someone switches an app off.
 */
export function appStatuses(probe: Probe, switches: Partial<Record<AppId, boolean>> = readSwitches(probe.appData)): AppStatus[] {
  return APPS.map((a) => {
    const installed = probe.exists(exeOf(a, probe.env));
    const where = a.connector.map((c) => connectorPath(c, probe)).find((p) => probe.exists(p)) ?? "";
    const built = a.connector.length > 0 && where !== "";
    const note = a.connector.length === 0 ? `not built yet (plan step ${a.planned})`
      : built ? (a.kind === "process" ? "built" : "installed in the app") : "not installed: it travels with the next build";
    const on = a.core ? true : switches[a.id] ?? installed;
    return { id: a.id, name: a.name, kind: a.kind, installed, running: installed && probe.running(a.process), connector: { built, where, note }, on, tools: a.tools };
  });
}

/** The tools of apps that are switched off: the server doesn't load them, so their descriptions cost nothing. */
export function toolsOff(statuses: AppStatus[]): Set<string> {
  return new Set(statuses.filter((s) => !s.on).flatMap((s) => s.tools));
}

/** The real PC. Running processes are listed once (tasklist) and cached for this probe. */
export function realProbe(serverDir: string, env: NodeJS.ProcessEnv = process.env): Probe {
  let procs: Set<string> | null = null;
  return {
    exists: (f) => { try { return fs.existsSync(f); } catch { return false; } },
    running: (name) => {
      if (!procs) {
        procs = new Set();
        try {
          const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 10000 });
          for (const line of out.split(/\r?\n/)) { const m = /^"([^"]+)"/.exec(line); if (m) procs.add(m[1].toLowerCase()); }
        } catch { /* not Windows, or tasklist failed: nothing counts as running */ }
      }
      return procs.has(name.toLowerCase());
    },
    appData: env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    serverDir,
    env,
  };
}

/** fmc_selftest's Apps lines: Pass when an installed app's connector is there, Warn when it is missing, Info otherwise. */
export function appLines(statuses: AppStatus[]): Array<{ area: string; check: string; state: "Pass" | "Warn" | "Info"; detail: string }> {
  return statuses.map((a) => {
    const where = `${a.installed ? (a.running ? "running" : "installed") : "not installed"}; ${a.kind} connector ${a.connector.note}; ${a.on ? "on" : "switched off"}`;
    const state = !a.installed || !a.on ? "Info" : a.connector.built ? "Pass" : a.connector.note.startsWith("not built yet") ? "Info" : "Warn";
    return { area: "Apps", check: a.name, state, detail: where };
  });
}
