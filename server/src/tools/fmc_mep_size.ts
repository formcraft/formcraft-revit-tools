import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { loadConfig } from "../fmc/policy.js";
import { traceEntriesFromStandards, type TraceBankEntry } from "../fmc/trace_bank.js";
import { writeReport } from "../fmc/localreport.js";
import {
  DRAFT, FLUIDS, checkSegment, criticalPath, mepLimits, sizeRound, summary, voltageDropRow,
  type CableRow, type CircuitIn, type Fluid, type MepSegment, type SizeRow,
} from "../fmc/mepsize.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_MEP_SIZE_DESCRIPTION =
  "Formcraft MEP sizing preview (read-only; nothing is written to the model, and this tool has no apply). Every answer is a DRAFT with " +
  "engineer_signoff_required true: Formcraft does not size or sign. " +
  "Actions: duct and pipe (smallest size in standard_sizes_mm within the velocity and friction limits), pressure (per segment: velocity, " +
  "Darcy-Weisbach friction with Swamee-Jain, fitting loss from K factors, total), critical_path (pressure on a run tree given by upstream ids, " +
  "and the index run with the largest summed loss), voltage_drop (per circuit, VD = mV/A/m x I x L / 1000 against the limit, and the smallest " +
  "cable in the cable table that passes; no cable table is FMC-NO-CABLE-TABLE, never an invented value; circuits from the call, or from Revit through fmc_mep_facts when from_model is true). " +
  "Limits come from the standards bank (mep.duct_velocity_max_ms, mep.duct_friction_max_pa_m, mep.duct_roughness_mm, the pipe equivalents, " +
  "trace.voltage_drop_pct, mep.voltage_drop_pct_lighting) or from limits on the call (tagged engineer). A missing limit is TBC, never a number " +
  "from code. The size list and the cable table (mV/A/m) must come from the kit, the type's size table or the engineer. " +
  "Segments can come from fmc_mep_audit's critical-path output. The full rows are JSON under %LOCALAPPDATA%\\Formcraft\\mep_size.";

const segment = z.object({
  id: z.string(),
  kind: z.enum(["duct", "pipe"]),
  flow_l_s: z.number().nonnegative(),
  length_m: z.number().nonnegative().optional(),
  shape: z.enum(["round", "rect"]).optional(),
  size_mm: z.number().positive().optional(),
  w_mm: z.number().positive().optional(),
  h_mm: z.number().positive().optional(),
  roughness_mm: z.number().nonnegative().optional(),
  k: z.array(z.number().nonnegative()).optional(),
  upstream: z.string().optional(),
  source: z.string().optional(),
});

const circuit = z.object({
  id: z.string(),
  voltage_v: z.number().positive().nullable(),
  current_a: z.number().nonnegative().nullable(),
  length_m: z.number().nonnegative().nullable(),
  lighting: z.boolean().optional(),
  cable_spec: z.string().optional(),
  wire_size: z.string().optional(),
  source: z.string().optional(),
});

const cable = z.object({
  spec: z.string().optional(),
  size_mm2: z.number().positive(),
  mv_a_m: z.number().positive(),
  rating_a: z.number().positive().optional(),
  source: z.string().optional(),
});

export const FMC_MEP_SIZE_SHAPE = {
  action: z.enum(["duct", "pipe", "pressure", "critical_path", "voltage_drop"]),
  segments: z.array(segment).optional().default([]),
  standard_sizes_mm: z.array(z.number().positive()).optional().default([]),
  circuits: z.array(circuit).optional().default([]),
  cables: z.array(cable).optional().default([]).describe("The cable table: mV/A/m by size (and spec, rating) from the kit or the engineer"),
  from_model: z.boolean().optional().default(false).describe("voltage_drop: read the circuits from Revit (fmc_mep_facts, read-only)"),
  limits: z.object({
    velocity_max_ms: z.number().positive().optional(),
    friction_max_pa_m: z.number().positive().optional(),
    roughness_mm: z.number().nonnegative().optional(),
    vd_pct: z.number().positive().optional(),
    vd_pct_lighting: z.number().positive().optional(),
  }).optional().default({}),
  fluid: z.object({ density_kg_m3: z.number().positive(), viscosity_m2_s: z.number().positive() }).optional(),
  sample_limit: z.number().int().min(1).max(200).optional().default(40),
};

export type FmcMepSizeArgs = z.infer<z.ZodObject<typeof FMC_MEP_SIZE_SHAPE>>;

export interface MepSizeIo {
  /** Revit read of fmc_mep_facts (read-only). */
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  bank?: Record<string, TraceBankEntry>;
  env?: NodeJS.ProcessEnv;
}

function bankOf(io: MepSizeIo): Record<string, TraceBankEntry> {
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

interface FactsCircuit { id?: number; board?: string; number?: string; voltage_v?: number | null; current_a?: number | null; length_m?: number | null; wire_size?: string; cable_spec?: string; classes?: string[] }

/** Circuits from fmc_mep_facts' reply ({ mep: { circuits } } or { circuits }). */
export function circuitsFromFacts(facts: unknown): CircuitIn[] {
  const root = (facts ?? {}) as { mep?: { circuits?: FactsCircuit[] }; circuits?: FactsCircuit[] };
  const list = root.mep?.circuits ?? root.circuits ?? [];
  return list.map((c) => ({
    id: `${c.board || "(no board)"}/${c.number ?? c.id ?? "?"}`,
    voltage_v: c.voltage_v ?? null,
    current_a: c.current_a ?? null,
    length_m: c.length_m ?? null,
    lighting: (c.classes ?? []).length > 0 && (c.classes ?? []).every((x) => /lighting/i.test(x)),
    cable_spec: c.cable_spec || undefined,
    wire_size: c.wire_size || undefined,
    source: c.id != null ? `model:${c.id}` : "model",
  }));
}

export async function runFmcMepSize(args: FmcMepSizeArgs, io: MepSizeIo = {}) {
  const bank = bankOf(io);
  const sample = args.sample_limit;
  const fluidFor = (kind: "duct" | "pipe"): Fluid => args.fluid
    ? { name: kind === "duct" ? "air" : "water", ...args.fluid, source: "engineer" }
    : FLUIDS[kind === "duct" ? "air" : "water"];
  const base = { tool: "fmc_mep_size", read_only: true, action: args.action, draft: DRAFT, engineer_signoff_required: true as const };

  if (args.action === "voltage_drop") {
    if (!args.cables.length) {
      return reply({ ...base, ok: false, code: "FMC-NO-CABLE-TABLE",
        message: "[FMC-NO-CABLE-TABLE] No cable table was supplied. Voltage drop needs mV/A/m by cable size from the kit or the engineer; none is invented.",
        hint: "Pass cables [{ size_mm2, mv_a_m, rating_a?, spec?, source? }]. The kit v2.2 has no mV/A/m table (kit change request CA-E-02)." }, true);
    }
    let circuits: CircuitIn[] = args.circuits as CircuitIn[];
    const notes: string[] = [];
    if (args.from_model) {
      try {
        const facts = io.read ? await io.read({}) : await withRevitConnection((client) => client.sendCommand("fmc_mep_facts", {}, 300000));
        circuits = [...circuits, ...circuitsFromFacts(facts)];
      } catch (error) {
        return reply({ ...base, error: error instanceof Error ? error.message : String(error) }, true);
      }
      notes.push("Length is Revit's circuit length; the engineer confirms the route and the installation method.");
    }
    const limits = mepLimits("pipe", bank, args.limits);
    const rows = circuits.map((c) => voltageDropRow(c, args.cables as CableRow[], limits));
    const report = writeReport("mep_size", args.action, { limits: { vd_pct: limits.vd_pct, vd_pct_lighting: limits.vd_pct_lighting }, rows }, io.env);
    return reply({ ...base, limits: { vd_pct: limits.vd_pct, vd_pct_lighting: limits.vd_pct_lighting }, summary: summary(rows),
      rows: rows.slice(0, sample), capped: rows.length > sample, notes, report });
  }

  const kinds = args.action === "duct" || args.action === "pipe" ? [args.action] : ["duct", "pipe"] as const;
  const segs = (args.segments as MepSegment[]).filter((s) => (kinds as readonly string[]).includes(s.kind));
  if (!segs.length) {
    return reply({ ...base, summary: summary([]), rows: [], notes: ["No segments. Pass segments (for example from fmc_mep_audit) with flow_l_s."] });
  }
  const limitsBy = { duct: mepLimits("duct", bank, args.limits), pipe: mepLimits("pipe", bank, args.limits) };
  const usedLimits = Object.fromEntries([...new Set(segs.map((s) => s.kind))].map((k) => [k, limitsBy[k]]));

  if (args.action === "duct" || args.action === "pipe") {
    const rows: SizeRow[] = segs.map((s) => sizeRound(s, limitsBy[s.kind], fluidFor(s.kind), args.standard_sizes_mm));
    const report = writeReport("mep_size", args.action, { limits: usedLimits, rows }, io.env);
    return reply({ ...base, limits: usedLimits, summary: summary(rows), rows: rows.slice(0, sample), capped: rows.length > sample, report,
      notes: ["Round sizes only; for a rectangular duct give the size and use pressure to check it."] });
  }

  const checked = segs.map((s) => checkSegment(s, limitsBy[s.kind], fluidFor(s.kind)));
  const losses = new Map(checked.map((r) => [r.id, r.loss_pa]));
  const rows = checked.map(({ loss_pa: _loss, ...row }) => row);
  const body: Record<string, unknown> = { ...base, limits: usedLimits, summary: summary(rows), rows: rows.slice(0, sample), capped: rows.length > sample };
  if (args.action === "critical_path") body.critical_path = criticalPath(segs, losses);
  body.report = writeReport("mep_size", args.action, { ...body, rows }, io.env);
  return reply(body);
}

export function registerFmcMepSizeTool(server: McpServer) {
  server.tool("fmc_mep_size", FMC_MEP_SIZE_DESCRIPTION, FMC_MEP_SIZE_SHAPE, (args) => runFmcMepSize(args));
}
