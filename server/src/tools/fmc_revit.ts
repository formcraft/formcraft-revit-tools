import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { label, readInstances, resolvePort } from "../fmc/connect.js";
import { getChosen, setChosen } from "../fmc/target.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_REVIT_DESCRIPTION =
  "The Revits open on this PC, each with its own AI connection (ports 8080-8089), so two projects can be automated at " +
    "once. list: every open Revit (pid, port, Revit version, documents, which is active) and the default target. use: " +
    "make one the default for later calls (a project or document name, a pid or a port); clear: no default. Any tool " +
    "also takes revit (the same kinds of name) for one call. With one Revit open none of this is needed.";

export const FMC_REVIT_SHAPE = {
  action: z.enum(["list", "use", "clear"]),
  target: z.string().optional().default("").describe("use: a project or document name, a pid or a port"),
};

export type FmcRevitArgs = z.infer<z.ZodObject<typeof FMC_REVIT_SHAPE>>;

export async function runFmcRevit(args: FmcRevitArgs) {
  try {
    const instances = readInstances();
    if (args.action === "use") {
      // Owner 26 Oct: a default would be shared by every chat on this server; with two Revits each call names its own
      if (instances.length > 1) return reply({ refused: true, reasons: [`${instances.length} Revits are open and chats share this server: pass revit on each call instead of a default`] }, true);
      if (!args.target.trim()) return reply({ refused: true, reasons: ["use needs a target: a project or document name, a pid or a port"] }, true);
      const port = resolvePort(args.target, instances, { ...process.env, REVIT_PORT: "" }, undefined);
      setChosen(args.target);
      const i = instances.find((x) => x.port === port);
      return reply({ default: args.target, port, revit: i ? label(i) : `port ${port}`, next: "Later calls go here unless they pass revit" });
    }
    if (args.action === "clear") { setChosen(undefined); return reply({ default: null, next: "With two or more Revits open, each call must say which (revit)" }); }
    return reply({
      default: getChosen() ?? null,
      revits: instances.map((i) => ({ pid: i.pid, port: i.port, revit: i.revit, build: i.build, started: i.started,
        documents: i.documents.map((d) => ({ title: d.title, active: d.active, family: d.family, workshared: d.workshared })), label: label(i) })),
      note: instances.length > 1 ? "Pass revit to a tool, or call use, to say which Revit a call goes to" : undefined,
    });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcRevitTool(server: McpServer) {
  server.tool("fmc_revit", FMC_REVIT_DESCRIPTION, FMC_REVIT_SHAPE, (args) => runFmcRevit(args));
}
