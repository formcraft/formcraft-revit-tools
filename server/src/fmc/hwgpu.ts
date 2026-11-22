/**
 * Sampling kernels that can run on the CPU, and on a GPU only when an optional library is present
 * and its result matches the CPU kernel.
 *
 * Revit's model database, regeneration, transactions and API calls are not in this file.
 * They stay on the CPU and in system RAM. These kernels are plugin-side numbers: point distance,
 * axis-aligned clash, and a ray through a box (the voxel / pressure sample).
 */

export type GpuBackendId = "cpu" | "directml" | "directcompute";

export interface GpuRunner {
  id: "directml" | "directcompute";
  available: boolean;
  detail: string;
  /** Return the same value the CPU kernel produced, or null to refuse. A mismatch is discarded. */
  run(kind: string, cpuResult: unknown): unknown | null;
}

export interface JobRun<T> {
  kind: string;
  backend: GpuBackendId;
  result: T;
  /** Set when the GPU was not used. The result is always the CPU kernel. */
  fallback: string | null;
  moved_to_gpu: boolean;
}

export function pointBoxDistanceMm(point: number[], box: number[]): number {
  if (point.length < 3 || box.length < 6) return Number.POSITIVE_INFINITY;
  const dx = point[0] < box[0] ? box[0] - point[0] : point[0] > box[3] ? point[0] - box[3] : 0;
  const dy = point[1] < box[1] ? box[1] - point[1] : point[1] > box[4] ? point[1] - box[4] : 0;
  const dz = point[2] < box[2] ? box[2] - point[2] : point[2] > box[5] ? point[2] - box[5] : 0;
  return Math.hypot(dx, dy, dz);
}

/** True when the point is within radius of x,y,z. Same test the trace spatial index uses. */
export function hypotWithin(x: number, y: number, z: number, px: number, py: number, pz: number, radius: number): boolean {
  return Math.hypot(px - x, py - y, pz - z) <= radius;
}

export function aabbOverlap(a: number[], b: number[]): boolean {
  if (a.length < 6 || b.length < 6) return false;
  return a[0] <= b[3] && a[3] >= b[0] && a[1] <= b[4] && a[4] >= b[1] && a[2] <= b[5] && a[5] >= b[2];
}

/** Pairs of box indexes that overlap. Order is ascending and stable. */
export function clashPairs(boxes: number[][]): Array<[number, number]> {
  const hits: Array<[number, number]> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (aabbOverlap(boxes[i], boxes[j])) hits.push([i, j]);
    }
  }
  return hits;
}

/** Slab test. A ray that starts inside the box counts as a hit. */
export function rayHitsAabb(origin: number[], direction: number[], box: number[]): boolean {
  if (origin.length < 3 || direction.length < 3 || box.length < 6) return false;
  let tmin = 0;
  let tmax = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const min = box[i];
    const max = box[i + 3];
    const o = origin[i];
    const d = direction[i];
    if (Math.abs(d) < 1e-12) {
      if (o < min || o > max) return false;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return tmax >= 0;
}

export interface Ray {
  origin: number[];
  direction: number[];
}

/** How many ray/box pairs meet. This is the pressure-test sample. It does not read a Revit model. */
export function rayVoxelHits(rays: Ray[], boxes: number[][]): number {
  let hits = 0;
  for (const ray of rays) {
    for (const box of boxes) if (rayHitsAabb(ray.origin, ray.direction, box)) hits++;
  }
  return hits;
}

/** Distances from each point to the nearest other point. A single point is an empty list. */
export function nearestPointMm(points: number[][]): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < points.length; j++) {
      if (i === j || points[i].length < 3 || points[j].length < 3) continue;
      const d = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1], points[i][2] - points[j][2]);
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) out.push(Math.round(best * 1000) / 1000);
  }
  return out;
}

function sameResult(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Run the CPU kernel. Use the GPU runner only when the capability check passed and the runner
 * returns the same JSON as the CPU. Any other outcome keeps the CPU result.
 */
export function dispatchJob<T>(kind: string, cpu: () => T, runner: GpuRunner | null, useGpu: boolean): JobRun<T> {
  const result = cpu();
  if (!useGpu) {
    return { kind, backend: "cpu", result, fallback: "No dedicated GPU passed the capability check, so the CPU kernel ran.", moved_to_gpu: false };
  }
  if (!runner?.available) {
    return {
      kind, backend: "cpu", result, moved_to_gpu: false,
      fallback: runner?.detail || "No optional GPU library is loaded (onnxruntime-node DirectML, or Formcraft.Gpu.dll). The CPU kernel ran.",
    };
  }
  try {
    const gpu = runner.run(kind, result);
    if (gpu == null) {
      return { kind, backend: "cpu", result, moved_to_gpu: false, fallback: `${runner.id} declined ${kind}. The CPU kernel ran.` };
    }
    if (!sameResult(gpu, result)) {
      return {
        kind, backend: "cpu", result, moved_to_gpu: false,
        fallback: `${runner.id} did not match the CPU kernel for ${kind}. The GPU numbers were discarded.`,
      };
    }
    return { kind, backend: runner.id, result, fallback: null, moved_to_gpu: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind, backend: "cpu", result, moved_to_gpu: false, fallback: `${runner.id} failed (${message}). The CPU kernel ran.` };
  }
}

/** Optional DirectML. Missing package is the normal case and is not an error. */
export async function probeDirectMl(): Promise<GpuRunner | null> {
  try {
    const moduleName = "onnxruntime-node";
    const ort = await import(moduleName) as { listSupportedBackends?: () => string[] };
    const backends = typeof ort.listSupportedBackends === "function" ? ort.listSupportedBackends() : [];
    const dml = backends.some((name) => /dml|directml/i.test(String(name)));
    if (!dml) {
      return { id: "directml", available: false, detail: "onnxruntime-node is installed without a DirectML provider.", run: () => null };
    }
    return {
      id: "directml",
      available: false,
      detail: "DirectML is listed, but this build has no ONNX model for these kernels. The CPU kernel runs, and the result is checked against it before a GPU answer would be kept.",
      run: () => null,
    };
  } catch {
    return null;
  }
}
