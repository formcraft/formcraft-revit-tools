import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import {
  BS8666_EDITION, SCHEDULE_COLUMNS, buildSchedule, coverChecks, markConflicts, massSummary, minClearSpacingMm,
  scheduleCsv, spacingChecks, type RebarFact,
} from "../fmc/rebar.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const AGGREGATE_KEY = "rebar.max_aggregate_mm";
export const MIN_COVER_KEY = "rebar.min_cover_mm";
export const PROVISIONAL_AGGREGATE_MM = 20;

export const FMC_REBAR_SCHEDULE_DESCRIPTION =
  "Formcraft BS 8666 bar bending schedule. Read-only. There is no dry run and no transaction: nothing is created, changed or rolled back. " +
  "Reads Rebar elements (structural rebar sets) and returns one line per member and bar mark: member, bar mark, type and size (H12), number of members, " +
  "bars in each, total number, length of each bar, shape code, A to E and R, and mass from BS 8666 Table 1 unit masses. " +
  "Lengths come from the BS 8666 shape-code formula when the shape and its dimensions are known, else from Revit's bar length, rounded up to round_mm (25). " +
  "Checks: cover against each host's cover settings and min_cover_mm (the call, else rebar.min_cover_mm in the standards bank), measured from bar centre lines and the host box; " +
  "clear bar spacing against max(bar size, aggregate + 5 mm, 20 mm), with aggregate_mm from the call, else rebar.max_aggregate_mm, else a provisional 20 mm that cannot PASS; " +
  "and a bar mark used for different bars. Failures are listed with element ids. " +
  "Pass document. A missing name is FMC-DOC-REQUIRED. host_ids or marks narrow the read. " +
  "The full JSON and a CSV schedule are under %LOCALAPPDATA%\\Formcraft\\rebar. No pictures. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-S-0001_USER, min_cover_mm 40, aggregate_mm 20.";

export const FMC_REBAR_SCHEDULE_SHAPE = {
  document: z.string().optional().default("").describe("Title or full path of an open document. Required."),
  host_ids: z.array(z.string()).optional().default([]).describe("Host element ids (beams, columns, slabs, walls, foundations). Empty reads every Rebar."),
  marks: z.array(z.string()).optional().default([]).describe("Bar marks to keep. Empty keeps all."),
  min_cover_mm: z.number().positive().optional().describe("Minimum nominal cover in mm. Overrides rebar.min_cover_mm."),
  aggregate_mm: z.number().positive().optional().describe("Maximum aggregate size in mm for the spacing rule. Overrides rebar.max_aggregate_mm."),
  grade_letter: z.enum(["H", "B", "C", "X"]).optional().default("H").describe("BS 8666 type letter when the bar type name does not start with one."),
  round_mm: z.number().int().min(0).max(100).optional().default(25).describe("Lengths are rounded up to this step. 0 keeps the millimetre."),
  sample_limit: z.number().int().min(1).max(500).optional().default(100),
};

export type FmcRebarScheduleArgs = z.infer<z.ZodObject<typeof FMC_REBAR_SCHEDULE_SHAPE>>;

export interface RebarIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  standards?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

export interface CitedValue {
  key: string;
  value: number | null;
  source: "call" | "standards" | "provisional" | "none";
  clause: string;
  can_pass: boolean;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-REBAR";
  return reply({ tool: "fmc_rebar_schedule", read_only: true, refused: true, code, message, transaction: false }, true);
}

function standardsOf(io: RebarIo): Record<string, unknown> | null {
  if (io.standards !== undefined) return io.standards;
  const env = io.env ?? process.env;
  const direct = (env.FMC_STANDARDS_FILE ?? "").trim();
  const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  if (direct) {
    try { return read(direct); } catch { return null; }
  }
  try {
    const loaded = io.guard ? { config: io.guard } : loadConfig(configPath(env));
    return read(path.win32.join(path.win32.dirname(kitPaths(loaded.config).recipesDir), "FMC_Standards_Building.json"));
  } catch {
    return null;
  }
}

/** call > standards entry with a clause (draft, approved or no status) > fallback. A provisional value cannot PASS. */
export function citeValue(standards: Record<string, unknown> | null | undefined, key: string, callValue: number | undefined, fallback: number | null): CitedValue {
  if (typeof callValue === "number" && Number.isFinite(callValue)) {
    return { key, value: callValue, source: "call", clause: "Given in the call.", can_pass: true };
  }
  const bag = standards && typeof standards.standards === "object" && standards.standards && !Array.isArray(standards.standards)
    ? standards.standards as Record<string, unknown>
    : (standards ?? {});
  const entry = bag[key] as { value?: unknown; status?: string; clause?: string; note?: string } | undefined;
  if (entry && typeof entry === "object" && entry.value != null && entry.value !== "") {
    const value = Number(entry.value);
    const status = String(entry.status ?? "").trim().toLowerCase();
    const clause = String(entry.clause || "").trim();
    if (Number.isFinite(value) && clause && (status === "" || status === "draft" || status === "approved")) {
      return { key, value, source: "standards", clause, can_pass: true };
    }
    if (Number.isFinite(value)) {
      return { key, value, source: "provisional", clause: clause || "PROVISIONAL bank entry without a clause. It cannot PASS.", can_pass: false };
    }
  }
  if (fallback == null) return { key, value: null, source: "none", clause: "Not in the call or the standards bank.", can_pass: true };
  return { key, value: fallback, source: "provisional", clause: `PROVISIONAL default ${fallback} mm. Not in the standards bank. It cannot PASS.`, can_pass: false };
}

export function rebarDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_REBAR_DIR ?? "").trim()) return env.FMC_REBAR_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(path.sep, "tmp", "FormcraftLocal");
  return path.join(local, "Formcraft", "rebar");
}

function writeReport(env: NodeJS.ProcessEnv, body: unknown, csv: string, dir = rebarDir(env)): { json: string; csv: string } {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const json = path.join(dir, `rebar-schedule-${stamp}.json`);
  const csvFile = path.join(dir, `rebar-schedule-${stamp}.csv`);
  fs.writeFileSync(json, JSON.stringify(body, null, 2));
  fs.writeFileSync(csvFile, csv);
  return { json, csv: csvFile };
}

function asFacts(raw: unknown): RebarFact[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row) => row && typeof row === "object" && Number((row as RebarFact).diameter_mm) > 0) as RebarFact[];
}

function verdict(failures: number, canPass: boolean): "PASS" | "FAIL" | "PROVISIONAL" {
  if (failures > 0) return "FAIL";
  return canPass ? "PASS" : "PROVISIONAL";
}

export async function runFmcRebarSchedule(args: FmcRebarScheduleArgs, io: RebarIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) {
      return reply({
        tool: "fmc_rebar_schedule", read_only: true, refused: true, code: "FMC-DOC-REQUIRED", transaction: false,
        message: "[FMC-DOC-REQUIRED] fmc_rebar_schedule needs document: a title or a full path. Refusing to use the active document.",
      }, true);
    }
    const body = { document: args.document, host_ids: args.host_ids };
    const snapshot = (io.read
      ? await io.read(body)
      : await withRevitConnection((client) => client.sendCommand("fmc_rebar_schedule", body, 180000))) as Record<string, unknown>;
    if (snapshot.refused || snapshot.code) {
      return reply({
        tool: "fmc_rebar_schedule", read_only: true, refused: true, transaction: false,
        code: snapshot.code || "FMC-REBAR", message: snapshot.message || "The read was refused.",
      }, true);
    }
    const marks = new Set(args.marks.map((m) => m.trim().toLowerCase()).filter(Boolean));
    const hosts = new Set(args.host_ids.map((h) => h.trim()).filter(Boolean));
    let facts = asFacts(snapshot.rebars);
    if (hosts.size) facts = facts.filter((f) => hosts.has(String(f.host_id ?? "")));
    if (marks.size) facts = facts.filter((f) => marks.has(String(f.mark ?? "").trim().toLowerCase()));

    const standards = standardsOf(io);
    const cover = citeValue(standards, MIN_COVER_KEY, args.min_cover_mm, null);
    const aggregate = citeValue(standards, AGGREGATE_KEY, args.aggregate_mm, PROVISIONAL_AGGREGATE_MM);
    const rows = buildSchedule(facts, { grade_letter: args.grade_letter, round_mm: args.round_mm });
    const mass = massSummary(rows);
    const coverResult = coverChecks(facts, { min_cover_mm: cover.value });
    const spacingResult = spacingChecks(facts, aggregate.value ?? PROVISIONAL_AGGREGATE_MM);
    const marksResult = markConflicts(rows);
    const failures = [...coverResult.failures, ...spacingResult.failures, ...marksResult];
    const checks = {
      cover: {
        status: verdict(coverResult.failures.length, coverResult.checked > 0 || cover.value != null),
        min_cover: cover,
        measured: coverResult.checked,
        unmeasured: coverResult.unmeasured.length,
        failures: coverResult.failures.length,
        method: "Bar centre-line extents against the host bounding box, less half the bar. Exact for hosts square to the project axes.",
      },
      spacing: {
        status: verdict(spacingResult.failures.length, aggregate.can_pass),
        aggregate,
        rule: "clear = spacing - bar size >= max(bar size, aggregate + 5 mm, 20 mm)",
        min_clear_example_mm: minClearSpacingMm(12, aggregate.value ?? PROVISIONAL_AGGREGATE_MM),
        checked: spacingResult.checked,
        failures: spacingResult.failures.length,
      },
      marks: { status: marksResult.length ? "FAIL" : "PASS", failures: marksResult.length },
    };
    const resolved = (snapshot.resolved_document ?? {}) as { title?: string; path?: string };
    const notes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
    const fileBody = {
      document: resolved.title || args.document,
      path: resolved.path || "",
      standard: BS8666_EDITION,
      columns: SCHEDULE_COLUMNS,
      rows,
      mass,
      checks,
      failures,
      notes,
    };
    const report = writeReport(env, fileBody, scheduleCsv(rows), io.reportDir);
    const sample = args.sample_limit;
    return reply({
      tool: "fmc_rebar_schedule",
      read_only: true,
      applied: false,
      transaction: false,
      saved: false,
      synced: false,
      images: [] as [],
      document: resolved.title || args.document,
      resolved_document: { title: resolved.title || "", path: resolved.path || "" },
      standard: BS8666_EDITION,
      rebar_sets: facts.length,
      rows_count: rows.length,
      rows: rows.slice(0, sample),
      rows_truncated: rows.length > sample,
      mass,
      checks,
      failure_count: failures.length,
      failures: failures.slice(0, sample),
      failures_truncated: failures.length > sample,
      notes,
      report,
      cites: {
        standard: `${BS8666_EDITION} Table 1 (unit mass), Table 2 (minimum radius), Table 3 (shape codes)`,
        standards: `FMC-BIM-STD-002 ${MIN_COVER_KEY}, ${AGGREGATE_KEY}`,
        rulebook: "Read-only. No transaction and no rollback. Checks are reported, not decided: a structural engineer signs off cover and spacing.",
      },
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcRebarScheduleTool(server: McpServer) {
  server.tool("fmc_rebar_schedule", FMC_REBAR_SCHEDULE_DESCRIPTION, FMC_REBAR_SCHEDULE_SHAPE, async (args) => runFmcRebarSchedule(args as FmcRebarScheduleArgs));
}
