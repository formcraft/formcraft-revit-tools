import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import {
  DEFAULT_ALLOW_DRAFT, DEFAULT_KEYS, DRAFT_LABEL, NEEDED_VALUES, SCHEMA_ID, buildChecks, candidatesFor, parseValues, summarize,
  type CheckArgs, type Facts, type Quantity, type ValuesDoc,
} from "../fmc/areacheck.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const VALUES_FILE_NAME = "FMC_Planning_Values.json";

export const FMC_AREA_CHECK_DESCRIPTION =
  "Formcraft: checks a project model against planning values (Uganda / KCCA development control). Read only: no transaction, " +
  "nothing is created or changed, nothing is written to disk. It computes GFA by level and in total (Areas in a chosen area " +
  "scheme, else Rooms, else Floors, and says which source it used), plot area (input plot_area_m2, else a named area, else the " +
  "Property Line), plot coverage (footprint / plot area), plot ratio (GFA / plot area), setbacks (distance from the footprint " +
  "to each property-line curve, front/side/rear by the segment numbers you pass, or inferred only for a four-sided plot) and " +
  "parking (required from use and GFA or unit count, against the Parking-category elements in the model or parking_provided). " +
  "THE PLANNING LIMITS ARE NOT BUILT IN. They come from a planning-values file (values_file, else env FMC_PLANNING_VALUES_FILE, " +
  "else " + VALUES_FILE_NAME + " beside the kit's FMC_Standards_Building.json), each value with a source, a clause and a status. " +
  "A limit that is not in the file is reported as 'no limit configured', and one the file has but you have not chosen as 'no limit " +
  "selected' (result unknown, with the candidate rules listed): pass limits to choose the exact file key for each check, the tool " +
  "never picks between zones or uses. Only an approved value with a source and a clause passes or fails; a draft value does so only " +
  "with allow_draft true and is then labelled DRAFT, not approved: indicative; unbanked, provisional or blank never do. " +
  "Non-numeric rules (text) are shown, not judged. Every check returns value, limit, result (pass, fail, unknown), " +
  "evidence (element ids, the source used) and assumptions. Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, area_scheme " +
  "\"Gross Building\", use residential, units 12.";

export const FMC_AREA_CHECK_SHAPE = {
  document: z.string().optional().default("").describe("The model's title or full path. Omit for the active document."),
  area_scheme: z.string().optional().default("").describe("Area scheme for GFA (default: the only scheme, else one named Gross Building)."),
  source: z.enum(["auto", "areas", "rooms", "floors"]).optional().default("auto").describe("auto uses areas, then rooms, then floors, whichever has data first."),
  footprint_level: z.string().optional().default("").describe("Level whose area is the building footprint (default: the lowest level with data)."),
  footprint_area_m2: z.number().positive().optional().describe("Footprint area in m2, overriding the model."),
  plot_area_m2: z.number().positive().optional().describe("Plot area in m2, overriding the model."),
  plot_area_name: z.string().optional().default("").describe("Name of an Area that is the plot."),
  property_line_ids: z.array(z.union([z.string(), z.number()])).optional().default([]).describe("Only these property-line elements (default: all in the model)."),
  front_segments: z.array(z.number().int().positive()).optional().default([]).describe("Segment numbers (from setback_overall) of the front boundary."),
  side_segments: z.array(z.number().int().positive()).optional().default([]),
  rear_segments: z.array(z.number().int().positive()).optional().default([]),
  use: z.string().optional().default("").describe("Use for parking, e.g. residential. Must match a parking.<use> key in the values file."),
  units: z.number().int().positive().optional().describe("Dwelling units, for a per_dwelling_unit parking rule."),
  parking_provided: z.number().int().min(0).optional().describe("Spaces provided, overriding the Parking elements counted in the model."),
  limits: z.object({
    plot_coverage: z.string().optional(), plot_ratio: z.string().optional(),
    setback_front: z.string().optional(), setback_side: z.string().optional(), setback_rear: z.string().optional(),
    parking: z.string().optional(),
  }).optional().default({}).describe("The exact key in the values file to judge each check against, e.g. plot_coverage: plot_coverage.max.nppsg2011_residential_medium_density. Without one, the check lists the candidate keys and does not judge."),
  allow_draft: z.boolean().optional().describe("A draft value judges only when true (default " + String(DEFAULT_ALLOW_DRAFT) + "); results are labelled DRAFT, not approved: indicative."),
  zone: z.string().optional().default("").describe("The planning zone the values are for; must match the values file's zone when both are given."),
  values_file: z.string().optional().default("").describe("Path to a planning-values JSON file (see docs/tools/fmc_area_check.md)."),
};

export type FmcAreaCheckArgs = z.infer<z.ZodObject<typeof FMC_AREA_CHECK_SHAPE>>;

export interface AreaCheckIo {
  send?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
}

function refuse(code: string, message: string) {
  return reply({ tool: "fmc_area_check", model_changed: false, read_only: true, refused: true, code, message }, true);
}

const looksWindows = (p: string) => /^[A-Za-z]:[\\/]|^\\\\/.test(p) || (p.includes("\\") && !p.includes("/"));
const joinLike = (base: string, ...parts: string[]) => (looksWindows(base) ? path.win32 : path.posix).join(base, ...parts);
const dirLike = (p: string) => (looksWindows(p) ? path.win32 : path.posix).dirname(p);

export interface ValuesLoad {
  file: string; found: boolean; where_looked: string[]; doc: ValuesDoc | null; problem: string;
}

/** values_file, else FMC_PLANNING_VALUES_FILE, else the kit folder's file. Reads only; never writes. */
export function loadValues(args: { values_file: string }, env: NodeJS.ProcessEnv, guard?: GuardConfig): ValuesLoad {
  const looked: string[] = [];
  let file = args.values_file.trim();
  if (file) looked.push(`values_file argument: ${file}`);
  if (!file) {
    const e = (env.FMC_PLANNING_VALUES_FILE ?? "").trim();
    looked.push(e ? `FMC_PLANNING_VALUES_FILE: ${e}` : "FMC_PLANNING_VALUES_FILE: not set");
    file = e;
  }
  if (!file) {
    try {
      const config = guard ?? loadConfig(configPath(env)).config;
      file = joinLike(dirLike(kitPaths(config).recipesDir), VALUES_FILE_NAME);
      looked.push(`kit folder: ${file}`);
    } catch (e) {
      looked.push(`kit folder: not known (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (!file) return { file: "", found: false, where_looked: looked, doc: null, problem: "no planning-values file location" };
  if (!/\.json$/i.test(file)) return { file, found: false, where_looked: looked, doc: null, problem: "the planning-values file must be a .json file" };
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return { file, found: false, where_looked: looked, doc: null, problem: `no planning-values file at ${file}` }; }
  try { return { file, found: true, where_looked: looked, doc: parseValues(JSON.parse(text.replace(/^\uFEFF/, ""))), problem: "" }; }
  catch (e) { return { file, found: true, where_looked: looked, doc: null, problem: `the planning-values file is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
}

export async function runFmcAreaCheck(args: FmcAreaCheckArgs, io: AreaCheckIo = {}) {
  const env = io.env ?? process.env;
  try {
    const ids: string[] = [];
    for (const raw of args.property_line_ids) {
      const t = String(raw).trim();
      if (!/^[0-9]+$/.test(t) || /^0+$/.test(t)) return refuse("FMC-AREA-IDS", `"${t}" is not an element id (a positive whole number).`);
      ids.push(t.replace(/^0+/, ""));
    }
    const loaded = loadValues(args, env, io.guard);
    let values: ValuesDoc | null = loaded.doc;
    const notes: string[] = [];
    if (values && args.zone.trim() && values.zone && values.zone.toLowerCase() !== args.zone.trim().toLowerCase()) {
      notes.push(`The values file is for the zone "${values.zone}", not "${args.zone.trim()}": none of its values were used.`);
      values = { ...values, values: {} };
    }
    if (!loaded.found) notes.push(`${loaded.problem}. Every limit is reported as 'no limit configured'.`);
    else if (!loaded.doc) notes.push(`${loaded.problem}. Every limit is reported as 'no limit configured'.`);
    else if (Object.keys(values?.values ?? {}).length === 0 && loaded.doc.problems.length) {
      notes.push(`The values file was read but none of its entries could be used (${loaded.doc.problems.length} problem(s), first: ${loaded.doc.problems[0]}). That is a file problem, not "no limit configured".`);
    } else if (loaded.doc.problems.length) notes.push(`${loaded.doc.problems.length} entry problem(s) in the values file are listed under planning_values.problems; those entries were not used.`);

    const send = io.send ?? ((body: Record<string, unknown>) => withRevitConnection((client) => client.sendCommand("fmc_area_check", body, 120000)));
    const body: Record<string, unknown> = {};
    if (args.document.trim()) body.document = args.document.trim();
    if (args.area_scheme.trim()) body.area_scheme = args.area_scheme.trim();
    if (args.footprint_level.trim()) body.footprint_level = args.footprint_level.trim();
    if (args.plot_area_name.trim()) body.plot_area_name = args.plot_area_name.trim();
    if (ids.length) body.property_line_ids = ids;
    const raw = await send(body) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || !raw.sources || typeof raw.sources !== "object") {
      return refuse("FMC-AREA-BAD-REPLY", "Revit's reply had no sources. That is an error, not 'no area'.");
    }
    const facts = raw as unknown as Facts;
    const checkArgs: CheckArgs = {
      source: args.source, use: args.use, units: args.units, parking_provided: args.parking_provided,
      plot_area_m2: args.plot_area_m2, plot_area_name: args.plot_area_name.trim(), footprint_area_m2: args.footprint_area_m2,
      front_segments: args.front_segments, side_segments: args.side_segments, rear_segments: args.rear_segments, zone: args.zone,
      limits: args.limits as Partial<Record<Quantity, string>>, allow_draft: args.allow_draft,
    };
    const report = buildChecks(facts, checkArgs, values?.values ?? {});
    // a quantity is missing when the file has no entry for it at all (the plain key or any rule in its namespace)
    const table = values?.values ?? {};
    const missing = NEEDED_VALUES.filter((n) => {
      const plain = n.quantity === "parking" ? false : !!table[DEFAULT_KEYS[n.quantity as Exclude<Quantity, "parking">]];
      return !plain && candidatesFor(n.quantity, table).length === 0;
    }).map((n) => n.key);
    if (report.draft_judged.length) notes.push(`${DRAFT_LABEL}: ${report.draft_judged.join(", ")} were judged with DRAFT values because allow_draft is on. They are not approved limits.`);
    return reply({
      tool: "fmc_area_check", model_changed: false, read_only: true,
      document: typeof raw.document === "string" ? raw.document : args.document,
      summary: summarize(report.checks),
      area_source: report.source,
      plot: report.plot,
      checks: report.checks,
      boundary_classification: report.classification,
      planning_values: {
        file: loaded.file, found: loaded.found, usable: !!values && Object.keys(values.values).length > 0,
        zone: values?.zone ?? "", jurisdiction: values?.jurisdiction ?? "", authority: values?.authority ?? "", notice: values?.notice ?? "",
        values_loaded: Object.keys(values?.values ?? {}).length, problems: values?.problems ?? [], where_looked: loaded.where_looked,
        values_missing: missing, schema: SCHEMA_ID, application_notes: values?.application_notes ?? [],
        allow_draft: report.allow_draft, allow_draft_default: DEFAULT_ALLOW_DRAFT, limits_selected: args.limits,
      },
      needed_values: NEEDED_VALUES,
      notes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse(message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-AREA", message);
  }
}

export function registerFmcAreaCheckTool(server: McpServer) {
  server.tool("fmc_area_check", FMC_AREA_CHECK_DESCRIPTION, FMC_AREA_CHECK_SHAPE, async (args) => runFmcAreaCheck(args as FmcAreaCheckArgs));
}
