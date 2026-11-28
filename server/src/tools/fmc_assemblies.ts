import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../fmc/policy.js";
import { FMC_ASSEMBLIES_SHAPE, FmcAssembliesArgs } from "../fmc/assemblies_shape.js";
import { AssembliesIo, Ctx, applyAction, legendAction, loadSpec, log, newRunId, patAction, readModel } from "../fmc/assemblies_tool.js";
import { planOps } from "../fmc/assemblies_plan.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

export { FMC_ASSEMBLIES_SHAPE, type FmcAssembliesArgs } from "../fmc/assemblies_shape.js";

export const FMC_ASSEMBLIES_DESCRIPTION =
  "Formcraft assemblies (F59): the kit's fill and model patterns, curtain wall types, railing types and their legend, from " +
    "the kit's 03_Master_Data\\FMC_Assemblies.json (or `spec`); every name, size and base type is a design input and nothing " +
    "is defaulted. check: the designs checked (no Revit). pat: the patterns as Revit .pat files (mm) in " +
    "<project>\\01_WIP\\_Assemblies (write roots only; dry run first, then dry_run=false with confirm=true; a changed file's " +
    "old copy moves to _Archive). read: the model's patterns, curtain wall, mullion, panel, railing and top rail types and " +
    "legend views (read only). plan: each design against the model: create, update, unchanged or blocked (a base, mullion, " +
    "panel or top rail type the model lacks is a kit request; nothing is substituted). apply: the plan carried out in one " +
    "Undo (patterns made or changed; curtain wall and railing types duplicated from their base and set); the dry run is " +
    "the real run rolled back, the real run needs confirm=true and goes through the live-model lock. legend: the fmc_legend " +
    "create_view and place calls for the curtain wall types (railings and patterns are listed, not placed). Every reply " +
    "carries a run_id (also in the file log) and the designs' hash.";

export async function runFmcAssemblies(args: FmcAssembliesArgs, io: AssembliesIo = {}) {
  const { config, problem } = io.config ?? loadConfig();
  const run_id = newRunId();
  const send = io.revit ?? ((command: string, payload: object, dry: boolean, ms: number) =>
    withRevitConnection((cl) => dry ? cl.sendRaw(command, payload, ms) : cl.sendCommand(command, payload, ms)));
  let stamps: Record<string, string> = {};
  const reply = (body: object, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify({ run_id, ...stamps, ...body }, null, 2) }], isError });
  const dry = args.dry_run !== false;
  const ctx: Ctx = { args, config, problem: problem ?? "", dry, run_id, send, reply };
  try {
    const got = loadSpec(args, config);
    if ("refused" in got) return reply(got.refused, true);
    stamps = { designs_from: got.from, designs_hash: got.hash };
    const spec = got.spec;
    if (args.action === "check")
      return reply({ ok: true, patterns: spec.patterns.length, curtain_walls: spec.curtain_walls.length, railings: spec.railings.length, legend: spec.legend?.view ?? "none" });
    if (args.action === "pat") return patAction(ctx, spec);
    const read = await readModel(send);
    if (args.action === "read") return reply({ model: read });
    if (args.action === "plan") return reply({ ...planOps(spec, read), next: "apply with dry_run=true shows the add-in's result rolled back" });
    if (args.action === "legend") return legendAction(ctx, spec, read);
    return await applyAction(ctx, spec, read);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (args.action === "apply" || args.action === "pat") log(config, dry, args.project_folder || "model", "error", msg, `assemblies_${args.action}`, run_id);
    return reply({ error: msg }, true);
  }
}

export function registerFmcAssembliesTool(server: McpServer) {
  server.tool("fmc_assemblies", FMC_ASSEMBLIES_DESCRIPTION, FMC_ASSEMBLIES_SHAPE, (args) => runFmcAssemblies(args));
}
