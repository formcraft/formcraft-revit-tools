import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { loadConfig, type GuardConfig } from "../fmc/policy.js";
import { batchLease } from "../fmc/target.js";
import { traceEntriesFromStandards, type TraceBankEntry } from "../fmc/trace_bank.js";
import { kitPaths } from "../fmc/context.js";
import fs from "node:fs";
import path from "node:path";
import {
  auditCircuits, circuitCaps, planCircuits, sampleIds, TARGET_DISTRIBUTION, voltageDropLimit,
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
  "non_board_ids are Panelboard part types that are loads (SPD, isolator, pump control). Families with no electrical connector are FMC-NO-CONNECTOR, not a crash. " +
  "Assignment uses MEPModel.GetElectricalSystems, not Connector.IsConnected. Data, telephone and fire alarm are skipped. " +
  "Switch-to-luminaire groups are included when include_switches is true. " +
  "dry_run defaults to true. apply and panel with dry_run false need batch_lease. One Revit transaction, one subtransaction per circuit. " +
  "Pass document (exact title or full path) when more than one document is open. " +
  "HEBERT HOSTELS, a central model and protected_paths are refused. Numeric caps come from trace.circuit.* keys. A missing key is PROVISIONAL and uses the stated default. " +
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
  if (/hebert hostels/i.test(`${title} ${file} ${named}`)) return "HEBERT HOSTELS is not written by fmc_circuits.";
  if (snapshot.is_central) return "A central model is not written by fmc_circuits.";
  const pathName = file.replace(/\//g, "\\").toLowerCase();
  for (const root of config.protected_paths ?? []) {
    const norm = root.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (norm && (pathName === norm || pathName.startsWith(norm + "\\"))) return `The document is under a protected path (${root}).`;
  }
  return null;
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
    non_board_ids: args.non_board_ids, include_switches: args.include_switches,
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
  if (args.action === "plan" || args.action === "audit") {
    return reply({
      tool: "fmc_circuits", read_only: true, action: args.action, document: snapshot.resolved_document ?? { title: snapshot.model ?? args.document, path: "" },
      counts: plan.counts, circuits: circuits.map((circuit) => ({ name: circuit.name, kind: circuit.kind, panel: circuit.panel_name, phase: circuit.phase, slot: circuit.slot, points: circuit.points, load_w: circuit.load_w, ids: circuit.element_ids.slice(0, 20), flags: circuit.flags, provisional: circuit.provisional })),
      skipped: plan.skipped.slice(0, args.sample_limit), switches: plan.switches.slice(0, args.sample_limit),
      phase: plan.phase, audit: audit ? { counts: audit.counts, findings: audit.findings.slice(0, args.sample_limit), provisional: audit.provisional } : undefined,
      ids, report, skipped_non_family: snapshot.skipped_non_family ?? { count: 0, ids: [] },
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
      ids, report, provisional: plan.caps.some((cap) => cap.provisional),
      next: "Apply with dry_run false and batch_lease. That call is one transaction.",
    });
  }
  const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
  if (!lease) return fail("FMC-BATCH-LOCKED", "This write needs batch_lease from fmc_batch request. Nothing was changed.", "fmc_batch request, then pass batch_lease.");
  const body = args.action === "panel"
    ? { mode: "panel", document: args.document, panel: args.panel, distribution: args.distribution, supply_from: args.supply_from, feeder: args.feeder, mains_a: args.mains_a ?? null, mains_type: args.mains_type }
    : { mode: "apply", document: args.document, circuits, switches: args.include_switches ? plan.switches : [], distribution: args.distribution };
  try {
    const applied = (io.apply
      ? await io.apply(body)
      : await withRevitConnection((client) => client.sendCommand("fmc_circuits_apply", body, 300000))) as Record<string, unknown>;
    const ok = applied?.applied === true;
    return reply({ tool: "fmc_circuits", dry_run: false, ...applied, planned: circuits.length, report }, !ok);
  } catch (error) {
    return reply({ tool: "fmc_circuits", error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcCircuitsTool(server: McpServer) {
  server.tool("fmc_circuits", FMC_CIRCUITS_DESCRIPTION, shape, (args) => runFmcCircuits(args));
}
