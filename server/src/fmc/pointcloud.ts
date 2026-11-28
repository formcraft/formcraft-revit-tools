/**
 * Point cloud against model (L011-F25, build plan item 61 / G029): align a scan to the model's element meshes and
 * report how far each element is off. Pure functions: the Revit read gives the meshes (metres), cloudread.ts gives
 * the points. Nothing here writes to the model; the report is written by the tool, in an allowed folder, on request.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { csvLine, expandEnv, isInside, type GuardConfig } from "./policy.js";

const win = path.win32;

export const POINTCLOUD_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_pointcloud needs document, a title or a full path. The active document is not a guess.",
  "FMC-POINTCLOUD-FILE": "cloud must be the full path of an .e57 or .las file that exists.",
  "FMC-POINTCLOUD-LAZ": "LAZ is compressed LAS. Decompress it to LAS first (pdal translate in.laz out.las, or laszip), then run again.",
  "FMC-POINTCLOUD-FORMAT": "Not an E57 or LAS file.",
  "FMC-POINTCLOUD-E57": "The E57 file could not be read.",
  "FMC-POINTCLOUD-SPEC": "The point cloud spec is missing or is not JSON.",
  "FMC-POINTCLOUD-NO-MESH": "The read found no element geometry in the named categories or ids.",
  "FMC-POINTCLOUD-NO-OVERLAP": "The cloud and the model do not overlap. Check coordinates (shared or internal), cloud_units, or give offset.",
  "FMC-POINTCLOUD-ALIGN-REJECTED": "The automatic alignment moved further than max_shift_m or turned more than max_rotation_deg, or found too few pairs. It was not used; the given alignment was kept.",
  "FMC-POINTCLOUD-FOLDER": "The output folder is not allowed. Use a folder inside write_roots or reports_dir in fmc_guard.json, never 02_Shared, 03_Published, 04_Archive, 05_Incoming or a protected original.",
  "FMC-POINTCLOUD-EXISTS": "A report with that name already exists. Nothing is overwritten.",
  "FMC-POINTCLOUD-TRUNCATED": "The model mesh was cut at max_triangles. Some elements are missing from the check.",
};

export interface PointCloudSpec {
  status?: string;
  categories?: string[];
  tolerance_mm?: number;
  tolerances_mm?: Record<string, number>;
  search_radius_m?: number;
  min_points?: number;
}

export interface LoadedPointCloudSpec { spec: PointCloudSpec; path: string; source: "kit" | "sample" | "file"; provisional: boolean }

export interface MeshElement {
  id: string;
  unique_id?: string;
  category?: string;
  name?: string;
  level?: string;
  v: number[];
  t: number[];
  mesh_cut?: boolean;
}

export interface Model {
  tri: Float64Array; // 9 per triangle
  elem: Int32Array; // element index per triangle
  elements: MeshElement[];
  min: [number, number, number];
  max: [number, number, number];
}

const here = path.dirname(fileURLToPath(import.meta.url));

function joinUnder(root: string, ...parts: string[]): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root) || (root.includes("\\") && !root.includes("/"));
  return (windows ? path.win32 : path).join(root, ...parts);
}

export function loadPointCloudSpec(opts: { file?: string; kitRoot?: string; env?: NodeJS.ProcessEnv; read?: (file: string) => string }): LoadedPointCloudSpec {
  const read = opts.read ?? ((file) => fs.readFileSync(file, "utf8"));
  const named = (opts.file ?? opts.env?.FMC_POINTCLOUD_FILE ?? "").trim();
  const kit = (opts.kitRoot ?? "").replace(/[\\/]+$/, "");
  const candidates: Array<{ file: string; source: LoadedPointCloudSpec["source"] }> = [];
  if (named) candidates.push({ file: named, source: "file" });
  if (kit) candidates.push({ file: joinUnder(kit, "03_Master_Data", "FMC_PointCloud.json"), source: "kit" });
  for (const file of [path.resolve(here, "..", "..", "data", "FMC_PointCloud.json"), path.resolve(here, "..", "data", "FMC_PointCloud.json")]) candidates.push({ file, source: "sample" });
  for (const item of candidates) {
    let raw: string;
    try { raw = read(item.file); } catch { continue; }
    let spec: PointCloudSpec;
    try { spec = JSON.parse(raw.replace(/^\uFEFF/, "")) as PointCloudSpec; } catch { throw new Error(`[FMC-POINTCLOUD-SPEC] ${item.file} is not JSON.`); }
    const provisional = item.source !== "kit" || String(spec.status ?? "").toUpperCase() === "PROVISIONAL";
    return { spec, path: item.file, source: item.source, provisional };
  }
  throw new Error(`[FMC-POINTCLOUD-SPEC] ${POINTCLOUD_FIX["FMC-POINTCLOUD-SPEC"]}`);
}

export const UNIT_TO_M: Record<string, number> = { m: 1, mm: 0.001, cm: 0.01, ft: 0.3048, us_ft: 1200 / 3937 };

export function buildModel(elements: MeshElement[]): Model {
  let n = 0;
  for (const e of elements) n += Math.floor((e.t?.length ?? 0) / 3);
  const tri = new Float64Array(n * 9);
  const elem = new Int32Array(n);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let k = 0;
  elements.forEach((e, ei) => {
    const v = e.v ?? [];
    for (let i = 0; i + 2 < (e.t?.length ?? 0); i += 3) {
      for (let c = 0; c < 3; c++) {
        const vi = e.t[i + c] * 3;
        for (let d = 0; d < 3; d++) {
          const val = v[vi + d];
          tri[k * 9 + c * 3 + d] = val;
          if (val < min[d]) min[d] = val;
          if (val > max[d]) max[d] = val;
        }
      }
      elem[k] = ei;
      k++;
    }
  });
  return { tri, elem, elements, min, max };
}

/** Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). Writes into out. */
export function closestOnTriangle(px: number, py: number, pz: number, t: Float64Array, o: number, out: Float64Array): void {
  const ax = t[o], ay = t[o + 1], az = t[o + 2], bx = t[o + 3], by = t[o + 4], bz = t[o + 5], cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz; return; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[0] = bx + w * (cx - bx); out[1] = by + w * (cy - by); out[2] = bz + w * (cz - bz); return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out[0] = ax + abx * v + acx * w; out[1] = ay + aby * v + acy * w; out[2] = az + abz * v + acz * w;
}

/** A hashed uniform grid over the triangles, so each point only looks at triangles near it. */
export class TriangleGrid {
  private cells = new Map<number, number[]>();
  private stamp: Int32Array;
  private tick = 0;
  private tmp = new Float64Array(3);
  readonly cell: number;
  constructor(readonly model: Model, cell: number) {
    this.cell = Math.max(cell, 1e-3);
    this.stamp = new Int32Array(model.elem.length);
    const t = model.tri;
    for (let i = 0; i < model.elem.length; i++) {
      const o = i * 9;
      const lo = [Math.min(t[o], t[o + 3], t[o + 6]), Math.min(t[o + 1], t[o + 4], t[o + 7]), Math.min(t[o + 2], t[o + 5], t[o + 8])];
      const hi = [Math.max(t[o], t[o + 3], t[o + 6]), Math.max(t[o + 1], t[o + 4], t[o + 7]), Math.max(t[o + 2], t[o + 5], t[o + 8])];
      const a = lo.map((v) => Math.floor(v / this.cell)), b = hi.map((v) => Math.floor(v / this.cell));
      for (let x = a[0]; x <= b[0]; x++) for (let y = a[1]; y <= b[1]; y++) for (let z = a[2]; z <= b[2]; z++) {
        const key = TriangleGrid.key(x, y, z);
        let list = this.cells.get(key);
        if (!list) { list = []; this.cells.set(key, list); }
        list.push(i);
      }
    }
  }
  static key(x: number, y: number, z: number): number {
    return (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0);
  }
  /** The nearest triangle within radius: its index, the distance and the closest point; null when none. */
  nearest(px: number, py: number, pz: number, radius: number): { tri: number; dist: number; cx: number; cy: number; cz: number } | null {
    this.tick++;
    if (this.tick === 0x7fffffff) { this.stamp.fill(0); this.tick = 1; }
    const r = Math.ceil(radius / this.cell);
    const ix = Math.floor(px / this.cell), iy = Math.floor(py / this.cell), iz = Math.floor(pz / this.cell);
    let best = -1, bestD2 = radius * radius, bx = 0, by = 0, bz = 0;
    for (let x = ix - r; x <= ix + r; x++) for (let y = iy - r; y <= iy + r; y++) for (let z = iz - r; z <= iz + r; z++) {
      const list = this.cells.get(TriangleGrid.key(x, y, z));
      if (!list) continue;
      for (const i of list) {
        if (this.stamp[i] === this.tick) continue;
        this.stamp[i] = this.tick;
        closestOnTriangle(px, py, pz, this.model.tri, i * 9, this.tmp);
        const dx = px - this.tmp[0], dy = py - this.tmp[1], dz = pz - this.tmp[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= bestD2) { bestD2 = d2; best = i; bx = this.tmp[0]; by = this.tmp[1]; bz = this.tmp[2]; }
      }
    }
    return best < 0 ? null : { tri: best, dist: Math.sqrt(bestD2), cx: bx, cy: by, cz: bz };
  }
}

/** A rigid transform: p' = R p + t, R row-major 3x3. */
export interface Rigid { r: number[]; t: [number, number, number] }

export const IDENTITY: Rigid = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export function rigidFromOffset(o: { x?: number; y?: number; z?: number; rotation_deg?: number } | undefined): Rigid {
  const a = ((o?.rotation_deg ?? 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { r: [c, -s, 0, s, c, 0, 0, 0, 1], t: [o?.x ?? 0, o?.y ?? 0, o?.z ?? 0] };
}

export function compose(a: Rigid, b: Rigid): Rigid {
  // a after b
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a.r[i * 3 + k] * b.r[k * 3 + j];
  const t: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) t[i] = a.r[i * 3] * b.t[0] + a.r[i * 3 + 1] * b.t[1] + a.r[i * 3 + 2] * b.t[2] + a.t[i];
  return { r, t };
}

export function applyRigid(m: Rigid, pts: Float64Array, scale = 1): Float64Array {
  const out = new Float64Array(pts.length);
  const r = m.r;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i] * scale, y = pts[i + 1] * scale, z = pts[i + 2] * scale;
    out[i] = r[0] * x + r[1] * y + r[2] * z + m.t[0];
    out[i + 1] = r[3] * x + r[4] * y + r[5] * z + m.t[1];
    out[i + 2] = r[6] * x + r[7] * y + r[8] * z + m.t[2];
  }
  return out;
}

export function rotationDeg(m: Rigid): number {
  const tr = m.r[0] + m.r[4] + m.r[8];
  return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
}

/** Largest eigenvector of a symmetric 4x4 matrix (Jacobi). */
function topEigen4(a: number[][]): number[] {
  const n = 4;
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const m = a.map((row) => row.slice());
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += m[p][q] * m[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(m[p][q]) < 1e-30) continue;
      const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const mkp = m[k][p], mkq = m[k][q];
        m[k][p] = c * mkp - s * mkq; m[k][q] = s * mkp + c * mkq;
      }
      for (let k = 0; k < n; k++) {
        const mpk = m[p][k], mqk = m[q][k];
        m[p][k] = c * mpk - s * mqk; m[q][k] = s * mpk + c * mqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (m[i][i] > m[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/** Best rigid transform taking src onto dst (Horn 1987 quaternions; or yaw and translation only). */
export function fitRigid(src: number[], dst: number[], zOnly: boolean): Rigid {
  const n = src.length / 3;
  let sx = 0, sy = 0, sz = 0, dx = 0, dy = 0, dz = 0;
  for (let i = 0; i < n; i++) { sx += src[i * 3]; sy += src[i * 3 + 1]; sz += src[i * 3 + 2]; dx += dst[i * 3]; dy += dst[i * 3 + 1]; dz += dst[i * 3 + 2]; }
  sx /= n; sy /= n; sz /= n; dx /= n; dy /= n; dz /= n;
  let r: number[];
  if (zOnly) {
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const ax = src[i * 3] - sx, ay = src[i * 3 + 1] - sy, bx = dst[i * 3] - dx, by = dst[i * 3 + 1] - dy;
      num += ax * by - ay * bx; den += ax * bx + ay * by;
    }
    const a = Math.atan2(num, den);
    const c = Math.cos(a), s = Math.sin(a);
    r = [c, -s, 0, s, c, 0, 0, 0, 1];
  } else {
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) {
      const a = [src[i * 3] - sx, src[i * 3 + 1] - sy, src[i * 3 + 2] - sz], b = [dst[i * 3] - dx, dst[i * 3 + 1] - dy, dst[i * 3 + 2] - dz];
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) S[j][k] += a[j] * b[k];
    }
    const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
    const N = [
      [xx + yy + zz, yz - zy, zx - xz, xy - yx],
      [yz - zy, xx - yy - zz, xy + yx, zx + xz],
      [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
      [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
    ];
    const [w, x, y, z] = topEigen4(N);
    r = [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
  }
  const t: [number, number, number] = [
    dx - (r[0] * sx + r[1] * sy + r[2] * sz),
    dy - (r[3] * sx + r[4] * sy + r[5] * sz),
    dz - (r[6] * sx + r[7] * sy + r[8] * sz),
  ];
  return { r, t };
}

export interface IcpResult {
  used: boolean;
  transform: Rigid;
  iterations: number;
  pairs: number;
  rms_before_mm: number;
  rms_after_mm: number;
  shift_m: number;
  rotation_deg: number;
  code?: string;
}

/** Point-to-surface ICP on a sample of the points, trimmed to pairs within radius. Returns the extra transform. */
export function icp(points: Float64Array, grid: TriangleGrid, opts: { radius: number; zOnly: boolean; maxIter: number; sample: number; maxShift: number; maxRotDeg: number; minPairs: number }): IcpResult {
  const n = points.length / 3;
  const step = Math.max(1, Math.floor(n / Math.max(1, opts.sample)));
  const sample: number[] = [];
  for (let i = 0; i < n; i += step) sample.push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
  let total: Rigid = IDENTITY;
  let cur: Float64Array = Float64Array.from(sample);
  const rmsOf = (pts: Float64Array) => {
    let s = 0, c = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const hit = grid.nearest(pts[i], pts[i + 1], pts[i + 2], opts.radius);
      if (hit) { s += hit.dist * hit.dist; c++; }
    }
    return { rms: c ? Math.sqrt(s / c) : NaN, pairs: c };
  };
  const before = rmsOf(cur);
  let it = 0;
  let pairs = before.pairs;
  for (; it < opts.maxIter; it++) {
    const src: number[] = [], dst: number[] = [];
    for (let i = 0; i < cur.length; i += 3) {
      const hit = grid.nearest(cur[i], cur[i + 1], cur[i + 2], opts.radius);
      if (hit) { src.push(cur[i], cur[i + 1], cur[i + 2]); dst.push(hit.cx, hit.cy, hit.cz); }
    }
    pairs = src.length / 3;
    if (pairs < opts.minPairs) break;
    const step1 = fitRigid(src, dst, opts.zOnly);
    cur = applyRigid(step1, cur);
    total = compose(step1, total);
    const moved = Math.hypot(...step1.t);
    if (moved < 1e-5 && rotationDeg(step1) < 1e-4) { it++; break; }
  }
  const after = rmsOf(cur);
  const shift = Math.hypot(...total.t);
  const rot = rotationDeg(total);
  const ok = pairs >= opts.minPairs && shift <= opts.maxShift && rot <= opts.maxRotDeg && !(after.rms > before.rms);
  return {
    used: ok, transform: ok ? total : IDENTITY, iterations: it, pairs,
    rms_before_mm: Math.round(before.rms * 10000) / 10, rms_after_mm: Math.round((ok ? after.rms : before.rms) * 10000) / 10,
    shift_m: Math.round(shift * 10000) / 10000, rotation_deg: Math.round(rot * 10000) / 10000,
    ...(ok ? {} : { code: "FMC-POINTCLOUD-ALIGN-REJECTED" }),
  };
}

export type ElementStatus = "WITHIN" | "OFF" | "NO-COVERAGE";

export interface ElementDeviation {
  id: string;
  unique_id: string;
  category: string;
  name: string;
  level: string;
  points: number;
  mean_mm: number;
  mean_abs_mm: number;
  rms_mm: number;
  p95_mm: number;
  max_mm: number;
  shift_mm: [number, number, number];
  tolerance_mm: number;
  status: ElementStatus;
  mesh_cut?: boolean;
}

export interface Deviation {
  elements: ElementDeviation[];
  matched: number;
  unmatched: number;
  outside: number;
  bands_mm: Record<string, number>;
  summary: Record<ElementStatus, number>;
}

const BANDS: Array<[string, number]> = [["0-5", 5], ["5-10", 10], ["10-20", 20], ["20-50", 50], ["50-100", 100], [">100", Infinity]];
const r1 = (v: number) => Math.round(v * 10) / 10;

function triNormal(t: Float64Array, o: number): [number, number, number] {
  const ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2];
  const vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Each point goes to its nearest element surface within radius. Distances are signed: + outside the face, - inside. */
export function deviation(points: Float64Array, grid: TriangleGrid, opts: { radius: number; minPoints: number; tolerance: (e: MeshElement) => number }): Deviation {
  const model = grid.model;
  const per = model.elements.map(() => [] as number[]);
  const shift = model.elements.map(() => [0, 0, 0]);
  const bands: Record<string, number> = Object.fromEntries(BANDS.map(([k]) => [k, 0]));
  let matched = 0, unmatched = 0, outside = 0;
  const pad = opts.radius;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i], y = points[i + 1], z = points[i + 2];
    if (x < model.min[0] - pad || y < model.min[1] - pad || z < model.min[2] - pad || x > model.max[0] + pad || y > model.max[1] + pad || z > model.max[2] + pad) { outside++; continue; }
    const hit = grid.nearest(x, y, z, opts.radius);
    if (!hit) { unmatched++; continue; }
    matched++;
    const e = model.elem[hit.tri];
    const nrm = triNormal(model.tri, hit.tri * 9);
    const sign = (x - hit.cx) * nrm[0] + (y - hit.cy) * nrm[1] + (z - hit.cz) * nrm[2] >= 0 ? 1 : -1;
    per[e].push(sign * hit.dist * 1000);
    shift[e][0] += x - hit.cx; shift[e][1] += y - hit.cy; shift[e][2] += z - hit.cz;
    const mm = hit.dist * 1000;
    for (const [k, lim] of BANDS) if (mm < lim) { bands[k]++; break; }
  }
  const summary: Record<ElementStatus, number> = { WITHIN: 0, OFF: 0, "NO-COVERAGE": 0 };
  const rows: ElementDeviation[] = model.elements.map((el, i) => {
    const d = per[i];
    const n = d.length;
    const abs = d.map(Math.abs).sort((a, b) => a - b);
    const tol = opts.tolerance(el);
    const mean = n ? d.reduce((s, v) => s + v, 0) / n : 0;
    const meanAbs = n ? abs.reduce((s, v) => s + v, 0) / n : 0;
    const rms = n ? Math.sqrt(abs.reduce((s, v) => s + v * v, 0) / n) : 0;
    const p95 = n ? abs[Math.min(n - 1, Math.floor(0.95 * (n - 1)))] : 0;
    const status: ElementStatus = n < opts.minPoints ? "NO-COVERAGE" : p95 > tol ? "OFF" : "WITHIN";
    summary[status]++;
    return {
      id: el.id, unique_id: el.unique_id ?? "", category: el.category ?? "", name: el.name ?? "", level: el.level ?? "",
      points: n, mean_mm: r1(mean), mean_abs_mm: r1(meanAbs), rms_mm: r1(rms), p95_mm: r1(p95), max_mm: r1(n ? abs[n - 1] : 0),
      shift_mm: n ? [r1((shift[i][0] / n) * 1000), r1((shift[i][1] / n) * 1000), r1((shift[i][2] / n) * 1000)] : [0, 0, 0],
      tolerance_mm: tol, status, ...(el.mesh_cut ? { mesh_cut: true } : {}),
    };
  });
  return { elements: rows, matched, unmatched, outside, bands_mm: bands, summary };
}

export function overlap(model: Model, b: { min: number[]; max: number[] } | null, pad: number): boolean {
  if (!b) return false;
  for (let d = 0; d < 3; d++) if (b.max[d] < model.min[d] - pad || b.min[d] > model.max[d] + pad) return false;
  return true;
}

export function deviationCsv(rows: ElementDeviation[]): Buffer {
  let out = "\uFEFF" + csvLine(["id", "unique_id", "category", "name", "level", "status", "points", "mean_mm", "mean_abs_mm", "rms_mm", "p95_mm", "max_mm", "shift_x_mm", "shift_y_mm", "shift_z_mm", "tolerance_mm"]);
  for (const r of rows) out += csvLine([r.id, r.unique_id, r.category, r.name, r.level, r.status, r.points, r.mean_mm, r.mean_abs_mm, r.rms_mm, r.p95_mm, r.max_mm, ...r.shift_mm, r.tolerance_mm]);
  return Buffer.from(out, "utf8");
}

function norm(p: string, env: NodeJS.ProcessEnv): string {
  return win.normalize(expandEnv(p, env)).replace(/[\\/]+$/, "");
}

/** The report folder: absolute; not a CDE gate folder or the family library; not under a protected original; inside write_roots or reports_dir. */
export function checkReportFolder(folder: string, cfg: GuardConfig, protectedList: string[], env: NodeJS.ProcessEnv = process.env): { ok: boolean; folder: string; reasons: string[] } {
  const reasons: string[] = [];
  const target = norm(folder, env);
  if (!folder.trim() || !win.isAbsolute(target) || /%[^%]+%/.test(target)) reasons.push(`Output folder must be an absolute path: ${folder || "(empty)"}`);
  const segs = target.toLowerCase().split("\\").filter(Boolean);
  const blocked = (cfg.blocked_segments ?? []).map((s) => s.toLowerCase()).filter((s) => segs.includes(s));
  if (blocked.length) reasons.push(`Writing into ${blocked.join(", ")} is a CDE gate with a named approver, not a tool action (Manual 7.5)`);
  if (segs.includes("04_families")) reasons.push("The kit family library is not an output folder");
  const prot = protectedList.filter((r) => r && isInside(target, norm(r, env)));
  if (prot.length) reasons.push(`Under a protected original: ${prot.join("; ")}`);
  const roots = [...(cfg.write_roots ?? []), ...(cfg.reports_dir ? [cfg.reports_dir] : [])].map((r) => norm(r, env)).filter(Boolean);
  if (!roots.some((r) => isInside(target, r))) reasons.push(`Not inside write_roots or reports_dir (${roots.join("; ") || "none configured"})`);
  return { ok: reasons.length === 0, folder: target, reasons };
}

export function safeName(title: string): string {
  const base = title.replace(/\.(rvt|rfa|e57|las|laz)$/i, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return (base || "model").slice(0, 60);
}

/** Writes a file next to its final name and renames it, never over an existing file. */
export function writeNew(target: string, data: Buffer): void {
  if (fs.existsSync(target)) throw new Error(`[FMC-POINTCLOUD-EXISTS] ${target} already exists. Nothing is overwritten.`);
  const partial = `${target}.partial`;
  fs.writeFileSync(partial, data, { flag: "wx" });
  fs.renameSync(partial, target);
}
