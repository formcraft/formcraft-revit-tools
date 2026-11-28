/**
 * Coordination transforms. Row-major 4×4, column vectors, translation in millimetres in the last column.
 * The upper 3×3 is the local axes. angle_deg is the plan angle of local X: atan2(m[1][0], m[0][0]).
 * compose(a, b) applies a, then b.
 */

export type Vec3 = [number, number, number];
export type Mat4 = [Vec3 & number[], Vec3 & number[], Vec3 & number[], Vec3 & number[]];

export const MM_DIGITS = 3;

export type CoordStatus = "PASS" | "FAIL" | "PROVISIONAL" | "UNKNOWN";

export interface Tolerance {
  value: number | null;
  /** null is UNKNOWN. provisional never PASS. draft or approved needs a clause before it can PASS. */
  status: string | null;
  clause: string | null;
  unit?: string | null;
}

export function identity(): number[][] {
  return [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
}

export function isMat4(value: unknown): value is number[][] {
  if (!Array.isArray(value) || value.length !== 4) return false;
  return value.every((row) => Array.isArray(row) && row.length === 4 && row.every((n) => typeof n === "number" && Number.isFinite(n)));
}

/** Z rotation in degrees, then translation in millimetres (last column). */
export function fromAngleMm(tx: number, ty: number, tz: number, angleDeg: number): number[][] {
  const r = (angleDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [c, -s, 0, tx],
    [s, c, 0, ty],
    [0, 0, 1, tz],
    [0, 0, 0, 1],
  ];
}

export function translationOf(m: number[][]): Vec3 {
  return [m[0][3], m[1][3], m[2][3]];
}

/** Plan angle of local X, in degrees, in (-180, 180]. */
export function angleDegOf(m: number[][]): number {
  const deg = (Math.atan2(m[1][0], m[0][0]) * 180) / Math.PI;
  if (Object.is(deg, -0)) return 0;
  return deg;
}

export function multiply(a: number[][], b: number[][]): number[][] {
  const out = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[i][k] * b[k][j];
      out[i][j] = sum;
    }
  }
  return out;
}

/** Apply a, then b. */
export function compose(a: number[][], b: number[][]): number[][] {
  return multiply(b, a);
}

/** Inverse of an invertible 4×4. A singular matrix is FMC-COORD-SINGULAR. */
export function invert(m: number[][]): number[][] {
  const a = [0, 1, 2, 3].map((i) => [
    m[i][0], m[i][1], m[i][2], m[i][3],
    i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0, i === 3 ? 1 : 0,
  ]);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let row = col + 1; row < 4; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error("[FMC-COORD-SINGULAR] That transform has no inverse.");
    if (pivot !== col) {
      const swap = a[col];
      a[col] = a[pivot];
      a[pivot] = swap;
    }
    const div = a[col][col];
    for (let c = 0; c < 8; c++) a[col][c] /= div;
    for (let row = 0; row < 4; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let c = 0; c < 8; c++) a[row][c] -= factor * a[col][c];
    }
  }
  return a.map((row) => [row[4], row[5], row[6], row[7]]);
}

/** Round the translation column to this many decimal places. 3 is 0.001 mm. Rotation is left as it is. */
export function roundMm(m: number[][], digits = MM_DIGITS): number[][] {
  const scale = 10 ** digits;
  const r = (n: number) => Math.round(n * scale) / scale;
  return [
    [m[0][0], m[0][1], m[0][2], r(m[0][3])],
    [m[1][0], m[1][1], m[1][2], r(m[1][3])],
    [m[2][0], m[2][1], m[2][2], r(m[2][3])],
    [m[3][0], m[3][1], m[3][2], m[3][3]],
  ];
}

export function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return Math.abs(d);
}

export interface Delta {
  delta_mm: number;
  delta_deg: number;
  dxyz_mm: Vec3;
}

/** How far `to` is from `from`: translation length in mm, and the absolute plan-angle change in degrees. */
export function deltaOf(from: number[][], to: number[][]): Delta {
  const a = translationOf(from);
  const b = translationOf(to);
  const dxyz: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  return {
    delta_mm: Math.hypot(dxyz[0], dxyz[1], dxyz[2]),
    delta_deg: angDiff(angleDegOf(to), angleDegOf(from)),
    dxyz_mm: dxyz,
  };
}

/**
 * Navisworks row-vector 4×4: upper 3×3 is R transposed, translation is the last row.
 * The record and Blender keep translation in the last column.
 */
export function rowVectorMatrix(m: number[][]): number[][] {
  return [
    [m[0][0], m[1][0], m[2][0], 0],
    [m[0][1], m[1][1], m[2][1], 0],
    [m[0][2], m[1][2], m[2][2], 0],
    [m[0][3], m[1][3], m[2][3], 1],
  ];
}

/** A standards entry. A missing entry, or status null, is an unknown tolerance. */
export function asTolerance(raw: unknown): Tolerance {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: null, status: null, clause: null };
  const row = raw as Record<string, unknown>;
  const value = typeof row.value === "number" && Number.isFinite(row.value) ? row.value : null;
  const status = row.status == null ? null : String(row.status);
  const clause = row.clause == null ? null : String(row.clause);
  const unit = row.unit == null ? null : String(row.unit);
  return { value, status, clause, unit };
}

/**
 * provisional never PASS (a miss is still FAIL).
 * draft or approved can PASS only with a clause.
 * null, or any other status, is UNKNOWN. A miss against a known number is still FAIL for draft and approved.
 */
export function judge(measured: number, tol: Tolerance): CoordStatus {
  const status = tol.status == null ? null : tol.status.trim().toLowerCase();
  if (status == null || status === "" || status === "null" || tol.value == null || !Number.isFinite(measured)) return "UNKNOWN";
  const within = Math.abs(measured) <= tol.value + 1e-9;
  if (status === "provisional") return within ? "PROVISIONAL" : "FAIL";
  const cited = (tol.clause ?? "").trim().length > 0;
  if (status === "draft" || status === "approved") {
    if (!within) return "FAIL";
    return cited ? "PASS" : "UNKNOWN";
  }
  return "UNKNOWN";
}

export function combineStatus(a: CoordStatus, b: CoordStatus): CoordStatus {
  if (a === "FAIL" || b === "FAIL") return "FAIL";
  if (a === "UNKNOWN" || b === "UNKNOWN") return "UNKNOWN";
  if (a === "PROVISIONAL" || b === "PROVISIONAL") return "PROVISIONAL";
  return "PASS";
}
