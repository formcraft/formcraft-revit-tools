/**
 * Plans for fmc_north. The add-in reads geometry and applies a delta. The angle decisions are here,
 * so they can be tested without Revit. Project north and shared coordinates are never written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asTolerance, combineStatus, judge, type CoordStatus, type Tolerance } from "./coordmath.js";
import {
  NORTH_FIX, arrowRotationDeg, distanceToRect, dominantAxis, gridInSet, gridSetKey, linkAngleDelta,
  orientationKind, roleOf, rotationToGrid, round3, round6, surveyDeltaMm, viewRotationVsTrueNorthDeg,
  type Vec3,
} from "./northmath.js";

export interface Xy { x: number; y: number }
export interface Rect { min: Xy; max: Xy }

export interface NorthMarker {
  id?: string;
  pinned?: boolean;
  easting_mm?: number | null;
  northing_mm?: number | null;
  elevation_mm?: number | null;
  angle_deg?: number | null;
  x_mm?: number | null;
  y_mm?: number | null;
  z_mm?: number | null;
}

export interface NorthView {
  id: string;
  unique_id?: string;
  name: string;
  view_type?: string;
  is_plan?: boolean;
  orientation?: string;
  orientation_param?: string;
  crop_basis_x_deg?: number | null;
  crop_active?: boolean;
  scope_box_id?: string;
  scope_box?: string;
}

export interface NorthGrid { id: string; name: string; angle_deg: number | null; curved?: boolean }
export interface NorthViewport {
  id: string;
  view_id: string;
  sheet_id: string;
  sheet_number?: string;
  sheet_name?: string;
  center_mm?: Xy;
  outline_mm?: Rect;
}
export interface NorthArrowInst {
  id: string;
  family?: string;
  type_name?: string;
  sheet_id?: string;
  on_sheet?: boolean;
  x_mm?: number;
  y_mm?: number;
  rotation_deg?: number | null;
  pinned?: boolean;
  param?: string;
}
export interface NorthLinkDoc {
  title?: string;
  angle_deg?: number | null;
  shared_basis_x_deg?: number | null;
  easting_mm?: number | null;
  northing_mm?: number | null;
  elevation_mm?: number | null;
  survey_point?: NorthMarker | null;
}
export interface NorthLink {
  id: string;
  name?: string;
  loaded?: boolean;
  pinned?: boolean;
  basis_x_deg?: number | null;
  origin_mm?: Vec3;
  host_shared_mm?: Vec3;
  link?: NorthLinkDoc | null;
}
export interface NorthDoc {
  title: string;
  path?: string;
  role?: string;
  is_central?: boolean;
  workshared?: boolean;
  site?: string;
  angle_deg?: number | null;
  shared_basis_x_deg?: number | null;
  easting_mm?: number | null;
  northing_mm?: number | null;
  elevation_mm?: number | null;
  survey_point?: NorthMarker | null;
  project_base_point?: NorthMarker | null;
  grids?: NorthGrid[];
  views?: NorthView[];
  viewports?: NorthViewport[];
  links?: NorthLink[];
  arrows?: NorthArrowInst[];
  error?: string;
}

export interface NorthSnapshot {
  read_only?: boolean;
  project_north_changed?: boolean;
  shared_coordinates_changed?: boolean;
  documents?: NorthDoc[];
  resolved_document?: { title?: string; path?: string };
  is_central?: boolean;
  active_unchanged?: boolean;
  refused?: boolean;
  code?: string;
  message?: string;
}

export interface CitedTol extends Tolerance {
  source: string;
  key: string;
}

const PROVISIONAL_DEG = "PROVISIONAL default 0.01 deg. Not in the standards bank. A provisional tolerance cannot PASS.";
const PROVISIONAL_MM = "PROVISIONAL default 1 mm. Not in the standards bank. A provisional tolerance cannot PASS.";

function bag(standards: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!standards) return {};
  const inner = standards.standards;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Record<string, unknown>;
  return standards;
}

function cited(standards: Record<string, unknown> | null | undefined, keys: string[], fallback: number, clause: string): CitedTol {
  const source = bag(standards);
  for (const key of keys) {
    if (!(key in source)) continue;
    const tol = asTolerance(source[key]);
    return { ...tol, source: "standards", key };
  }
  return { value: fallback, status: "provisional", clause, unit: keys[0].endsWith("deg") ? "degrees" : "mm", source: "provisional", key: keys[0] };
}

export function resolveNorthTolerances(
  standards: Record<string, unknown> | null | undefined,
  call: { tol_deg?: number; tol_mm?: number } = {},
): { deg: CitedTol; mm: CitedTol } {
  const deg = cited(standards, ["north.tol_deg", "coord.tol_deg"], 0.01, PROVISIONAL_DEG);
  const mm = cited(standards, ["north.tol_mm", "coord.tol_mm"], 1, PROVISIONAL_MM);
  if (typeof call.tol_deg === "number") deg.value = call.tol_deg;
  if (typeof call.tol_mm === "number") mm.value = call.tol_mm;
  if (typeof call.tol_deg === "number") deg.source = deg.source === "standards" ? "call" : deg.source;
  if (typeof call.tol_mm === "number") mm.source = mm.source === "standards" ? "call" : mm.source;
  return { deg, mm };
}

export function northDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_NORTH_DIR ?? "").trim()) return env.FMC_NORTH_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(os.tmpdir(), "FormcraftLocal");
  return path.join(local, "Formcraft", "north");
}

export function writeNorthReport(env: NodeJS.ProcessEnv, action: string, body: unknown, dir = northDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `north-${action}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

export function referenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return NORTH_FIX["FMC-NORTH-REFERENCES"];
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) return NORTH_FIX["FMC-NORTH-REFERENCES"];
  }
  return null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function markerVec(marker: NorthMarker | null | undefined, origin: { x: number | null; y: number | null; z: number | null }): Vec3 | null {
  const x = num(marker?.easting_mm);
  const y = num(marker?.northing_mm);
  const z = num(marker?.elevation_mm);
  if (x != null && y != null && z != null) return { x, y, z };
  if (origin.x != null && origin.y != null && origin.z != null) return { x: origin.x, y: origin.y, z: origin.z };
  return null;
}

export function prepareDoc(raw: NorthDoc): NorthDoc {
  const title = raw.title ?? "";
  return { ...raw, title, role: raw.role || roleOf(title) };
}

export function normalizeNorth(raw: unknown): NorthSnapshot {
  const row = (raw && typeof raw === "object" ? raw : {}) as NorthSnapshot;
  const documents = Array.isArray(row.documents) ? row.documents.map((doc) => prepareDoc(doc)) : [];
  return { ...row, documents, project_north_changed: row.project_north_changed === true, shared_coordinates_changed: row.shared_coordinates_changed === true };
}

export interface GridSetSummary {
  name: string;
  angle_deg: number | null;
  count: number;
  spread_deg: number | null;
  tied: boolean;
  ids: string[];
  truncated: boolean;
}

export function gridSetsOf(doc: NorthDoc, sample: number): GridSetSummary[] {
  const groups = new Map<string, NorthGrid[]>();
  for (const grid of doc.grids ?? []) {
    const key = gridSetKey(grid.name || "");
    const list = groups.get(key) ?? [];
    list.push(grid);
    groups.set(key, list);
  }
  const out: GridSetSummary[] = [];
  for (const [name, grids] of groups) {
    const straight = grids.filter((g) => g.angle_deg != null && !g.curved);
    const dominant = dominantAxis(straight.map((g) => g.angle_deg as number));
    const ids = grids.map((g) => g.id);
    out.push({
      name,
      angle_deg: dominant?.angle_deg ?? null,
      count: grids.length,
      spread_deg: dominant?.spread_deg ?? null,
      tied: dominant?.tied ?? false,
      ids: ids.slice(0, sample),
      truncated: ids.length > sample,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function selectedGrids(doc: NorthDoc, pick: { grid_set?: string; grid_names?: string[]; grid_ids?: string[] }): NorthGrid[] {
  const grids = (doc.grids ?? []).filter((g) => g.angle_deg != null && !g.curved);
  if (pick.grid_ids?.length) {
    const want = new Set(pick.grid_ids.map(String));
    return grids.filter((g) => want.has(g.id));
  }
  if (pick.grid_names?.length) {
    const want = new Set(pick.grid_names.map((n) => n.trim().toLowerCase()));
    return grids.filter((g) => want.has(g.name.trim().toLowerCase()));
  }
  if ((pick.grid_set ?? "").trim()) return grids.filter((g) => gridInSet(g.name, pick.grid_set!));
  return [];
}

export function selectedViews(doc: NorthDoc, pick: { views?: string[]; grid_set?: string }): { views: NorthView[]; code?: string } {
  const plans = (doc.views ?? []).filter((v) => v.is_plan);
  const named = (pick.views ?? []).map((v) => v.trim()).filter(Boolean);
  if (named.length) {
    const want = new Set(named.map((v) => v.toLowerCase()));
    const views = plans.filter((v) => want.has(v.id) || want.has(v.name.trim().toLowerCase()));
    return views.length ? { views } : { views: [], code: "FMC-NORTH-VIEW-NONE" };
  }
  const setName = (pick.grid_set ?? "").trim();
  if (setName) {
    const views = plans.filter((v) => v.name.toLowerCase().includes(setName.toLowerCase()));
    return views.length ? { views } : { views: [], code: "FMC-NORTH-VIEW-NONE" };
  }
  return { views: [], code: "FMC-NORTH-VIEW-NONE" };
}

export interface AlignOp {
  view_id: string;
  name: string;
  before_deg: number | null;
  delta_deg: number | null;
  after_deg: number | null;
  mode: "crop" | "scope_box";
  scope_box_id?: string;
  code?: string;
  fix?: string;
}

export function planAlign(doc: NorthDoc, pick: {
  views?: string[];
  grid_set?: string;
  grid_names?: string[];
  grid_ids?: string[];
  mode?: "crop" | "scope_box";
  scope_box?: string;
}): { grid_angle_deg: number | null; ops: AlignOp[]; code?: string; fix?: string; scope_note?: string } {
  const grids = selectedGrids(doc, pick);
  const dominant = dominantAxis(grids.map((g) => g.angle_deg as number));
  if (!dominant) return { grid_angle_deg: null, ops: [], code: "FMC-NORTH-GRID-NONE", fix: NORTH_FIX["FMC-NORTH-GRID-NONE"] };
  const chosen = selectedViews(doc, pick);
  if (chosen.code) return { grid_angle_deg: dominant.angle_deg, ops: [], code: chosen.code, fix: NORTH_FIX[chosen.code] };
  const mode = pick.mode === "scope_box" ? "scope_box" : "crop";
  if (mode === "scope_box" && !(pick.scope_box ?? "").trim()) {
    return { grid_angle_deg: dominant.angle_deg, ops: [], code: "FMC-NORTH-SCOPE-REQUIRED", fix: NORTH_FIX["FMC-NORTH-SCOPE-REQUIRED"] };
  }
  const ops: AlignOp[] = chosen.views.map((view) => {
    if (view.crop_basis_x_deg == null) {
      return {
        view_id: view.id, name: view.name, before_deg: null, delta_deg: null, after_deg: null, mode,
        code: "FMC-NORTH-CROP-NOT-FOUND", fix: NORTH_FIX["FMC-NORTH-CROP-NOT-FOUND"],
      };
    }
    const delta = round6(rotationToGrid(view.crop_basis_x_deg, dominant.angle_deg));
    return {
      view_id: view.id,
      name: view.name,
      before_deg: round6(view.crop_basis_x_deg),
      delta_deg: delta,
      after_deg: round6(view.crop_basis_x_deg + delta),
      mode,
      ...(mode === "scope_box" ? { scope_box_id: (pick.scope_box ?? "").trim() } : {}),
    };
  });
  return {
    grid_angle_deg: dominant.angle_deg,
    ops,
    ...(mode === "scope_box" ? { scope_note: NORTH_FIX["FMC-NORTH-SCOPE-SHARED"] } : {}),
  };
}

export interface ArrowMatch {
  viewport_id: string;
  view_id: string;
  sheet_id: string;
  sheet_number?: string;
  view_name?: string;
  arrow_id?: string;
  before_deg?: number | null;
  target_deg?: number | null;
  code?: string;
  fix?: string;
}

export function planArrows(doc: NorthDoc, pick: {
  views?: string[];
  sheets?: string[];
  family: string;
  type_name?: string;
  match_param?: string;
  near_mm?: number;
  arrow_zero_deg?: number;
  arrow_ids?: string[];
}): ArrowMatch[] {
  const near = pick.near_mm ?? 150;
  const family = pick.family.trim().toLowerCase();
  const typeName = (pick.type_name ?? "").trim().toLowerCase();
  const viewWant = new Set((pick.views ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean));
  const sheetWant = new Set((pick.sheets ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean));
  const views = new Map((doc.views ?? []).map((v) => [v.id, v]));
  const project = num(doc.angle_deg) ?? 0;
  let ports = doc.viewports ?? [];
  if (viewWant.size) {
    ports = ports.filter((p) => {
      const view = views.get(p.view_id);
      return viewWant.has(p.view_id) || viewWant.has((view?.name ?? "").toLowerCase());
    });
  }
  if (sheetWant.size) {
    ports = ports.filter((p) => sheetWant.has(p.sheet_id) || sheetWant.has((p.sheet_number ?? "").toLowerCase()) || sheetWant.has((p.sheet_name ?? "").toLowerCase()));
  }
  const arrows = (doc.arrows ?? []).filter((a) => {
    if (family && (a.family ?? "").trim().toLowerCase() !== family) return false;
    if (typeName && (a.type_name ?? "").trim().toLowerCase() !== typeName) return false;
    return true;
  });
  const idWant = new Set((pick.arrow_ids ?? []).map(String));
  const out: ArrowMatch[] = [];
  for (const port of ports) {
    const view = views.get(port.view_id);
    const base: ArrowMatch = {
      viewport_id: port.id,
      view_id: port.view_id,
      sheet_id: port.sheet_id,
      sheet_number: port.sheet_number,
      view_name: view?.name,
    };
    const crop = view?.crop_basis_x_deg;
    if (crop == null || view == null) {
      out.push({ ...base, code: "FMC-NORTH-CROP-NOT-FOUND", fix: NORTH_FIX["FMC-NORTH-CROP-NOT-FOUND"] });
      continue;
    }
    const target = round6(arrowRotationDeg(project, crop, pick.arrow_zero_deg ?? 0));
    let pool = arrows.filter((a) => !a.sheet_id || a.sheet_id === port.sheet_id);
    if (idWant.size) pool = pool.filter((a) => idWant.has(a.id));
    const onSheet = pool.filter((a) => a.on_sheet !== false);
    const inView = pool.filter((a) => a.on_sheet === false);
    const param = (pick.match_param ?? "").trim();
    const paramHits = param
      ? onSheet.filter((a) => {
        const value = (a.param ?? "").trim().toLowerCase();
        return value === port.id.toLowerCase() || value === port.view_id.toLowerCase() || value === (view.name ?? "").trim().toLowerCase() || value === (port.sheet_number ?? "").trim().toLowerCase();
      })
      : [];
    const chosen = paramHits.length ? paramHits : onSheet;
    if (!chosen.length) {
      out.push({
        ...base,
        target_deg: target,
        code: inView.length ? "FMC-NORTH-ARROW-IN-VIEW" : "FMC-NORTH-ARROW-UNMATCHED",
        fix: NORTH_FIX[inView.length ? "FMC-NORTH-ARROW-IN-VIEW" : "FMC-NORTH-ARROW-UNMATCHED"],
      });
      continue;
    }
    const ranked = chosen.map((a) => {
      const outline = port.outline_mm;
      const dist = outline
        ? distanceToRect(a.x_mm ?? 0, a.y_mm ?? 0, outline.min.x, outline.min.y, outline.max.x, outline.max.y)
        : Math.hypot((a.x_mm ?? 0) - (port.center_mm?.x ?? 0), (a.y_mm ?? 0) - (port.center_mm?.y ?? 0));
      return { a, dist };
    }).sort((p, q) => p.dist - q.dist);
    if (paramHits.length > 1 || (!paramHits.length && ranked.length > 1 && ranked[0].dist <= near && ranked[1].dist - ranked[0].dist < 20)) {
      out.push({ ...base, target_deg: target, code: "FMC-NORTH-ARROW-AMBIGUOUS", fix: NORTH_FIX["FMC-NORTH-ARROW-AMBIGUOUS"] });
      continue;
    }
    if (!paramHits.length && ranked[0].dist > near) {
      out.push({ ...base, target_deg: target, code: "FMC-NORTH-ARROW-UNMATCHED", fix: NORTH_FIX["FMC-NORTH-ARROW-UNMATCHED"] });
      continue;
    }
    const hit = ranked[0].a;
    out.push({ ...base, arrow_id: hit.id, before_deg: hit.rotation_deg ?? null, target_deg: target });
  }
  return out;
}

export interface PairFinding {
  code: string;
  fix: string;
  left: string;
  right: string;
  delta_deg?: number;
  delta_mm?: number;
  status: CoordStatus;
  measure: string;
  kind: "documents" | "link";
  link_id?: string;
}

function statusOf(delta: number, tol: Tolerance): CoordStatus {
  return judge(delta, tol);
}

function outside(delta: number, tol: Tolerance): boolean {
  if (tol.value == null || !Number.isFinite(delta)) return false;
  return Math.abs(delta) > tol.value + 1e-9;
}

export function compareSnapshot(docs: NorthDoc[], tols: { deg: CitedTol; mm: CitedTol }, includeLinks: boolean): { findings: PairFinding[]; status: CoordStatus } {
  const findings: PairFinding[] = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) findings.push(...pairDocs(docs[i], docs[j], tols));
  }
  if (includeLinks) {
    for (const doc of docs) {
      for (const link of doc.links ?? []) findings.push(...pairLink(doc, link, tols));
    }
  }
  let status: CoordStatus = findings.length ? "PASS" : (docs.length ? "PASS" : "UNKNOWN");
  if (!docs.length) status = "UNKNOWN";
  for (const finding of findings) status = combineStatus(status, finding.status);
  if (docs.length && tols.deg.source === "provisional") status = combineStatus(status, "PROVISIONAL");
  if (docs.length && tols.mm.source === "provisional") status = combineStatus(status, "PROVISIONAL");
  return { findings, status };
}

function pairDocs(a: NorthDoc, b: NorthDoc, tols: { deg: CitedTol; mm: CitedTol }): PairFinding[] {
  const out: PairFinding[] = [];
  const aa = num(a.angle_deg);
  const bb = num(b.angle_deg);
  if (aa == null || bb == null) {
    out.push({ code: "FMC-NORTH-ANGLE-MISMATCH", fix: NORTH_FIX["FMC-NORTH-ANGLE-MISMATCH"], left: a.title, right: b.title, status: "UNKNOWN", measure: "angle", kind: "documents" });
  } else {
    const delta = round6(linkAngleDelta(aa, 0, bb));
    const status = statusOf(delta, tols.deg);
    if (status === "UNKNOWN" || status === "FAIL" || outside(delta, tols.deg)) {
      out.push({ code: "FMC-NORTH-ANGLE-MISMATCH", fix: NORTH_FIX["FMC-NORTH-ANGLE-MISMATCH"], left: a.title, right: b.title, delta_deg: delta, status, measure: "angle", kind: "documents" });
    }
  }
  const asur = markerVec(a.survey_point, { x: num(a.easting_mm), y: num(a.northing_mm), z: num(a.elevation_mm) });
  const bsur = markerVec(b.survey_point, { x: num(b.easting_mm), y: num(b.northing_mm), z: num(b.elevation_mm) });
  if (!asur || !bsur) {
    out.push({ code: "FMC-NORTH-SURVEY-MISMATCH", fix: NORTH_FIX["FMC-NORTH-SURVEY-MISMATCH"], left: a.title, right: b.title, status: "UNKNOWN", measure: "survey", kind: "documents" });
  } else {
    const delta = round3(surveyDeltaMm(asur, bsur).delta_mm);
    const status = statusOf(delta, tols.mm);
    if (status === "UNKNOWN" || status === "FAIL" || outside(delta, tols.mm)) {
      out.push({ code: "FMC-NORTH-SURVEY-MISMATCH", fix: NORTH_FIX["FMC-NORTH-SURVEY-MISMATCH"], left: a.title, right: b.title, delta_mm: delta, status, measure: "survey", kind: "documents" });
    }
  }
  return out;
}

function pairLink(host: NorthDoc, link: NorthLink, tols: { deg: CitedTol; mm: CitedTol }): PairFinding[] {
  const name = link.name || link.id;
  if (!link.loaded || !link.link) {
    return [{ code: "FMC-NORTH-LINK-UNLOADED", fix: NORTH_FIX["FMC-NORTH-LINK-UNLOADED"], left: host.title, right: name, status: "UNKNOWN", measure: "link", kind: "link", link_id: link.id }];
  }
  const out: PairFinding[] = [];
  const hostAngle = num(host.shared_basis_x_deg) ?? num(host.angle_deg);
  const linkAngle = num(link.link.shared_basis_x_deg) ?? num(link.link.angle_deg);
  const basis = num(link.basis_x_deg);
  if (hostAngle == null || linkAngle == null || basis == null) {
    out.push({ code: "FMC-NORTH-ANGLE-MISMATCH", fix: NORTH_FIX["FMC-NORTH-ANGLE-MISMATCH"], left: host.title, right: name, status: "UNKNOWN", measure: "link_angle", kind: "link", link_id: link.id });
  } else {
    const delta = round6(linkAngleDelta(hostAngle, basis, linkAngle));
    const status = statusOf(delta, tols.deg);
    if (status === "UNKNOWN" || status === "FAIL" || outside(delta, tols.deg)) {
      out.push({ code: "FMC-NORTH-ANGLE-MISMATCH", fix: NORTH_FIX["FMC-NORTH-ANGLE-MISMATCH"], left: host.title, right: name, delta_deg: delta, status, measure: "link_angle", kind: "link", link_id: link.id });
    }
  }
  const hostShared = link.host_shared_mm;
  const linkShared = markerVec(link.link.survey_point, {
    x: num(link.link.easting_mm), y: num(link.link.northing_mm), z: num(link.link.elevation_mm),
  });
  if (!hostShared || !linkShared) {
    out.push({ code: "FMC-NORTH-SURVEY-MISMATCH", fix: NORTH_FIX["FMC-NORTH-SURVEY-MISMATCH"], left: host.title, right: name, status: "UNKNOWN", measure: "link_survey", kind: "link", link_id: link.id });
  } else {
    const delta = round3(surveyDeltaMm(hostShared, linkShared).delta_mm);
    const status = statusOf(delta, tols.mm);
    if (status === "UNKNOWN" || status === "FAIL" || outside(delta, tols.mm)) {
      out.push({ code: "FMC-NORTH-SURVEY-MISMATCH", fix: NORTH_FIX["FMC-NORTH-SURVEY-MISMATCH"], left: host.title, right: name, delta_mm: delta, status, measure: "link_survey", kind: "link", link_id: link.id });
    }
  }
  return out;
}

export function capFindings(findings: PairFinding[], sample: number) {
  const groups = new Map<string, PairFinding[]>();
  for (const finding of findings) {
    const list = groups.get(finding.code) ?? [];
    list.push(finding);
    groups.set(finding.code, list);
  }
  return [...groups.entries()].map(([code, rows]) => ({
    code,
    count: rows.length,
    fix: rows[0].fix,
    ids: rows.slice(0, sample).map((row) => row.link_id || `${row.left}|${row.right}`),
    truncated: rows.length > sample,
    pairs: rows.slice(0, sample).map((row) => ({
      left: row.left, right: row.right, kind: row.kind, measure: row.measure,
      delta_deg: row.delta_deg, delta_mm: row.delta_mm, status: row.status,
    })),
  }));
}

export function viewRotationRows(doc: NorthDoc, sample: number) {
  const rows = (doc.views ?? []).map((view) => {
    const project = num(doc.angle_deg);
    const crop = num(view.crop_basis_x_deg);
    return {
      id: view.id,
      name: view.name,
      orientation: orientationKind(view.orientation),
      orientation_param: view.orientation_param ?? "",
      crop_basis_x_deg: crop,
      vs_true_north_deg: project != null && crop != null ? round6(viewRotationVsTrueNorthDeg(project, crop)) : null,
    };
  });
  return { count: rows.length, ids: rows.slice(0, sample).map((row) => row.id), truncated: rows.length > sample, sample: rows.slice(0, sample) };
}

export { NORTH_FIX, roleOf, viewRotationVsTrueNorthDeg };
