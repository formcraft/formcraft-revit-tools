import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { configPath, loadConfig } from "../fmc/policy.js";
import {
  ASSETS_FIX, ASSETS_PROVISIONAL_NOTE, SHEETS, assetsStatus, buildRegister, loadAssetsSpec, sheetCsv, type AssetsRead, type SheetName,
} from "../fmc/assets.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_ASSETS_DESCRIPTION =
  "COBie-style asset register, READ ONLY (gap-analysis proposal 20): five sheets with COBie 2.4 column names, Facility (project information), " +
  "Space (placed rooms and MEP spaces), Type (element types in use: Manufacturer, ModelNumber, AssemblyCode, OmniClass), Component (family instances of the " +
  "asset categories, with their room or space) and System (MEP systems and their components). It is a register, not a certified COBie file. " +
  "No transaction, nothing saved or synced, and no file written: the sheets come back inline, as rows (format rows) or CSV text (format csv), " +
  "at most max_rows rows per sheet (the counts are always whole). sheets picks some of the five. " +
  "Categories and required fields come from the kit 03_Master_Data/FMC_Assets.json; it does not exist yet, so the built-in sample is used and the status is PROVISIONAL. " +
  "Gaps (a component in no space, a type without Manufacturer or ModelNumber, duplicate names) are listed with counts. Status: PROVISIONAL, GAPS or READY; never PASS. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-M-0001, sheets [Type, Component], format rows.";

export const FMC_ASSETS_SHAPE = {
  document: z.string().optional().default(""),
  sheets: z.array(z.string()).optional(),
  format: z.enum(["rows", "csv"]).optional().default("rows"),
  max_rows: z.number().int().min(0).max(5000).optional().default(200),
  categories: z.array(z.string()).optional(),
  max_elements: z.number().int().min(1).max(200000).optional().default(20000),
  max_gaps: z.number().int().min(0).max(2000).optional().default(100),
  spec: z.string().optional().default(""),
};

export type FmcAssetsArgs = z.infer<z.ZodObject<typeof FMC_ASSETS_SHAPE>>;

export interface AssetsIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  kitRoot?: string;
  specText?: string;
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_assets",
    read_only: true,
    written: false,
    saved: false,
    synced: false,
    model_changed: false,
    images: [] as [],
    cites: {
      kit: "03_Master_Data/FMC_Assets.json (not in the kit yet)",
      standards: "COBie 2.4 sheet and column names (Facility, Space, Type, Component, System)",
      rulebook: "A register for the person to check; not a certified COBie deliverable.",
    },
    ...extra,
  };
}

function refuse(code: string, message?: string) {
  return reply({ ...stamp(), refused: true, code, message: message ?? ASSETS_FIX[code] ?? code }, true);
}

function kitRootOf(io: AssetsIo): string {
  if (io.kitRoot != null) return io.kitRoot;
  try { return kitPaths(loadConfig(configPath(io.env ?? process.env)).config).root; } catch { return ""; }
}

export async function runFmcAssets(args: FmcAssetsArgs, io: AssetsIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) return refuse("FMC-DOC-REQUIRED");
    const wanted: SheetName[] = [];
    for (const raw of args.sheets?.length ? args.sheets : [...SHEETS]) {
      const hit = SHEETS.find((k) => k.toLowerCase() === raw.trim().toLowerCase());
      if (!hit) return refuse("FMC-ASSETS-SHEET", `${ASSETS_FIX["FMC-ASSETS-SHEET"]} Not: ${raw}`);
      if (!wanted.includes(hit)) wanted.push(hit);
    }
    let loaded;
    try {
      loaded = loadAssetsSpec({ file: args.spec, kitRoot: kitRootOf(io), env, ...(io.specText != null ? { read: () => io.specText as string } : {}) });
    } catch (error) {
      return refuse("FMC-ASSETS-SPEC", error instanceof Error ? error.message : String(error));
    }
    const spec = loaded.spec;
    const categories = args.categories?.length ? args.categories : (spec.categories ?? []);
    const readBody = {
      document: args.document.trim(),
      categories,
      component_parameters: Object.values(spec.component_parameters ?? {}).filter(Boolean),
      type_parameters: Object.values(spec.type_parameters ?? {}).filter(Boolean),
      max_elements: args.max_elements,
    };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_assets_read", readBody, 300000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return refuse(String(body.code ?? "FMC-ASSETS"), String(body.message ?? "The read was refused."));
    if (body.is_family === true) return refuse("FMC-ASSETS-FAMILY");
    const read = { ...(body as unknown as AssetsRead), title: String(body.title ?? args.document), path: String(body.path ?? "") };
    const reg = buildRegister(read, spec);
    const status = assetsStatus(reg, loaded.provisional);
    const sheets: Record<string, unknown> = {};
    const truncated: Record<string, boolean> = {};
    for (const k of wanted) {
      const rows = reg.sheets[k].slice(0, args.max_rows);
      truncated[k] = rows.length < reg.sheets[k].length;
      sheets[k] = args.format === "csv" ? sheetCsv(reg, k, rows) : rows;
    }
    return reply(stamp({
      document: read.title,
      status,
      can_pass: false,
      ready: status === "READY",
      provisional: loaded.provisional,
      ...(loaded.provisional ? { provisional_note: ASSETS_PROVISIONAL_NOTE } : {}),
      spec: loaded.path,
      spec_source: loaded.source,
      categories,
      format: args.format,
      counts: reg.counts,
      rows_returned: Object.fromEntries(wanted.map((k) => [k, Math.min(args.max_rows, reg.sheets[k].length)])),
      rows_cut: truncated,
      columns: Object.fromEntries(wanted.map((k) => [k, reg.columns[k]])),
      sheets,
      gap_counts: reg.gap_counts,
      gaps: reg.gaps.slice(0, args.max_gaps),
      warnings: reg.warnings,
      next: status === "READY"
        ? "Nothing was written. The person checks the register; the tool marks nothing passed."
        : "Nothing was written. Fill the gaps in the model (or add the kit spec) and read again; the tool marks nothing passed.",
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-ASSETS";
    return reply({ ...stamp(), refused: true, code, message }, true);
  }
}

export function registerFmcAssetsTool(server: McpServer) {
  server.tool("fmc_assets", FMC_ASSETS_DESCRIPTION, FMC_ASSETS_SHAPE, async (args) => runFmcAssets(args as FmcAssetsArgs));
}
