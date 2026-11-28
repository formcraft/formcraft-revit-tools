import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { checkWritePath, configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { checkGbxml } from "../fmc/gbxml.js";
import { analyticalFindings, planGbxmlExport, resolveCheckFile } from "../fmc/energyexport.js";
import {
  LIMIT_KEYS, TYPE_COLUMNS, citeLimit, classSummary, envelopeFacts, shgcChecks, typeRows, typesCsv, uChecks, verdictOf, wwrBySector, wwrChecks,
  type CitedLimit, type EnergyFact, type EnvelopeClass,
} from "../fmc/energy.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_ENERGY_DESCRIPTION =
  "Formcraft energy (GAP-23). The envelope, analytical and check modes are read-only: no transaction, nothing created or changed, and no energy model is made. Export writes one gbXML file (see export below). " +
  "Reads the building envelope of the named document: exterior walls and curtain walls, roofs, floors, windows, skylights and exterior doors, with each type's " +
  "U-value (heat transfer coefficient) or thermal resistance, SHGC and visible light transmittance as Revit holds them, net areas, and the outward direction " +
  "turned to true north. Returns one line per type (area, U, U x A), area-weighted mean U per class, the fabric heat loss coefficient UA in W/K, " +
  "and the window-to-wall ratio overall and by orientation (N, E, S, W). " +
  "Checks U per class, glazing SHGC and WWR against limits from the call (limits), else the standards bank keys energy.max_u_wall_w_m2k, energy.max_u_roof_w_m2k, " +
  "energy.max_u_floor_w_m2k, energy.max_u_window_w_m2k, energy.max_u_door_w_m2k, energy.max_shgc, energy.max_wwr. There are no built-in limits: a check without one is NO_LIMIT. " +
  "Thermal values are never guessed: a type without a U-value is listed as U_UNKNOWN and left out of the averages. " +
  "Pass document. A missing name is FMC-DOC-REQUIRED. The full JSON and a CSV of types are under %LOCALAPPDATA%\\Formcraft\\energy. No pictures. " +
  "Modes: envelope (default, the check above, read-only); analytical (read-only): energy settings, location and base points, whether the energy analytical model exists and its " +
  "spaces, zones, surfaces and openings, rooms and spaces not placed or not enclosed, missing levels, surfaces with no adjacent space, and Revit warnings; " +
  "export: a gbXML file ONLY in the folder that holds the open .rvt, named <model>_gbXML_<yyyyMMdd-HHmm>.xml (or a sanitised name), never over an existing file, never saving the model. " +
  "Export is a model-changing call (fmc_energy_export): dry_run defaults true and only plans the file; the live-model lock and batch lease apply. If Revit needs a transaction to export, " +
  "it runs inside a transaction group that is rolled back. An unsaved or cloud model is refused. check_after (default true) checks the new file; " +
  "check: the offline gbXML check of a file inside the project folder (file): Campus, Building, Space, Surface and Opening counts, surfaces with no AdjacentSpaceId, zero areas and missing constructions. " +
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
  mode: z.enum(["envelope", "analytical", "export", "check"]).optional().default("envelope").describe("envelope and analytical read; export writes a gbXML beside the .rvt; check reads a gbXML in the project folder."),
  dry_run: z.boolean().optional().default(true).describe("export only: true plans the file name and checks the rules without exporting."),
  file_name: z.string().optional().describe("export: a name for the gbXML (sanitised, .xml added). Default <model>_gbXML_<yyyyMMdd-HHmm>. An existing file is never overwritten."),
  model_type: z.enum(["default", "spaces", "building_elements"]).optional().default("default").describe("export: gbXML energy model type. default keeps Revit's export setting."),
  check_after: z.boolean().optional().default(true).describe("export: run the offline gbXML check on the new file."),
  file: z.string().optional().describe("check: a gbXML name or path inside the project folder."),
  sample_limit: z.number().int().min(1).max(500).optional().default(100),
};

export type FmcEnergyArgs = z.infer<z.ZodObject<typeof FMC_ENERGY_SHAPE>>;

export interface EnergyIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  /** fmc_energy_export, a model-changing command. */
  send?: (body: Record<string, unknown>) => Promise<unknown>;
  exists?: (file: string) => boolean;
  readFile?: (file: string) => string;
  now?: Date;
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

function refusedDoc() {
  return reply({
    tool: "fmc_energy", read_only: true, refused: true, code: "FMC-DOC-REQUIRED", transaction: false,
    message: "[FMC-DOC-REQUIRED] fmc_energy needs document: a title or a full path. Refusing to use the active document.",
  }, true);
}

async function readEnergy(io: EnergyIo, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (io.read
    ? await io.read(body)
    : await withRevitConnection((client) => client.sendCommand("fmc_energy", body, 180000))) as Record<string, unknown>;
}

function refusedRead(snapshot: Record<string, unknown>, readOnly = true) {
  return reply({
    tool: "fmc_energy", read_only: readOnly, refused: true, transaction: false,
    code: snapshot.code || "FMC-ENERGY", message: snapshot.message || "The read was refused.",
  }, true);
}

export async function runFmcEnergy(args: FmcEnergyArgs, io: EnergyIo = {}) {
  try {
    if (!args.document.trim()) return refusedDoc();
    if (args.mode === "analytical") return await runAnalytical(args, io);
    if (args.mode === "export") return await runExport(args, io);
    if (args.mode === "check") return await runCheck(args, io);
    return await runEnvelope(args, io);
  } catch (error) {
    return failed(error);
  }
}

async function runEnvelope(args: FmcEnergyArgs, io: EnergyIo) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) {
      return reply({
        tool: "fmc_energy", read_only: true, refused: true, code: "FMC-DOC-REQUIRED", transaction: false,
        message: "[FMC-DOC-REQUIRED] fmc_energy needs document: a title or a full path. Refusing to use the active document.",
      }, true);
    }
    const body = { document: args.document, parts: ["envelope"] };
    const snapshot = await readEnergy(io, body);
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

function docOf(snapshot: Record<string, unknown>) {
  const resolved = (snapshot.resolved_document ?? {}) as { title?: string; path?: string };
  return { title: resolved.title || "", path: resolved.path || String(snapshot.path ?? "") };
}

function reportFile(env: NodeJS.ProcessEnv, kind: string, body: unknown, dir = energyDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `energy-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

async function runAnalytical(args: FmcEnergyArgs, io: EnergyIo) {
  const env = io.env ?? process.env;
  const snapshot = await readEnergy(io, { document: args.document, parts: ["analytical"] });
  if (snapshot.refused || snapshot.code) return refusedRead(snapshot);
  const analytical = (snapshot.analytical ?? {}) as Record<string, unknown>;
  const { status, findings } = analyticalFindings(analytical);
  const doc = docOf(snapshot);
  const notes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
  const body = { document: doc.title || args.document, path: doc.path, status, findings, analytical, notes };
  const report = reportFile(env, "analytical", body, io.reportDir);
  return reply({
    tool: "fmc_energy", mode: "analytical", read_only: true, applied: false, transaction: false, saved: false, synced: false, images: [] as [],
    document: doc.title || args.document, resolved_document: doc, status, findings, analytical, notes, report: { json: report },
    cites: { rulebook: "Read-only. No transaction; the energy analytical model is read if it exists and is never created by this mode." },
  });
}

function defaultExists(file: string) { try { return fs.existsSync(file); } catch { return true; } }

function guardOf(io: EnergyIo, env: NodeJS.ProcessEnv): GuardConfig {
  return io.guard ?? loadConfig(configPath(env)).config;
}

async function runExport(args: FmcEnergyArgs, io: EnergyIo) {
  const env = io.env ?? process.env;
  const exists = io.exists ?? defaultExists;
  const snapshot = await readEnergy(io, { document: args.document, parts: ["doc"] });
  if (snapshot.refused || snapshot.code) return refusedRead(snapshot, false);
  const doc = docOf(snapshot);
  const refuse = (code: string, message: string, extra: Record<string, unknown> = {}) => reply({
    tool: "fmc_energy", mode: "export", read_only: false, refused: true, applied: false, saved: false, transaction: false, code, message: `[${code}] ${message}`,
    document: doc.title || args.document, ...extra,
  }, true);
  if (snapshot.is_model_in_cloud === true) return refuse("FMC-ENERGY-CLOUD", `${doc.title || args.document} is a cloud model. gbXML export goes only beside a local .rvt.`);
  const plan = planGbxmlExport(doc.path, { name: args.file_name, now: io.now, exists });
  if (!plan.ok) return refuse(plan.code ?? "FMC-ENERGY", plan.reasons.join(" "), { plan });
  const guard = checkWritePath(plan.file, guardOf(io, env), { checkName: false });
  if (!guard.ok) return refuse("FMC-ENERGY-WRITE-REFUSED", guard.reasons.join(" "), { plan });
  const base = {
    tool: "fmc_energy", mode: "export", document: doc.title || args.document, resolved_document: doc, folder: plan.folder, file: plan.file,
    name_changed: plan.name_changed, model_type: args.model_type, saved: false, synced: false, images: [] as [],
  };
  if (args.dry_run) {
    return reply({ ...base, dry_run: true, read_only: true, applied: false, transaction: false, message: "Dry run: the file name and folder pass. Nothing was exported. Run again with dry_run false to export." });
  }
  const sendBody = { document: args.document, file_name: plan.name, expected_folder: plan.folder, model_type: args.model_type, dry_run: false };
  const result = (io.send
    ? await io.send(sendBody)
    : await withRevitConnection((client) => client.sendCommand("fmc_energy_export", sendBody, 600000))) as Record<string, unknown>;
  if (result.refused || result.code) {
    return reply({ ...base, dry_run: false, read_only: false, refused: true, applied: false, code: result.code || "FMC-ENERGY-EXPORT", message: result.message || "The export was refused." }, true);
  }
  const written = String(result.file ?? "");
  if (written.toLowerCase() !== plan.file.toLowerCase()) {
    return reply({ ...base, dry_run: false, read_only: false, refused: true, applied: true, code: "FMC-ENERGY-PATH-MISMATCH", message: `The add-in wrote ${written}, not ${plan.file}. Check it by hand.`, result }, true);
  }
  let check: unknown = null;
  if (args.check_after) {
    try { check = checkGbxml((io.readFile ?? ((f: string) => fs.readFileSync(f, "utf8")))(plan.file), args.sample_limit); }
    catch (e) { check = { status: "UNREADABLE", message: e instanceof Error ? e.message : String(e) }; }
  }
  const body = { ...base, export: result, check };
  const report = reportFile(env, "export", body, io.reportDir);
  return reply({
    ...base, dry_run: false, read_only: false, applied: true, file_written: true,
    transaction: result.transaction_used === "group_rolled_back" ? "rolled_back" : false,
    transaction_used: result.transaction_used ?? "none", energy_model_created: result.energy_model_created === true,
    document_modified_after: result.is_modified_after ?? null, new_files: result.new_files ?? [plan.file],
    check, report: { json: report },
    cites: { rulebook: "The model is never saved or synced. The gbXML goes only beside the .rvt and never over an existing file. Any transaction Revit needs is rolled back." },
  });
}

async function runCheck(args: FmcEnergyArgs, io: EnergyIo) {
  const env = io.env ?? process.env;
  const snapshot = await readEnergy(io, { document: args.document, parts: ["doc"] });
  if (snapshot.refused || snapshot.code) return refusedRead(snapshot);
  const doc = docOf(snapshot);
  const folder = doc.path ? path.win32.dirname(doc.path) : "";
  const target = resolveCheckFile(folder, args.file ?? "");
  if (!target.ok) {
    return reply({ tool: "fmc_energy", mode: "check", read_only: true, refused: true, transaction: false, code: "FMC-ENERGY-CHECK-PATH", message: `[FMC-ENERGY-CHECK-PATH] ${target.reason}`, document: doc.title || args.document }, true);
  }
  const text = (io.readFile ?? ((f: string) => fs.readFileSync(f, "utf8")))(target.file);
  const check = checkGbxml(text, args.sample_limit);
  const report = reportFile(env, "check", { document: doc.title || args.document, file: target.file, check }, io.reportDir);
  return reply({
    tool: "fmc_energy", mode: "check", read_only: true, applied: false, transaction: false, saved: false, synced: false, images: [] as [],
    document: doc.title || args.document, file: target.file, check, report: { json: report },
  });
}

export function registerFmcEnergyTool(server: McpServer) {
  server.tool("fmc_energy", FMC_ENERGY_DESCRIPTION, FMC_ENERGY_SHAPE, async (args) => runFmcEnergy(args as FmcEnergyArgs));
}
