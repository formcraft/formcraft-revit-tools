import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContextDeps, SEARCH_KINDS, forTask, getItem, overview, search } from "../fmc/context.js";
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
    "profile:<family>, keynote:<code>, parameter:<name>); list:<kind> gives every name of a kind (spec, recipe, material, " +
    "keynote, parameter, rulebook, engine, tool); a ref that is not found is an error. search: free text across specs, recipes, " +
    "materials, keynotes, shared parameters and rulebook rules (every word must appear). Leave out action: task means for_task, " +
    "ref means get, query means search, none means overview. next_calls are the next steps as {tool, args}; an engine's " +
    "ai_mode says whether AI mode allows its real step, waits for approval or refuses it. Call for_task before creating or " +
    "proposing any family, material, keynote, parameter, sheet, schedule or template.";

export const FMC_CONTEXT_SHAPE = {
  action: z.enum(["overview", "for_task", "get", "search"]).optional()
    .describe("Optional: task means for_task, ref means get, query means search, none means overview"),
  task: z.string().optional().default("").describe("for_task: what the person asked for, in plain words"),
  ref: z.string().optional().default("").describe("get: spec:<family>, recipe:<family or file>, material:<name>, rulebook:<name>, profile:<family>, keynote:<code>, parameter:<name>, list:<kind>"),
  query: z.string().optional().default("").describe("search: words that must all appear, e.g. \"sill\" or \"fire door\""),
  kinds: z.array(z.enum(SEARCH_KINDS)).optional().describe("search: only these data sets (default all)"),
  limit: z.number().int().min(1).max(20).optional().describe("for_task: how many family specs (default 3 for a profile, 4 with no intent, else 8)"),
};

export type FmcContextArgs = z.infer<z.ZodObject<typeof FMC_CONTEXT_SHAPE>>;

/** The action asked for, or the one the arguments imply (tool-research fmc_context item 11). */
export function contextAction(args: Partial<FmcContextArgs>): "overview" | "for_task" | "get" | "search" {
  if (args.action) return args.action;
  if ((args.ref ?? "").trim()) return "get";
  if ((args.task ?? "").trim()) return "for_task";
  if ((args.query ?? "").trim()) return "search";
  return "overview";
}

function reply(body: object, isError = false) {
  // Compact JSON: the answer is for an AI, and every byte is a token.
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export async function runFmcContext(args: Partial<FmcContextArgs>, deps: ContextDeps = contextDeps()) {
  const task = (args.task ?? "").trim(), ref = (args.ref ?? "").trim(), query = (args.query ?? "").trim();
  try {
    const action = contextAction(args);
    if (action === "overview") return reply(overview(deps));
    if (action === "for_task") {
      if (!task) return reply({ refused: true, reasons: ["for_task needs the task in plain words"] }, true);
      return reply(forTask(task, deps, { limit: args.limit }));
    }
    if (action === "search") {
      if (!query) return reply({ refused: true, reasons: ["search needs a query, e.g. \"sill\""] }, true);
      return reply(search(query, deps, args.kinds ?? SEARCH_KINDS));
    }
    if (!ref) return reply({ refused: true, reasons: ["get needs a ref, e.g. spec:FMC_A_Door_AluSwing"] }, true);
    const item = getItem(ref, deps);
    // A miss is an error, so an agent that branches on isError does not read it as found (gap 6).
    return reply(item, item.found === false);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcContextTool(server: McpServer) {
  server.tool("fmc_context", FMC_CONTEXT_DESCRIPTION, FMC_CONTEXT_SHAPE, (args) => runFmcContext(args));
}
