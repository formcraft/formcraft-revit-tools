import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import {
  cacheStatus, findCacheByTitle, groupReportRows, idDocs, latestReport, onDriveD, readCacheHeader, readReportPage, refuseCacheWrite, summariseHits, writeClashCache,
  type CacheElement, type CacheHeader, type ClashHit,
} from "../fmc/clashscan.js";
import { DEFAULT_CLASH_CATEGORIES, defaultClashPairs, importLegacy, type LegacyExport } from "../fmc/clashfilter.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reportHostDir, writeReport } from "../fmc/localreport.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_CLASH_DESCRIPTION =
  "Formcraft low-RAM clash scan. Read-only. Streams one category pair at a time. " +
  "link names a RevitLinkInstance in the host (for example S). The structural model does not have to be open. " +
  "Its boxes are transformed by GetTotalTransform, using all eight corners. An unloaded link is FMC-LINK-NOT-LOADED and is not treated as a pass. " +
  "export_cache writes per-element boxes, and optional capped triangle meshes, under %LOCALAPPDATA%\\Formcraft\\clash\\cache. " +
  "It does not save the source model and it does not write on D:. " +
  "source cache:<file or doc title> scans the open host against that cache and reports the cache age. " +
  "source import:<file> reads the clash-bot JSON (doc, captured_at, elements[].bbox_mm, openings[].bbox_mm). Those coordinates are millimetres and are not scaled. Live Revit boxes are internal feet converted by 304.8. " +
  "An empty pairs list uses the default set, which includes OST_PlumbingEquipment, OST_Site, OST_GenericModel and OST_SpecialityEquipment, " +
  "for a live scan and for a cache scan alike (the reply says pairs_default true). " +
  "max_hits_per_pair stops one pair after that many hits and goes on to the next, so one busy pair does not hide the rest; " +
  "the reply has pairs_done of pairs_total and capped_pairs. Every length in a reply is millimetres (units mm). " +
  "id_docs says which document each id is in: host, a link title, or cache. " +
  "read_report returns a page of a JSONL report (report, default the newest; offset; limit up to 500) and group_by element, pair or status counts for that page. " +
  "Each hit has status hard, cleared_by_opening, join, hosted or clearance. centreline tests a pipe, duct, conduit or tray centreline plus radius instead of the full box. " +
  "sleeves lists openings and sleeve families near a hit or a point. " +
  "STALE when the source file's modified time is newer than the cache. " +
  "An axis-aligned box prefilter runs in chunks. Exact solid intersection runs only for box hits, and only when exact is true. " +
  "Geometry for the whole model is not kept. Results are appended to a JSONL file. " +
  "The reply is the hit count, a capped id list, the JSONL path, and the peak working set when the process can report it. No pictures. " +
  "Pass document when more than one document is open. A missing category is FMC-CLASH-CATEGORY and that pair is skipped.";

const pair = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
});

const shape = {
  action: z.enum(["scan", "export_cache", "sleeves", "read_report"]).optional().default("scan"),
  document: z.string().optional().default(""),
  pairs: z.array(pair).optional().default([]).describe("Category names, for example OST_Walls and OST_DuctCurves. Empty uses the default pairs, live or against a cache."),
  categories: z.array(z.string()).optional().default([]).describe("export_cache: categories to store. Empty uses the pairs."),
  link: z.string().optional().default("").describe("Link instance to use as the other model, for example S. The source model does not have to be open."),
  source: z.string().optional().default("").describe("cache:<file or title>, or import:<legacy json file>."),
  centreline: z.boolean().optional().default(false).describe("MEP curves: test centreline plus radius or half-width, not the full AABB."),
  clearance_mm: z.number().min(0).max(500).optional().default(0),
  hit_a: z.number().int().optional(),
  hit_b: z.number().int().optional(),
  point_mm: z.array(z.number()).length(3).optional(),
  radius_mm: z.number().min(0).max(5000).optional().default(300),
  meshes: z.boolean().optional().default(false).describe("export_cache: also store a capped triangle mesh per element."),
  mesh_cap: z.number().int().min(0).max(200).optional().default(24),
  chunk: z.number().int().min(1).max(2000).optional().default(250),
  tolerance_mm: z.number().min(0).max(500).optional().default(0),
  exact: z.boolean().optional().default(false),
  include_links: z.boolean().optional().default(true),
  max_hits: z.number().int().min(1).max(50000).optional().default(5000),
  sample_limit: z.number().int().min(1).max(100).optional().default(40),
  max_hits_per_pair: z.number().int().min(0).max(50000).optional().describe("scan: stop a pair after this many hits and go on to the next. 0 or absent: no per-pair stop."),
  report: z.string().optional().describe("read_report: a clash JSONL file. Default: the newest in the local clash folder."),
  offset: z.number().int().min(0).optional().describe("read_report: first line, from 0"),
  limit: z.number().int().min(1).max(500).optional().describe("read_report: lines per page, default 100"),
  group_by: z.enum(["element", "pair", "status"]).optional().describe("read_report: also count the page by element, pair or status"),
};

export type FmcClashArgs = z.infer<z.ZodObject<typeof shape>>;

export interface ClashIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
}

function cacheDir(env?: NodeJS.ProcessEnv): string {
  return pathJoin(reportHostDir("clash", env), "cache");
}

function pathJoin(dir: string, name: string): string {
  return dir.includes("\\") || process.platform === "win32" ? `${dir.replace(/[\\/]+$/, "")}\\${name}` : `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

function resolveCache(source: string, env?: NodeJS.ProcessEnv): { file: string } | { error: string } {
  const key = source.replace(/^cache:/i, "").trim();
  if (!key) return { error: "FMC-CLASH-CACHE: source cache: needs a file or a document title." };
  if (onDriveD(key)) return { error: "FMC-CLASH-PATH: refusing a cache path on D:." };
  if (/[\\/]/.test(key) || key.toLowerCase().endsWith(".json")) return { file: key };
  const found = findCacheByTitle(cacheDir(env), key);
  if (!found) return { error: `FMC-CLASH-CACHE: no cache for "${key}" under the clash cache folder.` };
  return { file: found };
}

export async function runFmcClash(args: FmcClashArgs, io: ClashIo = {}) {
  if (args.action === "export_cache") return exportCache(args, io);
  if (args.action === "sleeves") return sleeves(args, io);
  if (args.action === "read_report") return readReport(args, io);
  if (args.source.trim().toLowerCase().startsWith("import:")) return importSource(args, io);
  if (args.source.trim()) return scanCache(args, io);
  const pairs = args.pairs.length ? args.pairs : defaultClashPairs();
  const body = {
    mode: "scan", document: args.document, pairs, chunk: args.chunk, tolerance_mm: args.tolerance_mm,
    exact: args.exact, include_links: args.include_links, max_hits: args.max_hits, link: args.link,
    centreline: args.centreline, clearance_mm: args.clearance_mm,
    ...(args.max_hits_per_pair ? { max_hits_per_pair: args.max_hits_per_pair } : {}),
  };
  let result: Record<string, unknown>;
  try {
    result = (io.read ? await io.read(body) : await withRevitConnection((client) => client.sendRaw("fmc_clash", body, 300000))) as Record<string, unknown>;
  } catch (error) {
    return reply({ tool: "fmc_clash", read_only: true, error: error instanceof Error ? error.message : String(error) }, true);
  }
  const hits = Array.isArray(result.sample) ? result.sample as ClashHit[] : [];
  const summary = summariseHits(hits, args.sample_limit);
  const report = typeof result.report === "string" && result.report ? result.report : writeReport("clash", "scan", result, io.env);
  const peak = typeof result.peak_working_set_mb === "number" ? result.peak_working_set_mb : null;
  return reply({
    tool: "fmc_clash", read_only: true, applied: false, units: "mm",
    document: result.resolved_document ?? result.document ?? { title: args.document, path: "" },
    hits: result.count ?? summary.count,
    by_pair: result.by_pair ?? summary.by_pair,
    pairs_default: args.pairs.length === 0,
    ...(typeof result.pairs_total === "number" ? { pairs_total: result.pairs_total, pairs_done: result.pairs_done ?? null, capped_pairs: result.capped_pairs ?? [] } : {}),
    ids: result.ids ?? summary,
    id_docs: idDocs(hits, args.sample_limit * 2),
    chunks: result.chunks ?? null,
    compared: result.compared ?? null,
    exact: args.exact,
    truncated: result.truncated === true,
    report,
    peak_working_set_mb: peak,
    peak_note: peak == null ? "The host did not report a working set." : "Peak working set of the Revit process during this scan.",
    skipped_categories: result.skipped_categories ?? [],
    links: result.links ?? [],
    link: args.link || undefined,
    unloaded: result.unloaded ?? [],
    ...(typeof result.code === "string" ? { code: result.code, message: result.message } : {}),
  }, result.code === "FMC-LINK-NOT-LOADED" || result.code === "FMC-LINK-NOT-FOUND");
}

async function sleeves(args: FmcClashArgs, io: ClashIo) {
  const body = {
    mode: "sleeves", document: args.document, hit_a: args.hit_a ?? 0, hit_b: args.hit_b ?? 0,
    point_mm: args.point_mm ?? [], radius_mm: args.radius_mm,
  };
  try {
    const result = (io.read ? await io.read(body) : await withRevitConnection((client) => client.sendRaw("fmc_clash", body, 120000))) as Record<string, unknown>;
    return reply({ tool: "fmc_clash", read_only: true, applied: false, action: "sleeves", ...result });
  } catch (error) {
    return reply({ tool: "fmc_clash", read_only: true, error: error instanceof Error ? error.message : String(error) }, true);
  }
}

async function importSource(args: FmcClashArgs, io: ClashIo) {
  const file = args.source.replace(/^import:/i, "").trim();
  if (!file) return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-CACHE", message: "import: needs a file." }, true);
  if (onDriveD(file)) return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-PATH", message: "The import is read. A cache is not written on D:." }, true);
  let raw: LegacyExport;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as LegacyExport; }
  catch (error) { return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-CACHE", message: error instanceof Error ? error.message : String(error) }, true); }
  const converted = importLegacy(raw);
  const refused = refuseCacheWrite(cacheDir(io.env), "");
  if (refused) return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-PATH", message: refused }, true);
  const cache = writeClashCache(cacheDir(io.env), converted.header, converted.elements);
  return scanCache({ ...args, source: `cache:${cache}`, pairs: args.pairs.length ? args.pairs : defaultClashPairs() }, io);
}

async function exportCache(args: FmcClashArgs, io: ClashIo) {
  const categories = args.categories.length ? args.categories : args.pairs.length ? [...new Set(args.pairs.flatMap((item) => [item.a, item.b]))] : [...DEFAULT_CLASH_CATEGORIES];
  if (!categories.length) {
    return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-CATEGORY", message: "export_cache needs categories." }, true);
  }
  const body = { mode: "export_cache", document: args.document, categories, meshes: args.meshes, mesh_cap: args.mesh_cap };
  let result: Record<string, unknown>;
  try {
    result = (io.read ? await io.read(body) : await withRevitConnection((client) => client.sendRaw("fmc_clash", body, 300000))) as Record<string, unknown>;
  } catch (error) {
    return reply({ tool: "fmc_clash", read_only: true, error: error instanceof Error ? error.message : String(error) }, true);
  }
  if (typeof result.code === "string") return reply({ tool: "fmc_clash", read_only: true, ...result }, true);
  const elements = Array.isArray(result.elements) ? result.elements as CacheElement[] : null;
  let file = typeof result.cache === "string" ? result.cache : "";
  if (elements) {
    const header: CacheHeader = {
      kind: "fmc_clash_cache",
      doc_title: String(result.doc_title ?? args.document),
      path: String(result.path ?? ""),
      saved_at: String(result.saved_at ?? new Date(0).toISOString()),
      written_at: String(result.written_at ?? new Date().toISOString()),
      categories,
      mesh_cap: args.mesh_cap,
    };
    const refused = refuseCacheWrite(cacheDir(io.env), header.path);
    if (refused) return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-PATH", message: refused }, true);
    file = writeClashCache(cacheDir(io.env), header, elements, header.path);
  }
  if (file && onDriveD(file)) return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-PATH", message: "The cache path is on D:. It was not accepted." }, true);
  return reply({
    tool: "fmc_clash", read_only: true, applied: false, action: "export_cache",
    cache: file, doc_title: result.doc_title ?? args.document, saved_at: result.saved_at ?? null,
    count: result.count ?? elements?.length ?? 0, categories,
    note: "The source model was not saved. The cache is under the local clash folder, not on D:.",
  });
}

async function scanCache(args: FmcClashArgs, io: ClashIo) {
  const resolved = resolveCache(args.source, io.env);
  if ("error" in resolved) return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-CACHE", message: resolved.error }, true);
  let header: CacheHeader;
  try {
    header = readCacheHeader(resolved.file);
  } catch (error) {
    return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-CACHE", message: error instanceof Error ? error.message : String(error) }, true);
  }
  let sourceMtime: number | null = null;
  if (header.path && !onDriveD(header.path)) {
    try {
      const { statSync } = await import("node:fs");
      sourceMtime = statSync(header.path).mtimeMs;
    } catch { sourceMtime = null; }
  } else if (header.path && onDriveD(header.path)) {
    try {
      const { statSync } = await import("node:fs");
      sourceMtime = statSync(header.path).mtimeMs;
    } catch { sourceMtime = null; }
  }
  const status = cacheStatus(header, Date.now(), header.path ? sourceMtime : null);
  const pairsDefault = !args.pairs.length;
  const pairs = pairsDefault ? defaultClashPairs() : args.pairs;
  const body = {
    mode: "scan", document: args.document, pairs, chunk: args.chunk, tolerance_mm: args.tolerance_mm,
    exact: false, include_links: false, max_hits: args.max_hits, source: `cache:${resolved.file}`,
  };
  let result: Record<string, unknown>;
  try {
    result = (io.read ? await io.read(body) : await withRevitConnection((client) => client.sendRaw("fmc_clash", body, 300000))) as Record<string, unknown>;
  } catch (error) {
    return reply({ tool: "fmc_clash", read_only: true, error: error instanceof Error ? error.message : String(error), cache: status }, true);
  }
  return reply({
    tool: "fmc_clash", read_only: true, applied: false, units: "mm", source: `cache:${resolved.file}`,
    cache: { file: resolved.file, doc_title: header.doc_title, age_ms: status.age_ms, stale: status.stale, warning: status.warning, saved_at: header.saved_at },
    hits: result.count ?? 0, by_pair: result.by_pair ?? {}, report: result.report ?? null, pairs_default: pairsDefault,
    id_docs: idDocs(Array.isArray(result.sample) ? result.sample as ClashHit[] : [], args.sample_limit * 2),
    peak_working_set_mb: result.peak_working_set_mb ?? null,
    document: result.resolved_document ?? { title: args.document, path: "" },
  });
}

/** Folders read_report may read: the local clash folder (and its cache folder) and the temp folder the add-in falls back to. */
export function reportRoots(env?: NodeJS.ProcessEnv): string[] {
  return [reportHostDir("clash", env), os.tmpdir()];
}

function inside(file: string, root: string): boolean {
  const norm = (value: string) => path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  const f = norm(file);
  const r = norm(root);
  return f === r || f.startsWith(r + path.sep) || f.startsWith(r + "\\") || f.startsWith(r + "/");
}

async function readReport(args: FmcClashArgs, io: ClashIo) {
  const dir = reportHostDir("clash", io.env);
  const asked = (args.report ?? "").trim();
  const file = asked || latestReport(dir) || "";
  if (!file) return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-REPORT", message: `No clash report under ${dir}. Run scan first.` }, true);
  if (onDriveD(file)) return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-PATH", message: "Reports are not read from D:." }, true);
  if (!/\.jsonl$/i.test(file) || !reportRoots(io.env).some((root) => inside(file, root))) {
    return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-PATH", message: "read_report reads only .jsonl clash reports in the local clash folder or the temp folder." }, true);
  }
  let page;
  try { page = readReportPage(file, args.offset ?? 0, args.limit ?? 100); }
  catch (error) { return reply({ tool: "fmc_clash", read_only: true, code: "FMC-CLASH-REPORT", message: error instanceof Error ? error.message : String(error) }, true); }
  return reply({
    tool: "fmc_clash", read_only: true, applied: false, action: "read_report", units: "mm",
    ...page,
    ...(args.group_by ? { group_by: args.group_by, groups: groupReportRows(page.rows, args.group_by) } : {}),
  });
}

export function registerFmcClashTool(server: McpServer) {
  server.tool("fmc_clash", FMC_CLASH_DESCRIPTION, shape, (args) => runFmcClash(args));
}
