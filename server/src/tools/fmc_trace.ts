import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { splitCheckout } from "../fmc/coordination.js";
import { loadConfig } from "../fmc/policy.js";
import { resolve, type Resolved } from "../fmc/standards.js";
import { batchLease } from "../fmc/target.js";
import {
  catalogue,
  resolveTraceLimits,
  selectChecks,
  summarizeTrace,
  traceFromSnapshot,
  traceReportHostDir,
  writeTraceReport,
  type LimitKey,
  type TraceFilter,
  type TraceSnapshot,
} from "../fmc/trace.js";
import { dropOwnedEdits, PHASE2_DEFAULTS, planFixes, refuseTraceWrite, type TraceEdit } from "../fmc/trace_phase2.js";
import { countSystems, editsForRecommendations, recommend, summariseCounts, summariseRecommendations } from "../fmc/trace_phase3.js";

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
  "missing: parts a working system should have (trap, waste, isolation, cleanout, vent, fitting, cap, source, rating, main, switch, earth, duct system, damper). " +
  "standards: PASS, FAIL, UNKNOWN or PROVISIONAL per element, and compliant, not compliant or incomplete data per system. " +
  "A PASS is only against a trace.* value in the standards bank. A missing key is PROVISIONAL and is not a pass. " +
  "fix: a deterministic correction plan. dry_run defaults to true and returns the edits. dry_run false needs batch_lease and runs fmc_trace_apply, one transaction, " +
  "skipping elements owned by someone else or not current. The transaction rolls back if the failure count rises. " +
  "caps true is required before an end cap is planned. circuit is the circuit id for an unpowered device; a panel alone does not choose a circuit. " +
  "counts: a bill of quantities from that same snapshot (fixtures, fixture units, fittings, valves, traps, cleanouts, vents, pipe and duct length by size, terminals, dampers, circuits, loads, phases, spare ways when the panel stores them, cable length when modelled, orphans). " +
  "recommend: actionable items with a code, the element or system, the current value, the target, and the standards key. PROVISIONAL when the key is not in the bank. " +
  "fix recommendations takes those ids. A resize, a cap and a system assignment are applied. A split, a regrade, a cleanout and a valve stay advisory. " +
  "HEBERT HOSTELS, a central model, and protected_paths are refused. " +
  "Not run yet: duct_airflow, fitting_corner, earthing, tray_fill. " +
  "Example: action leak, document F26901-FMC-ZZ-ZZ-M3-P-0001_USER. Example: action continuity, document F26901-FMC-ZZ-ZZ-M3-E-0001_USER.";

const limit = (key: string) => z.number().optional().describe(`${key} override. PROVISIONAL when omitted.`);

export const FMC_TRACE_SHAPE = {
  action: z.enum(["checks", "limits", "leak", "continuity", "run", "missing", "standards", "counts", "recommend", "fix"]),
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
  dry_run: z.boolean().optional().default(true).describe("fix: return the plan unless false. A real apply needs batch_lease."),
  caps: z.boolean().optional().default(false).describe("fix: include end caps. Off unless you ask."),
  circuit: z.string().optional().default("").describe("fix: element id of the circuit an unpowered device should join."),
  max_edits: z.number().int().min(1).max(100).optional().default(25).describe("fix: how many corrections one call may plan or apply."),
  recommendations: z.array(z.string()).optional().default([]).describe("fix: recommendation ids from fmc_trace recommend. Only the deterministic ones are edited."),
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
  if (args.action === "checks") return reply({ ...catalogue(), phase2_defaults: PHASE2_DEFAULTS, not_run: ["duct_airflow", "fitting_corner", "earthing", "tray_fill"] });
  if (args.action === "limits") return reply({ tool: "fmc_trace", read_only: true, limits: resolved.limits, standard_keys: catalogue().standard_keys, phase2_defaults: PHASE2_DEFAULTS, api_limits: catalogue().api_limits });
  if (args.action === "counts" || args.action === "recommend") return countOrRecommend(args, resolved.limits);
  if (args.action === "fix") return fixTrace(args, resolved.limits);

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
  const filter = { ...filterOf(args), bank: traceBank() };
  const runs = traceFromSnapshot(snapshot, selection, resolved.limits, filter);
  const report = writeTraceReport(snapshot, runs, resolved.limits, filter);
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

function traceBank(): TraceFilter["bank"] {
  try {
    const { config } = loadConfig();
    const file = path.win32.join(path.win32.dirname(kitPaths(config).recipesDir), "FMC_Standards_Building.json");
    const kit = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const out: NonNullable<TraceFilter["bank"]> = {};
    for (const row of resolve(kit, null) as Resolved[]) {
      if (!row.key.startsWith("trace.")) continue;
      const value = typeof row.value === "number" ? row.value : Number(row.value);
      if (!Number.isFinite(value) || value < 0) continue;
      out[row.key] = { value, clause: row.note || row.status || "standards bank" };
    }
    return out;
  } catch {
    return {};
  }
}

async function countOrRecommend(args: FmcTraceArgs, limits: { values: { near_miss_mm: number; direction_deg: number; size_mismatch_mm: number; touch_mm: number; connected_gap_mm: number; voltage_tol_v: number } }) {
  let snapshot: TraceSnapshot;
  try {
    snapshot = await withRevitConnection((client) => client.sendRaw("fmc_trace", { mode: "snapshot", checks: ["counts"] }, 300000)) as TraceSnapshot;
  } catch (error) {
    return reply({ tool: "fmc_trace", read_only: true, error: error instanceof Error ? error.message : String(error) }, true);
  }
  const filter = { ...filterOf(args), bank: traceBank() };
  const counts = countSystems(snapshot);
  const items = args.action === "recommend" ? recommend(snapshot, filter, limits) : [];
  const report = writeJson(snapshot, args.action === "counts" ? { counts } : { counts, recommendations: items });
  const sample = args.sample_limit;
  return reply({
    tool: "fmc_trace", read_only: true, action: args.action, report,
    ...(args.action === "counts" ? summariseCounts(counts, sample) : summariseRecommendations(items, sample)),
  });
}

async function fixTrace(args: FmcTraceArgs, limits: { values: { near_miss_mm: number; direction_deg: number; size_mismatch_mm: number; touch_mm: number; connected_gap_mm: number; voltage_tol_v: number } }) {
  let snapshot: TraceSnapshot;
  try {
    snapshot = await withRevitConnection((client) => client.sendRaw("fmc_trace", { mode: "snapshot", checks: ["missing", "leak", "continuity"] }, 300000)) as TraceSnapshot;
  } catch (error) {
    return reply({ tool: "fmc_trace", read_only: true, error: error instanceof Error ? error.message : String(error) }, true);
  }
  const { config } = loadConfig();
  const refusal = refuseTraceWrite({ title: snapshot?.model, path: snapshot?.resolved_document?.path, is_central: snapshot?.is_central }, config.protected_paths ?? []);
  if (refusal) return reply({ tool: "fmc_trace", refused: true, reasons: [refusal] }, true);
  const named = args.recommendations ?? [];
  const advice = named.length ? editsForRecommendations(recommend(snapshot, { ...filterOf(args), bank: traceBank() }, limits), named) : null;
  const plan = advice
    ? { edits: advice.edits.slice(0, args.max_edits), warnings: [...advice.advisory.map((item) => `${item.id} is advisory and was not edited`), ...advice.unknown.map((id) => `${id} is not a recommendation`)], rule: "Recommendations: a resize, a cap and a system assignment can be edited. The rest stay advisory.", capped: advice.edits.length > args.max_edits }
    : planFixes(snapshot, limits, { caps: args.caps, circuit: args.circuit, max: args.max_edits });
  let skipped: Array<{ id: string; code: string; owner: string }> = [];
  try {
    const currency = await withRevitConnection((client) => client.sendRaw("fmc_elem_currency", { ids: plan.edits.flatMap((edit) => edit.ids) }, 60000)) as { elements?: Array<{ id: string; owner?: string; checkout?: string; updates?: string }> };
    skipped = splitCheckout(plan.edits.flatMap((edit) => edit.ids).map(String), currency?.elements ?? []).skipped;
  } catch { /* an older add-in still partitions inside the apply */ }
  const edits = dropOwnedEdits(plan.edits, skipped);
  if (args.dry_run !== false) {
    return reply({
      tool: "fmc_trace", dry_run: true, read_only: true, edits, skipped, warnings: plan.warnings, rule: plan.rule, capped: plan.capped,
      document: snapshot.resolved_document ?? { title: snapshot.model ?? "", path: "" },
      next: "Show this plan. Apply with dry_run false and batch_lease. caps and circuit stay as you set them.",
    });
  }
  if (!batchLease.getStore()) return reply({ tool: "fmc_trace", refused: true, reasons: ["fix with dry_run false needs batch_lease from fmc_batch request."] }, true);
  try {
    const applied = await withRevitConnection((client) => client.sendCommand("fmc_trace_apply", {
      edits, ids: edits.flatMap((edit: TraceEdit) => edit.ids), near_miss_mm: limits.values.near_miss_mm,
      size_mismatch_mm: limits.values.size_mismatch_mm, max_edits: args.max_edits,
    }, 300000)) as Record<string, unknown>;
    const report = correctionReport(snapshot, edits, applied);
    return reply({ tool: "fmc_trace", dry_run: false, ...applied, planned: edits.length, skipped, warnings: plan.warnings, rule: plan.rule, report });
  } catch (error) {
    return reply({ tool: "fmc_trace", error: error instanceof Error ? error.message : String(error) }, true);
  }
}

function correctionReport(snapshot: TraceSnapshot, edits: TraceEdit[], applied: Record<string, unknown>): string {
  return writeJson(snapshot, { before: { model: snapshot.model, resolved_document: snapshot.resolved_document }, edits, after: applied }, "fix");
}

function writeJson(snapshot: TraceSnapshot, body: unknown, kind = "trace"): string {
  const dir = traceReportHostDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `trace-${kind}-${(snapshot.model || "model").replace(/[<>:"|?*\\/]/g, "_").slice(0, 40)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

export function registerFmcTraceTool(server: McpServer) {
  server.tool("fmc_trace", FMC_TRACE_DESCRIPTION, FMC_TRACE_SHAPE, (args) => runFmcTrace(args));
}
