/**
 * The project coordination record. JSON, version 1.
 * One copy next to the project (FMC_Coord.json) and one in %APPDATA%\Formcraft\coord\<project>.json.
 * FMC_COORD_DIR and FMC_COORD_EXPORT_DIR replace those folders (tests). This module never reads process.env on its own:
 * every path takes the env it was given.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardConfig } from "./policy.js";
import { protectedRoots, underAny } from "./opencopy.js";
import {
  CoordStatus, Delta, Tolerance, Vec3, angleDegOf, asTolerance, combineStatus, deltaOf, fromAngleMm, identity,
  isMat4, judge, roundMm, rowVectorMatrix, translationOf,
} from "./coordmath.js";

export interface Xform {
  xyz_mm: Vec3;
  transform: number[][];
  angle_deg: number;
  name?: string;
}

export interface ControlPoint extends Xform {
  name: string;
  kind: "grid" | "survey" | "user";
  id?: string;
}

export interface ModelFacts {
  internal_to_shared: number[][];
  angle_deg: number;
  survey_point: Xform;
  project_base_point: Xform;
  true_north_angle_deg: number;
  elevation_datum_mm: number;
  shared_origin: Xform;
  title?: string;
  path?: string;
}

export interface ObjectRow extends Xform {
  stable_id: string;
  id?: string | number;
  unique_id?: string;
  mark?: string;
  category?: string;
  location?: string;
  rotation_deg?: number;
  level_offset_mm?: number;
  pinned?: boolean;
  document?: string;
}

export interface FamilyPlane {
  name: string;
  origin_mm: Vec3;
  normal: Vec3;
}

export interface FamilyRow extends Xform {
  name: string;
  stable_id: string;
  id?: string | number;
  insertion_mm?: Vec3;
  origin_mm?: Vec3;
  reference_planes?: FamilyPlane[];
  note?: string;
}

export interface Snapshot {
  document?: { title?: string; path?: string };
  resolved_document?: { title?: string; path?: string };
  model?: ModelFacts;
  control_points?: ControlPoint[];
  objects?: ObjectRow[];
  families?: FamilyRow[];
  other?: Snapshot;
  summary?: { control_points?: number; objects?: number; families?: number; ids?: Array<string | number> };
  note?: string;
  skipped?: unknown[];
  would?: unknown[];
  ok?: boolean;
  code?: string;
  error?: string;
}

export interface CoordRecord {
  version: 1;
  project: string;
  updated: string;
  survey_point: Xform;
  project_base_point: Xform;
  true_north_angle_deg: number;
  elevation_datum_mm: number;
  shared_origin: Xform;
  control_points: ControlPoint[];
  models: Record<string, ModelFacts>;
  objects: Record<string, ObjectRow>;
  families: Record<string, FamilyRow>;
}

export interface Tolerances {
  mm: Tolerance;
  deg: Tolerance;
  source: string;
}

export function coordAppDir(env: NodeJS.ProcessEnv): string {
  const own = (env.FMC_COORD_DIR ?? "").trim();
  if (own) return own;
  const base = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "Formcraft", "coord");
}

export function coordExportDir(env: NodeJS.ProcessEnv): string {
  const own = (env.FMC_COORD_EXPORT_DIR ?? "").trim();
  if (own) return own;
  const base = env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Local");
  return path.join(base, "Formcraft", "coord");
}

export function safeName(project: string): string {
  const cleaned = project.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+$/, "_").slice(0, 80);
  return cleaned || "project";
}

export function emptyRecord(project: string, at: string): CoordRecord {
  const origin = poseOf([0, 0, 0], 0, "shared origin");
  return {
    version: 1,
    project,
    updated: at,
    survey_point: poseOf([0, 0, 0], 0, "survey"),
    project_base_point: poseOf([0, 0, 0], 0, "project base"),
    true_north_angle_deg: 0,
    elevation_datum_mm: 0,
    shared_origin: origin,
    control_points: [],
    models: {},
    objects: {},
    families: {},
  };
}

export function poseOf(xyz: Vec3, angleDeg: number, name?: string): Xform {
  const transform = roundMm(fromAngleMm(xyz[0], xyz[1], xyz[2], angleDeg));
  return {
    ...(name ? { name } : {}),
    xyz_mm: [transform[0][3], transform[1][3], transform[2][3]],
    transform,
    angle_deg: angleDeg,
  };
}

export function poseFromTransform(transform: number[][], name?: string): Xform {
  if (!isMat4(transform)) throw new Error("[FMC-COORD-MATRIX] A transform is a 4×4 row-major matrix of finite numbers.");
  const m = roundMm(transform);
  return { ...(name ? { name } : {}), xyz_mm: translationOf(m), transform: m, angle_deg: angleDegOf(m) };
}

export function projectWriteBlock(file: string, cfg: GuardConfig): string | null {
  const prefixes = [...(cfg.protected_paths ?? []), ...protectedRoots(cfg)];
  if (underAny(file, prefixes)) return "Under a protected path. The coordination record is not written there.";
  return null;
}

export function appRecordPath(project: string, env: NodeJS.ProcessEnv): string {
  return path.join(coordAppDir(env), safeName(project) + ".json");
}

export function projectRecordPath(projectFolder: string): string {
  return path.join(projectFolder, "FMC_Coord.json");
}

export interface WritePlan {
  project_file: string | null;
  project_skipped: string | null;
  app_file: string;
}

export function planRecordWrite(projectFolder: string, projectKey: string, cfg: GuardConfig, env: NodeJS.ProcessEnv): WritePlan {
  const app_file = appRecordPath(projectKey, env);
  if (!projectFolder.trim()) return { project_file: null, project_skipped: null, app_file };
  const project_file = projectRecordPath(projectFolder);
  const why = projectWriteBlock(project_file, cfg);
  if (why) return { project_file: null, project_skipped: why, app_file };
  return { project_file, project_skipped: null, app_file };
}

function parseRecord(raw: string): CoordRecord | null {
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as CoordRecord;
    if (!parsed || parsed.version !== 1 || !parsed.project) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readRecord(projectFolder: string, projectKey: string, env: NodeJS.ProcessEnv): { record: CoordRecord | null; file: string } {
  const files = [
    ...(projectFolder.trim() ? [projectRecordPath(projectFolder)] : []),
    appRecordPath(projectKey, env),
  ];
  for (const file of files) {
    let raw = "";
    try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
    const record = parseRecord(raw);
    if (record) return { record, file };
  }
  return { record: null, file: "" };
}

export function writeRecordFiles(record: CoordRecord, plan: WritePlan): string[] {
  const text = JSON.stringify(record, null, 2);
  const wrote: string[] = [];
  fs.mkdirSync(path.dirname(plan.app_file), { recursive: true });
  fs.writeFileSync(plan.app_file, text);
  wrote.push(plan.app_file);
  if (plan.project_file) {
    fs.mkdirSync(path.dirname(plan.project_file), { recursive: true });
    fs.writeFileSync(plan.project_file, text);
    wrote.push(plan.project_file);
  }
  return wrote;
}

export function appendCoordLedger(env: NodeJS.ProcessEnv, line: Record<string, unknown>): void {
  try {
    const dir = coordAppDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "ledger.jsonl"), JSON.stringify(line) + "\n");
  } catch {
    // the ledger never blocks the coordination call
  }
}

export function docKey(snap: Snapshot): string {
  const doc = snap.document ?? snap.resolved_document ?? {};
  return (doc.path || doc.title || "model").trim() || "model";
}

export function mergeSnapshot(record: CoordRecord, snap: Snapshot, level: "model" | "object" | "family" | "all", at: string): CoordRecord {
  const next: CoordRecord = structuredClone(record);
  next.updated = at;
  const key = docKey(snap);
  if ((level === "model" || level === "all") && snap.model && isMat4(snap.model.internal_to_shared)) {
    const model: ModelFacts = {
      ...snap.model,
      internal_to_shared: roundMm(snap.model.internal_to_shared),
      title: snap.document?.title ?? snap.model.title ?? "",
      path: snap.document?.path ?? snap.model.path ?? "",
    };
    next.models[key] = model;
    if (model.survey_point) next.survey_point = model.survey_point;
    if (model.project_base_point) next.project_base_point = model.project_base_point;
    if (typeof model.true_north_angle_deg === "number") next.true_north_angle_deg = model.true_north_angle_deg;
    if (typeof model.elevation_datum_mm === "number") next.elevation_datum_mm = model.elevation_datum_mm;
    if (model.shared_origin) next.shared_origin = model.shared_origin;
  }
  if (level === "model" || level === "all") {
    for (const point of snap.control_points ?? []) {
      if (!point.name) continue;
      const row: ControlPoint = { ...point, kind: point.kind ?? "user" };
      const atIndex = next.control_points.findIndex((item) => item.name === row.name);
      if (atIndex >= 0) next.control_points[atIndex] = row;
      else next.control_points.push(row);
    }
  }
  if (level === "object" || level === "all") {
    for (const row of snap.objects ?? []) {
      const id = row.stable_id || row.unique_id;
      if (!id) continue;
      next.objects[id] = { ...row, stable_id: id, document: key };
    }
  }
  if (level === "family" || level === "all") {
    for (const row of snap.families ?? []) {
      const id = row.stable_id || row.name;
      if (!id) continue;
      next.families[id] = { ...row, stable_id: id };
    }
  }
  return next;
}

export function mergePoints(record: CoordRecord, points: ControlPoint[], at: string): CoordRecord {
  const next = structuredClone(record);
  next.updated = at;
  for (const point of points) {
    const atIndex = next.control_points.findIndex((item) => item.name === point.name);
    if (atIndex >= 0) next.control_points[atIndex] = point;
    else next.control_points.push(point);
  }
  return next;
}

export function findModel(record: CoordRecord, key: string): ModelFacts | null {
  const named = key.trim();
  if (!named) return null;
  if (record.models[named]) return record.models[named];
  const lower = named.toLowerCase();
  for (const [id, model] of Object.entries(record.models)) {
    if (id.toLowerCase() === lower) return model;
    if ((model.title ?? "").toLowerCase() === lower) return model;
    if ((model.path ?? "").toLowerCase() === lower) return model;
  }
  return null;
}

export function alignModelTarget(record: CoordRecord, which: "survey" | "base", to: string | undefined, document: string): { transform: number[][]; angle_deg: number } | null {
  if (to?.trim()) {
    const model = findModel(record, to);
    if (!model?.internal_to_shared) return null;
    return { transform: model.internal_to_shared, angle_deg: model.true_north_angle_deg ?? model.angle_deg };
  }
  if (which === "base") {
    if (!isMat4(record.project_base_point?.transform)) return null;
    return { transform: record.project_base_point.transform, angle_deg: record.project_base_point.angle_deg };
  }
  const own = findModel(record, document);
  if (own?.internal_to_shared) return { transform: own.internal_to_shared, angle_deg: own.true_north_angle_deg ?? own.angle_deg };
  if (!isMat4(record.survey_point?.transform)) return null;
  return { transform: record.survey_point.transform, angle_deg: record.true_north_angle_deg };
}

export function alignObjectTargets(record: CoordRecord, ids: string[], stableId: string | undefined): ObjectRow[] {
  const all = Object.values(record.objects);
  if (stableId?.trim()) {
    const key = stableId.trim();
    return all.filter((row) => row.stable_id === key || row.unique_id === key || String(row.id ?? "") === key);
  }
  if (ids.length) {
    const want = new Set(ids.map(String));
    return all.filter((row) => want.has(row.stable_id) || want.has(row.unique_id ?? "") || want.has(String(row.id ?? "")));
  }
  return all;
}

export interface CheckItem {
  kind: "model" | "point" | "object" | "family";
  name: string;
  id: string;
  stable_id: string;
  delta_mm: number;
  delta_deg: number;
  dxyz_mm: Vec3;
  position: CoordStatus;
  angle: CoordStatus;
  status: CoordStatus;
  note?: string;
}

export interface CheckReport {
  items: CheckItem[];
  summary: { count: number; pass: number; fail: number; provisional: number; unknown: number; ids: string[] };
}

function unmatched(kind: CheckItem["kind"], name: string, id: string, stable: string, note: string): CheckItem {
  return {
    kind, name, id, stable_id: stable, delta_mm: 0, delta_deg: 0, dxyz_mm: [0, 0, 0],
    position: "UNKNOWN", angle: "UNKNOWN", status: "UNKNOWN", note,
  };
}

export function judgeDelta(delta: Delta, mm: Tolerance, deg: Tolerance, kind: CheckItem["kind"], name: string, id: string, stable: string): CheckItem {
  const position = judge(delta.delta_mm, mm);
  const angle = judge(delta.delta_deg, deg);
  return {
    kind, name, id, stable_id: stable,
    delta_mm: delta.delta_mm, delta_deg: delta.delta_deg, dxyz_mm: delta.dxyz_mm,
    position, angle, status: combineStatus(position, angle),
  };
}

function pair(left: number[][] | undefined, right: number[][] | undefined, mm: Tolerance, deg: Tolerance, kind: CheckItem["kind"], name: string, id: string, stable: string): CheckItem {
  if (!left || !right || !isMat4(left) || !isMat4(right)) return unmatched(kind, name, id, stable, "no match");
  return judgeDelta(deltaOf(left, right), mm, deg, kind, name, id, stable);
}

export function summarize(items: CheckItem[]): CheckReport["summary"] {
  const count = (status: CoordStatus) => items.filter((item) => item.status === status).length;
  return {
    count: items.length,
    pass: count("PASS"),
    fail: count("FAIL"),
    provisional: count("PROVISIONAL"),
    unknown: count("UNKNOWN"),
    ids: items.map((item) => item.id || item.stable_id || item.name).filter(Boolean),
  };
}

function filterItems(items: CheckItem[], name?: string, stableId?: string): CheckItem[] {
  return items.filter((item) => {
    if (name && item.kind === "point" && item.name !== name) return false;
    if (stableId && (item.kind === "object" || item.kind === "family") && item.stable_id !== stableId && item.id !== stableId) return false;
    return true;
  });
}

export function checkModels(record: CoordRecord, leftKey: string, rightKey: string, tols: Tolerances, name?: string, stableId?: string): CheckReport {
  const left = findModel(record, leftKey);
  const right = findModel(record, rightKey);
  const items: CheckItem[] = [];
  if (!left || !right) {
    items.push(unmatched("model", leftKey, "", "", !left ? "left model is not in the record" : "right model is not in the record"));
  } else {
    items.push(pair(left.internal_to_shared, right.internal_to_shared, tols.mm, tols.deg, "model", `${leftKey} → ${rightKey}`, left.path || left.title || leftKey, ""));
  }
  return { items: filterItems(items, name, stableId), summary: summarize(filterItems(items, name, stableId)) };
}

export function checkSnapshot(record: CoordRecord, snap: Snapshot, tols: Tolerances, level: "model" | "object" | "family" | "all", name?: string, stableId?: string): CheckReport {
  const items: CheckItem[] = [];
  const key = docKey(snap);
  if (level === "model" || level === "all") {
    const published = findModel(record, key);
    items.push(pair(published?.internal_to_shared, snap.model?.internal_to_shared, tols.mm, tols.deg, "model", published?.title || key, key, ""));
    const byName = new Map(record.control_points.map((point) => [point.name, point]));
    for (const point of snap.control_points ?? []) {
      const had = byName.get(point.name);
      items.push(had
        ? pair(had.transform, point.transform, tols.mm, tols.deg, "point", point.name, point.id ?? "", point.name)
        : unmatched("point", point.name, point.id ?? "", point.name, "not in the record"));
    }
  }
  if (level === "object" || level === "all") {
    for (const row of snap.objects ?? []) {
      const id = row.stable_id || row.unique_id || "";
      const had = record.objects[id];
      items.push(had
        ? pair(had.transform, row.transform, tols.mm, tols.deg, "object", row.name ?? id, String(row.id ?? ""), id)
        : unmatched("object", row.name ?? id, String(row.id ?? ""), id, "not in the record"));
    }
  }
  if (level === "family" || level === "all") {
    for (const row of snap.families ?? []) {
      const id = row.stable_id || row.name;
      const had = record.families[id] ?? record.families[row.name];
      items.push(had
        ? pair(had.transform, row.transform, tols.mm, tols.deg, "family", row.name, String(row.id ?? ""), id)
        : unmatched("family", row.name, String(row.id ?? ""), id, "not in the record"));
    }
  }
  const filtered = filterItems(items, name, stableId);
  return { items: filtered, summary: summarize(filtered) };
}

export function checkSnapshots(left: Snapshot, right: Snapshot, tols: Tolerances, level: "model" | "object" | "family" | "all", name?: string, stableId?: string): CheckReport {
  const items: CheckItem[] = [];
  if (level === "model" || level === "all") {
    items.push(pair(left.model?.internal_to_shared, right.model?.internal_to_shared, tols.mm, tols.deg, "model", `${docKey(left)} → ${docKey(right)}`, docKey(left), ""));
    const byName = new Map((right.control_points ?? []).map((point) => [point.name, point]));
    for (const point of left.control_points ?? []) {
      const other = byName.get(point.name);
      items.push(other
        ? pair(point.transform, other.transform, tols.mm, tols.deg, "point", point.name, point.id ?? "", point.name)
        : unmatched("point", point.name, point.id ?? "", point.name, "no match"));
    }
  }
  if (level === "object" || level === "all") {
    const byId = new Map((right.objects ?? []).map((row) => [row.stable_id || row.unique_id || "", row]));
    for (const row of left.objects ?? []) {
      const id = row.stable_id || row.unique_id || "";
      const other = byId.get(id);
      items.push(other
        ? pair(row.transform, other.transform, tols.mm, tols.deg, "object", row.name ?? id, String(row.id ?? ""), id)
        : unmatched("object", row.name ?? id, String(row.id ?? ""), id, "no match"));
    }
  }
  if (level === "family" || level === "all") {
    const byId = new Map((right.families ?? []).map((row) => [row.stable_id || row.name, row]));
    for (const row of left.families ?? []) {
      const id = row.stable_id || row.name;
      const other = byId.get(id) ?? byId.get(row.name);
      items.push(other
        ? pair(row.transform, other.transform, tols.mm, tols.deg, "family", row.name, String(row.id ?? ""), id)
        : unmatched("family", row.name, String(row.id ?? ""), id, "no match"));
    }
  }
  const filtered = filterItems(items, name, stableId);
  return { items: filtered, summary: summarize(filtered) };
}

export interface ExportFile {
  name: string;
  path: string;
  text: string;
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "0.";
  const text = String(Math.round(n * 1e6) / 1e6);
  return text.includes(".") ? text : text + ".";
}

/** IfcMapConversion values, millimetres. Not a full IFC model: the six numbers other software reads. */
export function ifcMapConversion(m: number[][]): string {
  const tx = m[0][3], ty = m[1][3], tz = m[2][3];
  const abscissa = m[0][0], ordinate = m[1][0];
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('Formcraft coordination IfcMapConversion. Units: millimetres.'),'2;1');",
    "FILE_NAME('coord.ifc','',('Formcraft'),(''),'fmc_coord','Formcraft','');",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    "/* Eastings, Northings, OrthogonalHeight, XAxisAbscissa, XAxisOrdinate, Scale. Units: millimetres. */",
    `#1=IFCMAPCONVERSION(#2,#3,${num(tx)},${num(ty)},${num(tz)},${num(abscissa)},${num(ordinate)},1.);`,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

export function archicadText(m: number[][], trueNorth: number): string {
  return [
    "ARCHICAD",
    "units mm",
    `Eastings ${num(m[0][3])}`,
    `Northings ${num(m[1][3])}`,
    `Elevation ${num(m[2][3])}`,
    `Rotation_deg ${num(angleDegOf(m))}`,
    `TrueNorth_deg ${num(trueNorth)}`,
    `XAxisAbscissa ${num(m[0][0])}`,
    `XAxisOrdinate ${num(m[1][0])}`,
    "",
  ].join("\n");
}

export function pointsCsv(record: CoordRecord): string {
  const rows: Xform[] = [
    { ...record.shared_origin, name: record.shared_origin.name || "shared origin" },
    { ...record.survey_point, name: record.survey_point.name || "survey" },
    { ...record.project_base_point, name: record.project_base_point.name || "project base" },
    ...record.control_points,
  ];
  const lines = ["name,X,Y,Z,rotation"];
  for (const row of rows) {
    const xyz = row.xyz_mm ?? translationOf(row.transform);
    lines.push([csv(row.name || ""), csv(xyz[0]), csv(xyz[1]), csv(xyz[2]), csv(row.angle_deg)].join(","));
  }
  return lines.join("\n") + "\n";
}

function csv(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportBodies(record: CoordRecord, document: string | undefined): { ifc: string; archicad: string; navis: string; blender: string; csv: string; matrix: number[][] } {
  const matrix = exportMatrix(record, document);
  const listed = pointRows(record);
  const common = {
    units: "mm",
    row_major: true,
    angle_deg: angleDegOf(matrix),
    true_north_angle_deg: record.true_north_angle_deg,
    points: listed,
  };
  const navis = { ...common, translation: "last_column", matrix, matrix_row_vector: rowVectorMatrix(matrix), note: "matrix matches the record (translation in the last column). matrix_row_vector is the Navisworks row-vector form (translation in the last row)." };
  const blender = { ...common, translation: "last_column", matrix, note: "Blender mathutils.Matrix rows. Translation is the last column. Units are millimetres." };
  return {
    ifc: ifcMapConversion(matrix),
    archicad: archicadText(matrix, record.true_north_angle_deg),
    navis: JSON.stringify(navis, null, 2),
    blender: JSON.stringify(blender, null, 2),
    csv: pointsCsv(record),
    matrix,
  };
}

function pointRows(record: CoordRecord): Array<{ name: string; X: number; Y: number; Z: number; rotation: number }> {
  const rows: Xform[] = [
    { ...record.shared_origin, name: record.shared_origin.name || "shared origin" },
    ...record.control_points,
  ];
  return rows.map((row) => {
    const xyz = row.xyz_mm ?? translationOf(row.transform);
    return { name: row.name || "", X: xyz[0], Y: xyz[1], Z: xyz[2], rotation: row.angle_deg };
  });
}

export function exportMatrix(record: CoordRecord, document?: string): number[][] {
  if (document?.trim()) {
    const model = findModel(record, document);
    if (model?.internal_to_shared && isMat4(model.internal_to_shared)) return model.internal_to_shared;
  }
  const first = Object.values(record.models)[0];
  if (first?.internal_to_shared && isMat4(first.internal_to_shared)) return first.internal_to_shared;
  if (isMat4(record.survey_point?.transform)) return record.survey_point.transform;
  return identity();
}

export function exportFiles(record: CoordRecord, dir: string, document?: string): ExportFile[] {
  const safe = safeName(record.project);
  const body = exportBodies(record, document);
  return [
    { name: `${safe}-ifcmap.txt`, path: path.join(dir, `${safe}-ifcmap.txt`), text: body.ifc },
    { name: `${safe}-archicad.txt`, path: path.join(dir, `${safe}-archicad.txt`), text: body.archicad },
    { name: `${safe}-navis.json`, path: path.join(dir, `${safe}-navis.json`), text: body.navis },
    { name: `${safe}-blender.json`, path: path.join(dir, `${safe}-blender.json`), text: body.blender },
    { name: `${safe}-points.csv`, path: path.join(dir, `${safe}-points.csv`), text: body.csv },
  ];
}

export function writeExport(files: ExportFile[]): void {
  for (const file of files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.text);
  }
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCsvPoints(text: string): ControlPoint[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (!lines.length) throw new Error("[FMC-COORD-IMPORT] The CSV is empty.");
  const header = splitCsv(lines[0]).map((cell) => cell.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((cell) => names.includes(cell));
  const iName = col("name");
  const iX = col("x");
  const iY = col("y");
  const iZ = col("z");
  const iR = col("rotation", "angle", "angle_deg");
  if (iName < 0 || iX < 0 || iY < 0 || iZ < 0) throw new Error("[FMC-COORD-IMPORT] CSV needs columns name, X, Y, Z, rotation.");
  const points: ControlPoint[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const name = (cells[iName] ?? "").trim();
    if (!name) continue;
    const x = Number(cells[iX]);
    const y = Number(cells[iY]);
    const z = Number(cells[iZ] ?? 0);
    const rotation = iR >= 0 && cells[iR] ? Number(cells[iR]) : 0;
    if (![x, y, z, rotation].every(Number.isFinite)) throw new Error(`[FMC-COORD-IMPORT] ${name} is not a number.`);
    points.push({ ...poseOf([x, y, z], rotation, name), name, kind: "user" });
  }
  return points;
}

export function parseImport(text: string, fileName: string): ControlPoint[] {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  const asCsv = fileName.toLowerCase().endsWith(".csv") || (!trimmed.startsWith("{") && !trimmed.startsWith("["));
  if (asCsv) return parseCsvPoints(text);
  let json: unknown;
  try { json = JSON.parse(trimmed); } catch { throw new Error("[FMC-COORD-IMPORT] That file is not JSON or CSV."); }
  const points: ControlPoint[] = [];
  const take = (row: unknown, fallbackKind: ControlPoint["kind"]) => {
    if (!row || typeof row !== "object") return;
    const item = row as Record<string, unknown>;
    const name = String(item.name ?? item.Name ?? "").trim();
    if (!name) return;
    if (isMat4(item.transform)) {
      const pose = poseFromTransform(item.transform, name);
      const kind = item.kind === "grid" || item.kind === "survey" || item.kind === "user" ? item.kind : fallbackKind;
      points.push({ ...pose, name, kind });
      return;
    }
    const xyz = Array.isArray(item.xyz_mm) ? item.xyz_mm.map(Number) : [Number(item.X ?? item.x), Number(item.Y ?? item.y), Number(item.Z ?? item.z)];
    if (xyz.length < 3 || !xyz.slice(0, 3).every(Number.isFinite)) throw new Error(`[FMC-COORD-IMPORT] ${name} needs xyz_mm or X, Y, Z.`);
    const angle = Number(item.angle_deg ?? item.rotation ?? item.Rotation ?? 0);
    const kind = item.kind === "grid" || item.kind === "survey" || item.kind === "user" ? item.kind : fallbackKind;
    points.push({ ...poseOf([xyz[0], xyz[1], xyz[2]], Number.isFinite(angle) ? angle : 0, name), name, kind });
  };
  if (Array.isArray(json)) {
    for (const row of json) take(row, "user");
    return points;
  }
  if (!json || typeof json !== "object") throw new Error("[FMC-COORD-IMPORT] JSON needs points, control_points or transforms.");
  const body = json as Record<string, unknown>;
  const lists = [body.points, body.control_points, body.transforms].filter(Array.isArray) as unknown[][];
  if (!lists.length) throw new Error("[FMC-COORD-IMPORT] JSON needs points, control_points or transforms.");
  for (const list of lists) for (const row of list) take(row, "user");
  return points;
}

export function tolerancesFrom(standards: Record<string, unknown> | null, source: string): Tolerances {
  const bag = standards ?? {};
  return {
    mm: asTolerance(bag["coord.tol_mm"]),
    deg: asTolerance(bag["coord.tol_deg"]),
    source,
  };
}

export function idsOf(snap: Snapshot): string[] {
  const ids = [
    ...(snap.summary?.ids ?? []).map(String),
    ...(snap.objects ?? []).map((row) => String(row.id ?? row.stable_id)),
    ...(snap.control_points ?? []).map((point) => point.id || point.name),
    ...(snap.families ?? []).map((row) => String(row.id ?? row.stable_id)),
  ];
  return [...new Set(ids.filter(Boolean))];
}
