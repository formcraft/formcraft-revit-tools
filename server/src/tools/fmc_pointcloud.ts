import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import { RUNNING_BUILD } from "../fmc/buildinfo.js";
import { readCloud } from "../fmc/cloudread.js";
import {
  POINTCLOUD_FIX, TriangleGrid, UNIT_TO_M, applyRigid, buildModel, checkReportFolder, compose, deviation, deviationCsv, icp,
  loadPointCloudSpec, overlap, rigidFromOffset, rotationDeg, safeName, writeNew, type MeshElement,
} from "../fmc/pointcloud.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_POINTCLOUD_DESCRIPTION =
  "Point cloud against model (NBRB and DITACO): read an E57 or LAS scan, align it to the model and report how far each element is off. " +
  "LAZ is detected and refused: decompress it to LAS first. The model is only read (fmc_pointcloud_read: element meshes in metres, no transaction). " +
  "cloud is the full path of the .e57 or .las. coordinates (default shared) is the model frame the scan is in; cloud_units defaults to m. " +
  "offset {x,y,z metres, rotation_deg about Z} is a starting alignment; alignment icp (default) refines it and is rejected beyond max_shift_m or max_rotation_deg; none keeps the given alignment. " +
  "Each point goes to the nearest element surface within search_radius_m. Per element: points, mean (signed: + outside the face), p95, max, the mean shift (x,y,z mm) and status WITHIN, OFF (p95 over tolerance) or NO-COVERAGE. " +
  "Categories and tolerances come from the kit 03_Master_Data/FMC_PointCloud.json; without it the sample is used and the result is PROVISIONAL. " +
  "dry_run (default true) measures and answers without writing. dry_run false also writes <model>_Deviation_<cloud>_<time>.csv and .json in output_folder (default reports_dir\\PointCloud; it must be inside write_roots or reports_dir). " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0001, cloud D:\\Scans\\site.e57, dry_run true.";

const offsetShape = z.object({ x: z.number().optional(), y: z.number().optional(), z: z.number().optional(), rotation_deg: z.number().optional() }).optional();

export const FMC_POINTCLOUD_SHAPE = {
  document: z.string().optional().default(""),
  cloud: z.string().optional().default(""),
  cloud_units: z.enum(["m", "mm", "cm", "ft", "us_ft"]).optional().default("m"),
  coordinates: z.enum(["shared", "internal"]).optional().default("shared"),
  categories: z.array(z.string()).optional(),
  element_ids: z.array(z.union([z.string(), z.number()])).optional(),
  alignment: z.enum(["icp", "none"]).optional().default("icp"),
  offset: offsetShape,
  icp_z_only: z.boolean().optional().default(true),
  max_shift_m: z.number().positive().optional().default(0.5),
  max_rotation_deg: z.number().positive().optional().default(3),
  max_points: z.number().int().min(1000).max(5_000_000).optional().default(300000),
  search_radius_m: z.number().positive().max(5).optional(),
  tolerance_mm: z.number().positive().optional(),
  min_points: z.number().int().min(1).optional(),
  max_triangles: z.number().int().min(1000).max(2_000_000).optional().default(300000),
  top: z.number().int().min(1).max(500).optional().default(25),
  output_folder: z.string().optional().default(""),
  spec: z.string().optional().default(""),
  dry_run: z.boolean().optional().default(true),
};

export type FmcPointCloudArgs = z.infer<z.ZodObject<typeof FMC_POINTCLOUD_SHAPE>>;

export interface PointCloudIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  kitRoot?: string;
  specText?: string;
  now?: () => Date;
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_pointcloud",
    images: [] as [],
    saved: false,
    synced: false,
    model_changed: false,
    cites: {
      kit: "03_Master_Data/FMC_PointCloud.json",
      standards: "L011-F25 point cloud against model",
      rulebook: "Report how far each element is off; a person decides what to change.",
    },
    ...extra,
  };
}

function refuse(code: string, message?: string, extra: Record<string, unknown> = {}) {
  return reply({ ...stamp(), refused: true, code, message: message ?? POINTCLOUD_FIX[code] ?? code, ...extra }, true);
}

function kitRootOf(io: PointCloudIo): string {
  if (io.kitRoot != null) return io.kitRoot;
  try { return kitPaths(loadConfig(configPath(io.env ?? process.env)).config).root; } catch { return ""; }
}

function timeStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export async function runFmcPointCloud(args: FmcPointCloudArgs, io: PointCloudIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) return refuse("FMC-DOC-REQUIRED");
    const cloudPath = args.cloud.trim();
    if (!cloudPath || (!path.win32.isAbsolute(cloudPath) && !path.isAbsolute(cloudPath)) || !fs.existsSync(cloudPath)) return refuse("FMC-POINTCLOUD-FILE", `${POINTCLOUD_FIX["FMC-POINTCLOUD-FILE"]} Got: ${cloudPath || "(empty)"}`);
    let loaded;
    try {
      loaded = loadPointCloudSpec({ file: args.spec, kitRoot: kitRootOf(io), env, ...(io.specText != null ? { read: () => io.specText as string } : {}) });
    } catch (error) {
      return refuse("FMC-POINTCLOUD-SPEC", error instanceof Error ? error.message : String(error));
    }
    const spec = loaded.spec;
    const radius = args.search_radius_m ?? spec.search_radius_m ?? 0.15;
    const minPoints = args.min_points ?? spec.min_points ?? 30;
    const baseTol = args.tolerance_mm ?? spec.tolerance_mm ?? 25;
    const tolerance = (e: MeshElement) => args.tolerance_mm ?? spec.tolerances_mm?.[e.category ?? ""] ?? baseTol;
    // the cloud first: a bad or LAZ file is refused before Revit is asked for anything
    let cloud;
    try { cloud = readCloud(cloudPath, { maxPoints: args.max_points }); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-POINTCLOUD-FORMAT";
      return refuse(code, message);
    }
    const categories = args.categories?.length ? args.categories : (spec.categories ?? []);
    const readBody = {
      document: args.document.trim(), coordinates: args.coordinates, categories,
      element_ids: (args.element_ids ?? []).map((v) => String(v)), max_triangles: args.max_triangles,
    };
    const raw = io.read ? await io.read(readBody) : await withRevitConnection((client) => client.sendCommand("fmc_pointcloud_read", readBody, 300000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return refuse(String(body.code ?? "FMC-POINTCLOUD"), String(body.message ?? "The read was refused."));
    const elements = (Array.isArray(body.elements) ? body.elements : []) as MeshElement[];
    const title = String(body.title ?? args.document);
    const warnings: Array<{ code: string; message: string; detail?: string }> = [];
    if (body.truncated === true) warnings.push({ code: "FMC-POINTCLOUD-TRUNCATED", message: POINTCLOUD_FIX["FMC-POINTCLOUD-TRUNCATED"] });
    for (const c of (Array.isArray(body.unknown_categories) ? body.unknown_categories : []) as string[]) warnings.push({ code: "FMC-POINTCLOUD-CATEGORY", message: "Not a Revit built-in category (OST_...).", detail: c });
    for (const n of cloud.notes) warnings.push({ code: "FMC-POINTCLOUD-NOTE", message: n });
    const model = buildModel(elements);
    if (!model.elem.length) return refuse("FMC-POINTCLOUD-NO-MESH");
    const initial = rigidFromOffset(args.offset);
    let pts = applyRigid(initial, cloud.points, UNIT_TO_M[args.cloud_units] ?? 1);
    let bounds = null as null | { min: number[]; max: number[] };
    if (pts.length) {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pts.length; i += 3) for (let d = 0; d < 3; d++) { const v = pts[i + d]; if (v < mn[d]) mn[d] = v; if (v > mx[d]) mx[d] = v; }
      bounds = { min: mn, max: mx };
    }
    const round3 = (a: number[]) => a.map((v) => Math.round(v * 1000) / 1000);
    const geometry = {
      model_bounds_m: { min: round3(model.min), max: round3(model.max) },
      cloud_bounds_m: bounds ? { min: round3(bounds.min), max: round3(bounds.max) } : null,
    };
    if (!overlap(model, bounds, Math.max(radius, args.max_shift_m))) {
      return refuse("FMC-POINTCLOUD-NO-OVERLAP", undefined, { ...geometry, coordinates: args.coordinates, cloud_units: args.cloud_units, point_clouds_in_model: body.point_clouds ?? [] });
    }
    const grid = new TriangleGrid(model, Math.max(radius, 0.25));
    let alignment: Record<string, unknown> = { mode: args.alignment, offset: args.offset ?? null };
    let final = initial;
    if (args.alignment === "icp") {
      const icpGrid = args.max_shift_m > radius ? new TriangleGrid(model, Math.max(args.max_shift_m, 0.25)) : grid;
      const res = icp(pts, icpGrid, { radius: Math.max(radius, Math.min(args.max_shift_m, 1)), zOnly: args.icp_z_only, maxIter: 30, sample: 20000, maxShift: args.max_shift_m, maxRotDeg: args.max_rotation_deg, minPairs: 200 });
      if (res.used) { pts = applyRigid(res.transform, pts); final = compose(res.transform, initial); }
      else warnings.push({ code: "FMC-POINTCLOUD-ALIGN-REJECTED", message: POINTCLOUD_FIX["FMC-POINTCLOUD-ALIGN-REJECTED"], detail: `shift ${res.shift_m} m, rotation ${res.rotation_deg} deg, pairs ${res.pairs}` });
      alignment = { ...alignment, icp: { used: res.used, iterations: res.iterations, pairs: res.pairs, rms_before_mm: res.rms_before_mm, rms_after_mm: res.rms_after_mm, shift_m: res.shift_m, rotation_deg: res.rotation_deg, z_only: args.icp_z_only } };
    }
    alignment.final = { rotation_deg: Math.round(rotationDeg(final) * 10000) / 10000, translation_m: final.t.map((v) => Math.round(v * 10000) / 10000), matrix: final.r.map((v) => Math.round(v * 1e9) / 1e9) };
    const dev = deviation(pts, grid, { radius, minPoints, tolerance });
    const worst = [...dev.elements].filter((e) => e.status !== "NO-COVERAGE").sort((a, b) => b.p95_mm - a.p95_mm).slice(0, args.top);
    const status = loaded.provisional ? "PROVISIONAL" : dev.summary.OFF > 0 ? "OFF" : "WITHIN";
    const cfgLoaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
    const cfg = cfgLoaded.config;
    const folderRaw = args.output_folder.trim() || path.win32.join(cfg.reports_dir || "%USERPROFILE%\\FMC_Reports", "PointCloud");
    const folder = checkReportFolder(folderRaw, cfg, [...(cfg.protected_paths ?? []), ...protectedRoots(cfg)], env);
    const now = io.now ? io.now() : new Date();
    const baseName = `${safeName(title)}_Deviation_${safeName(path.win32.basename(cloudPath))}_${timeStamp(now)}`;
    const dry = args.dry_run !== false;
    const summary = stamp({
      dry_run: dry,
      read_only: true,
      document: title,
      coordinates: String(body.coordinates ?? args.coordinates),
      cloud: { file: cloudPath, format: cloud.format, version: cloud.version, scans: cloud.scans, total_points: cloud.total, sampled: cloud.sampled, stride: cloud.stride, units: args.cloud_units },
      status,
      can_pass: status === "WITHIN",
      provisional: loaded.provisional,
      spec: loaded.path,
      spec_source: loaded.source,
      search_radius_m: radius,
      tolerance_mm: baseTol,
      min_points: minPoints,
      ...geometry,
      alignment,
      points: { matched: dev.matched, unmatched_beyond_radius: dev.unmatched, outside_model_box: dev.outside },
      bands_mm: dev.bands_mm,
      elements_checked: dev.elements.length,
      summary: dev.summary,
      worst,
      triangles: model.elem.length,
      point_clouds_in_model: body.point_clouds ?? [],
      warnings,
      output_folder: folder.folder,
      output_folder_ok: folder.ok,
      ...(folder.ok ? {} : { output_folder_reasons: folder.reasons }),
      report: { csv: path.win32.join(folder.folder, `${baseName}.csv`), json: path.win32.join(folder.folder, `${baseName}.json`) },
    });
    if (dry) return reply({ ...summary, next: "Nothing was written. To keep the per-element report, call again with dry_run false (and output_folder if the default is not allowed)." });
    if (cfgLoaded.problem) return refuse("FMC-POINTCLOUD-FOLDER", cfgLoaded.problem);
    if (!folder.ok) return refuse("FMC-POINTCLOUD-FOLDER", `${POINTCLOUD_FIX["FMC-POINTCLOUD-FOLDER"]} ${folder.reasons.join("; ")}`);
    fs.mkdirSync(folder.folder, { recursive: true });
    const csvPath = path.win32.join(folder.folder, `${baseName}.csv`);
    const jsonPath = path.win32.join(folder.folder, `${baseName}.json`);
    if (fs.existsSync(csvPath) || fs.existsSync(jsonPath)) return refuse("FMC-POINTCLOUD-EXISTS");
    writeNew(csvPath, deviationCsv(dev.elements));
    const rest = { ...summary } as Record<string, unknown>;
    delete rest.worst;
    writeNew(jsonPath, Buffer.from(JSON.stringify({ schema: "fmc.pointcloud/1", build: RUNNING_BUILD.commit, created_at: now.toISOString(), ...rest, dry_run: false, elements: dev.elements }, null, 2), "utf8"));
    return reply({ ...summary, dry_run: false, written: true, report: { csv: csvPath, json: jsonPath }, next: "The report is written. A person decides what to change in the model; this tool changes nothing." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-POINTCLOUD";
    return reply({ tool: "fmc_pointcloud", refused: true, code, message, saved: false, synced: false, model_changed: false }, true);
  }
}

export function registerFmcPointCloudTool(server: McpServer) {
  server.tool("fmc_pointcloud", FMC_POINTCLOUD_DESCRIPTION, FMC_POINTCLOUD_SHAPE, async (args) => runFmcPointCloud(args as FmcPointCloudArgs));
}
