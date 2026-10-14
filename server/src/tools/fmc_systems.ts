import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { kitParams } from "../fmc/brief.js";
import { electricalChecks, structuralChecks, structuralFields, systemsReport } from "../fmc/systems.js";

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
    "more than 50 mm, members not joined at nodes, columns with nothing below, kit fields left empty (FMC_Member_Mark, " +
    "grades, exposure class), load cases, and analysis results already in the model (FMC_FEA_Utilisation). save: true " +
    "writes the list to <project>\\06_QA\\Systems for the engineer. Nothing in the model is changed: sizing, load cases " +
    "and design stay with the engineer.";

export const FMC_SYSTEMS_SHAPE = {
  action: z.enum(["electrical", "structural"]),
  kit_folder: z.string().optional().default("").describe("structural: the kit folder, for the field names"),
  project_folder: z.string().optional().default("").describe("save: the project folder (06_QA\\Systems)"),
  save: z.boolean().optional().default(false),
};

export type FmcSystemsArgs = z.infer<z.ZodObject<typeof FMC_SYSTEMS_SHAPE>>;

export async function runFmcSystems(args: FmcSystemsArgs) {
  const { config } = loadConfig();
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
