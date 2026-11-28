import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import {
  LIMIT_KEYS, TYPE_COLUMNS, citeLimit, classSummary, envelopeFacts, shgcChecks, typeRows, typesCsv, uChecks, verdictOf, wwrBySector, wwrChecks,
  type CitedLimit, type EnergyFact, type EnvelopeClass,
} from "../fmc/energy.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_ENERGY_DESCRIPTION =
  "Formcraft envelope energy check. Read-only. There is no dry run and no transaction: nothing is created, changed or rolled back, and no energy model is made. " +
  "Reads the building envelope of the named document: exterior walls and curtain walls, roofs, floors, windows, skylights and exterior doors, with each type's " +
  "U-value (heat transfer coefficient) or thermal resistance, SHGC and visible light transmittance as Revit holds them, net areas, and the outward direction " +
  "turned to true north. Returns one line per type (area, U, U x A), area-weighted mean U per class, the fabric heat loss coefficient UA in W/K, " +
  "and the window-to-wall ratio overall and by orientation (N, E, S, W). " +
  "Checks U per class, glazing SHGC and WWR against limits from the call (limits), else the standards bank keys energy.max_u_wall_w_m2k, energy.max_u_roof_w_m2k, " +
  "energy.max_u_floor_w_m2k, energy.max_u_window_w_m2k, energy.max_u_door_w_m2k, energy.max_shgc, energy.max_wwr. There are no built-in limits: a check without one is NO_LIMIT. " +
  "Thermal values are never guessed: a type without a U-value is listed as U_UNKNOWN and left out of the averages. " +
  "Pass document. A missing name is FMC-DOC-REQUIRED. The full JSON and a CSV of types are under %LOCALAPPDATA%\\Formcraft\\energy. No pictures. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0001_USER, limits {wall: 0.35, roof: 0.25, window: 2.2, wwr: 0.4}.";

const positive = z.number().positive();
export const FMC_ENERGY_SHAPE = {
  document: z.string().optional().default("").describe("Title or full path of an open document. Required."),
  limits: z.object({
    wall: positive.optional().describe("Max wall U in W/m2K. Overrides energy.max_u_wall_w_m2k."),
    roof: positive.optional().describe("Max roof U in W/m2K. Overrides energy.max_u_roof_w_m2k."),
    floor: positive.optional().describe("Max ground floor U in W/m2K. Overrides energy.max_u_floor_w_m2k."),
    window: positive.optional().describe("Max window, skylight and curtain wall U in W/m2K. Overrides energy.max_u_window_w_m2k."),
    door: positive.optional().describe("Max exterior door U in W/m2K. Overrides energy.max_u_door_w_m2k."),
    shgc: z.number().positive().max(1).optional().describe("Max glazing solar heat gain coefficient (0 to 1). Overrides energy.max_shgc."),
    wwr: z.number().positive().max(1).optional().describe("Max window-to-wall ratio (0 to 1). Overrides energy.max_wwr."),
  }).optional().default({}).describe("Limits for this call. Each one left out comes from the standards bank, else is not checked."),
  floor_scope: z.enum(["lowest", "all"]).optional().default("lowest").describe("lowest keeps floors on the lowest level with floors (ground floors); all keeps every floor."),
  wwr_by_orientation: z.boolean().optional().default(true).describe("Check the WWR limit on each orientation as well as overall."),
  sample_limit: z.number().int().min(1).max(500).optional().default(100),
};

export type FmcEnergyArgs = z.infer<z.ZodObject<typeof FMC_ENERGY_SHAPE>>;

export interface EnergyIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  standards?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-ENERGY";
  return reply({ tool: "fmc_energy", read_only: true, refused: true, code, message, transaction: false }, true);
}

function standardsOf(io: EnergyIo): Record<string, unknown> | null {
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

export function energyDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_ENERGY_DIR ?? "").trim()) return env.FMC_ENERGY_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(path.sep, "tmp", "FormcraftLocal");
  return path.join(local, "Formcraft", "energy");
}

function writeReport(env: NodeJS.ProcessEnv, body: unknown, csv: string, dir = energyDir(env)): { json: string; csv: string } {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const json = path.join(dir, `energy-${stamp}.json`);
  const csvFile = path.join(dir, `energy-types-${stamp}.csv`);
  fs.writeFileSync(json, JSON.stringify(body, null, 2));
  fs.writeFileSync(csvFile, csv);
  return { json, csv: csvFile };
}

const KINDS = new Set(["wall", "curtain_wall", "roof", "floor", "window", "skylight", "door"]);
function asFacts(raw: unknown): EnergyFact[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row) => row && typeof row === "object" && KINDS.has(String((row as EnergyFact).kind))) as EnergyFact[];
}

export async function runFmcEnergy(args: FmcEnergyArgs, io: EnergyIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) {
      return reply({
        tool: "fmc_energy", read_only: true, refused: true, code: "FMC-DOC-REQUIRED", transaction: false,
        message: "[FMC-DOC-REQUIRED] fmc_energy needs document: a title or a full path. Refusing to use the active document.",
      }, true);
    }
    const body = { document: args.document };
    const snapshot = (io.read
      ? await io.read(body)
      : await withRevitConnection((client) => client.sendCommand("fmc_energy", body, 180000))) as Record<string, unknown>;
    if (snapshot.refused || snapshot.code) {
      return reply({
        tool: "fmc_energy", read_only: true, refused: true, transaction: false,
        code: snapshot.code || "FMC-ENERGY", message: snapshot.message || "The read was refused.",
      }, true);
    }
    const angle = Number(snapshot.true_north_angle_rad ?? 0) || 0;
    const { kept: facts, floors_dropped } = envelopeFacts(asFacts(snapshot.elements), args.floor_scope);
    const standards = standardsOf(io);
    const lim = args.limits ?? {};
    const limits: Record<EnvelopeClass, CitedLimit> = {
      wall: citeLimit(standards, LIMIT_KEYS.wall, lim.wall),
      roof: citeLimit(standards, LIMIT_KEYS.roof, lim.roof),
      floor: citeLimit(standards, LIMIT_KEYS.floor, lim.floor),
      glazing: citeLimit(standards, LIMIT_KEYS.glazing, lim.window),
      door: citeLimit(standards, LIMIT_KEYS.door, lim.door),
    };
    const shgcLimit = citeLimit(standards, LIMIT_KEYS.shgc, lim.shgc);
    const wwrLimit = citeLimit(standards, LIMIT_KEYS.wwr, lim.wwr);

    const rows = typeRows(facts);
    const summary = classSummary(rows);
    const ratios = wwrBySector(facts, angle);
    const u = uChecks(rows, limits);
    const shgc = shgcChecks(rows, shgcLimit);
    const wwr = wwrChecks(ratios, wwrLimit, args.wwr_by_orientation);
    const failures = [...u.failures, ...shgc.failures, ...wwr.failures];
    const present = new Set(rows.map((r) => r.class));
    const uByClass = Object.fromEntries((Object.keys(limits) as EnvelopeClass[]).map((cls) => [cls, {
      status: present.has(cls) ? verdictOf(u.failed[cls], u.checked[cls], limits[cls]) : "NOT_APPLICABLE",
      limit: limits[cls],
      types_checked: u.checked[cls],
      failures: u.failed[cls],
      types_unknown_u: u.unknown.filter((x) => x.class === cls).length,
    }]));
    const checks = {
      u_value: uByClass,
      shgc: { status: present.has("glazing") ? verdictOf(shgc.failures.length, shgc.checked, shgcLimit) : "NOT_APPLICABLE", limit: shgcLimit, types_checked: shgc.checked, types_unknown: shgc.unknown, failures: shgc.failures.length },
      wwr: { status: ratios.overall.wwr == null ? "NOT_APPLICABLE" : verdictOf(wwr.failures.length, wwr.checked, wwrLimit), limit: wwrLimit, by_orientation: args.wwr_by_orientation, failures: wwr.failures.length },
    };
    const resolved = (snapshot.resolved_document ?? {}) as { title?: string; path?: string };
    const notes = Array.isArray(snapshot.notes) ? [...snapshot.notes] : [];
    if (floors_dropped) notes.push(`${floors_dropped} floors above the lowest floor level were left out (floor_scope lowest).`);
    if (ratios.no_orientation) notes.push(`${ratios.no_orientation} vertical elements had no direction and are not in the WWR.`);
    if (u.unknown.length) notes.push(`${u.unknown.length} types have no U-value in the model; their ${summary.area_unknown_u_m2} m2 is not in UA or the mean U.`);
    const settings = snapshot.energy_settings ?? null;
    const fileBody = {
      document: resolved.title || args.document, path: resolved.path || "", true_north_angle_rad: angle, energy_settings: settings,
      columns: TYPE_COLUMNS, types: rows, summary, wwr: ratios, checks, failures, unknown_u: u.unknown, notes,
    };
    const report = writeReport(env, fileBody, typesCsv(rows, limits), io.reportDir);
    const sample = args.sample_limit;
    return reply({
      tool: "fmc_energy",
      read_only: true,
      applied: false,
      transaction: false,
      saved: false,
      synced: false,
      images: [] as [],
      document: resolved.title || args.document,
      resolved_document: { title: resolved.title || "", path: resolved.path || "" },
      energy_settings: settings,
      true_north_angle_rad: angle,
      elements: facts.length,
      types_count: rows.length,
      types: rows.slice(0, sample),
      types_truncated: rows.length > sample,
      summary,
      wwr: ratios,
      checks,
      failure_count: failures.length,
      failures: failures.slice(0, sample),
      failures_truncated: failures.length > sample,
      unknown_u_count: u.unknown.length,
      unknown_u: u.unknown.slice(0, sample),
      notes,
      report,
      cites: {
        standards: `FMC-BIM-STD-002 ${Object.values(LIMIT_KEYS).join(", ")}`,
        method: "U from Revit type thermal properties (heat transfer coefficient, else 1/R). Areas are Revit net areas; WWR = glazing / (net wall + glazing + doors) on vertical faces. Fabric UA only: no thermal bridging, ventilation or solar gains.",
        rulebook: "Read-only. No transaction and no energy model. Checks are reported, not decided: the energy assessor signs off compliance.",
      },
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcEnergyTool(server: McpServer) {
  server.tool("fmc_energy", FMC_ENERGY_DESCRIPTION, FMC_ENERGY_SHAPE, async (args) => runFmcEnergy(args as FmcEnergyArgs));
}
