import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { loadConfig, type GuardConfig } from "../fmc/policy.js";
import { batchLease } from "../fmc/target.js";
import { writeReport } from "../fmc/localreport.js";
import { routePreview, type RouteRequest } from "../fmc/route.js";
import { planPlacement, type PlacementPlan } from "../fmc/mepfit.js";
import { routingCoverage, type CurveTypeRow, type RoutingCoverage } from "../fmc/mepsystems.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}
function fail(code: string, message: string, hint: string, extra: object = {}) {
  return reply({ tool: "fmc_mep_route", ok: false, code, message: `[${code}] ${message}`, hint, ...extra }, true);
}

export const FMC_MEP_ROUTE_DESCRIPTION =
  "Formcraft pipe and duct routing with fittings. Actions: preview (the constraint-aware route, the same solver as fmc_trace route, " +
  "plus the pieces and fittings it would place; no Revit write) and place (create the pipe or duct pieces with an existing type, " +
  "system type and level, then an elbow at each corner, a tee at each branch, a union at each stock-length joint, and a cap at open ends " +
  "when caps is true). Fittings come from the type's routing preferences as they are: a group with no rule is FMC-NO-FITTING-TYPE before " +
  "anything is sent, and this tool never edits routing preferences (that is modify_model edit_type). dry_run defaults to true. dry_run false " +
  "needs batch_lease. Each piece and each fitting is its own subtransaction, so one failure does not roll the rest back. HEBERT HOSTELS, a " +
  "central and protected_paths are refused. Coordinates are mm in the model's internal coordinates. Nothing is saved.";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const box = z.object({ id: z.string().optional(), kind: z.string().optional(), min: vec3, max: vec3 });

export const FMC_MEP_ROUTE_SHAPE = {
  action: z.enum(["preview", "place"]),
  kind: z.enum(["pipe", "duct"]),
  route: z.object({
    start: vec3, goal: vec3, branches: z.array(vec3).optional(),
    bounds: z.object({ min: vec3, max: vec3 }),
    grid_mm: z.number().positive().optional(), size_mm: z.number().positive().optional(), clearance_mm: z.number().nonnegative().optional(),
    obstacles: z.array(box).optional(), flow: z.enum(["gravity", "pressure"]).optional(),
  }).passthrough().describe("The route request for the solver (route.ts): slope, z_min_mm, z_max_mm, max_length_mm, max_bends, stock_length_mm pass through"),
  type_name: z.string().optional().default(""),
  system_type_name: z.string().optional().default(""),
  level_name: z.string().optional().default(""),
  size_mm: z.number().positive().optional(),
  caps: z.boolean().optional().default(false),
  angles_deg: z.array(z.number().positive()).optional().default([]),
  document: z.string().optional().default(""),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  sample_limit: z.number().int().min(1).max(200).optional().default(40),
};

export type FmcMepRouteArgs = z.infer<z.ZodObject<typeof FMC_MEP_ROUTE_SHAPE>>;

export interface RouteSnapshot {
  model?: string;
  resolved_document?: { title?: string; path?: string };
  is_central?: boolean;
  curve_types?: CurveTypeRow[];
  system_types?: Array<{ id: number; name: string; classification?: string }>;
  levels?: Array<{ id: number; name: string; elevation_mm?: number }>;
}

export interface MepRouteIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  guard?: GuardConfig;
  env?: NodeJS.ProcessEnv;
}

function guard(snapshot: RouteSnapshot, io: MepRouteIo, named = ""): string | null {
  const config = io.guard ?? loadConfig().config;
  const title = snapshot.resolved_document?.title || snapshot.model || "";
  const file = snapshot.resolved_document?.path || "";
  if (/hebert hostels/i.test(`${title} ${file} ${named}`)) return "HEBERT HOSTELS is not written by fmc_mep_route.";
  if (snapshot.is_central) return "A central model is not written by fmc_mep_route.";
  const pathName = file.replace(/\//g, "\\").toLowerCase();
  for (const root of (config as { protected_paths?: string[] }).protected_paths ?? []) {
    const norm = root.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (norm && (pathName === norm || pathName.startsWith(norm + "\\"))) return `The document is under a protected path (${root}).`;
  }
  return null;
}

const byName = <T extends { name: string }>(rows: T[], name: string): T | undefined =>
  name.trim() ? rows.find((r) => r.name.toLowerCase() === name.trim().toLowerCase()) : rows.length === 1 ? rows[0] : undefined;

function summary(plan: PlacementPlan, sample: number) {
  return {
    counts: plan.counts,
    blocked: plan.blocked.slice(0, sample),
    fittings: plan.fittings.slice(0, sample),
    pieces: plan.pieces.slice(0, sample),
    capped: plan.pieces.length > sample || plan.fittings.length > sample,
  };
}

export async function runFmcMepRoute(args: FmcMepRouteArgs, io: MepRouteIo = {}) {
  const sample = args.sample_limit;
  const request = { ...(args.route as unknown as RouteRequest), ...(args.size_mm && !args.route.size_mm ? { size_mm: args.size_mm } : {}) };
  const route = routePreview(request);
  if (!route.ok) return reply({ tool: "fmc_mep_route", read_only: true, action: args.action, route }, true);

  let snapshot: RouteSnapshot = {};
  let coverage: RoutingCoverage | undefined;
  let notes: string[] = [];
  const needRevit = args.action === "place" || args.type_name.trim().length > 0;
  if (needRevit) {
    try {
      const body = { document: args.document, kind: args.kind };
      snapshot = (io.read ? await io.read(body) : await withRevitConnection((client) => client.sendCommand("fmc_mep_route", body, 300000))) as RouteSnapshot;
    } catch (error) {
      return reply({ tool: "fmc_mep_route", read_only: true, error: error instanceof Error ? error.message : String(error) }, true);
    }
    const type = byName(snapshot.curve_types ?? [], args.type_name);
    if (type) coverage = routingCoverage(type);
    else notes.push(args.type_name ? `No ${args.kind} type named ${args.type_name}.` : `Name the ${args.kind} type (type_name).`);
  } else notes = ["No type named: every fitting is planned, and the type's routing preferences decide in Revit. Name type_name to check them first."];

  const plan = planPlacement(route, { coverage, caps: args.caps, angles_deg: args.angles_deg });
  const report = writeReport("mep_route", args.action, { route, plan, coverage }, io.env);
  const base = { tool: "fmc_mep_route", action: args.action, kind: args.kind, route: { runs: route.runs.length, totals: route.totals, warnings: route.warnings }, coverage, notes, report };

  if (args.action === "preview") return reply({ ...base, read_only: true, ...summary(plan, sample) });

  const type = byName(snapshot.curve_types ?? [], args.type_name);
  const systemType = byName(snapshot.system_types ?? [], args.system_type_name);
  const level = byName(snapshot.levels ?? [], args.level_name);
  const missing = [!type && "type_name", !systemType && "system_type_name", !level && "level_name"].filter(Boolean) as string[];
  if (missing.length) return fail("FMC-ROUTE-INPUT", `Not found or not named: ${missing.join(", ")}.`, "fmc_mep_systems types and routing list the names.", { notes });
  const refusal = guard(snapshot, io, args.document);
  if (refusal) return fail("FMC-ROUTE-GUARD", refusal, "This model is not written by fmc_mep_route.");
  if (plan.blocked.length) {
    return fail("FMC-NO-FITTING-TYPE", `${plan.blocked.length} fitting(s) cannot be placed with ${type!.name} as it is.`,
      "Add the missing routing rule with modify_model edit_type routing (the system-type editor), or pick another type. Nothing was changed.",
      { blocked: plan.blocked.slice(0, sample), coverage });
  }
  const body = {
    document: args.document, kind: args.kind, type_id: type!.id, system_type_id: systemType!.id, level_id: level!.id,
    size_mm: request.size_mm ?? 0, pieces: plan.pieces, fittings: plan.fittings,
  };
  if (args.dry_run !== false) {
    return reply({ ...base, dry_run: true, read_only: true, ...summary(plan, sample),
      target: { type: type!.name, system_type: systemType!.name, level: level!.name },
      next: "Apply with dry_run false and batch_lease. Each piece and each fitting is its own subtransaction." });
  }
  const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
  if (!lease) return fail("FMC-BATCH-LOCKED", "This write needs batch_lease from fmc_batch request. Nothing was changed.", "fmc_batch request, then pass batch_lease.");
  try {
    const applied = (io.apply ? await io.apply(body) : await withRevitConnection((client) => client.sendCommand("fmc_mep_route_apply", body, 300000))) as Record<string, unknown>;
    return reply({ ...base, dry_run: false, ...applied, planned: plan.counts }, applied?.applied !== true);
  } catch (error) {
    return reply({ tool: "fmc_mep_route", error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcMepRouteTool(server: McpServer) {
  server.tool("fmc_mep_route", FMC_MEP_ROUTE_DESCRIPTION, FMC_MEP_ROUTE_SHAPE, (args) => runFmcMepRoute(args));
}
