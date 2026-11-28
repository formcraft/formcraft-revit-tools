import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import type { GuardConfig } from "../fmc/policy.js";
import { siteProtectedRoots, siteReferenceProblems, siteWriteBlock } from "../fmc/sitecommon.js";
import { SUN_FIX, checkReadback, planSunStudy, writeSunReport, type SunReadback, type SunSite } from "../fmc/sun.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_SUN_DESCRIPTION =
  "Formcraft sun position and shadow study views. " +
  "read reports the document's site (latitude, longitude, time zone), the 3D views and the views that already hold a sun study. No transaction. " +
  "study computes the sun altitude and azimuth (true north, clockwise) for each date and local time and plans one 3D view per still, " +
  "or one view per date for kind one_day (start_time to end_time at interval_min). Dates are YYYY-MM-DD, or preset solstices_equinoxes (default), solstices or equinoxes. " +
  "Each view is a copy of source_view (a 3D view) or a new isometric 3D view, named name_prefix_YYYY-MM-DD_HHMM, with its sun settings set, shadows on and the sun path when sun_path is true. " +
  "An existing view name is skipped, never replaced. The sun below the horizon is skipped. " +
  "dry_run defaults to true and changes nothing. A write is fmc_sun_apply, one transaction, and needs batch_lease plus references.kit, references.standards and references.rulebook. " +
  "After the write Revit's own sun angle is read back and compared with the computed one (FMC-SUN-READBACK over 1 degree). " +
  "Pass document. HEBERT HOSTELS, a central model and protected paths are refused. JSON under %LOCALAPPDATA%\\Formcraft\\sun. No pictures. " +
  "Example: action study, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, times [09:00, 12:00, 15:00], dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_SUN_SHAPE = {
  action: z.enum(["read", "study"]),
  document: z.string().optional().default(""),
  kind: z.enum(["stills", "one_day"]).optional().default("stills"),
  dates: z.array(z.string()).optional().default([]).describe("YYYY-MM-DD. Empty uses preset."),
  preset: z.enum(["solstices_equinoxes", "solstices", "equinoxes"]).optional().default("solstices_equinoxes"),
  year: z.number().int().min(1900).max(2200).optional(),
  times: z.array(z.string()).optional().default([]).describe("stills: local HH:MM. Empty is 09:00, 12:00, 15:00."),
  start_time: z.string().optional().default("08:00"),
  end_time: z.string().optional().default("17:00"),
  interval_min: z.number().int().optional().default(60),
  name_prefix: z.string().optional().default("FMC_SUN"),
  source_view: z.string().optional().default("").describe("A 3D view name or id to copy. Empty makes a new isometric view."),
  sun_path: z.boolean().optional().default(true),
  latitude_deg: z.number().min(-90).max(90).optional().describe("Overrides the Revit site only when the site has none."),
  longitude_deg: z.number().min(-180).max(180).optional(),
  time_zone_h: z.number().min(-12).max(14).optional(),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
  sample_limit: z.number().int().min(1).max(100).optional().default(24),
};

export type FmcSunArgs = z.infer<z.ZodObject<typeof FMC_SUN_SHAPE>>;

export interface SunIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
  now?: Date;
}

function stamp(extra: Record<string, unknown> = {}) {
  return { tool: "fmc_sun", images: [] as [], saved: false, synced: false, ...extra };
}

function refused(code: string, message?: string) {
  return reply({ ...stamp(), refused: true, code, message: message ?? SUN_FIX[code] ?? code }, true);
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-SUN";
  return reply({ ...stamp(), refused: true, code, message }, true);
}

/** The Revit site, or the args when the site is missing. null when neither gives all three numbers. */
export function siteOf(raw: unknown, args: FmcSunArgs): SunSite | null {
  const s = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const lat = num(s.latitude_deg);
  const lon = num(s.longitude_deg);
  const tz = num(s.time_zone_h);
  if (lat != null && lon != null && tz != null && !(lat === 0 && lon === 0)) {
    return { latitude_deg: lat, longitude_deg: lon, time_zone_h: tz, place_name: typeof s.place_name === "string" ? s.place_name : "", source: "revit" };
  }
  if (args.latitude_deg != null && args.longitude_deg != null && args.time_zone_h != null) {
    return { latitude_deg: args.latitude_deg, longitude_deg: args.longitude_deg, time_zone_h: args.time_zone_h, source: "args" };
  }
  return null;
}

export async function runFmcSun(args: FmcSunArgs, io: SunIo = {}) {
  const env = io.env ?? process.env;
  try {
    const document = args.document.trim();
    if (!document) return refused("FMC-DOC-REQUIRED");
    const readBody = { document };
    const raw = io.read ? await io.read(readBody) : await withRevitConnection((client) => client.sendCommand("fmc_sun", readBody, 120000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return refused(String(body.code ?? "FMC-SUN"), String(body.message ?? "The read was refused."));
    const doc = { title: String(body.title ?? document), path: String(body.path ?? ""), is_central: body.is_central === true };
    const views3d = Array.isArray(body.views_3d) ? body.views_3d as Array<Record<string, unknown>> : [];
    const viewNames = Array.isArray(body.view_names) ? (body.view_names as unknown[]).map(String) : [];
    const sample = args.sample_limit;
    const site = siteOf(body.site, args);
    if (args.action === "read") {
      return reply(stamp({
        action: "read",
        read_only: true,
        document: doc.title,
        site: site ?? body.site ?? null,
        site_ok: site != null,
        project_north_deg: body.project_north_deg ?? null,
        views_3d: views3d.slice(0, sample),
        views_3d_count: views3d.length,
        sun_views: Array.isArray(body.sun_views) ? (body.sun_views as unknown[]).slice(0, sample) : [],
      }));
    }
    if (!site) return refused("FMC-SUN-SITE");
    if (args.source_view.trim()) {
      const key = args.source_view.trim().toLowerCase();
      const hit = views3d.find((v) => String(v.id ?? "") === key || String(v.name ?? "").toLowerCase() === key);
      if (!hit || hit.is_template === true) return refused("FMC-SUN-SOURCE-VIEW", `${args.source_view}: ${SUN_FIX["FMC-SUN-SOURCE-VIEW"]}`);
    }
    const plan = planSunStudy(site, {
      kind: args.kind, dates: args.dates, preset: args.preset, year: args.year, times: args.times,
      start_time: args.start_time, end_time: args.end_time, interval_min: args.interval_min, name_prefix: args.name_prefix,
    }, viewNames, io.now);
    const report = writeSunReport(env, { document: doc.title, site, plan }, io.reportDir);
    const dry = args.dry_run !== false;
    const summary = stamp({
      action: "study",
      dry_run: dry,
      read_only: dry,
      document: doc.title,
      site,
      kind: args.kind,
      source_view: args.source_view || null,
      studies: plan.studies.slice(0, sample),
      studies_count: plan.studies.length,
      skipped: plan.skipped.slice(0, sample),
      skipped_count: plan.skipped.length,
      note: plan.sample_times_note,
      report,
    });
    if (dry) return reply({ ...summary, next: "Nothing was made. Apply with dry_run false, batch_lease, and references. That call is fmc_sun_apply, one transaction." });
    const guard = siteWriteBlock("fmc_sun", doc, io.guard, env);
    if (guard.reason) return refused("FMC-SUN-GUARD", guard.reason);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return refused("FMC-BATCH-LOCKED");
    const refsProblem = siteReferenceProblems(args.references, SUN_FIX["FMC-SUN-REFERENCES"]);
    if (refsProblem) return refused("FMC-SUN-REFERENCES", refsProblem);
    if (!plan.studies.length) return reply({ ...summary, refused: true, code: "FMC-SUN-PLAN", message: SUN_FIX["FMC-SUN-PLAN"] }, true);
    const roots = siteProtectedRoots(guard.config);
    const applyBody = {
      document,
      source_view: args.source_view.trim(),
      sun_path: args.sun_path !== false,
      studies: plan.studies.map((row) => ({
        name: row.name, kind: row.kind, utc: row.utc, end_utc: row.end_utc ?? "", interval_min: row.interval_min ?? 0,
      })),
      protected_roots: roots,
      _protected_roots: roots,
      references: args.references ?? {},
    };
    const applied = (io.apply
      ? await io.apply(applyBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_sun_apply", applyBody, 300000))) as Record<string, unknown>;
    const views = Array.isArray(applied.views) ? applied.views as SunReadback[] : [];
    const readback = checkReadback(plan.studies, views);
    const mismatches = readback.filter((row) => row.code === "FMC-SUN-READBACK").length;
    return reply({
      ...summary,
      read_only: false,
      dry_run: false,
      views: readback.slice(0, sample),
      views_made: views.filter((row) => row.view_id && !row.code).length,
      readback_mismatches: mismatches,
      applied: { ok: applied.ok === true, failed: Array.isArray(applied.failed) ? applied.failed : [], shadows: applied.shadows ?? null },
      ...(mismatches ? { code: "FMC-SUN-READBACK", message: SUN_FIX["FMC-SUN-READBACK"] } : {}),
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcSunTool(server: McpServer) {
  server.tool("fmc_sun", FMC_SUN_DESCRIPTION, FMC_SUN_SHAPE, async (args) => runFmcSun(args as FmcSunArgs));
}
