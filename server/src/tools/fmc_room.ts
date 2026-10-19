import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { ROOM, planRoom } from "../tree/room.js";
import { Edit, LiveFacts, Snapshot, findEdits, opKeys, snapshot } from "../tree/drift.js";

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
  "Formcraft room recipe (docs/PLAN_RECIPE_TREE.md, T1, T3): a room as data (size, walls, door and window on a wall, the " +
    "families in it placed relative to the room, its ceiling, clearances) planned into exact elements, then built in the " +
    "open WIP model. plan (no Revit): every wall, opening, family, the ceiling and the room, positioned in mm, and the " +
    "checks (openings fit their walls, items inside the room, clearances free). build: a dry run lists the plan; with " +
    "dry_run false the Revit command builds it in one transaction (refused on live models) and records what it made, each " +
    "element with its key (item:Bed, door@south:…, wall:north) and a snapshot, in <project>\\01_WIP\\_Tree\\rooms\\<node>.json, " +
    "so a rebuild replaces those elements and nothing else. keep: keys a person owns (overrides): never replaced or rebuilt. " +
    "edits (T3, read-only): what people changed by hand since the build (moved, retyped, a parameter, deleted), each " +
    "adoptable into the recipe or kept as an override (fmc_tree adopt). A recipe tree node uses it as make: { tool: " +
    "fmc_room, args: { action: build, room: {…} } }.";

export const FMC_ROOM_SHAPE = {
  action: z.enum(["plan", "build", "edits"]),
  node: z.string().optional().default("").describe("build, edits: the tree node (or a name) the elements belong to"),
  room: ROOM.optional().describe("plan, build: the room"),
  keep: z.array(z.string()).optional().default([]).describe("build: keys of elements a person owns (overrides): left as they are"),
  design_option: z.string().optional().default("").describe("build: the Revit design option to build into (it must be the active one; options, O3); its own record, so the main model's room is never replaced"),
  project_folder: z.string().optional().default("").describe("build, edits: where the record of what was made is kept"),
  dry_run: z.boolean().optional().default(true),
};
export type FmcRoomArgs = z.infer<z.ZodObject<typeof FMC_ROOM_SHAPE>>;

export interface RoomRecord { node: string; room: string; built_at: string; made: string[]; elements?: Snapshot[]; keep?: string[]; notes?: string[] }

export const roomRecordFile = (project: string, node: string) =>
  win.join(expandEnv(project.trim()), "01_WIP", "_Tree", "rooms", `${node.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);

export function readRoomRecord(project: string, node: string): RoomRecord | null {
  const f = roomRecordFile(project, node);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) : null;
}

/** Which room node and recipe key made this element (the identity map: T3), from the build records; null if none. */
export function findRecipeElement(project: string, uid: string): { node: string; key: string } | null {
  if (!project.trim() || !uid) return null;
  const dir = win.join(expandEnv(project.trim()), "01_WIP", "_Tree", "rooms");
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".json"))) {
    try {
      const r = JSON.parse(fs.readFileSync(win.join(dir, f), "utf8").replace(/^﻿/, "")) as RoomRecord;
      const e = (r.elements ?? []).find((x) => x.unique_id === uid);
      if (e) return { node: r.node, key: e.key };
    } catch { /* a broken record is skipped */ }
  }
  return null;
}

/** Revit's facts for these elements now (read-only); a missing one is null (deleted). */
async function liveFacts(uids: string[]): Promise<Map<string, LiveFacts | null>> {
  const r = await withRevitConnection((c) => c.sendRaw("fmc_element_facts", { unique_ids: uids }, 30000)) as { elements?: LiveFacts[] };
  const m = new Map<string, LiveFacts | null>(uids.map((u) => [u, null]));
  for (const e of r?.elements ?? []) if (e.unique_id) m.set(e.unique_id, e);
  return m;
}

/** What people changed by hand in a room node since its build (T3). */
export async function roomEdits(project: string, node: string): Promise<{ record: RoomRecord; edits: Edit[] }> {
  const record = readRoomRecord(project, node);
  if (!record) throw new Error(`No build recorded for ${node} (fmc_room build records it)`);
  if (!record.elements?.length) throw new Error(`${node} was built before elements were recorded with snapshots: build it once more`);
  const live = await liveFacts(record.elements.map((e) => e.unique_id));
  return { record, edits: findEdits(record.elements, live, new Set(record.keep ?? [])) };
}

export async function runFmcRoom(args: FmcRoomArgs) {
  const { config } = loadConfig();
  try {
    if (args.action === "edits") {
      if (!args.node.trim() || !args.project_folder.trim()) return reply({ refused: true, reasons: ["Name the node and the project folder"] }, true);
      const { record, edits } = await roomEdits(args.project_folder, args.node);
      return reply({ node: args.node, built_at: record.built_at, elements: record.elements!.length, kept: record.keep ?? [], edits,
        next: edits.length ? "For each edit, fmc_tree adopt (the recipe takes it) or override (the element stays the person's)" : "No hand edits since the build" });
    }
    if (!args.room) return reply({ refused: true, reasons: ["Give the room"] }, true);
    const plan = planRoom(args.room);
    if (args.action === "plan") return reply({ room: args.room.name, ops: plan.ops.length, problems: plan.problems, warnings: plan.warnings, plan: plan.ops });
    if (plan.problems.length) return reply({ refused: true, reasons: ["The room's plan has problems: fix the recipe first", ...plan.problems] }, true);
    if (!args.node.trim()) return reply({ refused: true, reasons: ["Name the node the room belongs to (its elements are recorded under it)"] }, true);
    if (!args.project_folder.trim()) return reply({ refused: true, reasons: ["Set the project folder: what the build made is recorded in its 01_WIP"] }, true);
    // a design option's build is recorded apart: rebuilding it replaces only what was built into that option
    const recNode = args.design_option.trim() ? `${args.node}@${args.design_option.trim()}` : args.node;
    const record = roomRecordFile(args.project_folder, recNode);
    const v = checkWritePath(record, config, { checkName: false });
    if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
    const before = readRoomRecord(args.project_folder, recNode);
    const keep = new Set(args.keep);
    // a person's elements (overrides) are neither replaced nor rebuilt
    const keys = opKeys(plan.ops);
    const ops = plan.ops.map((o, i) => ({ ...o, key: keys[i] })).filter((o) => !keep.has(o.key));
    const kept = (before?.elements ?? []).filter((e) => keep.has(e.key));
    const replace = before?.elements ? before.elements.filter((e) => !keep.has(e.key)).map((e) => e.unique_id) : (before?.made ?? []);
    if (args.dry_run) return reply({ dry_run: true, room: args.room.name, would_build: ops.length, would_replace: replace.length, kept: kept.map((e) => e.key),
      warnings: plan.warnings, plan: ops, next: "Run again with dry_run=false in the WIP model" });
    // the write goes through the live-model lock (sendCommand); the command removes what it made last time, then builds
    const r = await withRevitConnection((c) => c.sendCommand("fmc_room_build", { node: args.node, level: args.room!.level, ops, replace, design_option: args.design_option.trim() }, 300000)) as Record<string, any>;
    const made: Array<{ unique_id: string; key: string }> = r.elements ?? (r.made ?? []).map((u: string) => ({ unique_id: u, key: "" }));
    // snapshots of what was made, and of the kept elements as they are now, so the next look finds only new edits
    let elements: Snapshot[] = [];
    try {
      const live = await liveFacts([...made.map((m) => m.unique_id), ...kept.map((e) => e.unique_id)]);
      elements = [...made, ...kept].filter((m) => live.get(m.unique_id)).map((m) => snapshot(m.key, { ...live.get(m.unique_id)!, unique_id: m.unique_id }));
    } catch { elements = made.map((m) => ({ key: m.key, unique_id: m.unique_id })); }
    const rec: RoomRecord = { node: args.node, room: args.room.name, built_at: new Date().toISOString(),
      made: [...made.map((m) => m.unique_id), ...kept.map((e) => e.unique_id)], elements, keep: [...keep], notes: r.notes ?? [] };
    fs.mkdirSync(win.dirname(record), { recursive: true });
    fs.writeFileSync(record, JSON.stringify(rec, null, 2));
    log(config, "room_build", false, args.node, "built", `${made.length} elements, ${(r.removed ?? 0)} replaced, ${kept.length} kept`);
    return reply({ done: true, node: args.node, made: made.length, removed: r.removed ?? 0, kept: kept.length, notes: r.notes ?? [], record });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(config, "room_" + args.action, args.dry_run, args.node || args.room?.name || "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcRoomTool(server: McpServer) {
  server.tool("fmc_room", FMC_ROOM_DESCRIPTION, FMC_ROOM_SHAPE, (args) => runFmcRoom(args));
}
