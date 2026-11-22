import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import {
  catalogue,
  resolveTraceLimits,
  selectChecks,
  summarizeTrace,
  traceFromSnapshot,
  writeTraceReport,
  type LimitKey,
  type TraceFilter,
  type TraceSnapshot,
} from "../fmc/trace.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_TRACE_DESCRIPTION =
  "Formcraft systems flow tracer, read-only. Walks piping, drainage and duct connectors the way water or air would, " +
  "and walks electrical circuits the way current would, and reports where the run stops. No transaction, no ownership " +
  "checkout, no save. The active document and the active view are not changed. " +
  "Pass document (exact title or full path) whenever more than one document is open. A name that matches nothing is " +
  "FMC-DOC-NOT-FOUND, a name that matches two documents is FMC-DOC-AMBIGUOUS, and several open documents with no name is " +
  "FMC-DOC-REQUIRED. A closed file is not opened. " +
  "actions: checks (catalogue, no Revit), limits (tolerances and standards-bank keys, no Revit), " +
  "leak (one system, one source element, or every piping and duct system), continuity (one panel or every panel), " +
  "run (leak and continuity, or checks, in one Revit round-trip per document). " +
  "domain: piping, duct or both. " +
  "The reply is pass/fail counts per check and a capped list of element ids with a problem code. " +
  "The full findings are a JSON file under %LOCALAPPDATA%\\Formcraft\\trace and the reply includes that path. " +
  "Codes: FLOW-OPEN-END, FLOW-NOT-CONNECTED, FLOW-SIZE-MISMATCH, FLOW-NEAR-MISS, FLOW-NO-SYSTEM, FLOW-ISLAND, " +
  "ELEC-NO-CIRCUIT, ELEC-NO-PANEL, ELEC-NO-SUPPLY, ELEC-VOLTAGE-MISMATCH, ELEC-EMPTY-CIRCUIT. " +
  "FLOW-NOT-CONNECTED is an open connector within touch_mm of another element's bounding box with no connector pair within near_miss_mm. " +
  "highlight: off (default), ids (capped id list only) or temporary (View.IsolateElementsTemporary on the active view when this document is already active; never saved; a background document is not activated). " +
  "Tolerances are PROVISIONAL until the standards bank has trace.near_miss_mm, trace.touch_mm, trace.size_mismatch_mm, trace.direction_deg, trace.connected_gap_mm and trace.voltage_tol_v. " +
  "Later checks are named and not run: drainage_fall, venting, cross_connection, dead_legs, pressure_flow, duct_airflow, fitting_corner, voltage_drop, overload, phase_balance, earthing, tray_fill. " +
  "Example: action leak, document P-0001_USER. Example: action continuity, document E-0001_USER.";

const limit = (key: string) => z.number().optional().describe(`${key} override. PROVISIONAL when omitted.`);

export const FMC_TRACE_SHAPE = {
  action: z.enum(["checks", "limits", "leak", "continuity", "run"]),
  checks: z.array(z.string()).optional().describe("run: check ids. Default leak and continuity. Phase 2 ids are skipped."),
  system: z.string().optional().default("").describe("leak: piping or duct system name, classification or element id. Empty checks every system."),
  source: z.string().optional().default("").describe("leak: element id to walk from. Empty uses each system's base equipment, or the largest connected part when a system has none."),
  domain: z.enum(["piping", "duct", "both"]).optional().default("both"),
  panel: z.string().optional().default("").describe("continuity: panel name or element id. Empty checks every panel. Devices on no circuit and circuits with no panel are still reported."),
  near_miss_mm: limit("near_miss_mm (default 50)"),
  touch_mm: limit("touch_mm (default 10)"),
  size_mismatch_mm: limit("size_mismatch_mm (default 2)"),
  direction_deg: limit("direction_deg (default 15)"),
  connected_gap_mm: limit("connected_gap_mm (default 15)"),
  voltage_tol_v: limit("voltage_tol_v (default 15)"),
  sample_limit: z.number().int().min(1).max(100).optional().default(20).describe("How many element ids the reply keeps per check. The JSON file keeps all of them."),
  highlight: z.enum(["off", "ids", "temporary"]).optional().default("off"),
};

export type FmcTraceArgs = z.infer<z.ZodObject<typeof FMC_TRACE_SHAPE>>;

export function parseTraceArgs(input: unknown): FmcTraceArgs {
  return z.object(FMC_TRACE_SHAPE).parse(input);
}

function filterOf(args: FmcTraceArgs): TraceFilter {
  return {
    system: args.system,
    source: args.source,
    domain: args.domain,
    panel: args.panel,
  };
}

function overrides(args: FmcTraceArgs): Partial<Record<LimitKey, number>> {
  const out: Partial<Record<LimitKey, number>> = {};
  const keys: LimitKey[] = ["near_miss_mm", "touch_mm", "size_mismatch_mm", "direction_deg", "connected_gap_mm", "voltage_tol_v"];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

async function highlightTemporary(ids: number[]): Promise<{ applied: boolean; reason?: string }> {
  if (!ids.length) return { applied: false, reason: "Nothing to highlight." };
  try {
    const result = await withRevitConnection((client) => client.sendRaw("fmc_trace", { mode: "highlight", ids: ids.slice(0, 2000) }, 60000)) as { applied?: boolean; reason?: string };
    return { applied: result?.applied === true, reason: typeof result?.reason === "string" ? result.reason : undefined };
  } catch (error) {
    return { applied: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function runFmcTrace(args: FmcTraceArgs) {
  const resolved = resolveTraceLimits(overrides(args));
  if (!resolved.ok) return reply({ refused: true, read_only: true, reasons: [resolved.message] }, true);
  if (args.action === "checks") return reply(catalogue());
  if (args.action === "limits") return reply({ tool: "fmc_trace", read_only: true, limits: resolved.limits, standard_keys: catalogue().standard_keys, api_limits: catalogue().api_limits });

  const selection = selectChecks(args.action, args.checks);
  if (!selection.run.length) {
    return reply({
      tool: "fmc_trace",
      read_only: true,
      pass: false,
      ran: [],
      skipped: selection.skipped,
      unknown: selection.unknown,
      note: "None of the requested checks run in phase 1. fmc_trace checks lists them.",
    });
  }
  let snapshot: TraceSnapshot;
  try {
    snapshot = await withRevitConnection((client) => client.sendRaw("fmc_trace", {
      mode: "snapshot",
      checks: selection.run.map((check) => check.id),
    }, 300000)) as TraceSnapshot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ tool: "fmc_trace", read_only: true, error: message }, true);
  }
  if (!snapshot || typeof snapshot !== "object") return reply({ tool: "fmc_trace", read_only: true, error: "fmc_trace returned no graph" }, true);
  const runs = traceFromSnapshot(snapshot, selection, resolved.limits, filterOf(args));
  const report = writeTraceReport(snapshot, runs, resolved.limits, filterOf(args));
  let highlightResult: { applied?: boolean; reason?: string } | undefined;
  if (args.highlight === "temporary") {
    const ids = [...new Set(runs.flatMap((run) => run.findings.map((finding) => finding.id)))];
    highlightResult = await highlightTemporary(ids);
  }
  const summary = summarizeTrace(runs, {
    limits: resolved.limits,
    skipped: selection.skipped,
    unknown: selection.unknown,
    sampleLimit: args.sample_limit,
    highlight: args.highlight,
    report,
    snapshot,
    highlightResult,
  });
  return reply(summary);
}

export function registerFmcTraceTool(server: McpServer) {
  server.tool("fmc_trace", FMC_TRACE_DESCRIPTION, FMC_TRACE_SHAPE, (args) => runFmcTrace(args));
}
