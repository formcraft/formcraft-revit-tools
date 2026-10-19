import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { kitParams } from "../fmc/brief.js";
import { boq, kitCodes } from "../fmc/build.js";
import { ClashRow, navisCall, processAlive, readState } from "../fmc/navis.js";
import type { FeaRow } from "../fmc/robot.js";
import type { Register } from "../fmc/review.js";
import { neededParameters, qaFacts, runQa } from "../fmc/rules.js";
import { TREE } from "../tree/tree.js";
import { treeQuantities } from "../tree/building.js";
import { appStatuses, realProbe } from "../hub/apps.js";
import { exchangeRoot, listPackages, loadIdentity, writePackage } from "../hub/exchange.js";
import {
  DATA_DIR, PROJECT, Row, SourceNote, TABLES, clashRows, dataFiles, dataFolderOf, gatewayStatus, identityRows, modelFiles, qaRows, quantityRows,
  readme, roomRows, sourceRows, structuralRows, ticketRows, RevitRoom,
} from "../hub/powerbi.js";
import { readRulebooks } from "./fmc_qa.js";
import { registerFile } from "./fmc_review.js";
import { treeFile } from "./fmc_tree.js";
import { serverRoot } from "./fmc_apps.js";

const win = path.win32;
const WHAT = "Project data model";

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

export const FMC_POWERBI_DESCRIPTION =
  "Formcraft Power BI (hub step H2): the project's data model as files Power BI Desktop reads, with no binary step. " +
    "Tidy CSV tables (Rooms, Quantities by keynote code, QA findings, Tickets and their elements, Clashes, Structural " +
    "results, Identity, Sources) joined by room number, Revit UniqueId, ticket id and the Formcraft id, plus a Power BI " +
    "Project (FMC_Project.pbip) whose semantic model is TMDL text: tables read their CSV from the DataFolder parameter, " +
    "with relationships and measures (rooms over and under target, open tickets by discipline and priority, clashes by " +
    "status, quantities by bill). Written as an exchange package (hub → powerbi) in <project>\\01_WIP\\_Exchange and a " +
    "stable PowerBI\\latest folder Power BI points at. plan: the tables and what each will read (read-only). build: reads " +
    "every source (Revit, Navisworks only when they answer; otherwise the table is empty with a note, never guessed), a " +
    "dry run first. status: the newest package and whether Power BI Desktop is running. gateway: Microsoft's Power BI " +
    "Modeling MCP server (not set up). Quantities only, never rates; tickets by discipline, never by person.";

export const FMC_POWERBI_SHAPE = {
  action: z.enum(["plan", "build", "status", "gateway"]),
  project_folder: z.string().optional().default("").describe("The project folder: the package goes in its 01_WIP\\_Exchange"),
  dry_run: z.boolean().optional().default(true).describe("build: true (default) reads the sources and shows what would be written"),
  live: z.boolean().optional().default(true)
    .describe("build: false reads only files (the register, the recipe tree, the identity map, Robot's results package), never Revit or Navisworks"),
  kit_folder: z.string().optional().default("").describe("build: the Formcraft kit folder, for the keynote codes (Quantities); by default next to the rulebooks"),
  gate: z.enum(["wip_to_shared", "shared_to_published", "weekly"]).optional().default("weekly").describe("build: the QA gate for the QA table"),
  stage: z.string().optional().describe("build: the project's RIBA stage, for QA"),
  tolerance_pct: z.number().min(0).max(100).optional().default(10).describe("Rooms over or under their target area by more than this"),
  clash_limit: z.number().int().min(1).max(2000).optional().default(2000).describe("build: at most this many clashes per test"),
  refresh_model: z.boolean().optional().default(false)
    .describe("build: also replace the PBIP model and report in the latest folder (the old ones are archived first). By default a model already there is kept, with the person's edits"),
};

export type FmcPowerbiArgs = z.infer<z.ZodObject<typeof FMC_POWERBI_SHAPE>>;

const readJson = (file: string): any => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Gathered { rows: Record<string, Row[]>; notes: SourceNote[] }

/** The newest Robot results package and its run's bars (from the revit → robot package of the same run). */
function robotResults(root: string): { run: string; rows: FeaRow[]; bars: Array<{ n: number; id: number }> | null; pkg: string } | null {
  const pkgs = listPackages(root, { app: "robot" });
  const res = pkgs.find((m) => m.from === "robot" && m.what.startsWith("results "));
  if (!res) return null;
  const run = res.what.slice("results ".length).trim();
  const file = res.files.find((f) => f.name.endsWith("_results.json"))?.name ?? `${run}_results.json`;
  const body = readJson(win.join(root, "Packages", res.id, file));
  const sent = pkgs.find((m) => m.from === "revit" && m.to === "robot" && m.what === `analytical model ${run}`);
  let bars: Array<{ n: number; id: number }> | null = null;
  try { if (sent) bars = readJson(win.join(root, "Packages", sent.id, `${run}.json`)).bars ?? null; } catch { bars = null; }
  return { run, rows: Array.isArray(body?.rows) ? body.rows : [], bars, pkg: res.id };
}

function kitMaster(args: FmcPowerbiArgs, config: GuardConfig): string {
  const kit = expandEnv(args.kit_folder.trim());
  return kit ? win.join(kit, "03_Master_Data", "FMC_Master_Data.json") : win.join(win.dirname(expandEnv(config.rulebooks_dir)), "FMC_Master_Data.json");
}

/**
 * Every source. Files (the register, the tree, the identity map, Robot's results package) are always read; Revit and
 * Navisworks only when live is true and the app answers. A table that wasn't read is empty with the reason.
 */
async function gather(args: FmcPowerbiArgs, config: GuardConfig, project: string, root: string, live: boolean, skipped = " (read at build)"): Promise<Gathered> {
  const rows: Record<string, Row[]> = {};
  const notes: SourceNote[] = [];
  const note = (table: string, state: SourceNote["state"], text: string) => notes.push({ table, state, note: text });
  const today = new Date().toISOString().slice(0, 10);
  const identity = loadIdentity(root);
  const statuses = appStatuses(realProbe(serverRoot()));
  const revitUp = statuses.find((s) => s.id === "revit")?.running ?? false;
  const nav = readState();
  const navisUp = !!nav && processAlive(nav.pid);
  const why = live ? "" : skipped;

  // the register
  let reg: Register | null = null;
  const regFile = project ? registerFile(project) : "";
  try { if (regFile && fs.existsSync(regFile)) reg = readJson(regFile) as Register; } catch (e) { note("Tickets", "not read", `${regFile}: ${errText(e)}`); }
  const t = ticketRows(reg, today, identity);
  rows.Tickets = t.tickets; rows.TicketElements = t.elements;
  if (!notes.some((n) => n.table === "Tickets"))
    note("Tickets", reg ? "read" : "empty", reg ? `The review register ${regFile}` : `No review register yet (${regFile || "no project folder"})`);
  note("TicketElements", reg ? "read" : "empty", reg ? "The elements named in each ticket" : "No review register yet");

  // rooms: the tree always, Revit when it answers
  let treeRows: ReturnType<typeof treeQuantities>["rows"] = [];
  const tf = project ? treeFile(project) : "";
  let treeNote = "no recipe tree";
  try { if (tf && fs.existsSync(tf)) { treeRows = treeQuantities(TREE.parse(readJson(tf)), args.tolerance_pct).rows; treeNote = `the recipe tree (${treeRows.length} rooms)`; } }
  catch (e) { treeNote = `the recipe tree couldn't be read: ${errText(e)}`; }
  let revitRooms: RevitRoom[] | null = null;
  let revitNote = live ? (revitUp ? "" : "Revit isn't running") : `Revit ${revitUp ? "is running" : "isn't running"}${why}`;
  if (live && revitUp) {
    try {
      const r = await withRevitConnection((c) => c.sendCommand("export_room_data", { includeUnplacedRooms: false, includeNotEnclosedRooms: false }, 120000)) as any;
      const list = r?.rooms ?? r?.result?.rooms;
      if (Array.isArray(list)) { revitRooms = list; revitNote = `Revit's rooms (${list.length})`; } else revitNote = `Revit answered without rooms: ${r?.message ?? "no message"}`;
    } catch (e) { revitNote = `Revit didn't answer: ${errText(e)}`; }
  }
  rows.Rooms = roomRows({ revit: revitRooms, tree: treeRows, identity, tolerancePct: args.tolerance_pct });
  note("Rooms", rows.Rooms.length ? "read" : "empty", `${revitNote}; ${treeNote}`);

  // QA and quantities: Revit only
  if (live && revitUp) {
    try {
      const books = readRulebooks(config.rulebooks_dir);
      if (!books.rules.length) throw new Error(books.problems[0] ?? "the kit's rulebooks have no rules");
      const facts = qaFacts(await withRevitConnection((c) => c.sendRaw("fmc_qa_facts", neededParameters(books.rules), 300000)));
      const qa = runQa(books, facts, args.gate, today, (args.stage ?? "").trim());
      rows.QA = qaRows(qa.results, args.gate, facts.model);
      note("QA", "read", `QA run on ${facts.model}, gate ${args.gate} (read-only)`);
    } catch (e) { rows.QA = []; note("QA", "not read", `QA not run: ${errText(e)}`); }
    try {
      const master = kitMaster(args, config);
      if (!fs.existsSync(master)) throw new Error(`kit master data not found: ${master}`);
      const data = readJson(master);
      const params = kitParams(data);
      const [CODE, STATUS, PACKAGE] = ["FMC_Keynote_Code", "FMC_Construction_Status", "FMC_Trade_Package"];
      const missing = [CODE, STATUS, PACKAGE].filter((p) => !params[p]);
      if (missing.length) throw new Error(`the kit has no ${missing.join(", ")}`);
      const categories = [...new Set([...params[CODE].categories, ...params[STATUS].categories])];
      const facts = await withRevitConnection((c) => c.sendRaw("fmc_build_facts", { code_param: CODE, status_param: STATUS, package_param: PACKAGE, categories }, 300000));
      rows.Quantities = quantityRows(boq(facts, kitCodes(data), null).items);
      note("Quantities", "read", `Quantities by keynote code from ${String((facts as any)?.model ?? "the model")} (no rates)`);
    } catch (e) { rows.Quantities = []; note("Quantities", "not read", `Quantities not read: ${errText(e)}`); }
  } else {
    rows.QA = []; rows.Quantities = [];
    note("QA", "not read", `Needs Revit: ${revitNote}`);
    note("Quantities", "not read", `Needs Revit: ${revitNote}`);
  }

  // clashes: Navisworks only
  rows.Clashes = [];
  if (live && navisUp) {
    try {
      const tests = ((await navisCall(nav!.port, "navis_clash_tests", {}, 30000)).tests ?? []) as Array<{ name: string }>;
      const read: Array<{ test: string; rows: ClashRow[] }> = [];
      for (const x of tests) {
        const r = await navisCall(nav!.port, "navis_clash_results", { test: x.name, status: "", limit: args.clash_limit });
        read.push({ test: x.name, rows: (r.results ?? []) as ClashRow[] });
      }
      rows.Clashes = clashRows(read, reg, identity);
      note("Clashes", rows.Clashes.length ? "read" : "empty", `Navisworks: ${tests.length} clash tests`);
    } catch (e) { note("Clashes", "not read", `Navisworks didn't answer: ${errText(e)}`); }
  } else note("Clashes", "not read", `Needs Navisworks with the Formcraft bridge: ${navisUp ? "running" : "not running"}${why}`);

  // structural: the newest Robot results package
  try {
    const rr = robotResults(root);
    rows.Structural = rr ? structuralRows(rr.rows, rr.bars, identity) : [];
    note("Structural", rr ? "read" : "empty", rr ? `Robot run ${rr.run} (package ${rr.pkg})${rr.bars ? "" : "; the run's bar list wasn't found, so members have no Formcraft id"}` : "No Robot results package yet (fmc_robot results with dry_run=false)");
  } catch (e) { rows.Structural = []; note("Structural", "not read", `The Robot results package couldn't be read: ${errText(e)}`); }

  rows.Identity = identityRows(identity);
  note("Identity", rows.Identity.length ? "read" : "empty", rows.Identity.length ? "The identity map FMC_Identity.json" : "The identity map is empty");
  rows.Sources = sourceRows(notes, rows, new Date().toISOString());
  return { rows, notes };
}

function writeFiles(dir: string, files: Array<{ name: string; text: string }>) {
  for (const f of files) {
    const p = win.join(dir, ...f.name.split("/"));
    fs.mkdirSync(win.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.text);
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export async function runFmcPowerbi(args: FmcPowerbiArgs) {
  const { config } = loadConfig();
  const project = expandEnv(args.project_folder.trim());
  const root = exchangeRoot(project || undefined, expandEnv(config.reports_dir));
  const latest = win.join(root, "PowerBI", "latest");
  try {
    if (args.action === "gateway") return reply(gatewayStatus());

    if (args.action === "status") {
      const app = appStatuses(realProbe(serverRoot())).find((s) => s.id === "powerbi")!;
      const pkgs = listPackages(root, { app: "powerbi" }).filter((m) => m.what === WHAT);
      let latestAt = "";
      try { latestAt = fs.statSync(win.join(latest, DATA_DIR, "FMC_Sources.csv")).mtime.toISOString(); } catch { /* none yet */ }
      return reply({ exchange: root, newest_package: pkgs[0] ? { id: pkgs[0].id, created: pkgs[0].created, files: pkgs[0].files.length, notes: pkgs[0].notes ?? [] } : null,
        packages: pkgs.length, latest: { folder: latest, written: latestAt || null, pbip: fs.existsSync(win.join(latest, `${PROJECT}.pbip`)) },
        power_bi_desktop: { installed: app.installed, running: app.running, on: app.on }, gateway: gatewayStatus().state,
        next: pkgs.length ? `Open ${win.join(latest, `${PROJECT}.pbip`)} in Power BI Desktop and Refresh` : "fmc_powerbi build (a dry run first)" });
    }

    if (args.action === "plan") {
      const g = await gather(args, config, project, root, false);
      return reply({ exchange: root, latest, tables: TABLES.map((t) => {
        const n = g.notes.find((x) => x.table === t.name);
        return { table: t.name, file: `${DATA_DIR}\\${t.file}`, columns: t.columns.map((c) => c.name), rows_now: g.rows[t.name]?.length ?? 0, source: n?.note ?? "", measures: t.measures.map((m) => m.name) };
      }), next: "fmc_powerbi build reads Revit and Navisworks when they answer (a dry run first)" });
    }

    // build
    if (!project) return reply({ refused: true, reasons: ["Name the project folder: the data model goes in its 01_WIP\\_Exchange"] }, true);
    const reasons = [win.join(root, "Packages", "x.csv"), win.join(latest, "x.csv")].flatMap((p) => checkWritePath(p, config, { checkName: false }).reasons);
    const g = await gather(args, config, project, root, args.live, " (live=false: files only)");
    const tables = TABLES.map((t) => ({ table: t.name, rows: g.rows[t.name]?.length ?? 0, note: g.notes.find((n) => n.table === t.name)?.note ?? "" }));
    const pbiRunning = appStatuses(realProbe(serverRoot())).find((s) => s.id === "powerbi")!.running;
    const modelThere = fs.existsSync(win.join(latest, `${PROJECT}.pbip`));
    const model = !modelThere ? "written (first time)" : args.refresh_model ? "replaced (the old one archived first)" : "kept (a person's edits stay; refresh_model=true replaces it)";
    if (args.dry_run) {
      return reply({ dry_run: true, exchange: root, would_write: { package: win.join(root, "Packages", `<time>_hub-powerbi_Project_data_model`), latest }, tables, latest_model: model,
        power_bi_desktop_running: pbiRunning, refused: reasons.length ? reasons : undefined,
        next: reasons.length ? "Fix the write folders first (write_roots in fmc_guard.json)" : "Run again with dry_run=false" });
    }
    if (reasons.length) return reply({ refused: true, reasons }, true);
    if (modelThere && args.refresh_model && pbiRunning)
      return reply({ refused: true, reasons: ["Power BI Desktop is running: close it before replacing the model in the latest folder (or build without refresh_model)"] }, true);

    const built = new Date().toISOString();
    const data = dataFiles(g.rows);
    const notes = g.notes.filter((n) => n.state !== "read").map((n) => `${n.table}: ${n.note}`);
    const pkg = writePackage(root, { from: "hub", to: "powerbi", what: WHAT, notes, source: { project, tables: tables.map((t) => `${t.table} ${t.rows}`) },
      files: (dir) => [...data, ...modelFiles(dataFolderOf(dir)), { name: "README.txt", text: readme(dataFolderOf(dir), built) }] });

    let archived = "";
    if (modelThere && args.refresh_model) {
      archived = win.join(root, "PowerBI", "_Archive", stamp());
      fs.mkdirSync(archived, { recursive: true });
      for (const n of [`${PROJECT}.pbip`, `${PROJECT}.SemanticModel`, `${PROJECT}.Report`])
        if (fs.existsSync(win.join(latest, n))) fs.renameSync(win.join(latest, n), win.join(archived, n));
    }
    writeFiles(latest, [...data, { name: "README.txt", text: readme(dataFolderOf(latest), built) }]);
    if (!modelThere || args.refresh_model) writeFiles(latest, modelFiles(dataFolderOf(latest)));
    log(config, "powerbi_build", false, pkg.dir, "written", tables.map((t) => `${t.table} ${t.rows}`).join("; "));
    return reply({ done: true, package: pkg.dir, latest, latest_model: model, archived: archived || undefined, tables,
      power_bi_desktop_running: pbiRunning,
      next: pbiRunning ? "In Power BI Desktop: Refresh (Home › Refresh)" : `Open ${win.join(latest, `${PROJECT}.pbip`)} in Power BI Desktop, then Refresh` });
  } catch (e) {
    log(config, "powerbi_" + args.action, args.dry_run, root, "error", errText(e));
    return reply({ error: errText(e) }, true);
  }
}

export function registerFmcPowerbiTool(server: McpServer) {
  server.tool("fmc_powerbi", FMC_POWERBI_DESCRIPTION, FMC_POWERBI_SHAPE, (args) => runFmcPowerbi(args));
}
