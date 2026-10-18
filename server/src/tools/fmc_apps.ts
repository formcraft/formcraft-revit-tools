import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { APPS, AppId, appStatuses, realProbe, writeSwitch } from "../hub/apps.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_APPS_DESCRIPTION =
  "Formcraft engineering hub (docs/PLAN_ENGINEERING_HUB.md): the apps this server connects to (Revit, Navisworks, Robot, " +
    "Rhino, Power BI), each with whether it is installed and running, its connector (an add-in bridge, a process, or a " +
    "gateway to another vendor's MCP server) and whether it is built, and whether it is switched on. list: every app. " +
    "switch: turn an app on or off (app, on); an app's tools load only while it is on, so an unused app costs no tokens. " +
    "Revit is always on. A switch takes effect the next time the MCP server starts (restart the Claude app).";

export const FMC_APPS_SHAPE = {
  action: z.enum(["list", "switch"]),
  app: z.enum(APPS.map((a) => a.id) as [AppId, ...AppId[]]).optional().describe("switch: the app"),
  on: z.boolean().optional().describe("switch: true to switch it on, false to switch it off"),
};

export type FmcAppsArgs = z.infer<z.ZodObject<typeof FMC_APPS_SHAPE>>;

/** The server build folder (build\..), where process connectors such as robot\fmc-robot.exe sit. */
export function serverRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export async function runFmcApps(args: FmcAppsArgs) {
  const probe = realProbe(serverRoot());
  if (args.action === "switch") {
    if (!args.app || args.on === undefined) return reply({ refused: true, reasons: ["switch needs app and on"] }, true);
    const def = APPS.find((a) => a.id === args.app)!;
    if (def.core && !args.on) return reply({ refused: true, reasons: [`${def.name} carries the whole Formcraft toolset: it is always on`] }, true);
    writeSwitch(probe.appData, args.app, args.on);
    return reply({ app: def.name, on: args.on, next: "Restart the Claude app (or the MCP server) for the tools to load or unload" });
  }
  const apps = appStatuses(probe);
  return reply({
    apps: apps.map((a) => ({ app: a.name, id: a.id, connector: `${a.kind}: ${a.connector.note}`, installed: a.installed, running: a.running, on: a.on,
      tools: a.tools })),
    summary: `${apps.filter((a) => a.installed).length} of ${apps.length} installed, ${apps.filter((a) => a.connector.built).length} connectors built, ` +
      `${apps.filter((a) => a.on).length} on`,
  });
}

export function registerFmcAppsTool(server: McpServer) {
  server.tool("fmc_apps", FMC_APPS_DESCRIPTION, FMC_APPS_SHAPE, (args) => runFmcApps(args));
}
