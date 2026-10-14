import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { kitParams } from "../fmc/brief.js";
import { baselineOf, boq, kitCodes, statusLegend } from "../fmc/build.js";

const win = path.win32;
const CODE = "FMC_Keynote_Code", STATUS = "FMC_Construction_Status", PACKAGE = "FMC_Trade_Package";

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

/** The baseline lives with the project (01_WIP\_Build) where the guard allows, otherwise in the reports folder. */
function baselineFile(cfg: GuardConfig, projectFolder: string, model: string): string {
  const name = `FMC_Quantities_Baseline_${model.replace(/\.rvt$/i, "").replace(/[^\w.-]+/g, "_")}.json`;
  const inProject = projectFolder.trim() ? win.join(projectFolder.trim(), "01_WIP", "_Build", name) : "";
  if (inProject && checkWritePath(inProject, cfg, { checkName: false }).ok) return inProject;
  return win.join(expandEnv(cfg.reports_dir), "Build", name);
}

export const FMC_BUILD_DESCRIPTION =
  "Formcraft Build, read-only on the model. quantities: every element in the kit's categories summed by its type's " +
    "FMC_Keynote_Code and joined to the kit's codes (description, unit, bill group, trade package); the quantity follows " +
    "the code's unit (m2 area, m3 volume, m length, nr count), other units are left for the QS. Lists elements with no " +
    "code by category, codes the kit doesn't have, progress counts by FMC_Construction_Status and counts by " +
    "FMC_Trade_Package, and flags quantities that moved since the baseline. baseline: saves the current quantities as " +
    "the baseline (the plugin's own file). Rates are never returned.";

export const FMC_BUILD_SHAPE = {
  action: z.enum(["quantities", "baseline"]),
  kit_folder: z.string().describe("The Formcraft kit folder"),
  project_folder: z.string().optional().default("").describe("Where the baseline is kept (01_WIP\\_Build)"),
};

export type FmcBuildArgs = z.infer<z.ZodObject<typeof FMC_BUILD_SHAPE>>;

export async function runFmcBuild(args: FmcBuildArgs) {
  const { config } = loadConfig();
  try {
    const master = win.join(args.kit_folder.trim(), "03_Master_Data", "FMC_Master_Data.json");
    if (!args.kit_folder.trim() || !fs.existsSync(master)) return reply({ refused: true, reasons: [`Kit master data not found: ${master}`] }, true);
    const data = JSON.parse(fs.readFileSync(master, "utf8").replace(/^﻿/, ""));
    const params = kitParams(data);
    const missing = [CODE, STATUS, PACKAGE].filter((p) => !params[p]);
    if (missing.length) return reply({ refused: true, reasons: [`The kit has no ${missing.join(", ")}: Build reads them from the kit`] }, true);
    const categories = [...new Set([...params[CODE].categories, ...params[STATUS].categories])];
    const facts = await withRevitConnection((c) => c.sendRaw("fmc_build_facts", { code_param: CODE, status_param: STATUS, package_param: PACKAGE, categories }, 300000));
    const model = String(facts?.model ?? "");
    const file = baselineFile(config, args.project_folder, model);
    let baseline: { saved: string; quantities: Record<string, number | null> } | null = null;
    try { baseline = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* no baseline yet */ }
    const result = boq(facts, kitCodes(data), baseline?.quantities ?? null);

    if (args.action === "baseline") {
      fs.mkdirSync(win.dirname(file), { recursive: true });
      const saved = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify({ model, saved, quantities: baselineOf(result.items) }, null, 2));
      log(config, "build_baseline", model, "saved", `${result.items.length} items · ${file}`);
      return reply({ model, baseline: file, saved, items: result.items.length, next: "Later measures flag every quantity that moves from this baseline" });
    }

    return reply({
      model, elements: facts?.elements ?? 0, params_in_model: facts?.params_in_model ?? {},
      baseline: baseline ? { file, saved: baseline.saved } : null,
      bills: result.bills, items: result.items, measured: result.measured, unmeasured: result.unmeasured, changed: result.changed,
      unmapped: result.unmapped, unknown_codes: result.unknown,
      progress: statusLegend(facts?.status ?? {}), packages: Object.entries(facts?.package ?? {}).map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value)),
      rates: "Not shown: rates are the QS's, behind the rates permission",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "build_" + args.action, "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcBuildTool(server: McpServer) {
  server.tool("fmc_build", FMC_BUILD_DESCRIPTION, FMC_BUILD_SHAPE, (args) => runFmcBuild(args));
}
