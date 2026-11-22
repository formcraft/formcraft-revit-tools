import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import { kitPaths } from "../fmc/context.js";
import {
  SHEET_FIX, drawingFrame, packViews, parkParameter, referenceProblems, resolveMargins, writeSheetReport,
  type SheetLayoutName, type SheetRead, type SheetViewBox,
} from "../fmc/sheetlayout.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_SHEET_LAYOUT_DESCRIPTION =
  "Place and arrange views on a sheet, and park sheets. pair packs views in a grid inside the title block drawing area. " +
  "arrange uses layout grid, pair or stack on the views already on the sheet. park sets the browser-organization parameter, " +
  "or FMC_Sheet_Status, to the target (default Parked). Margins are sheets.margin_left_mm, sheets.margin_other_mm and sheets.gap_mm. " +
  "A missing key is provisional and cannot PASS. dry_run defaults to true. A write is fmc_sheets_layout_apply, one transaction, " +
  "and needs batch_lease plus references.kit, references.standards and references.rulebook. " +
  "JSON under %LOCALAPPDATA%\\Formcraft\\sheets. No pictures. " +
  "Example: action pair, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, sheet A-101, views [\"Level 1\",\"Level 2\"], dry_run true.";

const refsShape = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_SHEET_LAYOUT_FIELDS = {
  document: z.string().optional().default(""),
  sheet: z.string().optional().default(""),
  views: z.array(z.string()).optional().default([]),
  layout: z.enum(["grid", "pair", "stack"]).optional().default("grid"),
  sheets: z.array(z.string()).optional().default([]),
  target: z.string().optional().default("Parked"),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refsShape,
};

export type SheetLayoutArgs = z.infer<z.ZodObject<typeof FMC_SHEET_LAYOUT_FIELDS>> & { action: "pair" | "arrange" | "park" };

export interface SheetLayoutIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  standards?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-SHEETS";
  return reply({ tool: "fmc_sheets", refused: true, code, message, saved: false, synced: false }, true);
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_sheets",
    images: [] as [],
    saved: false,
    synced: false,
    cites: {
      kit: "FMC-BIM-MAN-001 sheets",
      standards: "FMC-BIM-STD-002 sheets.margin_left_mm sheets.margin_other_mm sheets.gap_mm",
      rulebook: "Views sit in the title block drawing area. Parked is a sheet parameter, not a ranking of people.",
    },
    ...extra,
  };
}

function standardsOf(io: SheetLayoutIo): Record<string, unknown> | null {
  if (io.standards !== undefined) return io.standards;
  const env = io.env ?? process.env;
  const direct = (env.FMC_STANDARDS_FILE ?? "").trim();
  if (!direct) {
    try {
      const loaded = loadConfig(configPath(env));
      const file = path.win32.join(path.win32.dirname(kitPaths(loaded.config).recipesDir), "FMC_Standards_Building.json");
      return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  try { return JSON.parse(fs.readFileSync(direct, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>; } catch { return null; }
}

function guardReason(doc: { title: string; path?: string; is_central?: boolean }, io: SheetLayoutIo): string | null {
  const blob = `${doc.title} ${doc.path ?? ""}`;
  if (/hebert hostels/i.test(blob)) return "HEBERT HOSTELS is not written by fmc_sheets.";
  if (/[\\/]centrals[\\/]/i.test(doc.path ?? "")) return "A file under a Centrals folder is not written by fmc_sheets.";
  if (doc.is_central) return "A central model is not written by fmc_sheets.";
  const env = io.env ?? process.env;
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
  return saveBlocked(doc, loaded.config) || loaded.problem || null;
}

function asSheet(raw: unknown): SheetRead | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as SheetRead;
  if (!body.id && !body.number) return null;
  return body;
}

function pickViews(sheet: SheetRead, names: string[], arrange: boolean): { views: SheetViewBox[]; skipped: Array<Record<string, unknown>> } {
  const pool = arrange ? (sheet.placed ?? []) : (sheet.views ?? []);
  if (arrange && !names.length) return { views: pool, skipped: [] };
  const skipped: Array<Record<string, unknown>> = [];
  const views: SheetViewBox[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    const hit = pool.find((view) => view.id.toLowerCase() === key || view.name.toLowerCase() === key);
    if (!hit) {
      skipped.push({ name, code: "FMC-SHEETS-VIEW", reason: SHEET_FIX["FMC-SHEETS-VIEW"] });
      continue;
    }
    if (!arrange && hit.on_sheet && hit.on_sheet !== sheet.id && hit.on_sheet !== sheet.number) {
      skipped.push({ name: hit.name, view_id: hit.id, code: "FMC-SHEETS-VIEW-TAKEN", reason: SHEET_FIX["FMC-SHEETS-VIEW-TAKEN"] });
      continue;
    }
    views.push(hit);
  }
  return { views, skipped };
}

export async function runSheetLayout(args: SheetLayoutArgs, io: SheetLayoutIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: SHEET_FIX["FMC-DOC-REQUIRED"] }, true);
    if (args.action !== "park" && !args.sheet.trim()) return reply({ ...stamp(), refused: true, code: "FMC-SHEETS-SHEET", message: SHEET_FIX["FMC-SHEETS-SHEET"] }, true);
    const margins = resolveMargins(standardsOf(io));
    const readBody = {
      document: args.document.trim(),
      action: args.action,
      sheet: args.sheet,
      sheets: args.action === "park" ? args.sheets : [args.sheet],
      views: args.views,
    };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_sheets_layout", readBody, 180000));
    const payload = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (payload.refused === true) return reply({ ...stamp(), refused: true, code: String(payload.code ?? "FMC-SHEETS"), message: String(payload.message ?? "The read was refused.") }, true);
    const doc = {
      title: String(payload.title ?? args.document),
      path: String(payload.path ?? ""),
      is_central: payload.is_central === true,
    };
    const sheets = (Array.isArray(payload.sheets) ? payload.sheets : [payload.sheet ?? payload]).map(asSheet).filter((row): row is SheetRead => !!row);
    const reportBody: Record<string, unknown> = { action: args.action, margins, document: doc.title };
    let ops: unknown[] = [];
    let skipped: unknown[] = [];
    let code: string | undefined;
    if (args.action === "park") {
      const target = args.target.trim() || "Parked";
      const parked = sheets.map((sheet) => {
        const keys = sheet.parameters ? Object.keys(sheet.parameters) : undefined;
        const param = parkParameter(keys);
        return { sheet_id: sheet.id, number: sheet.number, parameter: param.parameter, value: target, code: param.code, reason: param.reason };
      });
      const bad = parked.filter((row) => row.code);
      ops = parked.filter((row) => !row.code);
      skipped = bad;
      if (!ops.length) code = "FMC-SHEETS-PARK-PARAM";
      reportBody.park = parked;
    } else {
      const sheet = sheets[0];
      if (!sheet) return reply({ ...stamp(), refused: true, code: "FMC-SHEETS-SHEET", message: SHEET_FIX["FMC-SHEETS-SHEET"] }, true);
      const frame = drawingFrame(sheet, margins);
      if (!frame.ok) return reply({ ...stamp(), refused: true, code: frame.code, message: frame.reason, margins }, true);
      const layout: SheetLayoutName = args.action === "pair" ? "grid" : args.layout;
      const picked = pickViews(sheet, args.views, args.action === "arrange");
      const packed = packViews(picked.views, frame.frame, layout, margins.gap_mm);
      ops = packed.placed;
      skipped = [...picked.skipped, ...packed.skipped];
      reportBody.frame = frame.frame;
      reportBody.layout = layout;
      reportBody.placed = packed.placed;
      if (!packed.placed.length) code = packed.skipped[0]?.code ?? picked.skipped[0]?.code ?? "FMC-SHEETS-VIEW";
    }
    const report = writeSheetReport(env, args.action, reportBody, io.reportDir);
    const dry = args.dry_run !== false;
    const summary = stamp({
      action: args.action,
      dry_run: dry,
      read_only: dry,
      document: doc.title,
      margins,
      can_pass: margins.can_pass,
      status: margins.can_pass ? margins.status.toUpperCase() : "PROVISIONAL",
      ops,
      skipped,
      ...(code ? { code, message: SHEET_FIX[code] ?? "" } : {}),
      report,
    });
    if (dry) return reply({ ...summary, next: "Nothing was moved. Apply with dry_run false, batch_lease, and references. That call is fmc_sheets_layout_apply, one transaction." });
    const guard = guardReason(doc, io);
    if (guard) return reply({ ...stamp(), refused: true, code: "FMC-SHEETS-GUARD", message: guard }, true);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: SHEET_FIX["FMC-BATCH-LOCKED"] }, true);
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-SHEETS-REFERENCES", message: refsProblem }, true);
    if (code || !(Array.isArray(ops) && ops.length)) return reply({ ...summary, refused: true, read_only: true }, true);
    const loaded = io.guard ? { config: io.guard } : loadConfig(configPath(env));
    const roots = [...(loaded.config.protected_paths ?? []), ...protectedRoots(loaded.config)];
    const applyBody = {
      document: args.document.trim(),
      action: args.action,
      sheet: args.sheet,
      ops,
      protected_roots: roots,
      _protected_roots: roots,
      references: args.references ?? {},
    };
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_sheets_layout_apply", applyBody, 180000)) as Record<string, unknown>;
    return reply({ ...summary, read_only: false, dry_run: false, applied });
  } catch (error) {
    return failed(error);
  }
}
