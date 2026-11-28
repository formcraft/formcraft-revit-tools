import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, loadConfig } from "../fmc/policy.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { kitPaths } from "../fmc/context.js";
import { documentRequired } from "../fmc/fairqueue.js";
import type { OpenDocRef } from "../fmc/docresolve.js";
import { isMat4 } from "../fmc/coordmath.js";
import {
  CheckReport, ControlPoint, CoordRecord, Snapshot, Tolerances, Xform,
  alignModelTarget, alignObjectTargets, appendCoordLedger, checkModels, checkSnapshot, checkSnapshots,
  coordExportDir, docKey, emptyRecord, exportFiles, findModel, idsOf, mergePoints, mergeSnapshot,
  parseImport, planRecordWrite, poseFromTransform, poseOf, projectWriteBlock, readRecord, tolerancesFrom,
  writeExport, writeRecordFiles,
} from "../fmc/coordrecord.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_COORD_DESCRIPTION =
  "Formcraft coordination matrix. One record per project holds the survey point, the project base point, true north, " +
  "the elevation datum, the shared origin and named control points. Every entry has a 4×4 row-major transform in " +
  "millimetres (translation in the last column) and an angle in degrees, relative to the project shared origin. " +
  "Three levels: model (internal-to-shared, from the project location and the base and survey points), object " +
  "(placement of chosen elements, keyed by UniqueId and an optional mark) and family (insertion, origin, reference " +
  "planes and local axes). action publish writes those into the record (the model is not changed). read shows the " +
  "record. check compares two published models, or a live model, object or family, to the record or to another open " +
  "model, and reports delta_mm and delta_deg with PASS or FAIL against coord.tol_mm and coord.tol_deg. align, with " +
  "dry_run false, moves the survey or the base point, or moves and rotates elements, to the record. It never acquires " +
  "coordinates from a link. place puts a family instance or a reference point on a record transform. export writes " +
  "IfcMapConversion, an Archicad transform, Navisworks and Blender 4×4 JSON, and a CSV of points, under " +
  "%LOCALAPPDATA%\\Formcraft\\coord. import reads a CSV or JSON of points into the record. The record is " +
  "FMC_Coord.json next to the project and a copy in %APPDATA%\\Formcraft\\coord. Every write is a dry run unless " +
  "dry_run is false. document is required whenever a model is read or changed: a missing or ambiguous document is " +
  "an FMC-DOC-* error, and the active document is not used. Tolerances come from FMC_Standards_Building.json keys " +
  "coord.*. A provisional tolerance never PASS. draft or approved can PASS only with a clause. A null status is UNKNOWN. " +
  "Pinned elements and elements another person owns are reported and not moved. No images.";

const pointShape = z.object({
  name: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  xyz_mm: z.array(z.number()).length(3).optional(),
  rotation: z.number().optional(),
  angle_deg: z.number().optional(),
  kind: z.enum(["grid", "survey", "user"]).optional(),
  id: z.string().optional(),
});

export const FMC_COORD_SHAPE = {
  action: z.enum(["publish", "read", "check", "align", "place", "export", "import"]),
  document: z.string().optional().default("").describe("Title or full path of an open document. Required for publish, a live check, align and place. Never the active document."),
  other: z.string().optional().default("").describe("check: a second open document, read in the same Revit call"),
  level: z.enum(["model", "object", "family", "all"]).optional().default("model"),
  project: z.string().optional().default("").describe("Project key for the record file name"),
  project_folder: z.string().optional().default("").describe("Folder the FMC_Coord.json is written next to"),
  dry_run: z.boolean().optional().default(true),
  ids: z.array(z.union([z.string(), z.number()])).optional().default([]).describe("Element ids or UniqueIds"),
  category: z.string().optional().default("").describe("Category name or OST_ token"),
  filter: z.string().optional().default("").describe("Name, mark or UniqueId contains this"),
  family: z.string().optional().default(""),
  type_name: z.string().optional().default(""),
  stable_id: z.string().optional().default("").describe("UniqueId, or UniqueId|mark"),
  name: z.string().optional().default("").describe("Control point name"),
  target: z.enum(["survey", "base"]).optional().default("survey").describe("align model: the survey relationship or the project base point"),
  to: z.string().optional().default("").describe("align: a published model key to match. Default: this document's published transform, else the record survey or base point"),
  against: z.string().optional().default("record").describe("check: record, other, or a published model key"),
  left: z.string().optional().default("").describe("check: a published model key, with right. No Revit call"),
  right: z.string().optional().default(""),
  reference_point: z.boolean().optional().default(false).describe("place: a reference point instead of a family instance"),
  on_level: z.string().optional().default("").describe("place: level name"),
  transform: z.array(z.array(z.number())).optional().describe("place: a 4×4 row-major transform in mm, instead of a record entry"),
  control_points: z.array(pointShape).optional().default([]),
  source: z.string().optional().default("").describe("import: a CSV or JSON path"),
  format: z.enum(["all", "ifc", "archicad", "navis", "blender", "csv"]).optional().default("all"),
};

export type FmcCoordArgs = z.infer<z.ZodObject<typeof FMC_COORD_SHAPE>>;

type Level = "model" | "object" | "family" | "all";

export interface CoordDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  guard?: GuardConfig;
  /** When set, the kit file is not read. */
  standards?: Record<string, unknown> | null;
  open?: Array<string | OpenDocRef>;
  revit?: (command: string, params: Record<string, unknown>, write: boolean) => Promise<unknown>;
}

function projectFolderOf(given: string, document: string): string {
  if (given.trim()) return given.trim();
  const norm = document.replace(/\//g, "\\");
  const at = norm.toLowerCase().indexOf("\\01_wip\\");
  return at > 0 ? norm.slice(0, at) : "";
}

function projectKeyOf(project: string, folder: string, document: string): string {
  if (project.trim()) return project.trim();
  if (folder.trim()) return win.basename(folder.replace(/[\\/]+$/, ""));
  if (document.trim()) {
    const base = document.split(/[\\/]/).pop() ?? document;
    return base.replace(/\.(rvt|rfa|rte|rft)$/i, "");
  }
  return "";
}

function bag(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const row = json as Record<string, unknown>;
  if (row.standards && typeof row.standards === "object" && !Array.isArray(row.standards)) return row.standards as Record<string, unknown>;
  return row;
}

function readJson(file: string): Record<string, unknown> | null {
  try { return bag(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))); } catch { return null; }
}

function loadTolerances(deps: CoordDeps, cfg: GuardConfig, folder: string): Tolerances {
  if (deps.standards !== undefined) return tolerancesFrom(deps.standards, "injected");
  let kitFile = "";
  try { kitFile = win.join(win.dirname(kitPaths(cfg).recipesDir), "FMC_Standards_Building.json"); } catch { kitFile = ""; }
  const kit = kitFile ? readJson(kitFile) : null;
  const projectFile = folder ? win.join(folder, "01_WIP", "FMC_Project_Standards.json") : "";
  const project = projectFile ? readJson(projectFile) : null;
  return tolerancesFrom({ ...(kit ?? {}), ...(project ?? {}) }, kit ? kitFile : "missing");
}

function userPoints(rows: FmcCoordArgs["control_points"]): { points: ControlPoint[]; pointIds: Array<{ name: string; id: string; kind?: string }> } {
  const points: ControlPoint[] = [];
  const pointIds: Array<{ name: string; id: string; kind?: string }> = [];
  for (const row of rows) {
    const xyz = row.xyz_mm ?? (row.x != null && row.y != null ? [row.x, row.y, row.z ?? 0] : null);
    if (!xyz) {
      if (row.id) pointIds.push({ name: row.name, id: row.id, ...(row.kind ? { kind: row.kind } : {}) });
      continue;
    }
    points.push({ ...poseOf([xyz[0], xyz[1], xyz[2]], row.angle_deg ?? row.rotation ?? 0, row.name), name: row.name, kind: row.kind ?? "user", ...(row.id ? { id: row.id } : {}) });
  }
  return { points, pointIds };
}

function guardReason(document: string, cfg: GuardConfig): string | null {
  const pathLike = /[\\/]/.test(document);
  const title = pathLike ? win.basename(document).replace(/\.(rvt|rfa|rte|rft)$/i, "") : document;
  return saveBlocked({ title, path: pathLike ? document : "" }, cfg);
}

function aim(action: string, document: string, open: Array<string | OpenDocRef> | undefined): { ok: true; document: string } | { ok: false; message: string } {
  const named = document.trim();
  if (open) {
    const message = documentRequired("fmc_coord_apply", open, named || undefined);
    if (message) return { ok: false, message };
  } else if (!named) {
    return { ok: false, message: `[FMC-DOC-REQUIRED] fmc_coord ${action} needs document: a title or a full path. Refusing to use the active document.` };
  }
  return { ok: true, document: named };
}

function summaryOf(record: CoordRecord) {
  return {
    models: Object.keys(record.models).length,
    control_points: record.control_points.length,
    objects: Object.keys(record.objects).length,
    families: Object.keys(record.families).length,
    ids: [
      ...record.control_points.map((point) => point.id || point.name),
      ...Object.values(record.objects).map((row) => String(row.id ?? row.stable_id)),
      ...Object.values(record.families).map((row) => String(row.id ?? row.stable_id)),
    ],
  };
}

export async function runFmcCoord(args: FmcCoordArgs, deps: CoordDeps = {}) {
  const env = deps.env ?? process.env;
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const cfg = deps.guard ?? loadConfig().config;
  const dry = args.dry_run !== false;
  const level = (args.level ?? "model") as Level;
  const folder = projectFolderOf(args.project_folder ?? "", args.document ?? "");
  const project = projectKeyOf(args.project ?? "", folder, args.document ?? "");
  const tols = loadTolerances(deps, cfg, folder);

  const finish = (body: object, isError = false, detail = "") => {
    appendCoordLedger(env, { at, action: args.action, project, ok: !isError, dry_run: dry, detail });
    return reply(body, isError);
  };

  const revit = async (params: Record<string, unknown>, write: boolean): Promise<Snapshot> => {
    if (deps.revit) return await deps.revit("fmc_coord_apply", params, write) as Snapshot;
    const result = await withRevitConnection((c) => write
      ? c.sendCommand("fmc_coord_apply", params, 180000)
      : c.sendRaw("fmc_coord_apply", params, 180000));
    return (result ?? {}) as Snapshot;
  };

  try {
    if ((args.action === "read" || args.action === "export" || args.action === "import") && !project)
      return finish({ error: "[FMC-COORD-PROJECT] Name project, project_folder or document so the record has a file." }, true);

    if (args.action === "read") {
      const found = readRecord(folder, project, env);
      if (!found.record) return finish({ error: "[FMC-COORD-EMPTY] No coordination record for this project. Publish one first.", project }, true);
      return finish({ project, file: found.file, version: found.record.version, record: found.record, summary: summaryOf(found.record) }, false, "read");
    }

    if (args.action === "import") {
      const source = (args.source ?? "").trim();
      if (!source) return finish({ error: "[FMC-COORD-IMPORT] import needs source: a CSV or JSON file." }, true);
      let text = "";
      try { text = fs.readFileSync(source, "utf8"); } catch { return finish({ error: `[FMC-COORD-IMPORT] Cannot read ${source}` }, true); }
      const points = parseImport(text, source);
      const existing = readRecord(folder, project, env).record ?? emptyRecord(project, at);
      const next = mergePoints(existing, points, at);
      const plan = planRecordWrite(folder, project, cfg, env);
      if (dry) return finish({ dry_run: true, project, would_add: points.map((point) => point.name), count: points.length, project_skipped: plan.project_skipped, next: "Run again with dry_run=false" }, false, `${points.length} points`);
      const files = writeRecordFiles(next, plan);
      return finish({ dry_run: false, project, imported: points.length, files, project_skipped: plan.project_skipped, summary: summaryOf(next) }, false, `${points.length} points`);
    }

    if (args.action === "export") {
      const found = readRecord(folder, project, env);
      if (!found.record) return finish({ error: "[FMC-COORD-EMPTY] No coordination record to export. Publish one first.", project }, true);
      const dir = coordExportDir(env);
      const blocked = projectWriteBlock(dir, cfg);
      if (blocked) return finish({ error: `[FMC-COORD-GUARD] ${blocked}`, project }, true);
      const files = exportFiles(found.record, dir, args.document || undefined).filter((file) => args.format === "all" || file.name.includes(args.format === "ifc" ? "ifcmap" : args.format));
      if (dry) return finish({ dry_run: true, project, dir, files: files.map((file) => ({ name: file.name, path: file.path, text: file.text })), next: "Run again with dry_run=false" }, false, `${files.length} files`);
      writeExport(files);
      return finish({ dry_run: false, project, dir, files: files.map((file) => ({ name: file.name, path: file.path })) }, false, `${files.length} files`);
    }

    if (args.action === "check" && !args.document?.trim() && args.left?.trim() && args.right?.trim()) {
      const found = readRecord(folder, project, env);
      if (!found.record) return finish({ error: "[FMC-COORD-EMPTY] No coordination record to compare.", project }, true);
      const report = checkModels(found.record, args.left, args.right, tols, args.name || undefined, args.stable_id || undefined);
      return finish({ project, server_only: true, tolerances: tols, ...report }, false, `${report.summary.count} items`);
    }

    const needsModel = args.action === "publish" || args.action === "align" || args.action === "place" || args.action === "check";
    if (!needsModel) return finish({ error: `[FMC-COORD] Unknown action ${args.action}` }, true);

    const aimed = aim(args.action, args.document ?? "", deps.open);
    if (!aimed.ok) return finish({ error: aimed.message }, true);
    if (!project) return finish({ error: "[FMC-COORD-PROJECT] Name project, project_folder or document so the record has a file." }, true);

    const loaded = readRecord(folder, project, env);
    const record = loaded.record;

    if (args.action === "publish") {
      const extra = userPoints(args.control_points ?? []);
      const snap = await revit({
        action: "snapshot", document: aimed.document, level, ids: (args.ids ?? []).map(String),
        category: args.category ?? "", filter: args.filter ?? "", family: args.family ?? "",
        other: "", point_ids: extra.pointIds,
      }, false);
      if (snap.error || snap.code) return finish({ error: snap.error || snap.code, code: snap.code, resolved_document: snap.resolved_document }, true);
      let next = mergeSnapshot(record ?? emptyRecord(project, at), snap, level, at);
      if (extra.points.length) next = mergePoints(next, extra.points, at);
      const plan = planRecordWrite(folder, project, cfg, env);
      const body = {
        dry_run: dry, project, level, summary: summaryOf(next), ids: idsOf(snap),
        project_skipped: plan.project_skipped, resolved_document: snap.resolved_document ?? snap.document,
        tolerances: tols,
      };
      if (dry) return finish({ ...body, would_write: [plan.app_file, plan.project_file].filter(Boolean), next: "Run again with dry_run=false" }, false, "publish dry run");
      const files = writeRecordFiles(next, plan);
      return finish({ ...body, files }, false, "publish");
    }

    if (args.action === "check") {
      const snap = await revit({
        action: "snapshot", document: aimed.document, level, ids: (args.ids ?? []).map(String),
        category: args.category ?? "", filter: args.filter ?? "", family: args.family ?? "",
        other: args.against === "other" ? (args.other ?? "") : "", point_ids: [],
      }, false);
      if (snap.error || snap.code) return finish({ error: snap.error || snap.code, code: snap.code }, true);
      if (!record && args.against !== "other") return finish({ error: "[FMC-COORD-EMPTY] No coordination record to check against. Publish one first.", project, resolved_document: snap.resolved_document }, true);
      let report: CheckReport;
      if (args.against === "other") {
        if (!snap.other) return finish({ error: "[FMC-DOC-REQUIRED] check against other needs other: a title or a full path of a second open document." }, true);
        report = checkSnapshots(snap, snap.other, tols, level, args.name || undefined, args.stable_id || undefined);
      } else if (args.against && args.against !== "record") {
        const model = record ? findModel(record, args.against) : null;
        if (!model) return finish({ error: `[FMC-COORD-EMPTY] ${args.against} is not a published model in the record.` }, true);
        const synthetic: Snapshot = {
          document: { title: model.title || args.against, path: model.path || "" },
          model, control_points: record?.control_points ?? [], objects: Object.values(record?.objects ?? {}), families: Object.values(record?.families ?? {}),
        };
        report = checkSnapshots(snap, synthetic, tols, level, args.name || undefined, args.stable_id || undefined);
      } else {
        report = checkSnapshot(record as CoordRecord, snap, tols, level, args.name || undefined, args.stable_id || undefined);
      }
      return finish({
        project, tolerances: tols, resolved_document: snap.resolved_document ?? { title: docKey(snap), path: snap.document?.path ?? "" },
        ...report,
      }, false, `${report.summary.count} items`);
    }

    const blocked = guardReason(aimed.document, cfg);
    if (blocked) return finish({ error: `[FMC-COORD-GUARD] ${blocked}`, document: aimed.document }, true);

    if (args.action === "align") {
      if (level === "family") return finish({ error: "[FMC-COORD-LEVEL] align does not edit a family definition. Use level object for instances, or place to put the family at a record transform." }, true);
      if (!record) return finish({ error: "[FMC-COORD-EMPTY] No coordination record to align to. Publish one first." }, true);
      const objectLevel = level === "object";
      const params: Record<string, unknown> = { action: "align", document: aimed.document, dry_run: dry, level: objectLevel ? "object" : level === "all" ? "all" : "model", target: args.target ?? "survey" };
      if (objectLevel || level === "all") {
        const rows = alignObjectTargets(record, (args.ids ?? []).map(String), args.stable_id || undefined);
        if (objectLevel && !rows.length) return finish({ error: "[FMC-COORD-EMPTY] No published objects match. Publish them, or name ids or stable_id." }, true);
        params.elements = rows.map((row) => ({ id: row.id ?? row.unique_id ?? row.stable_id, stable_id: row.stable_id, transform: row.transform, angle_deg: row.angle_deg }));
        params.element_ids = rows.map((row) => String(row.id ?? "")).filter((id) => /^\d+$/.test(id));
      }
      if (!objectLevel) {
        const target = alignModelTarget(record, args.target === "base" ? "base" : "survey", args.to || undefined, aimed.document);
        if (!target) return finish({ error: "[FMC-COORD-EMPTY] The record has no transform to align to. Publish the model first." }, true);
        params.transform = target.transform;
        params.angle_deg = target.angle_deg;
        if (!objectLevel && level !== "all") params.element_ids = [];
      }
      const result = await revit(params, !dry);
      if (result.error || result.code) return finish({ error: result.error || result.code, code: result.code, skipped: result.skipped, resolved_document: result.resolved_document }, true);
      return finish({ dry_run: dry, project, level, target: args.target, ...result }, false, dry ? "align dry run" : "align");
    }

    // place
    let pose: Xform | null = null;
    if (isMat4(args.transform)) pose = poseFromTransform(args.transform, args.name || undefined);
    else if (record && args.name) pose = record.control_points.find((point) => point.name === args.name) ?? null;
    else if (record && args.stable_id) pose = record.objects[args.stable_id] ?? record.families[args.stable_id] ?? null;
    else if (record && args.family) pose = record.families[args.family] ?? null;
    if (!pose) return finish({ error: "[FMC-COORD-EMPTY] place needs a transform, or a name, stable_id or family that is already in the record." }, true);
    if (!args.reference_point && !args.family) return finish({ error: "[FMC-COORD-PLACE] place needs family (a family name) or reference_point true." }, true);
    const result = await revit({
      action: "place", document: aimed.document, dry_run: dry, family: args.family ?? "", type_name: args.type_name ?? "",
      reference_point: args.reference_point === true, transform: pose.transform, angle_deg: pose.angle_deg,
      storey: args.on_level ?? "", name: args.name || pose.name || "",
    }, !dry);
    if (result.error || result.code) return finish({ error: result.error || result.code, code: result.code, resolved_document: result.resolved_document }, true);
    return finish({ dry_run: dry, project, ...result }, false, dry ? "place dry run" : "place");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish({ error: message }, true, "error");
  }
}

export function registerFmcCoordTool(server: McpServer) {
  server.tool("fmc_coord", FMC_COORD_DESCRIPTION, FMC_COORD_SHAPE, (args) => runFmcCoord(args));
}
