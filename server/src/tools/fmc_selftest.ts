import { appLines, appStatuses, realProbe } from "../hub/apps.js";
import { serverRoot } from "./fmc_apps.js";
import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { configPath, expandEnv, loadConfig } from "../fmc/policy.js";
import { label, notListening, readInstances, revitPort } from "../fmc/connect.js";
import { AddinFacts, Line, PathProbe, aiRulebookLine, generalSwitchLine, rhinoRulebookLine, guardPaths, kitLayout, revitLines, runningBuildLine, summary } from "../fmc/selftest.js";
import { loadRhinoRulebook } from "../hub/rhino.js";
import { loadAiConfig, loadRulebook } from "../fmc/aiuse_io.js";
import { BuildStamp, RUNNING_BUILD, diskBuild } from "../fmc/buildinfo.js";

const probe: PathProbe = {
  exists: (p) => fs.existsSync(p),
  isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  list: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
};

/**
 * The build this server process runs: build/build-info.json as it was when the process started (F-042). The updater
 * can replace the file while the Claude app keeps the old process running, so the file is not re-read here.
 */
export function serverBuild(): BuildStamp {
  return RUNNING_BUILD;
}

export const FMC_SELFTEST_DESCRIPTION =
  "Formcraft self-test: run it first in every test run. One read-only call checks, link by link: the server build this " +
    "process runs against the build installed on disk (a difference means the Claude app must be restarted), the AI connection to " +
    "Revit, the add-in build in Revit against this server's build, every command known to Revit, whether Revit may be " +
    "closed for an install (only new, unchanged documents open), the guard's paths and the kit's layout (FMC_Kit.json, " +
    "rulebooks in 03_Master_Data\\FMC_Rulebook, the _Staging folders, templates). Each line is Pass, Warn, Fail or Info; " +
    "the result is 'Ready to test' or 'Fix first'. Nothing is changed.";

export const FMC_SELFTEST_SHAPE = {
  kit_folder: z.string().optional().describe("Kit folder to check when Revit can't be reached (otherwise the pane's setting)"),
};

export type FmcSelftestArgs = z.infer<z.ZodObject<typeof FMC_SELFTEST_SHAPE>>;

export async function runFmcSelftest(args: FmcSelftestArgs) {
  const server = serverBuild();
  const onDisk = diskBuild();
  let facts: AddinFacts | null = null;
  let failure = notListening(revitPort());
  // Ogala report: right after a restart Revit isn't listening yet; wait for it (up to about 30 s) before saying so
  const ask = () => withRevitConnection((c) => c.sendRaw("fmc_selftest_facts", {}, 15000)) as Promise<AddinFacts>;
  try {
    for (let i = 0; ; i++) {
      try { facts = await ask(); break; }
      catch (e) { if (i >= 5 || !String(e instanceof Error ? e.message : e).includes("nothing in Revit is listening")) throw e; await new Promise((r) => setTimeout(r, 5000)); }
    }
  }
  catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Revit answered but doesn't know the command: the add-in is older than the self-test.
    if (/Revits are open|No open Revit|matches \d+ Revits/.test(msg)) failure = msg;
    else if (!msg.includes("nothing in Revit is listening")) failure = `Revit answers, but the add-in in Revit has no self-test (it is older than this server): ${msg}. Install the latest build.`;
  }

  const { config, problem } = loadConfig();
  const open = readInstances();
  const lines: Line[] = [
    { area: "Revit", check: "Revits open", state: "Info",
      detail: open.length ? open.map(label).join("; ") + (open.length > 1 ? ". Pass revit to say which one a call (and this self-test) goes to" : "") : "None announced (an older add-in, or the AI connection is off)" },
    { area: "Server", check: "Server build", state: server.commit === "unknown" ? "Warn" : "Info", detail: `${server.commit} · built ${server.built} (running, read at startup)` },
    runningBuildLine(server, onDisk),
    ...revitLines(facts, server, failure),
    { area: "Guard", check: "fmc_guard.json", state: problem ? "Fail" : "Pass", detail: problem ?? configPath() },
    ...guardPaths(config, probe, (p) => expandEnv(p)),
    aiRulebookLine(loadRulebook(config), config.rulebooks_dir),
    generalSwitchLine(loadAiConfig(config), loadRulebook(config).book),
    rhinoRulebookLine(loadRhinoRulebook(expandEnv(config.rulebooks_dir))),
    ...kitLayout((facts?.kit_folder || args.kit_folder || "").trim(), probe),
    // the engineering hub: each app, its connector and whether it is on (fmc_apps)
    ...appLines(appStatuses(realProbe(serverRoot()))),
  ];
  const s = summary(lines);
  const text = { ...s, lines, server, server_on_disk: onDisk, addin: facts?.addin ?? null, documents: facts?.documents ?? [] };
  return { content: [{ type: "text" as const, text: JSON.stringify(text, null, 2) }], isError: false };
}

export function registerFmcSelftestTool(server: McpServer) {
  server.tool("fmc_selftest", FMC_SELFTEST_DESCRIPTION, FMC_SELFTEST_SHAPE, (args) => runFmcSelftest(args));
}
