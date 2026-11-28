import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { label, matchInstances, readInstances, resolvePort, type RevitInstance } from "../fmc/connect.js";
import { RUNNING_BUILD } from "../fmc/buildinfo.js";

const shortCommit = (c: string) => (c || "").trim().replace(/\+.*$/, "").slice(0, 7).toLowerCase();

/** RE-5: the add-in's build against this server's. Unknown on either side is not a mismatch, it is unknown. */
export function buildMatch(addin: string, server: string): boolean | null {
  const a = shortCommit(addin), s = shortCommit(server);
  if (!a || !s || a === "unknown" || s === "unknown") return null;
  return a === s;
}

/** RE-2/RE-9: one Revit as list shows it, with the exact revit value to pass. */
export function instanceRow(i: RevitInstance, server: string, now = Date.now()) {
  const extra = i as RevitInstance & { unattended?: boolean };
  const updatedMs = Date.parse(i.updated || "");
  const match = buildMatch(i.build, server);
  return {
    pid: i.pid, port: i.port, revit: i.revit, user: i.user ?? "", started: i.started, updated: i.updated ?? "",
    updated_age_s: Number.isFinite(updatedMs) ? Math.round((now - updatedMs) / 1000) : null,
    unattended: extra.unattended === true,
    addin_build: i.build ?? "", server_build: server, build_match: match,
    revit_arg: String(i.pid),
    documents: i.documents.map((d) => ({ title: d.title, path: d.path ?? "", active: d.active, family: d.family, workshared: d.workshared, modified: d.modified ?? null })),
    label: label(i),
  };
}

/** RE-8: why list can be empty. */
export const NO_REVIT_NOTE = "No Revit with the AI connection was found. Likely: Revit is closed; the Formcraft add-in did not load; " +
  "AI is off (Formcraft tab, Core: \"AI: off\"); or the instance file under %APPDATA%\\Formcraft\\instances was removed. fmc_recover_revit diagnose says which.";
import { getChosen, setChosen } from "../fmc/target.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_REVIT_DESCRIPTION =
  "The Revits open on this PC, each with its own AI connection (ports 8080-8089), so two projects can be automated at " +
    "once. list: every open Revit (pid, port, Revit version, documents, which is active) and the default target. use: " +
    "make one the default for later calls (a project or document name, a pid or a port); clear: no default. Any tool " +
    "also takes revit (the same kinds of name) for one call. With one Revit open none of this is needed. " +
    "list gives each Revit's revit_arg (its pid: the exact value to pass as revit), user, updated (a stale file shows an old time), unattended, " +
    "addin_build against server_build (build_match), and each document's path and modified. A name matches the exact title first, then a title prefix, " +
    "then a title substring, then a path substring; use says which (matched). use and revit pick a Revit, not a document: a document is chosen with " +
    "each tool's own document argument, and a name open in two Revits needs the pid.";

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
      const matched = /^\d+$/.test(args.target.trim()) ? "pid_or_port" : matchInstances(args.target, instances).rule;
      return reply({ default: args.target, port, matched, revit: i ? label(i) : `port ${port}`, next: "Later calls go here unless they pass revit" });
    }
    if (args.action === "clear") { setChosen(undefined); return reply({ default: null, next: "With two or more Revits open, each call must say which (revit)" }); }
    const rows = instances.map((i) => instanceRow(i, RUNNING_BUILD.commit));
    const mismatched = rows.filter((r) => r.build_match === false);
    return reply({
      default: getChosen() ?? null,
      server_build: RUNNING_BUILD.commit,
      revits: rows,
      note: !instances.length ? NO_REVIT_NOTE : instances.length > 1 ? "Pass revit (revit_arg) to a tool, or call use, to say which Revit a call goes to" : undefined,
      ...(mismatched.length ? { next: `Build mismatch: the add-in in ${mismatched.map((r) => `pid ${r.pid} (${r.addin_build})`).join(", ")} is not this server's build ${RUNNING_BUILD.commit}. Tools added since may be missing on one side.` } : {}),
    });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcRevitTool(server: McpServer) {
  server.tool("fmc_revit", FMC_REVIT_DESCRIPTION, FMC_REVIT_SHAPE, (args) => runFmcRevit(args));
}
