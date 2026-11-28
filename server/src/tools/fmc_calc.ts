import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { CALC_IDS, CalcResult, EngineerInputs, Facts, kitRequests, listCalcs, runCalcs } from "../fmc/calc/index.js";
import { Tabs, kitWorkbookPath, readKitTabs } from "../fmc/calc/kit.js";
import { DRAFT_HEADER, sheetCsv, sheetJson, sheetMarkdown, sheetPlan } from "../fmc/calc/sheet.js";
import { BOARD_CALCS, BoardsRead, confirmProblem, heldIds, holdForBoards, sheetConfirmToken } from "../fmc/calc/boards.js";

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

export const FMC_CALC_DESCRIPTION =
  "Formcraft MEP calculations from the kit (E1), read-only on the model. The kit's calculation tabs (FMC_Revit_Kit.xlsx: " +
    "Calculations, Electrical_Settings, Calc_E_MaxDemand, Calc_E_VoltDrop, Calc_P_Water, Calc_P_Drainage, " +
    "Calc_FP_Extinguishers) ported to code: CA-E-01 maximum demand per board and building, CA-E-02 voltage drop per " +
    "circuit, CA-P-01 water demand and storage, CA-P-02 drainage flow Qww = K sqrt(sum DU), CA-FP-01 extinguishers, " +
    "CA-FP-02 hose reel coverage, CA-LP-02 earth resistance. Facts come from Revit (fmc_mep_facts, fmc_electrical_facts). " +
    "Every value is tagged kit:<tab>!<cell>, model:<id>, engineer or TBC; a value the kit lacks is TBC, never invented " +
    "(demand factors only from the kit). list: the calcs, their inputs, what the kit gives and lacks, and the calcs the " +
    "kit leaves to another tool. run: results (summary or full). sheet: a calculation sheet per calc (Markdown, CSV, " +
    "JSON) in <project>\\01_WIP\\<Role>\\_Calcs, dry run first; the dry run returns a confirm token and the write needs " +
    "dry_run false with that confirm token (a changed plan needs a new dry run). When the boards (fmc_electrical_facts) are " +
    "not read, CA-E-01 is held as TBC with the reason and its sheet is refused. Every sheet is a draft the engineer checks and signs.";

export const FMC_CALC_SHAPE = {
  action: z.enum(["list", "run", "sheet"]),
  calcs: z.array(z.string()).optional().default([]).describe(`run/sheet: calc ids (${CALC_IDS.join(", ")}); empty runs all`),
  project_folder: z.string().optional().default("").describe("sheet: the project folder; sheets go in its 01_WIP\\<Role>\\_Calcs"),
  kit_folder: z.string().optional().default("").describe("The kit folder (03_Master_Data\\FMC_Revit_Kit.xlsx); by default beside the guard's specs file"),
  inputs: z.object({
    mv_a_m: z.record(z.number()).optional().describe("CA-E-02: mV/A/m by cable size mm2, e.g. {\"2.5\": 18}, for the installation method chosen"),
    hose_throw_m: z.number().optional().describe("CA-FP-02: hose reel throw in m"),
    earth_target_ohm: z.number().optional().describe("CA-LP-02: design earth resistance target in ohm"),
    single_phase_units: z.number().int().optional().describe("CA-E-01: single-phase units to share over L1-L3 (from the brief)"),
  }).optional().default({}).describe("Values the engineer gives where the kit has none; each is tagged engineer on the sheet"),
  facts_file: z.string().optional().default("").describe("run/sheet: read the facts from this JSON ({ mep, boards }) instead of Revit"),
  detail: z.enum(["summary", "full"]).optional().default("summary").describe("run: summary (totals, failing rows and TBCs) or full (every row)"),
  dry_run: z.boolean().optional().default(true).describe("sheet: true (default) shows the files it would write"),
  confirm: z.string().optional().default("").describe("sheet with dry_run false: the confirm token the dry run returned, after the person said yes"),
};

export type FmcCalcArgs = z.infer<z.ZodObject<typeof FMC_CALC_SHAPE>>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Facts from a file, or from Revit: fmc_mep_facts (read-only) and the boards from fmc_electrical_facts. */
export interface CalcIo {
  mep?: () => Promise<unknown>;
  boards?: () => Promise<unknown>;
}

/**
 * Facts from a file, or from Revit. boards_read says whether the boards were read: a failed fmc_electrical_facts, a
 * reply without a boards list, or a facts file without a boards key is not read (the board calcs are then held as TBC).
 */
export async function readFacts(args: Pick<FmcCalcArgs, "facts_file">, io: CalcIo = {}): Promise<{ facts: Facts; notes: string[]; boards: BoardsRead }> {
  if (args.facts_file.trim()) {
    const j = JSON.parse(fs.readFileSync(args.facts_file.trim(), "utf8").replace(/^﻿/, ""));
    const has = Array.isArray(j.boards);
    return {
      facts: { mep: j.mep ?? {}, boards: has ? j.boards : [] }, notes: [`Facts from ${args.facts_file.trim()}`],
      boards: has ? { read: true, reason: "" } : { read: false, reason: `the facts file ${args.facts_file.trim()} has no boards list` },
    };
  }
  const mep = await (io.mep ? io.mep() : withRevitConnection((c) => c.sendCommand("fmc_mep_facts", {}, 300000)));
  const notes: string[] = [];
  let boards: Facts["boards"] = [];
  let read: BoardsRead = { read: true, reason: "" };
  try {
    const got = (await (io.boards ? io.boards() : withRevitConnection((c) => c.sendRaw("fmc_electrical_facts", {}, 120000)))) as any;
    if (Array.isArray(got?.boards)) boards = got.boards;
    else read = { read: false, reason: `fmc_electrical_facts replied without a boards list${got?.error ? ` (${String(got.error)})` : ""}` };
  } catch (e) {
    read = { read: false, reason: `fmc_electrical_facts failed: ${errText(e)}` };
  }
  if (!read.read) notes.push(`Boards not read: ${read.reason}. ${BOARD_CALCS.join(", ")} held as TBC.`);
  return { facts: { mep: (mep ?? {}) as Facts["mep"], boards }, notes, boards: read };
}

function summary(r: CalcResult) {
  return {
    id: r.id, title: r.title, result: r.result, rows: r.rows.length,
    failing: r.rows.filter((x) => x.check?.result === "fail").map((x) => x.item).slice(0, 25),
    totals: r.totals, tbc: r.tbc,
  };
}

export async function runFmcCalc(args: FmcCalcArgs, io: CalcIo = {}) {
  const { config } = loadConfig();
  const kitFile = kitWorkbookPath(args.kit_folder, expandEnv(config.specs_path));
  let tabs: Tabs;
  try { tabs = readKitTabs(kitFile); }
  catch (e) { return reply({ refused: true, reasons: [`Kit workbook not readable: ${kitFile} (${errText(e)})`] }, true); }

  if (args.action === "list") {
    const { calcs, elsewhere } = listCalcs(tabs);
    return reply({ kit: kitFile, calcs, elsewhere, next: "run the calcs (fmc_calc run), then sheet writes them for the engineer to check and sign" });
  }

  const unknownIds = args.calcs.map((c) => c.trim().toUpperCase()).filter((c) => !CALC_IDS.includes(c));
  if (unknownIds.length) return reply({ refused: true, reasons: [`Not a calc here: ${unknownIds.join(", ")} (fmc_calc list shows them)`] }, true);
  try {
    const { facts, notes, boards } = await readFacts(args, io);
    const eng = args.inputs as EngineerInputs;
    const results = holdForBoards(runCalcs(args.calcs, facts, tabs, eng).results, boards);
    const held = heldIds(results);
    const model = String(facts.mep.model ?? "");
    const requests = kitRequests(results);

    if (args.action === "run") {
      log(config, "calc_run", true, model, "done", results.map((r) => `${r.id} ${r.result}`).join("; "));
      return reply({
        model, kit: kitFile, header: DRAFT_HEADER, counts: facts.mep.counts ?? {}, notes,
        boards_read: boards.read, held_for_boards: held.length ? held : undefined,
        results: args.detail === "full" ? results : results.map(summary),
        kit_change_requests: requests,
        next: "sheet writes each calc to 01_WIP\\<Role>\\_Calcs for the engineer; TBC items need the engineer or a kit change",
      });
    }

    // sheet: a board calc held for missing boards is never written as a sheet
    if (held.length) {
      return reply({ refused: true, code: "FMC-CALC-BOARDS-UNREAD", boards_read: false, held_for_boards: held,
        reasons: [`Boards not read: ${boards.reason}. No sheet is written for ${held.join(", ")} until they are read.`],
        next: `Retry when fmc_electrical_facts answers, or leave ${held.join(", ")} out of calcs.` }, true);
    }
    const date = new Date().toISOString().slice(0, 10);
    const meta = { model, kit: kitFile, date, project: args.project_folder.trim() };
    const plans = results.map((r) => ({ r, plan: sheetPlan(args.project_folder, r, date, config, (p) => fs.existsSync(p)) }));
    const refused = plans.filter((p) => !p.plan.ok);
    if (refused.length) return reply({ refused: true, reasons: [...new Set(refused.flatMap((p) => p.plan.reasons))] }, true);
    const files = plans.map(({ r, plan }) => ({ calc: r.id, result: r.result, tbc: r.tbc.length, ...plan.files }));
    const token = sheetConfirmToken(files, model, date);
    if (args.dry_run) {
      log(config, "calc_sheet", true, args.project_folder, "planned", files.map((f) => f.md).join("; "));
      return reply({ dry_run: true, model, header: DRAFT_HEADER, files, kit_change_requests: requests, confirm_token: token,
        next: `Show the person these files. When they say yes, call sheet with dry_run false and confirm "${token}".` });
    }
    const problem = confirmProblem(args.confirm, token);
    if (problem) return reply({ refused: true, code: "FMC-CALC-CONFIRM", reasons: [problem], next: "Run sheet with dry_run true, show the files, then confirm its token." }, true);
    const results_by_calc: Array<{ calc: string; status: "written" | "failed"; md: string; error?: string }> = [];
    for (const { r, plan } of plans) {
      try {
        fs.mkdirSync(win.dirname(plan.files.md), { recursive: true });
        fs.writeFileSync(plan.files.md, sheetMarkdown(r, meta));
        fs.writeFileSync(plan.files.csv, "﻿" + sheetCsv(r));
        fs.writeFileSync(plan.files.json, sheetJson(r, meta));
        log(config, "calc_sheet", false, plan.files.md, "written", `${r.id} ${r.result}, ${r.tbc.length} TBC`);
        results_by_calc.push({ calc: r.id, status: "written", md: plan.files.md });
      } catch (e) {
        log(config, "calc_sheet", false, plan.files.md, "error", errText(e));
        results_by_calc.push({ calc: r.id, status: "failed", md: plan.files.md, error: errText(e) });
      }
    }
    const failedSheets = results_by_calc.filter((row) => row.status === "failed").length;
    return reply({ dry_run: false, model, header: DRAFT_HEADER, written: files.filter((f) => results_by_calc.some((row) => row.calc === f.calc && row.status === "written")),
      results: results_by_calc, counts: { planned: plans.length, written: plans.length - failedSheets, failed: failedSheets }, kit_change_requests: requests,
      next: "The engineer checks and signs each sheet; Formcraft does not size or sign" }, failedSheets > 0);
  } catch (error) {
    log(config, `calc_${args.action}`, args.dry_run, "", "error", errText(error));
    return reply({ error: errText(error) }, true);
  }
}

export function registerFmcCalcTool(server: McpServer) {
  server.tool("fmc_calc", FMC_CALC_DESCRIPTION, FMC_CALC_SHAPE, (args) => runFmcCalc(args));
}
