import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, loadConfig } from "../fmc/policy.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { kitPaths } from "../fmc/context.js";
import { documentRequired } from "../fmc/fairqueue.js";
import { asOpenDocs, looksLikeRevitPath, matchesOpenDoc, type OpenDocRef } from "../fmc/docresolve.js";
import { readInstances } from "../fmc/connect.js";
import { isMat4 } from "../fmc/coordmath.js";
import {
  CheckItem, CheckReport, ControlPoint, CoordRecord, Snapshot, Tolerances, Xform,
  alignModelTarget, alignObjectTargets, appRecordPath, appendCoordLedger, checkModels, checkSnapshot, checkSnapshots,
  coordExportDir, docKey, emptyRecord, exportFiles, findModel, idsOf, mergePoints, mergeSnapshot,
  parseImport, planRecordWrite, poseFromTransform, poseOf, projectRecordPath, projectWriteBlock, readRecord, tolerancesFrom,
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
  "Pinned elements and elements another person owns are reported and not moved. read with no record is not an error: " +
  "it returns exists false, where it looked (record_files), how the project key was found (project_key_from) and next " +
  "publish. check replies start with verdict counts and each FAIL item has an explain line. align lists moved_ids and " +
  "place lists created_ids when Revit returns them. No images.";

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

/** The folder above 01_WIP in a document path; empty when the path has no 01_WIP segment. */
export function projectFolderFromDocument(document: string): string {
  const unified = document.replace(/\\/g, "/");
  const at = unified.toLowerCase().indexOf("/01_wip/");
  if (at <= 0) return "";
  const folder = unified.slice(0, at);
  // Keep the document's own separators so the record path still opens on this machine.
  return /\\/.test(document) && !/^\//.test(document) ? folder.replace(/\//g, "\\") : folder;
}

/** Write-side folder (publish / import). An explicit project_folder still wins; this path is not changed in F99. */
function writeProjectFolder(given: string, document: string): string {
  if (given.trim()) return given.trim();
  return projectFolderFromDocument(document);
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

function openDocsOf(deps: CoordDeps): OpenDocRef[] {
  if (deps.open) return asOpenDocs(deps.open);
  try {
    return readInstances(deps.env ?? process.env).flatMap((instance) =>
      (instance.documents ?? []).map((d) => ({ title: d.title ?? "", path: d.path ?? "", family: d.family === true })));
  } catch {
    return [];
  }
}

/** Title or path ? the open document's path when it is unique; otherwise the argument itself. */
export function documentPathOf(document: string, open: OpenDocRef[]): string {
  const named = document.trim();
  if (!named) return "";
  const hits = open.filter((d) => matchesOpenDoc(d, named) && (d.path ?? "").trim());
  if (hits.length === 1) return hits[0].path;
  if (looksLikeRevitPath(named) || /[\\/]/.test(named)) return named;
  return named;
}

/** Join a child name onto a project folder using that folder's own separators (Windows or POSIX). */
function joinUnder(folder: string, name: string): string {
  return /\\/.test(folder) && !/^\//.test(folder) ? win.join(folder, name) : path.join(folder, name);
}

function has01Wip(folder: string): boolean {
  if (!folder.trim()) return false;
  try { return fs.existsSync(joinUnder(folder, "01_WIP")); } catch { return false; }
}

export interface CoordBinding {
  /** Folder used to look up FMC_Coord.json (read, export, check, align, place). */
  folder: string;
  /** Folder publish / import would write next to. Unchanged from the pre-F99 rule. */
  write_folder: string;
  project: string;
  from: ProjectKeyFrom;
  document_path: string;
  ignored_project_folder?: string;
  write_folder_note?: string;
}

/**
 * F99: the record key and the read folder bind to the named document's project folder
 * (the folder above 01_WIP, resolved from the open document list when the argument is a title).
 * A leftover project_folder such as out-files does not override that. An explicit `project` still wins as the key.
 * publish / import keep writing next to the given project_folder (safety: that write path is Builder 1).
 */
export function bindCoordRecord(project: string, givenFolder: string, document: string, open: OpenDocRef[] = []): CoordBinding {
  const given = givenFolder.trim();
  const write_folder = writeProjectFolder(given, document);
  const document_path = documentPathOf(document, open);
  const fromDoc = projectFolderFromDocument(document_path);
  let folder = "";
  if (fromDoc) folder = fromDoc;
  else if (given && !document.trim()) folder = given;
  else if (given && document.trim() && has01Wip(given)) folder = given;

  const from: ProjectKeyFrom = project.trim() ? "project"
    : folder && !fromDoc ? "project_folder"
    : (document.trim() || document_path) ? "document"
    : folder ? "project_folder"
    : "none";
  const key = projectKeyOf(project, folder, document);
  const out: CoordBinding = { folder, write_folder, project: key, from, document_path };
  if (given && folder.toLowerCase() !== given.replace(/[\\/]+$/, "").toLowerCase()) out.ignored_project_folder = given;
  if (write_folder && folder && win.normalize(write_folder).toLowerCase() !== win.normalize(folder).toLowerCase()) {
    out.write_folder_note = `A real publish would still write FMC_Coord.json next to ${write_folder} (the project_folder argument), not this document's project folder ${folder}. That write path is unchanged (Builder 1).`;
  } else if (write_folder && !folder && document.trim()) {
    out.write_folder_note = `A real publish would still write FMC_Coord.json next to ${write_folder} (the project_folder argument), not under this document's name. That write path is unchanged (Builder 1).`;
  }
  return out;
}

export type ProjectKeyFrom = "project" | "project_folder" | "document" | "none";

export function projectKeyFrom(project: string, folder: string, document: string): ProjectKeyFrom {
  if (project.trim()) return "project";
  if (folder.trim()) return "project_folder";
  if (document.trim()) return "document";
  return "none";
}

/** Where read looks for the record, in order, and a hint when the key is a guess (P-fmc_coord-01). */
export function recordLookup(folder: string, project: string, from: ProjectKeyFrom, env: NodeJS.ProcessEnv) {
  const record_files = [...(folder.trim() ? [projectRecordPath(folder)] : []), appRecordPath(project, env)];
  const out: { project_key_from: ProjectKeyFrom; record_files: string[]; folder_has_01_wip?: boolean; key_warning?: string } = { project_key_from: from, record_files };
  if (folder.trim()) out.folder_has_01_wip = has01Wip(folder);
  if (from !== "project") {
    const source = from === "project_folder" ? "project folder name" : folder.trim() ? "document's project folder name" : "document name";
    out.key_warning = `The project key "${project}" was taken from the ${source}. Name project to be sure this is the record you mean.`;
  }
  return out;
}

/** One plain line per FAIL item, from the numbers already in the item. */
export function explainItem(item: CheckItem): string {
  const parts: string[] = [];
  if (item.position === "FAIL") {
    const [dx, dy, dz] = item.dxyz_mm ?? [0, 0, 0];
    parts.push(`position off by ${item.delta_mm} mm (dx ${dx}, dy ${dy}, dz ${dz} mm)`);
  }
  if (item.angle === "FAIL") parts.push(`angle off by ${item.delta_deg} degrees`);
  if (!parts.length) parts.push(`status ${item.status}`);
  return `${item.kind} ${item.name || item.stable_id || item.id}: ${parts.join("; ")}`;
}

export function withExplain(report: CheckReport) {
  const s = report.summary;
  return {
    verdict: { pass: s.pass, fail: s.fail, unknown: s.unknown, provisional: s.provisional, count: s.count },
    ...report,
    items: report.items.map((item) => item.status === "FAIL" ? { ...item, explain: explainItem(item) } : item),
  };
}

/** Ids from Revit result rows such as applied[] or placed[]; empty when none carry an id. */
export function rowIds(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>).id : undefined))
    .filter((id) => id !== undefined && id !== null && String(id) !== "")
    .map(String);
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
  const bound = bindCoordRecord(args.project ?? "", args.project_folder ?? "", args.document ?? "", openDocsOf(deps));
  const folder = bound.folder;
  const writeFolder = bound.write_folder;
  const project = bound.project;
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
      const lookup = recordLookup(folder, project, bound.from, env);
      const extra = {
        ...(bound.ignored_project_folder ? { ignored_project_folder: bound.ignored_project_folder } : {}),
        ...(bound.document_path ? { document_path: bound.document_path } : {}),
        ...(bound.write_folder_note ? { write_folder_note: bound.write_folder_note } : {}),
      };
      if (!found.record) {
        return finish({
          exists: false, project, ...lookup, ...extra,
          message: "[FMC-COORD-EMPTY] No coordination record for this project yet.",
          next: { tool: "fmc_coord", args: { action: "publish", document: args.document || "<open document>", project, ...(folder ? { project_folder: folder } : {}), dry_run: true } },
        }, false, "read empty");
      }
      return finish({ exists: true, project, project_key_from: lookup.project_key_from, file: found.file, version: found.record.version, record: found.record, summary: summaryOf(found.record), ...extra }, false, "read");
    }

    if (args.action === "import") {
      const source = (args.source ?? "").trim();
      if (!source) return finish({ error: "[FMC-COORD-IMPORT] import needs source: a CSV or JSON file." }, true);
      let text = "";
      try { text = fs.readFileSync(source, "utf8"); } catch { return finish({ error: `[FMC-COORD-IMPORT] Cannot read ${source}` }, true); }
      const points = parseImport(text, source);
      const existing = readRecord(folder, project, env).record ?? emptyRecord(project, at);
      const next = mergePoints(existing, points, at);
      const plan = planRecordWrite(writeFolder, project, cfg, env);
      if (dry) return finish({ dry_run: true, project, would_add: points.map((point) => point.name), count: points.length, project_skipped: plan.project_skipped, ...(bound.write_folder_note ? { write_folder_note: bound.write_folder_note } : {}), next: "Run again with dry_run=false" }, false, `${points.length} points`);
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
      return finish({ project, server_only: true, tolerances: tols, ...withExplain(report) }, false, `${report.summary.count} items`);
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
      const plan = planRecordWrite(writeFolder, project, cfg, env);
      const body = {
        dry_run: dry, project, level, summary: summaryOf(next), ids: idsOf(snap),
        project_skipped: plan.project_skipped, resolved_document: snap.resolved_document ?? snap.document,
        tolerances: tols,
        ...(bound.write_folder_note ? { write_folder_note: bound.write_folder_note } : {}),
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
        ...withExplain(report),
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
      const moved = rowIds((result as Record<string, unknown>).applied);
      return finish({ dry_run: dry, project, level, target: args.target, ...result, ...(dry ? {} : { moved_ids: moved }) }, false, dry ? "align dry run" : "align");
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
    const created = rowIds((result as Record<string, unknown>).placed);
    return finish({ dry_run: dry, project, ...result, ...(dry ? {} : { created_ids: created }) }, false, dry ? "place dry run" : "place");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish({ error: message }, true, "error");
  }
}

export function registerFmcCoordTool(server: McpServer) {
  server.tool("fmc_coord", FMC_COORD_DESCRIPTION, FMC_COORD_SHAPE, (args) => runFmcCoord(args));
}
