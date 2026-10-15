import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { BarResult, Member, assemble, checkForm, mapResults, runRef } from "../fmc/robot.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_ROBOT_DESCRIPTION =
  "Formcraft and Robot Structural Analysis (track R). status: whether Robot is installed and running. send: the model's " +
    "analytical columns and beams go to a new Robot model (nodes merged within 1 mm, sections from Robot's databases or " +
    "concrete rectangles, grades as materials); the engineer's form is required: column-base supports (Fixed or Pinned), the " +
    "load cases (name, nature, self-weight yes/no) and their name. A dry run (the default) shows what would go. The run is " +
    "FEA-yyyymmdd-hhmm, saved as <run>.rtd with <run>.json (the bar to element mapping). In Robot the engineer adds the loads, " +
    "combinations and code. calculate: runs Robot's analysis on a run. results: each member's governing NEd (kN) and MEd (kN·m) " +
    "as a dry run; dry_run=false writes them into FMC_FEA_NEd_kN, FMC_FEA_MEd_kNm and FMC_FEA_Run_Ref (behind the live-model " +
    "lock). FMC_FEA_Approval_Ref is the engineer's signature and is never written; no section, load or size is ever chosen.";

const CASE = z.object({
  name: z.string(),
  nature: z.string().describe("PERMANENT, EXPLOATATION (imposed), WIND, SNOW, TEMPERATURE, ACCIDENTAL or SEISMIC"),
  self_weight: z.boolean().describe("Robot adds the members' self-weight to this case"),
});

export const FMC_ROBOT_SHAPE = {
  action: z.enum(["status", "send", "calculate", "results"]),
  supports: z.enum(["Fixed", "Pinned"]).optional().describe("send: the engineer's column-base supports"),
  cases: z.array(CASE).optional().describe("send: the engineer's load cases"),
  engineer: z.string().optional().describe("send: the engineer whose run this is"),
  run: z.string().optional().default("").describe("calculate, results: the run (FEA-yyyymmdd-hhmm)"),
  folder: z.string().optional().default("").describe("Where runs are kept; default <reports_dir>\\Robot"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcRobotArgs = z.infer<z.ZodObject<typeof FMC_ROBOT_SHAPE>>;

/** fmc-robot.exe: FMC_ROBOT_EXE, or beside the server build (server\robot, installed as mcp\revit-fmc\robot). */
export function robotExe(): string {
  if (process.env.FMC_ROBOT_EXE) return process.env.FMC_ROBOT_EXE;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "robot", "fmc-robot.exe");
}

export function connector(command: string, input: object, timeoutMs = 20 * 60 * 1000): Promise<Record<string, unknown>> {
  const exe = robotExe();
  if (!fs.existsSync(exe)) return Promise.resolve({ error: `The Robot connector isn't installed (${exe}). It's built on a PC with Robot: dotnet build connectors/robot` });
  return new Promise((resolve) => {
    const child = execFile(exe, [command], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      try { resolve(JSON.parse(String(stdout || "{}"))); }
      catch { resolve({ error: err ? err.message : "The connector's reply isn't JSON" }); }
    });
    child.stdin?.end(JSON.stringify(input));
  });
}

interface RunFile { run: string; model: string; rtd: string; engineer: string; made_at: string; form: object; bars: Array<{ n: number; id: number }> }

function runsFolder(cfg: GuardConfig, folder: string) {
  return folder ? expandEnv(folder) : win.join(expandEnv(cfg.reports_dir), "Robot");
}

function readRun(dir: string, run: string): RunFile | null {
  try { return JSON.parse(fs.readFileSync(win.join(dir, `${run}.json`), "utf8")) as RunFile; } catch { return null; }
}

export async function runFmcRobot(args: FmcRobotArgs) {
  const { config } = loadConfig();
  const dry = args.dry_run !== false;
  const dir = runsFolder(config, args.folder);
  try {
    if (args.action === "status") {
      const exe = robotExe();
      const s = fs.existsSync(exe) ? await connector("status", {}, 60000) : { error: `No connector at ${exe}` };
      let runs: string[] = [];
      try { runs = fs.readdirSync(dir).filter((f) => /^FEA-\d{8}-\d{4}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort().reverse(); } catch { /* none yet */ }
      return reply({ connector: exe, ...s, runs_folder: dir, runs });
    }

    if (args.folder) {
      const v = checkWritePath(win.join(dir, "FEA.rtd"), config, { checkName: false });
      if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
    }

    if (args.action === "send") {
      const { form, problems } = checkForm({ supports: args.supports, cases: args.cases, engineer: args.engineer });
      if (!form) return reply({ refused: true, reasons: problems, note: "Supports, load cases and loads are the engineer's decisions: nothing is filled in" }, true);
      const exported = (await withRevitConnection((c) => c.sendRaw("fmc_analytical_export", {}, 300000))) as { members?: Member[]; without_analytical?: number; model?: string };
      const members = exported.members ?? [];
      if (members.length === 0) return reply({ refused: true, reasons: ["No columns or beams with an analytical member in this model"], without_analytical: exported.without_analytical ?? 0 }, true);
      const model = assemble(members);
      const run = runRef();
      const rtd = win.join(dir, `${run}.rtd`);
      const summary = { model: exported.model, run, rtd, nodes: model.nodes.length, bars: model.bars.length, supports: `${model.supports.length} ${form.supports}`,
        cases: form.cases, skipped: model.skipped, without_analytical: exported.without_analytical ?? 0 };
      if (dry) return reply({ dry_run: true, ...summary, next: "Run again with dry_run=false to open Robot and build this model" });
      fs.mkdirSync(dir, { recursive: true });
      const sent = await connector("send", { rtd, model: { nodes: model.nodes, bars: model.bars, supports: model.supports }, form });
      if (sent.error) { log(config, "robot_send", false, rtd, "error", String(sent.error)); return reply({ error: sent.error }, true); }
      const file: RunFile = { run, model: String(exported.model ?? ""), rtd, engineer: form.engineer, made_at: new Date().toISOString(), form,
        bars: model.bars.map((b) => ({ n: b.n, id: b.id })) };
      fs.writeFileSync(win.join(dir, `${run}.json`), JSON.stringify(file, null, 2));
      log(config, "robot_send", false, rtd, "sent", `${model.bars.length} bars, ${form.cases.length} cases, by ${form.engineer}`);
      return reply({ ...summary, robot: sent, next: "In Robot the engineer adds the loads, combinations and code; then calculate and results" });
    }

    if (!args.run) return reply({ refused: true, reasons: ["Name the run (fmc_robot status lists them)"] }, true);
    const runFile = readRun(dir, args.run);
    if (!runFile) return reply({ refused: true, reasons: [`No run ${args.run} in ${dir}`] }, true);

    if (args.action === "calculate") {
      const r = await connector("calculate", { rtd: runFile.rtd });
      log(config, "robot_calculate", false, runFile.rtd, r.error ? "error" : String(r.calculated), String(r.error ?? r.status ?? ""));
      return reply(r.error ? { error: r.error } : { run: args.run, ...r }, !!r.error);
    }

    // results
    const r = await connector("results", { rtd: runFile.rtd, bars: runFile.bars });
    if (r.error) return reply({ error: r.error }, true);
    const { rows, unknown } = mapResults(runFile.bars, (r.bars ?? []) as BarResult[], args.run);
    const written = (await withRevitConnection((c) => c.sendRaw("fmc_fea_write", { results: rows, dry_run: dry }, 300000))) as Record<string, unknown>;
    log(config, "robot_results", dry, runFile.rtd, dry ? "dry run" : `${written.values_set ?? 0} values`, `${rows.length} members`);
    return reply({ run: args.run, model: runFile.model, engineer: runFile.engineer, cases: r.cases, members: rows.length, not_mapped: unknown, revit: written,
      note: "Utilisation and the approval are the engineer's: FMC_FEA_Approval_Ref is never written",
      ...(dry ? { next: "Run again with dry_run=false to write these values into the model" } : {}) });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "robot_" + args.action, dry, dir, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcRobotTool(server: McpServer) {
  server.tool("fmc_robot", FMC_ROBOT_DESCRIPTION, FMC_ROBOT_SHAPE, (args) => runFmcRobot(args));
}
