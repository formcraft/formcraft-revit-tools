/**
 * Low-RAM clash prefilter. Boxes are compared in chunks. Geometry for a solid test is never kept here.
 * The Revit command writes JSONL as it goes and reports the peak working set.
 * A link that is not open as its own document is still a source when it is loaded in the host.
 * A cache file is the fallback when the structural model is not linked. It is never written on D:.
 */
import fs from "node:fs";
import path from "node:path";

export interface Aabb {
  id: number;
  category: string;
  link?: string;
  min: number[];
  max: number[];
}

export interface ClashHit {
  a: number;
  b: number;
  category_a: string;
  category_b: string;
  link_a?: string;
  link_b?: string;
  overlap: boolean;
}

export function boxesOverlap(a: Aabb, b: Aabb, tolerance: number): boolean {
  if (a.min.length < 3 || b.min.length < 3 || a.max.length < 3 || b.max.length < 3) return false;
  return a.min[0] - tolerance <= b.max[0] && a.max[0] + tolerance >= b.min[0]
    && a.min[1] - tolerance <= b.max[1] && a.max[1] + tolerance >= b.min[1]
    && a.min[2] - tolerance <= b.max[2] && a.max[2] + tolerance >= b.min[2];
}

export interface ChunkScan {
  hits: ClashHit[];
  compared: number;
  chunks: number;
}

/**
 * Compare every left chunk with every right chunk. Only the two live chunks are required.
 * `left` and `right` may be the same list (a category against itself): an element is not paired with itself.
 */
export function scanChunks(left: Aabb[], right: Aabb[], chunk: number, tolerance: number, same = false): ChunkScan {
  const size = Math.max(1, Math.floor(chunk) || 1);
  const hits: ClashHit[] = [];
  let compared = 0;
  let chunks = 0;
  for (let i = 0; i < left.length; i += size) {
    const aChunk = left.slice(i, i + size);
    for (let j = same ? i : 0; j < right.length; j += size) {
      const bChunk = right.slice(j, j + size);
      chunks += 1;
      for (const a of aChunk) {
        for (const b of bChunk) {
          if (same && (a.id > b.id || (a.id === b.id && (a.link ?? "") >= (b.link ?? "")))) continue;
          if (a.id === b.id && (a.link ?? "") === (b.link ?? "")) continue;
          compared += 1;
          if (!boxesOverlap(a, b, tolerance)) continue;
          hits.push({
            a: a.id, b: b.id, category_a: a.category, category_b: b.category,
            ...(a.link ? { link_a: a.link } : {}),
            ...(b.link ? { link_b: b.link } : {}),
            overlap: true,
          });
        }
      }
    }
  }
  return { hits, compared, chunks };
}

export function summariseHits(hits: ClashHit[], sample: number): { count: number; ids: number[]; capped: boolean; by_pair: Record<string, number> } {
  const ids: number[] = [];
  const seen = new Set<number>();
  const by_pair: Record<string, number> = {};
  for (const hit of hits) {
    const key = `${hit.category_a}|${hit.category_b}`;
    by_pair[key] = (by_pair[key] ?? 0) + 1;
    for (const id of [hit.a, hit.b]) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (ids.length < sample) ids.push(id);
    }
  }
  return { count: hits.length, ids, capped: seen.size > ids.length, by_pair };
}

/** A link transform: origin plus the three basis vectors, in the same units as the boxes. */
export interface LinkTransform {
  origin: number[];
  x: number[];
  y: number[];
  z: number[];
}

/** Host point = origin + x * px + y * py + z * pz. */
export function transformPoint(point: number[], xform: LinkTransform): number[] {
  const px = point[0] ?? 0;
  const py = point[1] ?? 0;
  const pz = point[2] ?? 0;
  const at = (axis: number) => (xform.origin[axis] ?? 0)
    + (xform.x[axis] ?? 0) * px
    + (xform.y[axis] ?? 0) * py
    + (xform.z[axis] ?? 0) * pz;
  return [at(0), at(1), at(2)];
}

/**
 * Axis-aligned box of a transformed box. All eight corners are transformed.
 * Transforming only the min and max is wrong once the link is rotated.
 */
export function transformAabb(min: number[], max: number[], xform: LinkTransform): { min: number[]; max: number[] } {
  const xs = [min[0] ?? 0, max[0] ?? 0];
  const ys = [min[1] ?? 0, max[1] ?? 0];
  const zs = [min[2] ?? 0, max[2] ?? 0];
  let outMin = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  let outMax = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        const point = transformPoint([x, y, z], xform);
        outMin = outMin.map((value, axis) => Math.min(value, point[axis]));
        outMax = outMax.map((value, axis) => Math.max(value, point[axis]));
      }
    }
  }
  return { min: outMin, max: outMax };
}

export interface LinkRef {
  name: string;
  title?: string;
  path?: string;
  loaded: boolean;
}

/** The discipline token in F26901-FMC-ZZ-ZZ-M3-S-0001 is S. `_USER` is not part of it. */
export function modelRole(title: string): string {
  const file = title.split(/[\\/]/).pop() ?? title;
  const base = file.replace(/\.(rvt|rfa)$/i, "").replace(/_user$/i, "");
  const parts = base.split("-").filter(Boolean);
  return parts.length >= 6 ? parts[5].toUpperCase() : "";
}

/** A short key such as S matches the role. A longer key matches the title, the link name or the path. */
export function linkMatches(wanted: string, link: { name?: string; title?: string; path?: string }): boolean {
  const key = wanted.trim();
  if (!key) return false;
  const title = link.title ?? "";
  const name = link.name ?? "";
  const file = link.path ?? "";
  if (eq(title, key) || eq(name, key) || eq(file, key)) return true;
  const role = modelRole(title) || modelRole(name) || modelRole(file);
  if (key.length <= 3 && role && role === key.toUpperCase()) return true;
  if (key.length > 3) {
    const blob = `${title} ${name} ${file}`.toLowerCase();
    return blob.includes(key.toLowerCase());
  }
  return false;
}

function eq(value: string, key: string): boolean {
  return value.trim().length > 0 && value.trim().toLowerCase() === key.trim().toLowerCase();
}

export function resolveLinkRequest(wanted: string, links: LinkRef[]): { ok: true; loaded: LinkRef[]; unloaded: LinkRef[] } | { ok: false; code: "FMC-LINK-NOT-FOUND" | "FMC-LINK-NOT-LOADED"; message: string; unloaded: LinkRef[] } {
  const matches = links.filter((link) => linkMatches(wanted, link));
  if (!matches.length) {
    return { ok: false, code: "FMC-LINK-NOT-FOUND", message: `No link instance matches "${wanted}". The structural model does not have to be open, but it does have to be a link in this host.`, unloaded: [] };
  }
  const loaded = matches.filter((link) => link.loaded);
  const unloaded = matches.filter((link) => !link.loaded);
  if (!loaded.length) {
    return { ok: false, code: "FMC-LINK-NOT-LOADED", message: `Link "${wanted}" is in the host but it is not loaded. GetLinkDocument() is null. Nothing was scanned.`, unloaded };
  }
  return { ok: true, loaded, unloaded };
}

export interface CacheHeader {
  kind: "fmc_clash_cache";
  doc_title: string;
  path: string;
  saved_at: string;
  written_at: string;
  categories: string[];
  mesh_cap: number;
}

export interface CacheElement {
  id: number;
  unique_id: string;
  category: string;
  min: number[];
  max: number[];
  version?: string;
  /** Triangles. Each triangle is three points, and each point is x, y, z. Capped per element. */
  mesh?: number[][][];
}

export function onDriveD(file: string): boolean {
  return /^d:/i.test(file.trim().replace(/\//g, "\\"));
}

/** A cache write is refused on D: and on the source model path. */
export function refuseCacheWrite(file: string, sourcePath = ""): string | null {
  if (onDriveD(file)) return "FMC-CLASH-PATH: a clash cache is not written on D:.";
  if (sourcePath && eq(file, sourcePath)) return "FMC-CLASH-PATH: the cache is not written onto the source model.";
  if (sourcePath && onDriveD(sourcePath) && eq(file, sourcePath)) return "FMC-CLASH-PATH: the source model is not written.";
  return null;
}

export function cacheFileName(title: string, when = new Date()): string {
  const safe = title.replace(/[<>:"|?*\\/]/g, "_").replace(/\.rvt$/i, "").slice(0, 80) || "model";
  return `${safe}-${when.toISOString().replace(/[:.]/g, "-")}.json`;
}

export function writeClashCache(dir: string, header: CacheHeader, elements: CacheElement[], sourcePath = ""): string {
  const file = path.join(dir, cacheFileName(header.doc_title, new Date(header.written_at)));
  const refused = refuseCacheWrite(file, sourcePath) ?? refuseCacheWrite(dir, sourcePath);
  if (refused) throw new Error(refused);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ ...header, kind: "fmc_clash_cache" as const }), ...elements.map((element) => JSON.stringify(element))];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

export function readCacheHeader(file: string): CacheHeader {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, n).toString("utf8");
    const line = text.split(/\r?\n/, 1)[0] ?? "";
    const header = JSON.parse(line) as CacheHeader;
    if (header.kind !== "fmc_clash_cache") throw new Error("FMC-CLASH-CACHE: the file is not an fmc_clash cache.");
    return header;
  } finally {
    fs.closeSync(fd);
  }
}

export function readCacheLines(file: string): { header: CacheHeader; elements: CacheElement[] } {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("FMC-CLASH-CACHE: the cache file is empty.");
  const header = JSON.parse(lines[0]) as CacheHeader;
  if (header.kind !== "fmc_clash_cache") throw new Error("FMC-CLASH-CACHE: the file is not an fmc_clash cache.");
  const elements = lines.slice(1).map((line) => JSON.parse(line) as CacheElement);
  return { header, elements };
}

export function cacheStatus(header: CacheHeader, now: number, sourceMtimeMs: number | null): { age_ms: number; stale: boolean; warning: string | null } {
  const written = Date.parse(header.written_at);
  const age = Number.isFinite(written) ? Math.max(0, now - written) : 0;
  if (sourceMtimeMs == null) {
    return { age_ms: age, stale: false, warning: header.path ? "The source file could not be read, so staleness was not checked." : null };
  }
  if (Number.isFinite(written) && sourceMtimeMs > written) {
    return { age_ms: age, stale: true, warning: "STALE: the source file is newer than this cache." };
  }
  return { age_ms: age, stale: false, warning: null };
}

export function findCacheByTitle(dir: string, title: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const want = title.replace(/\.rvt$/i, "").replace(/_user$/i, "").toLowerCase();
  const files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".json") && name.toLowerCase().includes(want)).sort();
  if (!files.length) return null;
  return path.join(dir, files[files.length - 1]);
}
