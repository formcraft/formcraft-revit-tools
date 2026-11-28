import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import {
  HEADROOM_BANK_SHAPE, citeHeadroom, filterLevels, headroomHits, verdict, writeHeadroomReport,
  type HeadroomObstacle, type HeadroomZone,
} from "../fmc/headroom.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_HEADROOM_DESCRIPTION =
  "Formcraft clear headroom. Read-only. There is no dry run and no transaction: no rollback, no view created, no element moved. " +
  "Scans stairs, corridors and rooms in the host and in loaded links. Clear height is the distance from the walking surface up to the underside of a beam, duct, pipe or soffit. " +
  "A 3D view that already exists is used with ReferenceIntersector. Without one, bounding boxes are used and the reply says so. " +
  "min_clear_mm comes from headroom.min_clear_mm in the standards bank. A missing key is the provisional 2100 mm and cannot PASS. " +
  "levels limits the scan to those level names. sources is host, link, or both (the default). " +
  "Pass document. A missing name is FMC-DOC-REQUIRED. The active document is not a guess. " +
  "Hits return ids, a location in millimetres, and the clear height. The full JSON is under %LOCALAPPDATA%\\Formcraft\\headroom. No pictures. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, levels [\"Level 1\"], sources [\"host\", \"link\"].";

export const FMC_HEADROOM_SHAPE = {
  document: z.string().optional().default("").describe("Title or full path of an open document. Required."),
  levels: z.array(z.string()).optional().default([]).describe("Level names. Empty scans every level."),
  min_clear_mm: z.number().positive().optional().describe("Overrides the number. A missing standards key stays PROVISIONAL and cannot PASS."),
  sources: z.array(z.enum(["host", "link"])).optional().default(["host", "link"]),
  sample_limit: z.number().int().min(1).max(100).optional().default(50),
};

export type FmcHeadroomArgs = z.infer<z.ZodObject<typeof FMC_HEADROOM_SHAPE>>;

export interface HeadroomIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  standards?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-HEADROOM";
  return reply({ tool: "fmc_headroom", read_only: true, refused: true, code, message, transaction: false }, true);
}

function standardsOf(io: HeadroomIo): Record<string, unknown> | null {
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

function asZones(raw: unknown): HeadroomZone[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row) => row && typeof row === "object") as HeadroomZone[];
}

function asObstacles(raw: unknown): HeadroomObstacle[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row) => row && typeof row === "object") as HeadroomObstacle[];
}

export async function runFmcHeadroom(args: FmcHeadroomArgs, io: HeadroomIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) {
      return reply({
        tool: "fmc_headroom", read_only: true, refused: true, code: "FMC-DOC-REQUIRED", transaction: false,
        message: "[FMC-DOC-REQUIRED] fmc_headroom needs document: a title or a full path. Refusing to use the active document.",
      }, true);
    }
    const body = { document: args.document, levels: args.levels, sources: args.sources };
    const snapshot = (io.read
      ? await io.read(body)
      : await withRevitConnection((client) => client.sendCommand("fmc_headroom", body, 180000))) as Record<string, unknown>;
    if (snapshot.refused || snapshot.code) {
      return reply({
        tool: "fmc_headroom", read_only: true, refused: true, transaction: false,
        code: snapshot.code || "FMC-HEADROOM", message: snapshot.message || "The read was refused.",
      }, true);
    }
    const cited = citeHeadroom(standardsOf(io), args.min_clear_mm);
    const zones = filterLevels(asZones(snapshot.zones), args.levels);
    const obstacles = asObstacles(snapshot.obstacles);
    const hits = headroomHits(zones, obstacles, cited.value, args.sources);
    const status = verdict(hits.length, cited);
    const worst = hits.length ? hits[0].clear_mm : null;
    const resolved = (snapshot.resolved_document ?? {}) as { title?: string; path?: string };
    const fileBody = {
      document: resolved.title || args.document,
      path: resolved.path || "",
      min_clear: cited,
      status,
      method: snapshot.method ?? (hits.some((hit) => hit.method === "ray") ? "ray" : "bbox"),
      view3d: snapshot.view3d ?? null,
      notes: snapshot.notes ?? [],
      unloaded_links: snapshot.unloaded_links ?? [],
      zones: zones.length,
      obstacles: obstacles.length,
      hits,
    };
    const report = writeHeadroomReport(env, fileBody, io.reportDir);
    const sample = args.sample_limit;
    return reply({
      tool: "fmc_headroom",
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
      min_clear: cited,
      bank_shape: HEADROOM_BANK_SHAPE,
      status,
      can_pass: cited.can_pass,
      method: fileBody.method,
      view3d: snapshot.view3d ?? null,
      notes: snapshot.notes ?? [],
      unloaded_links: snapshot.unloaded_links ?? [],
      zones: zones.length,
      obstacles: obstacles.length,
      hit_count: hits.length,
      worst_mm: worst,
      hits: hits.slice(0, sample),
      truncated: hits.length > sample,
      report,
      cites: {
        kit: "FMC-BIM-MAN-001",
        standards: "FMC-BIM-STD-002 headroom.min_clear_mm",
        rulebook: "Read-only. No transaction and no rollback.",
      },
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcHeadroomTool(server: McpServer) {
  server.tool("fmc_headroom", FMC_HEADROOM_DESCRIPTION, FMC_HEADROOM_SHAPE, async (args) => runFmcHeadroom(args as FmcHeadroomArgs));
}
