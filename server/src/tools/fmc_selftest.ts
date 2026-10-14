import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { configPath, expandEnv, loadConfig } from "../fmc/policy.js";
import { notListening, revitPort } from "../fmc/connect.js";
import { AddinFacts, Line, PathProbe, guardPaths, kitLayout, revitLines, summary } from "../fmc/selftest.js";

const probe: PathProbe = {
  exists: (p) => fs.existsSync(p),
  isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  list: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
};

/** This server build's stamp (scripts/build-info.mjs writes build/build-info.json). */
export function serverBuild(): { commit: string; built: string } {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(here, "..", "build-info.json"), "utf8"));
  } catch {
    return { commit: "unknown", built: "" };
  }
}

export const FMC_SELFTEST_DESCRIPTION =
  "Formcraft self-test: run it first in every test run. One read-only call checks, link by link: the AI connection to " +
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
  let facts: AddinFacts | null = null;
  let failure = notListening(revitPort());
  try { facts = (await withRevitConnection((c) => c.sendRaw("fmc_selftest_facts", {}, 15000))) as AddinFacts; }
  catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Revit answered but doesn't know the command: the add-in is older than the self-test.
    if (!msg.includes("nothing in Revit is listening")) failure = `Revit answers, but the add-in in Revit has no self-test (it is older than this server): ${msg}. Install the latest build.`;
  }

  const { config, problem } = loadConfig();
  const lines: Line[] = [
    { area: "Server", check: "Server build", state: server.commit === "unknown" ? "Warn" : "Info", detail: `${server.commit} · built ${server.built}` },
    ...revitLines(facts, server, failure),
    { area: "Guard", check: "fmc_guard.json", state: problem ? "Fail" : "Pass", detail: problem ?? configPath() },
    ...guardPaths(config, probe, (p) => expandEnv(p)),
    ...kitLayout((facts?.kit_folder || args.kit_folder || "").trim(), probe),
  ];
  const s = summary(lines);
  const text = { ...s, lines, server, addin: facts?.addin ?? null, documents: facts?.documents ?? [] };
  return { content: [{ type: "text" as const, text: JSON.stringify(text, null, 2) }], isError: false };
}

export function registerFmcSelftestTool(server: McpServer) {
  server.tool("fmc_selftest", FMC_SELFTEST_DESCRIPTION, FMC_SELFTEST_SHAPE, (args) => runFmcSelftest(args));
}
