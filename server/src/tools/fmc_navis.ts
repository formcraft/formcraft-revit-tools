import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClashRow, groupClashes, navisCall, processAlive, readState, stateFile } from "../fmc/navis.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_NAVIS_DESCRIPTION =
  "Formcraft and Navisworks Manage (track N, read-only for now). Talks to the Formcraft bridge inside a running Navisworks. " +
    "status: whether Navisworks and the bridge are up. info: the open file and its models. tests: every clash test with its " +
    "results by status (New, Active, Reviewed, Approved, Resolved). results: one test's clashes (filter by status, limit), each " +
    "item with its Revit Element ID, category and source model, plus the clashes grouped by model and category pair. It never " +
    "runs tests, changes statuses or edits a model: fixes go back to the Revit model through a person's yes.";

export const FMC_NAVIS_SHAPE = {
  action: z.enum(["status", "info", "tests", "results"]),
  test: z.string().optional().default("").describe("results: the clash test's name"),
  status: z.string().optional().default("").describe("results: only this status (New, Active, Reviewed, Approved, Resolved)"),
  limit: z.number().int().min(1).max(2000).optional().default(200).describe("results: at most this many clashes"),
};

export type FmcNavisArgs = z.infer<z.ZodObject<typeof FMC_NAVIS_SHAPE>>;

export async function runFmcNavis(args: FmcNavisArgs) {
  const state = readState();
  const up = state !== null && processAlive(state.pid);
  if (args.action === "status") {
    if (!state) return reply({ navisworks: "not found", detail: `No ${stateFile()}: Navisworks isn't running, or the Formcraft bridge isn't installed in it` });
    if (!up) return reply({ navisworks: "closed", detail: `Navisworks (pid ${state.pid}) has closed` });
    try {
      const info = await navisCall(state.port, "navis_info", {}, 15000);
      return reply({ navisworks: "running", port: state.port, pid: state.pid, file: info.file, models: (info.models as unknown[] | undefined)?.length ?? 0, clash_tests: info.clash_tests });
    } catch (e) {
      return reply({ navisworks: "running", port: state.port, pid: state.pid, bridge: e instanceof Error ? e.message : String(e) }, true);
    }
  }
  if (!up) return reply({ refused: true, reasons: ["Navisworks with the Formcraft bridge isn't running (fmc_navis status)"] }, true);
  try {
    if (args.action === "info") return reply(await navisCall(state!.port, "navis_info"));
    if (args.action === "tests") return reply(await navisCall(state!.port, "navis_clash_tests"));
    if (!args.test) return reply({ refused: true, reasons: ["Name the clash test (fmc_navis tests lists them)"] }, true);
    const r = await navisCall(state!.port, "navis_clash_results", { test: args.test, status: args.status, limit: args.limit });
    const rows = (r.results ?? []) as ClashRow[];
    return reply({ ...r, groups: groupClashes(rows), note: "Read-only. Each clash names both Revit elements: a fix is the model author's, through a person's yes" });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, true);
  }
}

export function registerFmcNavisTool(server: McpServer) {
  server.tool("fmc_navis", FMC_NAVIS_DESCRIPTION, FMC_NAVIS_SHAPE, (args) => runFmcNavis(args));
}
