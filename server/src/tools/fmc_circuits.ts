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
  DISTRIBUTION_HINT, auditCircuits, circuitCaps, planCircuits, sampleIds, TARGET_DISTRIBUTION, voltageDropLimit,
  type CircuitDevice, type CircuitPanel, type ExistingCircuit,
} from "../fmc/circuitplan.js";
import { reportHostDir, writeReport } from "../fmc/localreport.js";

/** What counts.mismatched counts, said in the reply (P-fmc_circuits-01): it is not the audit's voltage findings. */
export const COUNTS_MEANING = {
  mismatched: "Devices in groups no panel can feed at plan time because connector voltage or poles differ from the panel's distribution (the mismatches list). Existing circuits at the wrong voltage are audit findings ELEC-CIRCUIT-VOLTAGE, not counted here.",
};

/** P-fmc_circuits-02: said once at the top of a reply when any circuit cap fell back to its default. */
export const CAPS_NOTE = "Circuit caps are PROVISIONAL defaults: the standards bank has no trace.circuit.* key for them. A provisional result is not a pass.";

const REPORT_READ_MAX = 200_000;

/** P-fmc_circuits-04: the report file's size, and how many reports the folder holds (none are deleted). */
function reportFacts(file: string, env?: NodeJS.ProcessEnv): { report_bytes: number | null; report_folder: { files: number; bytes: number } } {
  let bytes: number | null = null;
  try { bytes = fs.statSync(file).size; } catch { bytes = null; }
  let files = 0;
  let total = 0;
  try {
    const dir = reportHostDir("circuits", env);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      files += 1;
      try { total += fs.statSync(path.join(dir, name)).size; } catch { /* a file that went away */ }
    }
  } catch { /* no folder yet */ }
  return { report_bytes: bytes, report_folder: { files, bytes: total } };
}

/** action report: one report from the circuits folder (newest by default), read-only. */
function readCircuitReport(name: string, env?: NodeJS.ProcessEnv) {
  const dir = reportHostDir("circuits", env);
  let pick = name.trim();
  if (pick && (!/^[A-Za-z0-9_.-]+\.json$/.test(pick) || pick.includes(".."))) {
    return reply({ tool: "fmc_circuits", read_only: true, action: "report", ok: false, code: "FMC-REPORT-NAME", message: "report_file is a file name from the circuits report folder (letters, digits, _ . -, ending .json). Nothing was read." }, true);
  }
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort(); } catch { names = []; }
  if (!pick) pick = names.length ? names[names.length - 1] : "";
  if (!pick || !names.includes(pick)) {
    return reply({ tool: "fmc_circuits", read_only: true, action: "report", ok: false, code: "FMC-REPORT-MISSING", message: pick ? `${pick} is not in the circuits report folder.` : "No circuits report yet.", folder: dir, files: names.length }, true);
  }
  const file = path.join(dir, pick);
  const text = fs.readFileSync(file, "utf8");
  const truncated = text.length > REPORT_READ_MAX;
  let body: unknown = null;
  if (!truncated) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  return reply({
    tool: "fmc_circuits", read_only: true, action: "report", file, bytes: Buffer.byteLength(text), files_in_folder: names.length,
    newest: names[names.length - 1], truncated, body,
    ...(truncated ? { note: `The report is over ${REPORT_READ_MAX} characters; open the file to read it.` } : {}),
  });
}

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
  "It is not refused for being a board family. When that board has no distribution system the reply is FMC-PANEL-NO-DISTRIBUTION, with a dry-run plan that sets the Distribution System parameter. " +
  "Devices are grouped by connector voltage and poles and assigned only to a panel whose distribution system matches (1-pole uses line-to-ground, 2-pole and 3-pole use line-to-line, 3-pole needs three-phase). " +
  "A group Revit would refuse in SelectPanel is FMC-CIRCUIT-PANEL-MISMATCH and names the panel line-to-line and line-to-ground voltage against the device connector. " +
  "non_board_ids are panel part types that are loads (SPD, isolator, pump control). Families with no electrical connector are FMC-NO-CONNECTOR, grouped by family. " +
  "Assignment uses MEPModel.GetElectricalSystems, not Connector.IsConnected. Data, telephone and fire alarm are skipped. " +
  "Switch-to-luminaire groups are included when include_switches is true. " +
  "dry_run defaults to true. apply and panel with dry_run false need batch_lease. One Revit transaction, one subtransaction per circuit. " +
  "Pass document (exact title or full path) when more than one document is open. " +
  "HEBERT HOSTELS, a central model and protected_paths are refused. Numeric caps come from trace.circuit.* keys. A missing key is PROVISIONAL and uses the stated default. " +
  "The reply is counts and a capped id list (audit findings say total and truncated). The full plan is JSON under %LOCALAPPDATA%\\Formcraft\\circuits; action report reads one back (newest, or report_file). No pictures. " +
  "Board distribution other than the target is ELEC-DISTRIBUTION-TARGET; an existing circuit at the wrong voltage is ELEC-CIRCUIT-VOLTAGE (both were ELEC-VOLTAGE-MISMATCH, kept as replaces). " +
  "Example document: F26901-FMC-ZZ-ZZ-M3-E-0001_USER.";

const shape = {
  action: z.enum(["plan", "apply", "panel", "audit", "limits", "report"]),
  report_file: z.string().optional().describe("report: a file name from the circuits report folder. Empty reads the newest."),
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
  if (args.action === "report") return readCircuitReport(args.report_file ?? "", io.env);
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
  const facts = reportFacts(report, io.env);
  const capsNote = plan.caps.some((cap) => cap.provisional) ? { caps_note: CAPS_NOTE } : {};
  const distribution_plans = plan.distribution_plans ?? [];
  const mismatches = plan.mismatches ?? [];
  const no_connector_families = plan.no_connector_families ?? [];
  if ((args.action === "apply" || args.action === "panel") && circuits.length === 0 && (distribution_plans.length > 0 || mismatches.length > 0)) {
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
    const limit = args.sample_limit;
    return reply({
      tool: "fmc_circuits", read_only: true, action: args.action, ...capsNote, document: snapshot.resolved_document ?? { title: snapshot.model ?? args.document, path: "" },
      counts: plan.counts, counts_meaning: COUNTS_MEANING, circuits: circuits.map((circuit) => ({ name: circuit.name, kind: circuit.kind, panel: circuit.panel_name, phase: circuit.phase, slot: circuit.slot, points: circuit.points, load_w: circuit.load_w, ids: circuit.element_ids.slice(0, 20), flags: circuit.flags, provisional: circuit.provisional })),
      skipped: plan.skipped.slice(0, args.sample_limit), mismatches, no_connector_families, switches: plan.switches.slice(0, args.sample_limit),
      phase: plan.phase,
      audit: audit ? {
        counts: audit.counts, findings: audit.findings.slice(0, limit), total: audit.findings.length, truncated: audit.findings.length > limit,
        provisional: audit.provisional,
      } : undefined,
      ids, report, ...facts, distribution_plans, skipped_non_family: snapshot.skipped_non_family ?? { count: 0, ids: [] },
      rule: plan.rule,
    });
  }
  const refusal = guard(snapshot, io, args.document);
  if (refusal) return fail("FMC-CIRCUIT-GUARD", refusal, "This model is not written by fmc_circuits.");
  if (args.dry_run !== false) {
    return reply({
      tool: "fmc_circuits", dry_run: true, read_only: true, action: args.action, ...capsNote,
      document: snapshot.resolved_document ?? { title: snapshot.model ?? "", path: "" },
      circuits: args.action === "apply" ? circuits : undefined,
      panel: args.action === "panel" ? { id: args.panel, distribution: args.distribution, supply_from: args.supply_from, feeder: args.feeder, mains_a: args.mains_a, mains_type: args.mains_type } : undefined,
      counts: { circuits: circuits.length, points: circuits.reduce((sum, circuit) => sum + circuit.points, 0) },
      ids, report, ...facts, distribution_plans, mismatches, no_connector_families, provisional: plan.caps.some((cap) => cap.provisional),
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
