import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RoomRead } from "./casework_place.js";

/**
 * Saved inputs by run id, so a caller can pass `run_id` instead of sending the run, the unit list and the standards
 * again. Kept in %APPDATA%\Formcraft\casework\runs (one small JSON per call), never next to the pack files, so the
 * pack's byte-for-byte "unchanged" check is not affected. Old entries are pruned (30 days, at most 500 files).
 */

export const RUN_ID_RE = /^CW-\d{8}T\d{6}-[0-9a-f]{6}(-[A-C])?$/;
const KEEP_DAYS = 30;
const KEEP_FILES = 500;
/** A room read is reused for this long when a call names the run that read it (check → place) */
export const ROOM_CACHE_MS = 10 * 60 * 1000;

export interface RoomCache { room: string; at: string; read: RoomRead }

export interface StoredRun {
  id: string;
  at: string;
  action: string;
  run?: unknown;
  units?: unknown;
  standards?: Record<string, unknown>;
  /** The last room read along this chain of calls (check and place reuse it) */
  room_read?: RoomCache;
  /** options: which option of which call this is */
  option?: { of: string; name: string };
}

export function storeDir(override?: string): string {
  if (override) return override;
  if (process.env.FMC_CASEWORK_RUNS) return process.env.FMC_CASEWORK_RUNS;
  return path.join(process.env.APPDATA || os.homedir(), "Formcraft", "casework", "runs");
}

/** A saved run, or why there is none. The id is checked before it touches a path. */
export function loadRun(id: string, dir?: string): { run: StoredRun } | { problem: string } {
  const key = id.trim();
  if (!RUN_ID_RE.test(key)) return { problem: `${key} isn't a casework run id (CW-<date>T<time>-<6 hex>, from a reply)` };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(storeDir(dir), `${key}.json`), "utf8")) as StoredRun;
    if (j.id !== key) return { problem: `The saved run ${key} doesn't match its file` };
    return { run: j };
  } catch {
    return { problem: `No saved run ${key} (runs are kept ${KEEP_DAYS} days on this PC)` };
  }
}

/** Saves a call's inputs; never blocks the call (returns false when it couldn't). */
export function saveRun(entry: StoredRun, dir?: string): boolean {
  if (!RUN_ID_RE.test(entry.id)) return false;
  try {
    const d = storeDir(dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${entry.id}.json`), JSON.stringify(entry));
    prune(d);
    return true;
  } catch {
    return false;
  }
}

function prune(d: string, now = Date.now()) {
  const files = fs.readdirSync(d).filter((f) => f.endsWith(".json") && RUN_ID_RE.test(f.slice(0, -5)))
    .map((f) => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  files.forEach((x, i) => {
    if (i >= KEEP_FILES || now - x.t > KEEP_DAYS * 86400000) { try { fs.rmSync(path.join(d, x.f), { force: true }); } catch { /* next time */ } }
  });
}

/** A cached room read that may stand in for a new one: the same room, young enough. */
export function usableRoom(cache: RoomCache | undefined, room: string, now = Date.now()): RoomCache | null {
  if (!cache || cache.room.trim().toLowerCase() !== room.trim().toLowerCase()) return null;
  const age = now - Date.parse(cache.at);
  return age >= 0 && age <= ROOM_CACHE_MS ? cache : null;
}
