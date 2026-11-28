/**
 * GAP-18 fmc_print_sets: view and sheet sets from the drawing register, for fmc_issue and exports.
 * list is read-only. build is a dry run by default; the real run is fmc_print_sets_apply (WRITE_COMMANDS), sent with
 * sendCommand so the batch lease, the live-model lock and the AI gate apply. It needs batch_lease, references and the
 * dry run's plan_hash. Sets are only created or replaced, never deleted.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { referenceProblems } from "../fmc/sheetlayout.js";
import { parseRegister } from "../fmc/sheets.js";
import { readRegisterFile } from "./fmc_sheets.js";
import { PRINT_SETS_FIX, applyOps, planPrintSets, type ModelSet, type ModelSheetRef } from "../fmc/printsets.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_PRINT_SETS_DESCRIPTION =
  "Formcraft print sets (view and sheet sets for printing and export) from the project's drawing register " +
  "(FMC_Sheet_Register .xlsx or .csv: Number, Name, Role, Issue sets). document is required on every call. " +
  "list (read-only): the sets in the model and their sheets. build: one set per issue set the register names " +
  "(or the issue_sets asked for), holding the model sheets the register plans for it, the same sheets fmc_issue checks. " +
  "Set names come only from the register; register sheets missing from the model are listed, never created. " +
  "dry_run defaults to true. A set that already exists and differs is skipped unless replace_existing is true. " +
  "The real run (fmc_print_sets_apply, one transaction) needs batch_lease, references.kit/standards/rulebook and the dry run's plan_hash. " +
  "Example: action build, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, register D:\\Jobs\\F26901\\FMC_Sheet_Register.xlsx, issue_sets [\"PERMIT\"], dry_run true.";

export const FMC_PRINT_SETS_SHAPE = {
  action: z.enum(["list", "build"]),
  document: z.string().optional().default(""),
  register: z.string().optional().default("").describe("build: absolute path of the project's sheet register (.xlsx or .csv)"),
  issue_sets: z.array(z.string()).optional().default([]).describe("build: issue sets from the register (default: every set the register names)"),
  replace_existing: z.boolean().optional().default(false).describe("build: replace a set of the same name that differs (after a person has seen the dry run)"),
  dry_run: z.boolean().optional().default(true),
  plan_hash: z.string().optional().default("").describe("build, dry_run false: the plan_hash the dry run returned"),
  batch_lease: z.string().optional().default(""),
  references: z.object({
    kit: z.array(z.string()).optional(),
    standards: z.array(z.string()).optional(),
    rulebook: z.array(z.string()).optional(),
  }).optional(),
};

export type FmcPrintSetsArgs = z.infer<z.ZodObject<typeof FMC_PRINT_SETS_SHAPE>>;

export interface PrintSetsIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  registerRows?: (file: string) => string[][];
  guard?: GuardConfig;
  env?: NodeJS.ProcessEnv;
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_print_sets",
    saved: false,
    synced: false,
    cites: {
      kit: "FMC_Sheet_Register (Number, Name, Role, Issue sets)",
      standards: "FMC-BIM-STD-002 sheet register: sheet numbers and issue sets come from the register",
      rulebook: "Gap analysis 18: names come from the register; the write is under a lease",
    },
    ...extra,
  };
}

function refused(code: string, message = PRINT_SETS_FIX[code] ?? code, extra: Record<string, unknown> = {}) {
  return reply({ ...stamp(), refused: true, code, message, ...extra }, true);
}

function asSheets(raw: Record<string, unknown>): ModelSheetRef[] {
  const rows = Array.isArray(raw.sheets) ? raw.sheets : [];
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const r = item as Record<string, unknown>;
    const id = String(r.id ?? "").trim();
    const number = String(r.number ?? "").trim();
    return id && number ? [{ id, number, name: String(r.name ?? "") }] : [];
  });
}

function asSets(raw: Record<string, unknown>): ModelSet[] {
  const rows = Array.isArray(raw.sets) ? raw.sets : [];
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const r = item as Record<string, unknown>;
    const ids = Array.isArray(r.view_ids) ? r.view_ids.map((x) => String(x)) : [];
    return [{ id: String(r.id ?? ""), name: String(r.name ?? ""), view_ids: ids }];
  });
}

function guardReason(doc: { title: string; path: string; is_central: boolean }, io: PrintSetsIo): string | null {
  if (doc.is_central) return "A central model is not written by fmc_print_sets: work in a local copy.";
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(io.env ?? process.env));
  return saveBlocked(doc, loaded.config) || loaded.problem || null;
}

export async function runFmcPrintSets(args: FmcPrintSetsArgs, io: PrintSetsIo = {}) {
  try {
    const document = args.document.trim();
    if (!document) return refused("FMC-DOC-REQUIRED");
    const readBody = { document };
    const raw = (io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_print_sets_read", readBody, 120000))) as Record<string, unknown> ?? {};
    const doc = { title: String(raw.title ?? document), path: String(raw.path ?? ""), is_central: raw.is_central === true };
    const sheets = asSheets(raw);
    const sets = asSets(raw);
    if (args.action === "list") {
      const numberOf = new Map(sheets.map((s) => [s.id, s.number]));
      return reply({ ...stamp({ read_only: true, document: doc.title }),
        sets: sets.map((s) => ({ id: s.id, name: s.name, sheets: s.view_ids.filter((id) => numberOf.has(id)).map((id) => numberOf.get(id)),
          other_views: s.view_ids.filter((id) => !numberOf.has(id)).length })),
        sheets: sheets.length });
    }

    const file = args.register.trim();
    const ext = path.win32.extname(file).toLowerCase();
    if (!file || ![".xlsx", ".csv"].includes(ext) || !(io.registerRows || fs.existsSync(file))) return refused("FMC-PRINTSETS-REGISTER");
    const reg = parseRegister((io.registerRows ?? readRegisterFile)(file));
    if (!reg.sheets.length) return refused("FMC-PRINTSETS-REGISTER", PRINT_SETS_FIX["FMC-PRINTSETS-REGISTER"], { problems: reg.problems });
    const plan = planPrintSets(reg.sheets, sheets, sets, args.issue_sets, { replaceExisting: args.replace_existing, document: doc.title });
    if (!plan.register_sets.length) return refused("FMC-PRINTSETS-NO-SETS");
    const dry = args.dry_run !== false;
    const summary = stamp({
      action: "build", dry_run: dry, read_only: dry, document: doc.title, register: file,
      ...plan,
      ...(plan.unknown.length ? { unknown_code: "FMC-PRINTSETS-UNKNOWN", unknown_reason: PRINT_SETS_FIX["FMC-PRINTSETS-UNKNOWN"] } : {}),
      register_problems: reg.problems,
    });
    if (dry) return reply({ ...summary, next: plan.changes
      ? "Nothing was changed. Show this to the person. To write: dry_run false, batch_lease, references, and this plan_hash (fmc_print_sets_apply, one transaction)."
      : "Nothing to write." });
    if (plan.unknown.length) return refused("FMC-PRINTSETS-UNKNOWN", PRINT_SETS_FIX["FMC-PRINTSETS-UNKNOWN"], { unknown: plan.unknown });
    if (!plan.changes) return reply({ ...summary, refused: true, code: "FMC-PRINTSETS-NOTHING", message: "Nothing to write." }, true);
    const guard = guardReason(doc, io);
    if (guard) return refused("FMC-PRINTSETS-GUARD", guard);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return refused("FMC-BATCH-LOCKED");
    if (referenceProblems(args.references)) return refused("FMC-PRINTSETS-REFERENCES");
    if (args.plan_hash.trim() !== plan.plan_hash) return refused("FMC-PRINTSETS-STALE", PRINT_SETS_FIX["FMC-PRINTSETS-STALE"], { plan_hash: plan.plan_hash });
    const applyBody = { document, ops: applyOps(plan), plan_hash: plan.plan_hash, references: args.references ?? {} };
    const applied = io.apply
      ? await io.apply(applyBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_print_sets_apply", applyBody, 120000));
    return reply({ ...summary, dry_run: false, read_only: false, applied });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refused(message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-PRINTSETS", message);
  }
}

export function registerFmcPrintSetsTool(server: McpServer) {
  server.tool("fmc_print_sets", FMC_PRINT_SETS_DESCRIPTION, FMC_PRINT_SETS_SHAPE, (args) => runFmcPrintSets(args));
}
