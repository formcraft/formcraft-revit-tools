import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expandEnv, loadConfig } from "../fmc/policy.js";
import { ClashRow, navisCall, processAlive, readState } from "../fmc/navis.js";
import type { Register } from "../fmc/review.js";
import { TREE, Tree } from "../tree/tree.js";
import { exchangeRoot, identityFile, listPackages, loadIdentity } from "../hub/exchange.js";
import { ClashHit, fileLogLines, identityLines, identityMatches, matchClashes, matchPackages, matchTickets, matchTree,
  mergeTimeline, needlesFor, packageLines, ticketLines } from "../hub/find.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { csvRow } from "./fmc_sheets.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_FIND_DESCRIPTION =
  "Formcraft engineering hub, one search and one log (docs/PLAN_ENGINEERING_HUB.md, X3). find: \"where is D-12 and what " +
    "touches it\", answered across the apps from a mark, a room number, a name, a Formcraft id (FMC-…), a Revit UniqueId or " +
    "element id: the identity map (its id in each app); Revit (elements by mark, type mark, number, name or sheet number, " +
    "and the model elements touching them; partial for a part match); Navisworks (the items it became and the clashes " +
    "naming it, with what it clashes with); review tickets naming it; recipe tree nodes (by id, name or a value such as a " +
    "room number); exchange packages that carry it. An app that isn't open is skipped and said so. log: one timeline, " +
    "newest first, for the same query: the file log (FMC_MCP_FileLog.csv), exchange packages, review ticket history and " +
    "identity links, from files only. Both are read-only: nothing is selected, written or changed (fmc_select shows it). " +
    "find also takes: categories (Revit category names, e.g. [\"Doors\"]); parameter (search only that parameter's value, e.g. Comments); " +
    "offset for the next page (the reply's next_offset). Work plane grids and internal elements are left out unless all_categories is true. " +
    "A project_folder that does not exist, or does not look like the open model's project, is said so in warnings.";

export const FMC_FIND_SHAPE = {
  action: z.enum(["find", "log"]).optional().default("find"),
  query: z.string().min(1).describe("A mark (D-12), a room number, a name, a Formcraft id, a Revit UniqueId or element id"),
  project_folder: z.string().optional().default("").describe("The project: its review register, recipe tree and exchange (default <reports>\\Exchange, no tickets or tree)"),
  partial: z.boolean().optional().default(false).describe("find: Revit matches part of a mark or name too"),
  touching: z.boolean().optional().default(true).describe("find: also what touches each Revit match (its box, 25 mm apart at most)"),
  limit: z.number().int().min(1).max(500).optional().default(50).describe("find: Revit matches at most; log: timeline lines at most"),
  offset: z.number().int().min(0).optional().default(0).describe("find: skip this many Revit matches (the reply's next_offset gives the next page)"),
  categories: z.array(z.string().min(1)).optional().default([]).describe("find: only these Revit categories (names as Revit shows them, e.g. Doors, Rooms, Levels)"),
  parameter: z.string().optional().default("").describe("find: search only this parameter (instance, then type), e.g. Comments or FMC_System"),
  all_categories: z.boolean().optional().default(false).describe("find: keep work plane grids and internal elements (left out by default)"),
};

/** The project number at the start of a folder name: F26902 from F26902_TestHouse. Empty when there is none. */
export function projectNumberOf(folder: string): string {
  const base = win.basename(folder.replace(/[\\/]+$/, ""));
  const m = /^([A-Za-z]{0,3}\d{3,})/.exec(base);
  return m ? m[1] : "";
}

/**
 * Why project_folder may not be the open model's project (Tool Research: the TestHouse folder silently gave empty
 * tickets and tree for other models). Empty when it looks right or there is nothing to compare.
 */
export function projectFolderWarnings(project: string, model: { title?: string; path?: string } | null, exists: (p: string) => boolean): string[] {
  if (!project) return [];
  if (!exists(project)) return [`project_folder ${project} does not exist: review tickets, the recipe tree and exchange were not read`];
  if (!model || (!model.title && !model.path)) return [];
  const folder = project.replace(/[\\/]+$/, "").toLowerCase();
  const modelPath = (model.path ?? "").toLowerCase();
  if (modelPath && (modelPath.startsWith(folder + "\\") || modelPath.startsWith(folder + "/"))) return [];
  const number = projectNumberOf(project).toLowerCase();
  const names = `${model.title ?? ""} ${win.basename(model.path ?? "")}`.toLowerCase();
  if (number && names.includes(number)) return [];
  return [`project_folder ${project} may not be the project of the open model ${model.title || model.path}` +
    (number ? ` (its name does not hold ${projectNumberOf(project)})` : "") +
    ": empty tickets, tree or packages may mean the wrong folder, not that nothing names the element"];
}

type FindNewArgs = "offset" | "categories" | "parameter" | "all_categories";
type FindParsed = z.infer<z.ZodObject<typeof FMC_FIND_SHAPE>>;
/** The newer find arguments are optional for callers that build args by hand (tests, flows). */
export type FmcFindArgs = Omit<FindParsed, FindNewArgs> & Partial<Pick<FindParsed, FindNewArgs>>;

type Call = (method: string, params: object) => Promise<any>;

/** What the tool reads and asks. Tests pass stand-ins and temporary folders. */
export interface FindDeps {
  revit: Call | null;
  navis: Call | null;
  identityRoot: string;
  reportsDir: string;
  /** Does a folder exist (tests pass a stand-in). */
  exists?: (p: string) => boolean;
}

export function realFindDeps(projectFolder: string): FindDeps {
  const { config } = loadConfig();
  const ns = readState();
  const reports = expandEnv(config.reports_dir);
  return {
    revit: (cmd, params) => withRevitConnection((c) => c.sendRaw(cmd, params, 300000)),
    navis: ns && processAlive(ns.pid) ? (m, p) => navisCall(ns.port, m, p, 120000) : null,
    identityRoot: exchangeRoot(projectFolder || undefined, reports),
    reportsDir: reports,
  };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as T; } catch { return null; } };
const registerOf = (project: string) => (project ? readJson<Register>(win.join(project, "01_WIP", "_Reviews", "FMC_Review_Register.json")) : null);
const treeOf = (project: string): Tree | null => {
  const raw = project ? readJson<unknown>(win.join(project, "01_WIP", "_Tree", "FMC_Recipe_Tree.json")) : null;
  const t = raw ? TREE.safeParse(raw) : null;
  return t?.success ? t.data : null;
};
const csvRows = (file: string): string[][] => {
  try { return fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).map(csvRow); } catch { return []; }
};

export async function runFmcFind(args: FmcFindArgs, deps?: FindDeps) {
  const d = deps ?? realFindDeps(args.project_folder);
  const project = args.project_folder.trim();
  const query = args.query.trim();
  const map = loadIdentity(d.identityRoot);
  const entries = identityMatches(map, query);
  const noProject = project ? undefined : "No project_folder: review tickets and the recipe tree weren't searched";

  if (args.action === "log") {
    const needles = needlesFor(query, entries);
    const reg = registerOf(project);
    const lines = [
      ...fileLogLines(csvRows(win.join(d.reportsDir, "FMC_MCP_FileLog.csv")), needles),
      ...packageLines(matchPackages(d.identityRoot, listPackages(d.identityRoot), needles)),
      ...ticketLines(reg, needles),
      ...identityLines(entries),
    ];
    const t = mergeTimeline(lines, args.limit);
    return reply({ query, needles, ...t, ...(noProject ? { note: noProject } : {}),
      read_only: "From files only (the file log, exchange packages, the review register, the identity map); nothing changed" });
  }

  // Revit: the elements named by the query, and what touches them
  let revit: Record<string, unknown> = { open: false };
  let revitFound: any[] = [];
  let revitModel: { title?: string; path?: string } | null = null;
  if (d.revit) {
    try {
      const r = await d.revit("fmc_find_elements", {
        query, partial: args.partial, touching: args.touching, limit: args.limit,
        offset: args.offset ?? 0, categories: args.categories ?? [], parameter: (args.parameter ?? "").trim(), all_categories: args.all_categories === true,
      });
      revitFound = r?.found ?? [];
      revitModel = { title: r?.model, path: r?.path };
      // An add-in older than this server ignores the filters; drop work plane grids here too.
      if (!args.all_categories && !(args.categories ?? []).length) {
        const before = revitFound.length;
        revitFound = revitFound.filter((f) => !/^work plane grid$/i.test(String(f?.category ?? "")));
        if (before !== revitFound.length && typeof r?.skipped_non_model !== "number") r.skipped_non_model = before - revitFound.length;
      }
      revit = {
        model: r?.model, found: revitFound, touching: r?.touching ?? [], truncated: r?.truncated ?? false,
        ...(typeof r?.next_offset === "number" ? { next_offset: r.next_offset } : {}),
        ...(r?.skipped_non_model ? { skipped_non_model: r.skipped_non_model } : {}),
      };
    } catch (e) { revit = { error: msg(e) }; }
  }
  // a UniqueId typed as the query, or one of the map's, names the same element as Revit's matches
  const needles = needlesFor(query, entries, revitFound);

  // Navisworks: the items the Revit elements became (looked up, not selected), and every clash naming them
  let navisworks: Record<string, unknown> = { open: false, detail: "Navisworks with the Formcraft bridge isn't open (fmc_navis status)" };
  if (d.navis) {
    try {
      const items = revitFound.filter((f) => f.element_id !== undefined).map((f) => ({ revit_id: String(f.element_id), source: String(f.model ?? "") }));
      const found = items.length ? await d.navis("navis_select", { items, select: false }) : { found: [] };
      const tests = ((await d.navis("navis_clash_tests", {}))?.tests ?? []) as Array<{ name: string }>;
      const clashes: ClashHit[] = [];
      for (const t of tests.slice(0, 30)) {
        const r = await d.navis("navis_clash_results", { test: t.name, limit: 2000 });
        clashes.push(...matchClashes(t.name, (r?.results ?? []) as ClashRow[], needles));
      }
      navisworks = { items: found?.found ?? [], clashes: clashes.slice(0, 200), clash_count: clashes.length, tests_read: Math.min(tests.length, 30) };
    } catch (e) { navisworks = { error: msg(e) }; }
  }

  const tickets = matchTickets(registerOf(project), needles);
  const tree = matchTree(treeOf(project), query);
  const packages = matchPackages(d.identityRoot, listPackages(d.identityRoot), needles);
  const warnings = projectFolderWarnings(project, revitModel, d.exists ?? ((p) => fs.existsSync(p)));
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const summary = `${revitFound.length} Revit, ${count((navisworks as { items?: unknown }).items)} Navisworks, ${count((navisworks as { clashes?: unknown }).clashes)} clashes, ` +
    `${count(tickets)} tickets, ${count(tree)} tree nodes, ${count(packages)} packages, ${entries.length} identity entries`;

  return reply({
    query, needles, summary,
    identity: { file: identityFile(d.identityRoot), elements: entries.map((e) => ({ fmc: e.fmc, name: e.name, kind: e.kind, apps: e.apps })) },
    revit, navisworks, tickets, tree, packages,
    ...(warnings.length ? { warnings } : {}),
    ...(noProject ? { note: noProject } : {}),
    read_only: "Nothing was selected or changed: fmc_select shows these elements in each app",
  });
}

export function registerFmcFindTool(server: McpServer) {
  server.tool("fmc_find", FMC_FIND_DESCRIPTION, FMC_FIND_SHAPE, (args) => runFmcFind(args));
}
