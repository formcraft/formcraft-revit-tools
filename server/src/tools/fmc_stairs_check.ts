import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import {
  BANK_SHAPE, OVERRIDE_NAMES, TOLERANCE_MM, overall, resolveRules, rulesList, runChecks, summarise, writeStairsReport,
  type CheckInput, type ElementKind, type OverrideName,
} from "../fmc/stairscheck.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_STAIRS_CHECK_DESCRIPTION =
  "Formcraft stair, ramp and handrail compliance check. Read-only. There is no dry run and no transaction: no rollback, no view created, no element moved, nothing saved. " +
  "Reads stairs (runs, landings, associated railings), ramps and railings in the host and in loaded links, and compares them with kit values from the standards bank: " +
  "riser height, going, 2R+G, run width, risers per flight, landing depth, handrail count and height, stair guard height, ramp gradient (Maximum Incline 1/x), ramp rise. " +
  "Every element gets a result row and every check has a status: pass, fail, not_applicable (with the reason), or provisional (the kit number or the measurement cannot be confirmed, so it cannot PASS). Each check shows measured against required, the bank key and the clause. " +
  "A key missing from the standards bank is a labelled PROVISIONAL default and cannot PASS. Headroom is not measured here: use fmc_headroom. " +
  "Pass document. A missing name is FMC-DOC-REQUIRED. The active document is not a guess. " +
  "kinds limits the scan to stair, ramp or railing. levels limits it to those level names. sources is host, link, or both (the default). " +
  "use picks a use class from the bank's uses tables (for example residential, office, education, healthcare). accessible adds the accessible-route checks. " +
  "overrides sets a number for this call only; the result still names the bank key and its status. " +
  "The full JSON, with every row, is under %LOCALAPPDATA%\\Formcraft\\stairs_check. No pictures. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, kinds [\"stair\", \"ramp\"], use residential.";

const overridesShape = z.object(Object.fromEntries(OVERRIDE_NAMES.map((name) => [name, z.number().positive().optional()])) as Record<OverrideName, z.ZodOptional<z.ZodNumber>>).partial();

export const FMC_STAIRS_CHECK_SHAPE = {
  document: z.string().optional().default("").describe("Title or full path of an open document. Required."),
  kinds: z.array(z.enum(["stair", "ramp", "railing"])).optional().default([]).describe("Empty checks stairs, ramps and railings."),
  levels: z.array(z.string()).optional().default([]).describe("Level names. Empty checks every level."),
  sources: z.array(z.enum(["host", "link"])).optional().default(["host", "link"]),
  use: z.string().optional().describe("Use class from the bank's uses tables, such as residential or office."),
  accessible: z.boolean().optional().default(false).describe("Add the accessible-route checks from accessibility.stair and accessibility.handrail."),
  overrides: overridesShape.optional().describe("Numbers for this call only. A missing bank key still cannot PASS."),
  element_limit: z.number().int().min(1).max(5000).optional().default(500).describe("How many element rows the reply lists. The file always holds all of them."),
};

export type FmcStairsCheckArgs = z.infer<z.ZodObject<typeof FMC_STAIRS_CHECK_SHAPE>>;

export interface StairsCheckIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  standards?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-STAIRS-CHECK";
  return reply({ tool: "fmc_stairs_check", read_only: true, refused: true, code, message, transaction: false }, true);
}

function standardsOf(io: StairsCheckIo): Record<string, unknown> | null {
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

function list<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw.filter((row) => row && typeof row === "object") as T[]) : [];
}

export async function runFmcStairsCheck(args: FmcStairsCheckArgs, io: StairsCheckIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) {
      return reply({
        tool: "fmc_stairs_check", read_only: true, refused: true, code: "FMC-DOC-REQUIRED", transaction: false,
        message: "[FMC-DOC-REQUIRED] fmc_stairs_check needs document: a title or a full path. Refusing to use the active document.",
      }, true);
    }
    const body = { document: args.document, levels: args.levels, sources: args.sources, kinds: args.kinds };
    const snapshot = (io.read
      ? await io.read(body)
      : await withRevitConnection((client) => client.sendCommand("fmc_stairs_check", body, 180000))) as Record<string, unknown>;
    if (snapshot.refused || snapshot.code) {
      return reply({
        tool: "fmc_stairs_check", read_only: true, refused: true, transaction: false,
        code: snapshot.code || "FMC-STAIRS-CHECK", message: snapshot.message || "The read was refused.",
      }, true);
    }
    const standards = standardsOf(io);
    const rules = resolveRules(standards, { use: args.use, accessible: args.accessible, overrides: args.overrides });
    const input: CheckInput = {
      stairs: list(snapshot.stairs), ramps: list(snapshot.ramps), railings: list(snapshot.railings),
    };
    const rows = runChecks(input, rules, { kinds: args.kinds as ElementKind[], levels: args.levels, accessible: args.accessible });
    const summary = summarise(rows);
    const status = overall(summary);
    const resolved = (snapshot.resolved_document ?? {}) as { title?: string; path?: string };
    const used = rulesList(rules);
    const needsConfirmation = used.filter((rule) => !rule.can_pass).map((rule) => ({ check: rule.id, key: rule.key, value: rule.value, value_max: rule.value_max ?? null, unit: rule.unit, why: rule.clause }));
    const fileBody = {
      document: resolved.title || args.document,
      path: resolved.path || "",
      status, summary, tolerance_mm: TOLERANCE_MM, use: args.use ?? "", accessible: args.accessible,
      rules: used, needs_confirmation: needsConfirmation,
      notes: snapshot.notes ?? [], unloaded_links: snapshot.unloaded_links ?? [],
      elements: rows,
    };
    const report = writeStairsReport(env, fileBody, io.reportDir);
    const limit = args.element_limit;
    return reply({
      tool: "fmc_stairs_check",
      read_only: true,
      applied: false,
      transaction: false,
      saved: false,
      synced: false,
      images: [] as [],
      document: resolved.title || args.document,
      resolved_document: { title: resolved.title || "", path: resolved.path || "" },
      sources: args.sources,
      levels: args.levels,
      kinds: args.kinds,
      use: args.use ?? "",
      accessible: args.accessible,
      status,
      summary,
      tolerance_mm: TOLERANCE_MM,
      rules: used,
      needs_confirmation: needsConfirmation,
      bank_shape: BANK_SHAPE,
      notes: snapshot.notes ?? [],
      unloaded_links: snapshot.unloaded_links ?? [],
      elements: rows.slice(0, limit),
      truncated: rows.length > limit,
      report,
      cites: {
        kit: "FMC-BIM-MAN-001",
        standards: "FMC-BIM-STD-002 stairs.*, guards.*, accessibility.*",
        rulebook: "Read-only. No transaction and no rollback.",
      },
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcStairsCheckTool(server: McpServer) {
  server.tool("fmc_stairs_check", FMC_STAIRS_CHECK_DESCRIPTION, FMC_STAIRS_CHECK_SHAPE, async (args) => runFmcStairsCheck(args as FmcStairsCheckArgs));
}