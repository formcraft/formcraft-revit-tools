import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { kitParams } from "../fmc/brief.js";
import { electricalChecks, structuralChecks, structuralFields, systemsReport } from "../fmc/systems.js";
import { loadMatrix, matrixGrid, summarize } from "../fmc/mep_matrix.js";
import { CIRCUIT, KitElectrical, circuitsPayload } from "../fmc/circuits.js";
import { electrical } from "../fmc/templatekit.js";
import { readXlsxSheets } from "../fmc/xlsx.js";
import { kitWorkbookPath } from "../fmc/calc/kit.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, false, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_SYSTEMS_DESCRIPTION =
  "Formcraft Engineer › Systems and Structural, read-only. electrical: every board (electrical equipment) with its " +
    "connected and demand load, circuits and the circuit feeding it; devices with a power connector on no circuit; " +
    "circuits on no board. structural: columns and beams without an analytical member, physical and analytical out by " +
    "more than 50 mm, members not joined at nodes, columns with nothing below (no footing, beam, slab, wall or column), kit " +
    "fields left empty (FMC_Member_Mark, " +
    "grades, exposure class), load cases, and analysis results already in the model (FMC_FEA_Utilisation). save: true " +
    "writes the list to <project>\\06_QA\\Systems for the engineer. Nothing in the model is changed: sizing, load cases " +
    "and design stay with the engineer. matrix: the engineering grid (23 systems by 7 capabilities) from " +
    "docs/tracker/mep_matrix.json with its counts by state, per system and per capability; no Revit needed. " +
    "create_circuits (the one write, KISIC 4.4): groups the devices named in each circuit into a power circuit on the " +
    "named board (ElectricalSystem.Create, then the board selected as its panel); when the board has no distribution " +
    "system, the one named is set from the kit's Electrical_Settings (made in the project from the kit's values if " +
    "missing). It never sizes: no rating, wire size, demand factor or load is set (rule 5). A dry run unless dry_run is " +
    "false; the dry run is the real run rolled back (so a board Revit refuses shows in it), and the real run is one Undo, " +
    "all or nothing, behind the live-model lock.";

export const FMC_SYSTEMS_SHAPE = {
  action: z.enum(["electrical", "structural", "matrix", "create_circuits"]),
  kit_folder: z.string().optional().default("").describe("structural: the kit folder, for the field names; create_circuits: for Electrical_Settings (default: beside the guard's specs file)"),
  project_folder: z.string().optional().default("").describe("save: the project folder (06_QA\\Systems)"),
  save: z.boolean().optional().default(false),
  board: z.string().optional().default("").describe("create_circuits: the board (electrical equipment): its unique id, element id or panel name"),
  board_name: z.string().optional().default("").describe("create_circuits: a Panel Name for the board when it has none"),
  distribution_system: z.string().optional().default("")
    .describe("create_circuits: a distribution system from the kit's Electrical_Settings by name (e.g. DS_415-240V_3Ph_4W), set on the board only if it has none"),
  circuits: z.array(CIRCUIT).optional().default([]).describe("create_circuits: one entry per circuit, the devices on it"),
  dry_run: z.boolean().optional().default(true).describe("create_circuits: a dry run (the real run rolled back) unless false"),
};

export type FmcSystemsArgs = z.infer<z.ZodObject<typeof FMC_SYSTEMS_SHAPE>>;

/** The engineering grid (E0): read-only, from the one data file; the counts are computed, never stored. */
export function runMatrix() {
  const { file, matrix, errors } = loadMatrix();
  if (!matrix) return reply({ error: "The engineering grid can't be read", file, errors }, true);
  const summary = summarize(matrix);
  return reply({ file, title: matrix.title, updated: matrix.updated, summary, grid: matrixGrid(matrix),
    next: "Each cell's evidence, feature and step are in the file; a cell moves only with the PR that changes it" });
}

/** The kit's Electrical_Settings (voltages, distribution systems, load classes), or why it can't be read. */
function kitElectrical(kitFolder: string, specsPath: string): { kit: KitElectrical | null; file: string; problem: string } {
  const file = kitWorkbookPath(kitFolder, specsPath);
  try {
    const notes: string[] = [];
    return { kit: electrical(readXlsxSheets(fs.readFileSync(file)).get("Electrical_Settings"), notes), file, problem: "" };
  } catch (e) {
    return { kit: null, file, problem: `${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** create_circuits: checked here, then sent to Revit (the dry run reads, the real run goes through the lock). */
export async function runCreateCircuits(args: FmcSystemsArgs, config: GuardConfig) {
  const { kit, file, problem } = args.distribution_system.trim() ? kitElectrical(args.kit_folder, expandEnv(config.specs_path)) : { kit: null, file: "", problem: "" };
  const { problems, payload } = circuitsPayload({ board: args.board, board_name: args.board_name, distribution_system: args.distribution_system,
    circuits: args.circuits, dry_run: args.dry_run !== false }, kit, problem);
  if (!payload) return reply({ refused: true, reasons: problems }, true);
  const dry = args.dry_run !== false;
  const r = await withRevitConnection((c) => dry ? c.sendRaw("fmc_circuits_create", payload, 300000) : c.sendCommand("fmc_circuits_create", payload, 300000)) as Record<string, any>;
  const found: string[] = Array.isArray(r?.problems) ? r.problems : [];
  const made = Number(r?.made) || 0;
  if (!dry) log(config, "systems_create_circuits", String(r?.board?.name || args.board), found.length ? "rolled back" : "made",
    `${made} circuits${found.length ? `; ${found.join("; ")}` : ""}`);
  const body = { dry_run: dry, kit: file || undefined, ...r, made, problems: found,
    next: found.length ? "Nothing was changed: fix each problem (a board Revit refuses needs its family fixed: Part Type, distribution system), then run again"
      : dry ? "Show this to the person; run again with dry_run=false to make the circuits (one Undo)"
      : "The circuits are made: fmc_mep_facts, fmc_calc run and fmc_diagram scan read them; the engineer sizes (rule 5)" };
  return reply(body, !dry && found.length > 0);
}

export async function runFmcSystems(args: FmcSystemsArgs) {
  if (args.action === "matrix") return runMatrix();
  const { config } = loadConfig();
  if (args.action === "create_circuits") {
    try { return await runCreateCircuits(args, config); }
    catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(config, "systems_create_circuits", args.board, "error", msg);
      return reply({ error: msg }, true);
    }
  }
  try {
    let body: any;
    let extra: string[] = [];
    if (args.action === "electrical") {
      const facts = await withRevitConnection((c) => c.sendRaw("fmc_electrical_facts", {}, 120000));
      const { boards, checks } = electricalChecks(facts);
      extra = boards.map((b) => `- ${b.name}: ${b.connected_va} VA connected, ${b.demand_va} VA demand, ${b.circuits} circuits, fed by ${b.fed_by || "none"}${b.note ? ` (${b.note})` : ""}`);
      body = { model: facts?.model ?? "", boards, checks };
    } else {
      const master = win.join(args.kit_folder.trim(), "03_Master_Data", "FMC_Master_Data.json");
      if (!args.kit_folder.trim() || !fs.existsSync(master)) return reply({ refused: true, reasons: [`Kit master data not found: ${master}`] }, true);
      const { fields, not_in_kit } = structuralFields(kitParams(JSON.parse(fs.readFileSync(master, "utf8").replace(/^﻿/, ""))));
      const facts = await withRevitConnection((c) => c.sendRaw("fmc_structural_facts", { fields }, 300000));
      const checks = structuralChecks(facts);
      const results = (facts?.results ?? []) as any[];
      extra = results.filter((r) => r.utilisation > 1).map((r) => `- ${r.mark || r.id} (${r.type}): utilisation ${r.utilisation}${r.run ? `, run ${r.run}` : ""}`);
      body = { model: facts?.model ?? "", members: facts?.members ?? {}, checks, results, results_count: facts?.results_count ?? 0, not_in_kit };
    }

    if (args.save) {
      const name = `FMC_${args.action === "electrical" ? "Electrical" : "Structural"}_Check_${String(body.model).replace(/\.rvt$/i, "")}_${new Date().toISOString().slice(0, 10)}.md`;
      let file = args.project_folder.trim() ? win.join(args.project_folder.trim(), "06_QA", "Systems", name) : "";
      if (!file || !checkWritePath(file, config, { checkName: false }).ok) file = win.join(expandEnv(config.reports_dir), "Systems", name);
      fs.mkdirSync(win.dirname(file), { recursive: true });
      fs.writeFileSync(file, systemsReport(args.action, body.model, body.checks, extra, new Date()));
      log(config, `systems_${args.action}`, body.model, "saved", file);
      body.saved = file;
    }
    return reply({ ...body, next: "Read-only: the engineer fixes or accepts each item" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, `systems_${args.action}`, "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcSystemsTool(server: McpServer) {
  server.tool("fmc_systems", FMC_SYSTEMS_DESCRIPTION, FMC_SYSTEMS_SHAPE, (args) => runFmcSystems(args));
}
