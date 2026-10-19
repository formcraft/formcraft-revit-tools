import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { ROOM, planRoom } from "../tree/room.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch { /* logging never blocks the work */ }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_ROOM_DESCRIPTION =
  "Formcraft room recipe (docs/PLAN_RECIPE_TREE.md, T1): a room as data (size, walls, door and window on a wall, the " +
    "families in it placed relative to the room, its ceiling, clearances) planned into exact elements, then built in the " +
    "open WIP model. plan (no Revit): every wall, opening, family, the ceiling and the room, positioned in mm, and the " +
    "checks (openings fit their walls, items inside the room, clearances free). build: a dry run lists the plan; with " +
    "dry_run false the Revit command builds it in one transaction (refused on live models) and records what it made in " +
    "<project>\\01_WIP\\_Tree\\rooms\\<node>.json, so a rebuild replaces those elements and nothing else. A recipe tree node " +
    "uses it as make: { tool: fmc_room, args: { action: build, node, room: {…} } }.";

export const FMC_ROOM_SHAPE = {
  action: z.enum(["plan", "build"]),
  node: z.string().optional().default("").describe("build: the tree node (or a name) the elements belong to"),
  room: ROOM,
  project_folder: z.string().optional().default("").describe("build: where the record of what was made is kept"),
  dry_run: z.boolean().optional().default(true),
};
export type FmcRoomArgs = z.infer<z.ZodObject<typeof FMC_ROOM_SHAPE>>;

export async function runFmcRoom(args: FmcRoomArgs) {
  const { config } = loadConfig();
  try {
    const plan = planRoom(args.room);
    if (args.action === "plan") return reply({ room: args.room.name, ops: plan.ops.length, problems: plan.problems, warnings: plan.warnings, plan: plan.ops });
    if (plan.problems.length) return reply({ refused: true, reasons: ["The room's plan has problems: fix the recipe first", ...plan.problems] }, true);
    if (!args.node.trim()) return reply({ refused: true, reasons: ["Name the node the room belongs to (its elements are recorded under it)"] }, true);
    if (!args.project_folder.trim()) return reply({ refused: true, reasons: ["Set the project folder: what the build made is recorded in its 01_WIP"] }, true);
    const record = win.join(expandEnv(args.project_folder.trim()), "01_WIP", "_Tree", "rooms", `${args.node.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    const v = checkWritePath(record, config, { checkName: false });
    if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
    const before: string[] = fs.existsSync(record) ? (JSON.parse(fs.readFileSync(record, "utf8")).made ?? []) : [];
    if (args.dry_run) return reply({ dry_run: true, room: args.room.name, would_build: plan.ops.length, would_replace: before.length, warnings: plan.warnings, plan: plan.ops, next: "Run again with dry_run=false in the WIP model" });
    // the write goes through the live-model lock (sendCommand); the command removes what it made last time, then builds
    const r = await withRevitConnection((c) => c.sendCommand("fmc_room_build", { node: args.node, level: args.room.level, ops: plan.ops, replace: before }, 300000)) as Record<string, any>;
    fs.mkdirSync(win.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify({ node: args.node, room: args.room.name, built_at: new Date().toISOString(), made: r.made ?? [], notes: r.notes ?? [] }, null, 2));
    log(config, "room_build", false, args.node, "built", `${(r.made ?? []).length} elements, ${(r.removed ?? 0)} replaced`);
    return reply({ done: true, node: args.node, made: (r.made ?? []).length, removed: r.removed ?? 0, notes: r.notes ?? [], record });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(config, "room_" + args.action, args.dry_run, args.node || args.room?.name || "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcRoomTool(server: McpServer) {
  server.tool("fmc_room", FMC_ROOM_DESCRIPTION, FMC_ROOM_SHAPE, (args) => runFmcRoom(args));
}
