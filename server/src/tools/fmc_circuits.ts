import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { loadConfig, protectedNameHit, protectedNames, type GuardConfig } from "../fmc/policy.js";
import { batchBoard } from "../fmc/batchline.js";
import { batchLease } from "../fmc/target.js";
import { traceEntriesFromStandards, type TraceBankEntry } from "../fmc/trace_bank.js";
import { kitPaths } from "../fmc/context.js";
import fs from "node:fs";
import path from "node:path";
import {
  DISTRIBUTION_HINT, auditCircuits, circuitCaps, planCircuits, sampleIds, TARGET_DISTRIBUTION, voltageDropLimit,
  type CircuitDevice, type CircuitPanel, type ExistingCircuit,
} from "../fmc/circuitplan.js";
import { writeReport } from "../fmc/localreport.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_CIRCUITS_DESCRIPTION =
  "Formcraft power and lighting circuits. Actions: plan (group unassigned lighting fixtures, lighting devices, electrical fixtures and devices by room, then level, then kind), " +
  "apply (ElectricalSystem.Create, SelectPanel, name, number, breaker, poles and wire size where the API allows, and FMC_Phase), " +
  "panel (distribution system, supply, feeder, main rating and mains type; parameters the API cannot set are listed), " +
  "audit (unassigned by category and level, overloaded circuits, voltage or pole mismatches, panels with no supply, suspect panelboards), " +
  "limits (the caps and whether each one is PROVISIONAL). " +
  "Lighting and sockets are never on one circuit. Kinds are L, R, AC, SH and STAIR. The name pattern is {board}/{zone}-{type}{n}, for example DB-BQ/A1-L. " +
  "Phases are balanced across L1, L2 and L3. A panel in accept_no_supply, or marked utility-fed, may have no supply. " +
  "A board is electrical equipment whose part type is Panelboard, Switchboard or Other Panel, or whose family has a panel-schedule MEP connector (power balanced or unbalanced). " +
  "It is not refused for being a board family. When that board has no distribution system, apply replies FMC-PANEL-NO-DISTRIBUTION with a dry-run plan that sets the Distribution System parameter; the panel action is let through, because it is the step that sets it. " +
  "Devices are grouped by connector voltage and poles and assigned only to a panel whose distribution system matches (1-pole uses line-to-ground, 2-pole and 3-pole use line-to-line, 3-pole needs three-phase). " +
  "A group Revit would refuse in SelectPanel is FMC-CIRCUIT-PANEL-MISMATCH and names the panel line-to-line and line-to-ground voltage against the device connector. " +
  "non_board_ids are panel part types that are loads (SPD, isolator, pump control). Families with no electrical connector are FMC-NO-CONNECTOR, grouped by family. " +
  "Assignment uses MEPModel.GetElectricalSystems, not Connector.IsConnected. Data, telephone and fire alarm are skipped. " +
  "Switch-to-luminaire groups are included when include_switches is true. " +
  "dry_run defaults to true. apply and panel with dry_run false need batch_lease, and that lease must be the active fmc_batch lease on this document (a queued, released or other document's lease is FMC-BATCH-LOCKED). One Revit transaction, one subtransaction per circuit. " +
  "A real apply returns created_ids (the new circuits) and undo { tool: fmc_batch_undo, batch_id: the lease }, and results: one row per planned circuit, created, failed or not_reported. " +
  "Pass document (exact title or full path) when more than one document is open. " +
  "Project names in the guard config's protected_names (default HEBERT HOSTELS), a central model and protected_paths are refused. Numeric caps come from trace.circuit.* keys. A missing key is PROVISIONAL and uses the stated default. " +
  "The reply is counts and a capped id list. The full plan is JSON under %LOCALAPPDATA%\\Formcraft\\circuits. No pictures. " +
  "Example document: F26901-FMC-ZZ-ZZ-M3-E-0001_USER.";

const shape = {
  action: z.enum(["plan", "apply", "panel", "audit", "limits"]),
  document: z.string().optional().default("").describe("Exact title or full path of the open document."),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  panel: z.string().optional().default("").describe("Panel name or element id. Empty picks the nearest board, preferring the same level."),
  pattern: z.string().optional().default("{board}/{zone}-{type}{n}"),
  load_unit: z.enum(["W", "VA"]).optional().default("W"),
  distribution: z.string().optional().default(TARGET_DISTRIBUTION),
  accept_no_supply: z.array(z.string()).optional().default([]),
  non_board_ids: z.array(z.number().int()).optional().default([]),
  include_switches: z.boolean().optional().default(false),
  supply_from: z.string().optional().default(""),
  feeder: z.string().optional().default(""),
  mains_a: z.number().optional(),
  mains_type: z.string().optional().default(""),
  sample_limit: z.number().int().min(1).max(100).optional().default(40),
  ids: z.array(z.number().int()).optional().describe("apply: only these device ids. Omit it to apply the whole plan."),
};

export type FmcCircuitsArgs = z.infer<z.ZodObject<typeof shape>>;

export interface CircuitsSnapshot {
  model?: string;
  resolved_document?: { title?: string; path?: string };
  is_central?: boolean;
  devices?: CircuitDevice[];
  panels?: CircuitPanel[];
  circuits?: ExistingCircuit[];
  skipped_non_family?: { count?: number; ids?: number[] };
}

export interface CircuitsIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  bank?: Record<string, TraceBankEntry>;
  guard?: GuardConfig;
  env?: NodeJS.ProcessEnv;
  /** Who holds the batch lease on a document now. Defaults to the batch board. */
  holder?: (document: string) => { lease: string; client: string } | null;
}

function fail(code: string, message: string, hint: string) {
  return reply({ ok: false, code, message: `[${code}] ${message}`, hint }, true);
}

function bankOf(io: CircuitsIo): Record<string, TraceBankEntry> {
  if (io.bank) return io.bank;
  try {
    const { config } = loadConfig();
    const file = path.win32.join(path.win32.dirname(kitPaths(config).recipesDir), "FMC_Standards_Building.json");
    const kit = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { standards?: Record<string, unknown> };
    return traceEntriesFromStandards(kit.standards);
  } catch {
    return {};
  }
}

function guard(snapshot: CircuitsSnapshot, io: CircuitsIo, named = ""): string | null {
  const config = io.guard ?? loadConfig().config;
  const title = snapshot.resolved_document?.title || snapshot.model || "";
  const file = snapshot.resolved_document?.path || "";
  const hit = protectedNameHit([title, file, named], protectedNames(config));
  if (hit) return `${hit} is a protected project (guard config protected_names) and is not written by fmc_circuits.`;
  if (snapshot.is_central) return "A central model is not written by fmc_circuits.";
  const pathName = file.replace(/\//g, "\\").toLowerCase();
  for (const root of config.protected_paths ?? []) {
    const norm = root.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (norm && (pathName === norm || pathName.startsWith(norm + "\\"))) return `The document is under a protected path (${root}).`;
  }
  return null;
}

/**
 * The lease must be the active (granted) batch lease on this document. A non-empty string is not enough: a queued,
 * released, expired or made-up lease, or another document's lease, is refused here before Revit is called.
 */
export function checkCircuitLease(lease: string, names: string[], io: CircuitsIo = {}): string | null {
  const holderOf = io.holder ?? ((document: string) => batchBoard().activeHolder(document));
  const docs = [...new Set(names.map((name) => String(name ?? "").trim()).filter(Boolean))];
  if (!docs.length) return "No document was resolved, so the lease cannot be checked against it. Pass document. Nothing was changed.";
  let held: { lease: string; client: string } | null = null;
  for (const doc of docs) {
    try { held = holderOf(doc); } catch (error) { return `${error instanceof Error ? error.message : String(error)} Nothing was changed.`; }
    if (held) break;
  }
  if (!held) return `Lease ${lease} is not the active batch lease on ${docs[0]}: nobody holds that document now (the lease is queued, released, expired or unknown). Nothing was changed.`;
  if (held.lease !== lease.trim()) return `${docs[0]} is held by another batch lease, not ${lease}. Nothing was changed.`;
  return null;
}

export interface CircuitResult { name: string; status: "created" | "failed" | "not_reported"; id?: number; error?: string; element_ids: number[] }

/** One row per planned circuit: created (with its id), failed (with Revit's reason) or not_reported. Nothing is dropped. */
export function circuitResults(planned: Array<{ name: string; element_ids: number[] }>, applied: Record<string, unknown>): { results: CircuitResult[]; created_ids: number[] } {
  const created = (Array.isArray(applied.created) ? applied.created : []) as Array<Record<string, unknown>>;
  const failed = (Array.isArray(applied.failed) ? applied.failed : []) as Array<Record<string, unknown>>;
  const made = new Map<string, number>();
  const created_ids: number[] = [];
  for (const row of created) {
    if (row?.op === "switch") continue;
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    created_ids.push(id);
    if (typeof row.name === "string") made.set(row.name, id);
  }
  if (Array.isArray(applied.created_ids)) {
    for (const value of applied.created_ids) {
      const id = Number(value);
      if (Number.isFinite(id) && id > 0 && !created_ids.includes(id)) created_ids.push(id);
    }
  }
  const errors = new Map<string, string>();
  for (const row of failed) if (typeof row?.name === "string" && row.name) errors.set(row.name, String(row.error ?? "failed"));
  const results = planned.map((circuit): CircuitResult => {
    const id = made.get(circuit.name);
    if (id !== undefined) return { name: circuit.name, status: "created", id, element_ids: circuit.element_ids };
    const error = errors.get(circuit.name);
    if (error !== undefined) return { name: circuit.name, status: "failed", error, element_ids: circuit.element_ids };
    return { name: circuit.name, status: "not_reported", error: "Revit's reply did not name this circuit. Check the model before retrying.", element_ids: circuit.element_ids };
  });
  return { results, created_ids };
}

async function readSnapshot(args: FmcCircuitsArgs, io: CircuitsIo): Promise<CircuitsSnapshot> {
  const body = { mode: "snapshot", document: args.document, non_board_ids: args.non_board_ids };
  if (io.read) return await io.read(body) as CircuitsSnapshot;
  return await withRevitConnection((client) => client.sendRaw("fmc_circuits", body, 300000)) as CircuitsSnapshot;
}

export async function runFmcCircuits(args: FmcCircuitsArgs, io: CircuitsIo = {}) {
  const bank = bankOf(io);
  if (args.action === "limits") {
    return reply({ tool: "fmc_circuits", read_only: true, caps: circuitCaps(bank), voltage_drop: voltageDropLimit(bank), distribution: args.distribution || TARGET_DISTRIBUTION, rule: "A missing key is PROVISIONAL. It is not a pass." });
  }
  let snapshot: CircuitsSnapshot;
  try {
    snapshot = await readSnapshot(args, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ tool: "fmc_circuits", read_only: true, error: message }, true);
  }
  const devices = snapshot.devices ?? [];
  const panels = snapshot.panels ?? [];
  const plan = planCircuits({
    devices, panels, bank, panel: args.panel, pattern: args.pattern, load_unit: args.load_unit,
    non_board_ids: args.non_board_ids, include_switches: args.include_switches, distribution: args.distribution,
  });
  const listed = args.ids;
  const circuits = listed
    ? plan.circuits.flatMap((circuit) => {
      const element_ids = circuit.element_ids.filter((id) => listed.includes(id));
      return element_ids.length ? [{ ...circuit, element_ids, points: element_ids.length }] : [];
    })
    : plan.circuits;
  const audit = args.action === "audit" || args.action === "plan"
    ? auditCircuits({ devices, panels, circuits: snapshot.circuits ?? [], bank, accept_no_supply: args.accept_no_supply, non_board_ids: args.non_board_ids, distribution: args.distribution })
    : null;
  const ids = sampleIds(circuits.flatMap((circuit) => circuit.element_ids), args.sample_limit);
  const report = writeReport("circuits", args.action, { plan: { ...plan, circuits }, audit, snapshot: { model: snapshot.model, resolved_document: snapshot.resolved_document } }, io.env);
  const distribution_plans = plan.distribution_plans ?? [];
  const mismatches = plan.mismatches ?? [];
  const no_connector_families = plan.no_connector_families ?? [];
  if (args.action === "panel" && !args.panel.trim()) {
    return fail("FMC-CIRCUIT-PANEL-REQUIRED", `Name the board to set (panel). Boards with no distribution system: ${distribution_plans.map((row) => row.panel).join(", ") || "none"}.`, "Pass panel with the board name or element id, and distribution.");
  }
  // The panel action is the step that sets a missing distribution system, so FMC-PANEL-NO-DISTRIBUTION only stops apply.
  if (args.action === "apply" && circuits.length === 0 && (distribution_plans.length > 0 || mismatches.length > 0)) {
    const code = distribution_plans.length > 0 ? "FMC-PANEL-NO-DISTRIBUTION" : "FMC-CIRCUIT-PANEL-MISMATCH";
    const message = code === "FMC-PANEL-NO-DISTRIBUTION"
      ? `[FMC-PANEL-NO-DISTRIBUTION] ${distribution_plans[0].panel} has no distribution system.`
      : `[FMC-CIRCUIT-PANEL-MISMATCH] ${mismatches[0].detail}`;
    return reply({
      tool: "fmc_circuits", ok: false, code, dry_run: true, read_only: true,
      message, hint: code === "FMC-PANEL-NO-DISTRIBUTION" ? DISTRIBUTION_HINT : "Group the devices by connector voltage and poles, and use a panel whose distribution system matches. Nothing was changed.",
      distribution_plans, mismatches, no_connector_families,
      document: snapshot.resolved_document ?? { title: snapshot.model ?? args.document, path: "" },
      report,
    }, true);
  }
  if (args.action === "plan" || args.action === "audit") {
    return reply({
      tool: "fmc_circuits", read_only: true, action: args.action, document: snapshot.resolved_document ?? { title: snapshot.model ?? args.document, path: "" },
      counts: plan.counts, circuits: circuits.map((circuit) => ({ name: circuit.name, kind: circuit.kind, panel: circuit.panel_name, phase: circuit.phase, slot: circuit.slot, points: circuit.points, load_w: circuit.load_w, ids: circuit.element_ids.slice(0, 20), flags: circuit.flags, provisional: circuit.provisional })),
      skipped: plan.skipped.slice(0, args.sample_limit), skipped_total: plan.skipped.length, mismatches, no_connector_families, switches: plan.switches.slice(0, args.sample_limit), switches_total: plan.switches.length,
      phase: plan.phase, audit: audit ? { counts: audit.counts, findings: audit.findings.slice(0, args.sample_limit), findings_total: audit.findings.length, provisional: audit.provisional } : undefined,
      truncated: plan.skipped.length > args.sample_limit || plan.switches.length > args.sample_limit || (audit?.findings.length ?? 0) > args.sample_limit
        ? `Lists are capped at sample_limit ${args.sample_limit}. The full plan is in report.` : undefined,
      ids, report, distribution_plans, skipped_non_family: snapshot.skipped_non_family ?? { count: 0, ids: [] },
      rule: plan.rule,
    });
  }
  const refusal = guard(snapshot, io, args.document);
  if (refusal) return fail("FMC-CIRCUIT-GUARD", refusal, "This model is not written by fmc_circuits.");
  if (args.dry_run !== false) {
    return reply({
      tool: "fmc_circuits", dry_run: true, read_only: true, action: args.action,
      document: snapshot.resolved_document ?? { title: snapshot.model ?? "", path: "" },
      circuits: args.action === "apply" ? circuits : undefined,
      panel: args.action === "panel" ? { id: args.panel, distribution: args.distribution, supply_from: args.supply_from, feeder: args.feeder, mains_a: args.mains_a, mains_type: args.mains_type } : undefined,
      counts: { circuits: circuits.length, points: circuits.reduce((sum, circuit) => sum + circuit.points, 0) },
      ids, report, distribution_plans, mismatches, no_connector_families, provisional: plan.caps.some((cap) => cap.provisional),
      next: "Apply with dry_run false and batch_lease. That call is one transaction.",
    });
  }
  const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
  if (!lease) return fail("FMC-BATCH-LOCKED", "This write needs batch_lease from fmc_batch request. Nothing was changed.", "fmc_batch request, then pass batch_lease.");
  const leaseProblem = checkCircuitLease(lease, [snapshot.resolved_document?.title ?? "", snapshot.resolved_document?.path ?? "", snapshot.model ?? "", args.document], io);
  if (leaseProblem) return fail("FMC-BATCH-LOCKED", leaseProblem, "fmc_batch request for this document, wait until it is granted, then pass that batch_lease.");
  const protected_names = protectedNames(io.guard ?? loadConfig().config);
  const body = args.action === "panel"
    ? { mode: "panel", document: args.document, panel: args.panel, distribution: args.distribution, supply_from: args.supply_from, feeder: args.feeder, mains_a: args.mains_a ?? null, mains_type: args.mains_type, protected_names }
    : { mode: "apply", document: args.document, circuits, switches: args.include_switches ? plan.switches : [], distribution: args.distribution, protected_names };
  try {
    const applied = (io.apply
      ? await io.apply(body)
      : await withRevitConnection((client) => client.sendCommand("fmc_circuits_apply", body, 300000))) as Record<string, unknown>;
    const ok = applied?.applied === true;
    if (args.action === "panel") return reply({ tool: "fmc_circuits", dry_run: false, ...applied, report }, !ok);
    const { results, created_ids } = circuitResults(circuits, applied ?? {});
    const counts = {
      planned: circuits.length,
      created: results.filter((row) => row.status === "created").length,
      failed: results.filter((row) => row.status === "failed").length,
      not_reported: results.filter((row) => row.status === "not_reported").length,
    };
    return reply({
      tool: "fmc_circuits", dry_run: false, ...applied, planned: circuits.length, report, counts, results, created_ids,
      undo: created_ids.length ? { tool: "fmc_batch_undo", batch_id: lease, document: snapshot.resolved_document?.title ?? args.document, ids: created_ids } : undefined,
      partial: ok && (counts.failed > 0 || counts.not_reported > 0),
    }, !ok);
  } catch (error) {
    return reply({ tool: "fmc_circuits", error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcCircuitsTool(server: McpServer) {
  server.tool("fmc_circuits", FMC_CIRCUITS_DESCRIPTION, shape, (args) => runFmcCircuits(args));
}
