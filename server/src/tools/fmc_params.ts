import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import {
  PARAMS_MAX_ROWS, auditParams, parseCsv, paramsApplyProblems, planBind, planCopy, planFill, readKitShared,
  type Binding, type ValueRow,
} from "../fmc/params.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_PARAMS_DESCRIPTION =
  "Formcraft project parameter manager (GAP-11, co-owned with Kit Loader on the kit GUID rule). Pass document (a title or full path; the active document is never used). " +
  "audit (read-only) compares the project's parameter bindings with the kit shared parameter file (read as UTF-8 or UTF-16): kit parameters not bound, a shared parameter whose GUID differs from the kit, one that is not in the kit, a project parameter that clashes with a kit name, a data type that differs. names narrows it. " +
  "bind binds kit shared parameters (names) to categories (built-in names such as OST_Walls) as instance or type. The GUID must match the kit; a name that is already a project parameter with another GUID is refused; categories are added to an existing binding, never removed. The kit file is never edited and Revit is pointed back at the person's own file afterwards. " +
  "copy copies the value of one parameter into another (from, to) on elements given by ids or by category (OST_ name); the same storage, or anything into text. An empty source leaves the target alone. " +
  "fill_csv fills values from a CSV file (csv_path): a header row with an Id column and one column per parameter name; length and other unit values are read in the parameter's display units; a blank cell is left alone. " +
  `At most ${PARAMS_MAX_ROWS} elements or rows. ` +
  "bind, copy and fill_csv are dry runs by default and return a preview and plan_hash. A real change needs dry_run false, that plan_hash and batch_lease; the call plans again and refuses FMC-PARAM-PLAN-CHANGED when the model moved. One transaction: any failure rolls everything back. " +
  "Another user's elements, HEBERT HOSTELS, a central model, a protected path and family files are refused. The project is not saved or synced. " +
  "Example: action bind, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, names [Status], categories [OST_Walls], binding instance, dry_run true.";

const id = z.union([z.string(), z.number()]);

export const FMC_PARAMS_SHAPE = {
  action: z.enum(["audit", "bind", "copy", "fill_csv"]),
  document: z.string().optional().default("").describe("Title or full path of the open project."),
  names: z.array(z.string()).optional().default([]).describe("audit: limit to these kit names. bind: the kit parameters to bind."),
  categories: z.array(z.string()).optional().default([]).describe("bind: built-in categories, e.g. OST_Walls. copy and fill_csv: one category to take elements from."),
  binding: z.enum(["instance", "type"]).optional().default("instance"),
  group: z.string().optional().default("data").describe("bind: properties group (identity, data, text, constraints, general, graphics, materials)."),
  ids: z.array(id).optional().default([]).describe("copy: element ids."),
  from: z.string().optional().default("").describe("copy: parameter to read."),
  to: z.string().optional().default("").describe("copy: parameter to write."),
  overwrite_empty: z.boolean().optional().default(false).describe("copy: an empty source clears the target."),
  csv_path: z.string().optional().default("").describe("fill_csv: the .csv file."),
  dry_run: z.boolean().optional().default(true),
  plan_hash: z.string().optional().default("").describe("From the dry run. Required to apply."),
  batch_lease: z.string().optional().default(""),
};

export type FmcParamsArgs = z.infer<z.ZodObject<typeof FMC_PARAMS_SHAPE>>;

export interface ParamsIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
  kitFile?: string;
}

function stamp(extra: Record<string, unknown> = {}) {
  return { tool: "fmc_params", saved: false, synced: false, kit_saved: false, images: [] as [], ...extra };
}

function refuse(code: string, message: string) {
  return reply(stamp({ refused: true, code, message: message.startsWith("[") ? message : `[${code}] ${message}` }), true);
}

function kitFileOf(io: ParamsIo): string {
  if (io.kitFile != null) return io.kitFile;
  const env = io.env ?? process.env;
  const direct = (env.FMC_SHARED_PARAMETER_FILE ?? "").trim();
  if (direct) return direct;
  try {
    const loaded = io.guard ? { config: io.guard } : loadConfig(configPath(env));
    return kitPaths(loaded.config).sharedParams;
  } catch { return ""; }
}

function guardReason(doc: { title: string; path: string }, central: boolean | undefined, io: ParamsIo): string | null {
  const env = io.env ?? process.env;
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
  if (/hebert hostels/i.test(`${doc.title} ${doc.path}`)) return "HEBERT HOSTELS is not written by fmc_params.";
  if (/[\\/]centrals[\\/]/i.test(doc.path)) return "A file under a Centrals folder is not written by fmc_params.";
  if (central) return "A central model is not written by fmc_params.";
  return saveBlocked({ title: doc.title, path: doc.path }, loaded.config) ?? loaded.problem ?? null;
}

function writeReport(io: ParamsIo, name: string, body: unknown): string {
  const env = io.env ?? process.env;
  const dir = io.reportDir || (env.FMC_PARAMS_DIR ?? "").trim() || path.join(env.LOCALAPPDATA || os.tmpdir(), "Formcraft", "params");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `params-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

export async function runFmcParams(args: FmcParamsArgs, io: ParamsIo = {}) {
  try {
    if (!args.document.trim()) return refuse("FMC-DOC-REQUIRED", "fmc_params needs document: a title or a full path. Refusing to use the active document.");
    const send = async (command: string, body: Record<string, unknown>, ms: number) =>
      (command.endsWith("_apply") ? io.apply : io.read)
        ? await (command.endsWith("_apply") ? io.apply! : io.read!)(body) as Record<string, unknown>
        : await withRevitConnection((client) => client.sendCommand(command, body, ms)) as Record<string, unknown>;
    const kitFile = kitFileOf(io);
    const kit = readKitShared(kitFile);
    const dry = args.dry_run !== false;

    // Values come first for copy and fill_csv (the CSV is read before the model is asked anything).
    let csv: string[][] = [];
    if (args.action === "fill_csv") {
      const file = args.csv_path.trim();
      if (!file || !/\.csv$/i.test(file)) return refuse("FMC-PARAM-CSV", "fill_csv needs csv_path: a .csv file.");
      if (!fs.existsSync(file)) return refuse("FMC-PARAM-CSV", `The CSV was not found: ${file}`);
      if (fs.statSync(file).size > 8 * 1024 * 1024) return refuse("FMC-PARAM-CSV", "The CSV is over 8 MB. Split it.");
      csv = parseCsv(fs.readFileSync(file, "utf8"));
    }
    if (args.action === "audit" || args.action === "bind") {
      if (args.action === "audit" && !kit) return refuse("FMC-PARAM-FILE", `The kit shared parameter file is not readable at ${kitFile || "(not set)"}. Nothing was invented.`);
      const snap = await send("fmc_params", { document: args.document, action: "bindings" }, 180000);
      if (snap.refused || (typeof snap.code === "string" && snap.code)) return refuse(String(snap.code || "FMC-PARAMS"), String(snap.message || "The read was refused."));
      const bound = (Array.isArray(snap.bindings) ? snap.bindings : []) as Binding[];
      const resolved = (snap.resolved_document ?? {}) as { title?: string; path?: string };
      const doc = { title: String(resolved.title || args.document), path: String(resolved.path || "") };
      if (args.action === "audit") {
        const audit = auditParams(kit!, bound, args.names);
        return reply(stamp({ action: "audit", read_only: true, document: doc.title, resolved_document: doc, kit_file: kitFile, ...audit }));
      }
      const plan = planBind({ kit, kitFile, names: args.names, categories: args.categories, binding: args.binding, group: args.group, bound });
      if (!plan.ok) return refuse(plan.code, plan.message);
      return await finish(args, io, doc, snap.is_central === true, plan, { action: "bind", kit_file: kitFile }, send, { kitFile });
    }
    // copy and fill_csv
    const wantNames = args.action === "copy" ? [args.from, args.to] : (csv[0] ?? []).slice().map((h) => h.trim()).filter(Boolean);
    const ids = args.ids.map((x) => String(x).trim()).filter(Boolean);
    if (ids.some((x) => !/^\d+$/.test(x))) return refuse("FMC-PARAM-IDS", "ids must be element ids (digits).");
    if (args.action === "copy" && ids.length === 0 && args.categories.length === 0) return refuse("FMC-PARAM-SCOPE", "copy needs ids or one category.");
    const fillIds = args.action === "fill_csv" ? csv.slice(1).map((r) => (r[(csv[0] ?? []).findIndex((h) => ["id", "elementid", "element id", "element_id"].includes(h.trim().toLowerCase()))] ?? "").trim()).filter((x) => /^\d+$/.test(x)) : [];
    const snap = await send("fmc_params", {
      document: args.document, action: "values", ids: args.action === "copy" ? ids : fillIds, category: args.action === "copy" ? (args.categories[0] ?? "") : "",
      names: wantNames, cap: PARAMS_MAX_ROWS + 1,
    }, 180000);
    if (snap.refused || (typeof snap.code === "string" && snap.code)) return refuse(String(snap.code || "FMC-PARAMS"), String(snap.message || "The read was refused."));
    const rows = (Array.isArray(snap.rows) ? snap.rows : []) as ValueRow[];
    const resolved = (snap.resolved_document ?? {}) as { title?: string; path?: string };
    const doc = { title: String(resolved.title || args.document), path: String(resolved.path || "") };
    const plan = args.action === "copy" ? planCopy(rows, args.from, args.to, { overwrite_empty: args.overwrite_empty }) : planFill(rows, csv);
    if (!plan.ok) return refuse(plan.code, plan.message);
    return await finish(args, io, doc, snap.is_central === true, plan, { action: args.action, totals: (plan as { totals?: unknown }).totals }, send, {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply(stamp({ refused: true, code: message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-PARAMS", message }), true);
  }
}

async function finish(
  args: FmcParamsArgs, io: ParamsIo, doc: { title: string; path: string }, central: boolean,
  plan: { steps: unknown[]; preview: Array<Record<string, unknown>>; plan_hash: string; ok: boolean; message: string },
  extra: Record<string, unknown>, send: (c: string, b: Record<string, unknown>, ms: number) => Promise<Record<string, unknown>>,
  more: { kitFile?: string },
) {
  const reason = guardReason(doc, central, io);
  if (reason) return reply(stamp({ refused: true, code: "FMC-PARAM-GUARD", dry_run: true, document: doc.title, message: reason }), true);
  const body = stamp({ ...extra, document: doc.title, resolved_document: doc, steps: plan.steps.length, preview: plan.preview.slice(0, 300), preview_truncated: plan.preview.length > 300, plan_hash: plan.plan_hash, dry_run: args.dry_run !== false });
  if (args.dry_run !== false) {
    const report = writeReport(io, `${args.action}-dry`, { ...body, preview: plan.preview, plan_steps: plan.steps });
    return reply({ ...body, read_only: true, report, next: "Show this preview. Apply with dry_run false, this plan_hash and batch_lease." });
  }
  if (!(args.batch_lease.trim() || (batchLease.getStore() ?? ""))) return reply(stamp({ refused: true, code: "FMC-BATCH-LOCKED", dry_run: true, message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was changed." }), true);
  const problems = paramsApplyProblems(plan as never, args.plan_hash);
  if (problems.length) return reply(stamp({ refused: true, code: problems[0].match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-PARAMS", message: problems.join(" "), plan_hash: plan.plan_hash }), true);
  const env = io.env ?? process.env;
  const loaded = io.guard ? { config: io.guard } : loadConfig(configPath(env));
  const roots = [...(loaded.config.protected_paths ?? []), ...protectedRoots(loaded.config)];
  const applied = await send("fmc_params_apply", { document: args.document, steps: plan.steps, plan_hash: plan.plan_hash, shared_parameter_file: more.kitFile ?? "", protected_roots: roots, _protected_roots: roots }, 300000);
  const report = writeReport(io, `${args.action}-apply`, { ...body, applied });
  return reply({ ...body, read_only: false, dry_run: false, applied, report, kit_saved: false, saved: false, synced: false });
}

export function registerFmcParamsTool(server: McpServer) {
  server.tool("fmc_params", FMC_PARAMS_DESCRIPTION, FMC_PARAMS_SHAPE, async (args) => runFmcParams(args as FmcParamsArgs));
}
