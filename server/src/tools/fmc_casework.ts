import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../fmc/policy.js";
import { newRunId, StandardsRevision } from "../fmc/casework_run.js";
import { saveRun } from "../fmc/casework_store.js";
import { FMC_CASEWORK_SHAPE, FmcCaseworkArgs } from "../fmc/casework_shape.js";
import { CaseworkIo, Ctx, log, prepare, replyOf, resolveInputs } from "../fmc/casework_tool.js";
import { checkAction, engineAction, packAction } from "../fmc/casework_actions.js";
import { placeAction, roomAction, shopAction } from "../fmc/casework_revit.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

// The tool is split for the hub's 300-line rule: schema (fmc/casework_shape.ts), plumbing (fmc/casework_tool.ts),
// engine and pack (fmc/casework_actions.ts), Revit actions (fmc/casework_revit.ts).
export { FMC_CASEWORK_SHAPE, type FmcCaseworkArgs } from "../fmc/casework_shape.js";
export { kitStandardsFile, type CaseworkIo } from "../fmc/casework_tool.js";

export const FMC_CASEWORK_DESCRIPTION =
  "Formcraft Casework Assistant engine (Engineer › Casework, +Model). Pure computation, no Revit. From a run (walls with " +
    "lengths, window and door openings, a fixed sink and appliance gaps, the corner unit, a tall unit at one end, and the " +
    "unit widths to fill with) or a unit list: units (greedy fill), parts (panels per unit with board and edge banding), " +
    "nest (guillotine nesting per board on the standard sheet with the kerf), cutlist (rows per assembly mark), hardware, " +
    "summary (counts, sheets and yield, edge metres, worktop, cost from the kit's material library: missing prices show " +
    "\"price needed\", never a guess, and boards missing from the library come back as kit change requests). pack writes " +
    "the cut list, nesting, hardware and BoQ as CSV into <project>\\01_WIP\\_Casework (write roots only; dry run first, " +
    "then dry_run=false), and the workshop pack PDF beside them (summary, unit elevations, cut list per assembly mark, " +
    "nesting drawings per sheet, hardware, cost with its sources). In Revit (CW2): room reads a room's walls, doors, " +
    "windows and services points into a run's walls with their place in the model (read only); check flags the services " +
    "against the layout (waste and water at the sink, gas at the cooker, sockets behind tall units or over the cooker, " +
    "window sills) and never decides (rule 5); place puts the units in the model as the kit's FMC_I_Casework_* family " +
    "types with FMC_Assembly_Mark, FMC_Carcass_Spec and FMC_Worktop_Spec, in one Undo (the dry run is the real run rolled " +
    "back; the real run is behind the live-model lock); shop_drawings makes a front elevation per placed unit on the " +
    "register's A3 joinery sheets, places the I11_Joinery_Cutlist schedule and exports the sheets as PDF beside the pack. " +
    "Workshop standards (sizes, boards, construction and hardware rules) are design inputs: from the " +
    "kit's 03_Master_Data\\FMC_Casework_Standards.json when it exists, else from `standards`; nothing is defaulted. " +
    "Families, types, parameters and sheets come from the kit's register files; what the kit lacks is a kit change " +
    "request. Every reply carries a run_id (also in the file log row) and, once the standards are read, standards_revision " +
    "(the kit file's label and hash, the hash of the standards used, and whether the call changed them). shop_drawings " +
    "exports the PDF under a temporary name and swaps it in only when Revit reports the export done: then the old PDF moves " +
    "to _Archive; if the export fails the current PDF is left exactly as it was. It never decides gas, electrical or structural items.";

export async function runFmcCasework(args: FmcCaseworkArgs, io: CaseworkIo = {}) {
  const { config, problem } = io.config ?? loadConfig();
  /** One id per call: in every reply and every log row it writes */
  const run_id = newRunId();
  let stamps: { standards_revision?: StandardsRevision; units_hash?: string } = {};
  const send = io.revit ?? ((command: string, payload: object, dry: boolean, ms: number) =>
    withRevitConnection((cl) => dry ? cl.sendRaw(command, payload, ms) : cl.sendCommand(command, payload, ms)));
  const reply = (body: object, isError = false) => replyOf({ run_id, ...stamps, ...ctx.inputsFrom, ...body }, isError);
  const dry = args.dry_run !== false;
  const ctx: Ctx & { inputsFrom?: { inputs_from: string } } = { args, config, problem, dry, run_id, send, reply, store: io.store,
    entry: { id: run_id, at: new Date().toISOString(), action: args.action } };
  try {
    const resolved = resolveInputs(args, io.store);
    if ("refused" in resolved) return reply(resolved.refused, true);
    ctx.args = args = resolved.args;
    ctx.saved = resolved.saved;
    if (resolved.saved) ctx.inputsFrom = { inputs_from: resolved.saved.id };
    ctx.entry = { ...ctx.entry, run: args.run, units: args.units, standards: args.standards };
    // room reading needs no standards: it gives the run's walls, which the person completes
    if (args.action === "room") return await roomAction(ctx);
    const prep = prepare(args, config);
    if ("refused" in prep) return reply(prep.refused, true);
    const p = prep.ok;
    stamps = { standards_revision: p.revision, units_hash: p.units_hash };
    switch (args.action) {
      case "check": return await checkAction(ctx, p);
      case "place": return await placeAction(ctx, p);
      case "shop_drawings": return await shopAction(ctx, p);
      case "pack": return packAction(ctx, p);
      default: return engineAction(ctx, p);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (args.action === "pack") log(config, dry, args.project_folder, "error", msg, "casework_pack", run_id);
    else if (args.action === "place" || args.action === "shop_drawings") log(config, dry, args.level || args.project_folder, "error", msg, `casework_${args.action}`, run_id);
    return reply({ error: msg }, true);
  } finally {
    // the inputs (and a room read) under this call's run id, for the next call's run_id
    const e = ctx.entry;
    if (e.run || e.units || e.room_read) saveRun(e, io.store);
  }
}

export function registerFmcCaseworkTool(server: McpServer) {
  server.tool("fmc_casework", FMC_CASEWORK_DESCRIPTION, FMC_CASEWORK_SHAPE, (args) => runFmcCasework(args));
}
