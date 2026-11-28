import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { buildOwnersReport, normalizeCurrency, normalizeOwnersFacts, opTargets } from "../fmc/workshareowners.js";

/** The only two commands this tool sends to Revit. Both only read. */
export const OWNERS_COMMANDS = ["fmc_workshare_facts", "fmc_elem_currency"] as const;
export const MAX_ELEMENT_IDS = 500;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_WORKSHARE_OWNERS_DESCRIPTION =
  "Formcraft workshare owners, read-only. Who owns or borrows what in the open workshared model: every user workset with its owner " +
  "and whether you can edit it (yours, someone else's, or nobody's so an edit borrows), the owners with their worksets, and for the " +
  "element ids you name, whether you can edit each one (checked out by another user, not current with central, in a workset owned by " +
  "someone else, or free to borrow) with who holds it. planned_ops takes the operations you are about to run (tool, action, params or " +
  "element_ids, workset names) and says which would be blocked or partly blocked by someone else's ownership, and what a person " +
  "should do about it. This tool never relinquishes, synchronises, saves or checks anything out and never grants an editing request: " +
  "a person does those in Revit. It sends only fmc_workshare_facts and fmc_elem_currency, which read. Ownership is read one element at " +
  "a time, so there is no model-wide list of borrowed elements; the reply's gaps say what is not known.";

export const FMC_WORKSHARE_OWNERS_SHAPE = {
  element_ids: z.array(z.union([z.string(), z.number()])).optional().default([]).describe(`Element ids to check (at most ${MAX_ELEMENT_IDS})`),
  planned_ops: z.array(z.record(z.unknown())).optional().default([])
    .describe("Operations you plan to run, each {label?, tool?, action?, params?, element_ids?, worksets?}. Ids and workset names are read from params"),
  element_worksets: z.record(z.string()).optional().default({}).describe("Element id to workset name, when you know it (fmc_elem_currency does not return worksets)"),
};

export type FmcWorkshareOwnersArgs = z.infer<z.ZodObject<typeof FMC_WORKSHARE_OWNERS_SHAPE>>;

export interface OwnersDeps {
  /** Sends one read command to Revit. The default uses the open connection. */
  send?: (command: (typeof OWNERS_COMMANDS)[number], params: Record<string, unknown>) => Promise<unknown>;
}

export async function runFmcWorkshareOwners(args: FmcWorkshareOwnersArgs, deps: OwnersDeps = {}) {
  const send = deps.send ?? ((command, params) => withRevitConnection((c) => c.sendRaw(command, params, 60000)));
  try {
    const facts = normalizeOwnersFacts(await send("fmc_workshare_facts", {}));
    if (!facts) return reply({ refused: true, reasons: ["Revit gave no workshare facts: is a project model open?"] }, true);

    // Ids to check: the ones named, and those the planned ops name (same rule the edit tools use).
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const id of [...args.element_ids.map(String), ...args.planned_ops.flatMap((op) => opTargets(op).ids)]) {
      if (id.trim() && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    const checked = ids.slice(0, MAX_ELEMENT_IDS);
    let rows: ReturnType<typeof normalizeCurrency> = null;
    let currencyError = "";
    if (facts.workshared && checked.length) {
      try { rows = normalizeCurrency(await send("fmc_elem_currency", { ids: checked })); }
      catch (error) { currencyError = error instanceof Error ? error.message : String(error); }
    }
    const report = buildOwnersReport(facts, rows, checked, args.planned_ops, args.element_worksets, { currencyError, truncated: ids.length - checked.length });
    return reply(report);
  } catch (error) {
    return reply({ refused: true, reasons: [error instanceof Error ? error.message : String(error)] }, true);
  }
}

export function registerFmcWorkshareOwnersTool(server: McpServer) {
  server.tool("fmc_workshare_owners", FMC_WORKSHARE_OWNERS_DESCRIPTION, FMC_WORKSHARE_OWNERS_SHAPE, (args) => runFmcWorkshareOwners(args as FmcWorkshareOwnersArgs));
}
