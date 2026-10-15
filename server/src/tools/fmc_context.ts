import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContextDeps, forTask, getItem, overview } from "../fmc/context.js";
import { contextDeps } from "../fmc/mcp_context.js";

export const FMC_CONTEXT_DESCRIPTION =
  "Formcraft context: what the kit and the plugin already hold, before anything is made (read-only, fast, small). " +
    "overview: the kit (path, version, revision), counts per data set (family specs, recipes incl. design-movement profile " +
    "recipes, profile sets, materials, keynotes, shared parameters, rulebooks, templates, staged and released families), " +
    "the open Revit documents, the project manifest, the AI-use rulebook state and which tool does what. for_task: give the " +
    "task in plain words (\"a bi-fold aluminium door\", \"georgian trim profile\", \"terrazzo floor material\"); returns the " +
    "matching family specs (template, category, types, GUIDs), recipes with op counts and value sources, staged and released " +
    "files, library materials with keynote and price status, keynote codes, profile set rows, engines, and the exact next " +
    "tool calls. get: one item in full by ref (spec:<family>, recipe:<family or file>, material:<name>, rulebook:<name>, " +
    "profile:<family>, keynote:<code>, parameter:<name>). Call for_task before creating or proposing any family, material, " +
    "keynote, parameter, sheet, schedule or template.";

export const FMC_CONTEXT_SHAPE = {
  action: z.enum(["overview", "for_task", "get"]),
  task: z.string().optional().default("").describe("for_task: what the person asked for, in plain words"),
  ref: z.string().optional().default("").describe("get: spec:<family>, recipe:<family or file>, material:<name>, rulebook:<name>, profile:<family>, keynote:<code>, parameter:<name>"),
};

export type FmcContextArgs = z.infer<z.ZodObject<typeof FMC_CONTEXT_SHAPE>>;

function reply(body: object, isError = false) {
  // Compact JSON: the answer is for an AI, and every byte is a token.
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export async function runFmcContext(args: FmcContextArgs, deps: ContextDeps = contextDeps()) {
  try {
    if (args.action === "overview") return reply(overview(deps));
    if (args.action === "for_task") {
      if (!args.task.trim()) return reply({ refused: true, reasons: ["for_task needs the task in plain words"] }, true);
      return reply(forTask(args.task.trim(), deps));
    }
    if (!args.ref.trim()) return reply({ refused: true, reasons: ["get needs a ref, e.g. spec:FMC_A_Door_AluSwing"] }, true);
    return reply(getItem(args.ref.trim(), deps));
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcContextTool(server: McpServer) {
  server.tool("fmc_context", FMC_CONTEXT_DESCRIPTION, FMC_CONTEXT_SHAPE, (args) => runFmcContext(args));
}
