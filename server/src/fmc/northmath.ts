/**
 * True-north maths for fmc_north. fmc_coord still owns the coordination record and may move the survey.
 * This module only measures angles. Nothing here calls SetProjectPosition or acquires coordinates.
 *
 * ProjectPosition.Angle is radians, counterclockwise from project north to true north (the same reading
 * fmc_links and fmc_coord publish). Crop basis X is the crop box X axis, counterclockwise from project X.
 * A north arrow whose symbol points up the sheet at rotation 0 then sits at projectAngle − cropBasisX.
 */
import { angDiff } from "./coordmath.js";

export interface Vec3 { x: number; y: number; z: number }

export function wrap180(deg: number): number {
  if (!Number.isFinite(deg)) return deg;
  let x = deg % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  if (Object.is(x, -0)) return 0;
  return x;
}

/** Undirected axis, folded into (-45, 45]. 90° and 180° are the same building axes as 0°. */
export function toAxisDeg(deg: number): number {
  if (!Number.isFinite(deg)) return deg;
  let x = deg % 90;
  if (x <= -45) x += 90;
  else if (x > 45) x -= 90;
  if (x <= -45) x += 90;
  if (Object.is(x, -0)) return 0;
  return x;
}

export function axisDistance(a: number, b: number): number {
  return Math.abs(toAxisDeg(a - b));
}

/** Circular mean on the 90° axis. 15° and 105° average to 15°. */
export function axisMean(angles: number[]): number {
  const finite = angles.filter((n) => Number.isFinite(n));
  if (!finite.length) return NaN;
  const scale = (4 * Math.PI) / 180;
  let s = 0;
  let c = 0;
  for (const a of finite) {
    const t = a * scale;
    s += Math.sin(t);
    c += Math.cos(t);
  }
  if (Math.hypot(s, c) < 1e-12) return 0;
  return toAxisDeg(Math.atan2(s, c) / scale);
}

export interface DominantAxis {
  angle_deg: number;
  count: number;
  spread_deg: number;
  tied: boolean;
  clusters: number;
}

/** Largest cluster of grid directions, within tolerance degrees on the 90° axis. */
export function dominantAxis(angles: number[], tolerance = 2): DominantAxis | null {
  const finite = angles.filter((n) => Number.isFinite(n));
  if (!finite.length) return null;
  const used = new Array(finite.length).fill(false);
  const clusters: number[][] = [];
  for (let i = 0; i < finite.length; i++) {
    if (used[i]) continue;
    const group = [finite[i]];
    used[i] = true;
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < finite.length; j++) {
        if (used[j]) continue;
        if (group.some((g) => axisDistance(g, finite[j]) <= tolerance + 1e-9)) {
          used[j] = true;
          group.push(finite[j]);
          grew = true;
        }
      }
    }
    clusters.push(group);
  }
  const scored = clusters.map((group) => ({ group, angle: axisMean(group) }));
  scored.sort((a, b) => b.group.length - a.group.length || Math.abs(a.angle) - Math.abs(b.angle));
  const best = scored[0];
  const spread = Math.max(...best.group.map((a) => axisDistance(a, best.angle)));
  return {
    angle_deg: round6(best.angle),
    count: best.group.length,
    spread_deg: round6(spread),
    tied: scored.length > 1 && scored[1].group.length === best.group.length,
    clusters: scored.length,
  };
}

/** Leading letters of a grid name: BQ1 and BQ-1 are BQ, BQA stays BQA, 12 is #. */
export function gridSetKey(name: string): string {
  const m = name.trim().match(/^([A-Za-z]+?)(?=\d|[^A-Za-z]|$)/);
  if (!m?.[1]) return "#";
  return m[1].toUpperCase();
}

/** grid_set BQ matches BQ1 and BQ-A. It does not match BQA. */
export function gridInSet(name: string, setName: string): boolean {
  const n = name.trim().toLowerCase();
  const s = setName.trim().toLowerCase();
  if (!s || !n.startsWith(s)) return false;
  const next = n.charAt(s.length);
  return next === "" || !/[a-z]/.test(next);
}

/**
 * Degrees counterclockwise from the view's up to true north.
 * That is the sheet rotation of a north arrow that points up at rotation 0.
 * cropBasisXDeg is the crop box X axis from project X. The True North view setting is already in that basis.
 */
export function arrowRotationDeg(projectAngleDeg: number, cropBasisXDeg: number, arrowZeroDeg = 0): number {
  return wrap180(projectAngleDeg - cropBasisXDeg + arrowZeroDeg);
}

export function viewRotationVsTrueNorthDeg(projectAngleDeg: number, cropBasisXDeg: number): number {
  return arrowRotationDeg(projectAngleDeg, cropBasisXDeg, 0);
}

/** Smallest crop rotation, in (-45, 45], that puts the crop axes on the grid axes. */
export function rotationToGrid(cropBasisXDeg: number, gridAngleDeg: number): number {
  return toAxisDeg(gridAngleDeg - cropBasisXDeg);
}

export function surveyDeltaMm(a: Vec3, b: Vec3): { delta_mm: number; dxyz: Vec3 } {
  const dxyz = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  return { delta_mm: Math.hypot(dxyz.x, dxyz.y, dxyz.z), dxyz };
}

export function anglesDisagree(a: number, b: number, tolDeg: number): { delta_deg: number; mismatch: boolean } {
  const delta_deg = angDiff(a, b);
  return { delta_deg, mismatch: delta_deg > tolDeg + 1e-9 };
}

/** Host shared direction of the link's project X, compared with the link's own shared direction. */
export function linkAngleDelta(hostAngleDeg: number, linkBasisXDeg: number, linkAngleDeg: number): number {
  return angDiff(hostAngleDeg + linkBasisXDeg, linkAngleDeg);
}

export function orientationKind(value: string | null | undefined): "project_north" | "true_north" | "unknown" {
  const s = (value ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s === "1" || s.includes("true")) return "true_north";
  if (s === "0" || s.includes("project")) return "project_north";
  return "unknown";
}

export function distanceToRect(x: number, y: number, minX: number, minY: number, maxX: number, maxY: number): number {
  const loX = Math.min(minX, maxX);
  const hiX = Math.max(minX, maxX);
  const loY = Math.min(minY, maxY);
  const hiY = Math.max(minY, maxY);
  const dx = x < loX ? loX - x : x > hiX ? x - hiX : 0;
  const dy = y < loY ? loY - y : y > hiY ? y - hiY : 0;
  return Math.hypot(dx, dy);
}

export function round6(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e6) / 1e6;
}

export function round3(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e3) / 1e3;
}

/** File name role: F26901-FMC-ZZ-ZZ-M3-A-0002_USER → A. */
export function roleOf(title: string): string {
  const base = title.split(/[\\/]/).pop() ?? title;
  const stem = base.replace(/\.(rvt|rfa|rte)$/i, "").replace(/_user$/i, "");
  const parts = stem.split("-");
  if (parts.length >= 6 && /^[A-Za-z]{1,3}$/.test(parts[5])) return parts[5].toUpperCase();
  return "";
}

export const NORTH_FIX: Record<string, string> = {
  "FMC-NORTH-ANGLE-MISMATCH": "The project-north to true-north angles differ. Do not call SetProjectPosition. Agree the angle, then publish it with fmc_coord. fmc_north only reports.",
  "FMC-NORTH-SURVEY-MISMATCH": "The survey points differ by more than the tolerance. Do not acquire coordinates. Agree the survey point, then publish it with fmc_coord.",
  "FMC-NORTH-LINK-UNLOADED": "The link is not loaded, so its site was not read. Load it and run compare again. This tool will not acquire coordinates.",
  "FMC-NORTH-CROP-NOT-FOUND": "Revit returned no crop region element. There is no public CropRegion class. Turn the crop on, or use mode scope_box with a scope box that already exists.",
  "FMC-NORTH-VIEW-NOT-PLAN": "Only plan views are rotated. This view is not a plan.",
  "FMC-NORTH-VIEW-NONE": "Name the plan views, or pass grid_set so plan views whose names contain that set are used.",
  "FMC-NORTH-GRID-NONE": "No straight grids matched. Pass grid_set, grid_names or grid_ids.",
  "FMC-NORTH-ARROW-UNMATCHED": "No north-arrow instance of that family sits on the sheet near this viewport, and none matched the parameter. Place one on the sheet, or set match_param.",
  "FMC-NORTH-ARROW-AMBIGUOUS": "More than one arrow of that family sits near this viewport. Pass the element id, or move the others away.",
  "FMC-NORTH-ARROW-IN-VIEW": "That arrow is in the model view, not on the sheet. A model arrow turns with the crop. Place the symbol on the sheet.",
  "FMC-NORTH-VIEWPORT-SHIFT": "The viewport centre moved when the crop rotated. The centre is put back when Revit allows SetBoxCenter, and the shift is still reported.",
  "FMC-NORTH-SCOPE-REQUIRED": "mode scope_box needs scope_box, the name or id of a scope box that already exists. This tool does not create one and does not change project north.",
  "FMC-NORTH-SCOPE-SHARED": "Rotating this scope box turns every view that uses it.",
  "FMC-NORTH-PINNED": "The element is pinned. Unpin it in Revit. This tool does not unpin it.",
  "FMC-BATCH-LOCKED": "Request a lease with fmc_batch. Pass batch_lease, and references.kit, references.standards and references.rulebook.",
  "FMC-NORTH-REFERENCES": "A write needs references.kit, references.standards and references.rulebook, each with one id.",
  "FMC-NORTH-GUARD": "This file is protected, a central, or HEBERT HOSTELS. Nothing was written.",
  "FMC-NORTH-PLAN": "There is nothing to apply. Run the dry run and pass a view set that resolves.",
  "FMC-DOC-REQUIRED": "Pass document, a title or a full path. The active document is not used.",
};
