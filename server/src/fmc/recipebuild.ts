/**
 * Recipe builds that finish (F-029, F-038, F-040). Pure helpers for fmc_recipe build; the tool is in tools/fmc_recipe_build.ts.
 *
 * F-029, the cause: the add-in reads each request with one 8 KB socket read and parses that read as a whole JSON-RPC
 * message (plugin/Core/SocketService.cs). A recipe's ops sent as one fmc_doc_apply call are 23-44 KB (the LOD 400 doors
 * and windows), so Revit only ever saw a broken first 8 KB, answered "Invalid JSON" with no request id, and the apply
 * never started: "no answer after 300 s", the template left open. Until the bridge reads whole messages, a call must
 * stay under BRIDGE_LIMIT_BYTES; stepwise builds send the ops in chunks that do.
 *
 * Build records (FMC_Recipe_Builds.json) and per-op progress (written by the add-in) are this PR's own small job
 * record. They move to the job model (fmc_job) once both are merged.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const win = path.win32;

/** What the add-in's socket takes in one read (plugin/Core/SocketService.cs: byte[8192]). */
export const BRIDGE_LIMIT_BYTES = 8192;
/** A chunk's request stays under this, leaving room for the session, the shared parameter file and the server's own fields. */
export const CHUNK_BYTES = 6000;
export const DEFAULT_CHUNK_OPS = 20;

/** The bytes of one JSON-RPC request as the server writes it to the socket. */
export function requestBytes(method: string, params: unknown): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method, params, id: "1760000000000123456" }), "utf8");
}

/** The fields an fmc_doc_apply request carries besides the ops (for sizing). */
export function applyEnvelope(session: string, sharedParameterFile: string) {
  return { session, ops: [] as unknown[], dry_run: true, shared_parameter_file: sharedParameterFile, document: { title: "x".repeat(40), path: "x".repeat(120) } };
}

export interface Chunk { from: number; to: number }

/**
 * Splits the ops into chunks of at most maxOps ops whose request stays under maxBytes. Ops are numbered from 1.
 * An op that can't fit in a request on its own is listed in tooBig (it can't reach Revit until the bridge is fixed).
 */
export function planChunks(ops: unknown[], maxOps = DEFAULT_CHUNK_OPS, maxBytes = CHUNK_BYTES, envelopeBytes = 400): { chunks: Chunk[]; tooBig: Array<{ op: number; bytes: number }> } {
  const chunks: Chunk[] = [];
  const tooBig: Array<{ op: number; bytes: number }> = [];
  let from = 0, bytes = envelopeBytes;
  const close = (to: number) => { if (from) chunks.push({ from, to }); from = 0; bytes = envelopeBytes; };
  ops.forEach((o, i) => {
    const n = i + 1, size = Buffer.byteLength(JSON.stringify(o), "utf8") + 1;
    if (envelopeBytes + size > maxBytes) { close(n - 1); tooBig.push({ op: n, bytes: envelopeBytes + size }); chunks.push({ from: n, to: n }); return; }
    if (from && (bytes + size > maxBytes || n - from + 1 > maxOps)) close(n - 1);
    if (!from) from = n;
    bytes += size;
  });
  close(ops.length);
  return { chunks, tooBig };
}

export function opsHash(ops: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(ops)).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- per-op progress (written by the add-in)

/** %APPDATA%\Formcraft\Progress\fmc_doc_<session>.json: FmcDocProgress.cs writes it before every op and when the batch ends. */
export function progressPath(session: string, appData = process.env.APPDATA || ""): string {
  return path.join(appData, "Formcraft", "Progress", `fmc_doc_${session.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export interface ApplyProgress {
  session?: string; state?: "running" | "finished" | "failed"; started?: string; updated?: string;
  ops_total?: number; op?: number; kind?: string; name?: string; done?: number; error?: string;
  result?: { created?: number; updated?: number; skipped?: number; warnings?: number };
}

export function readProgress(file: string): ApplyProgress | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return null; }
}

/**
 * Where an apply that didn't answer stopped, in words, with ops numbered in the whole recipe (offset = the chunk's
 * first op - 1). Progress older than the call (sentAt) belongs to an earlier call and is ignored.
 */
export function stoppedAt(p: ApplyProgress | null, offset = 0, sentAt?: string): { op: number | null; text: string } {
  const fresh = p && (!sentAt || !p.started || Date.parse(p.started) >= Date.parse(sentAt) - 5000) ? p : null;
  if (!fresh) return { op: null, text: "Revit never started the batch: no progress was recorded for this call (the request didn't reach the handler, or Revit was held by a dialog)" };
  if (fresh.state === "finished") return { op: null, text: `Revit finished the batch (${fresh.ops_total ?? "?"} ops) after the server stopped waiting` };
  if (fresh.state === "failed") return { op: fresh.op ? fresh.op + offset : null, text: `op ${(fresh.op ?? 0) + offset} (${fresh.kind ?? ""} ${fresh.name ?? ""}) failed: ${fresh.error ?? ""}`.trim() };
  if (!fresh.op) return { op: offset + 1, text: `The batch reached Revit but stopped before op ${offset + 1}` };
  return { op: fresh.op + offset, text: `Revit started op ${fresh.op + offset} (${fresh.kind ?? ""} ${fresh.name ?? ""}) and hadn't finished it; ${(fresh.done ?? fresh.op - 1)} ops before it were done${fresh.updated ? ` (last progress ${fresh.updated})` : ""}` };
}

/** "op 12 failed, nothing was changed: …" from the add-in, renumbered to the whole recipe. */
export function renumberOpError(message: string, offset: number): { op: number | null; text: string } {
  const m = /\bop (\d+) failed/.exec(message);
  if (!m) return { op: null, text: message };
  const op = Number(m[1]) + offset;
  return { op, text: message.replace(/\bop \d+ failed/, `op ${op} failed`) };
}

/** The server gave up waiting but Revit may still be working (the soft timeout, F-022). */
export const isStillQueued = (msg: string) => /hasn't answered .* in \d+ s/.test(msg);
/** No answer at all within the hard timeout. */
export const isNoAnswer = (msg: string) => /timed out after|no answer after|timed out$/.test(msg);
export const isSessionGone = (msg: string) => /No open session/.test(msg);

// ---------------------------------------------------------------- build records (until fmc_job)

export interface ChunkRecord {
  from: number; to: number; state: "sent" | "done" | "failed" | "no answer" | "running in Revit";
  sent_at?: string; ms?: number; created?: number; updated?: number; skipped?: number; warnings?: number; replay?: boolean; error?: string;
}

export interface BuildRecord {
  id: string; family: string; recipe_file: string; template: string; dry_run: boolean; stepwise: boolean; chunk_size: number;
  ops_total: number; ops_hash: string; session: string; sessions: string[]; started: string; updated: string;
  state: "running" | "waiting" | "failed" | "dry run done" | "built";
  /** The last op whose chunk Revit committed in the open session (0 = none). */
  last_good_op: number;
  /** Hash of ops 1..last_good_op, so a resume refuses when those ops changed. */
  good_hash: string;
  chunks: ChunkRecord[];
  failed_op?: { op: number | null; text: string };
  result?: unknown;
  /** F-045: what the build's own flex said about labelled dimension sides (recipes.ts RecordedSides), for a later gate. */
  sides?: { at: string; dimension_sides: { checked: number; unrecorded: number }; wrong: Array<{ type: string; a: string; b: string; label?: string; axis: string; drawn: number; now_mm: number }> } | null;
}

export function buildsFile(reportsDir: string) { return path.join(reportsDir, "FMC_Recipe_Builds.json"); }

export function readBuilds(reportsDir: string): Record<string, BuildRecord> {
  try { return JSON.parse(fs.readFileSync(buildsFile(reportsDir), "utf8")); } catch { return {}; }
}

export function writeBuild(reportsDir: string, rec: BuildRecord) {
  try {
    const all = readBuilds(reportsDir);
    rec.updated = new Date().toISOString();
    all[rec.family] = rec;
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(buildsFile(reportsDir), JSON.stringify(all, null, 2));
  } catch {
    // the record helps a resume; the build itself goes on
  }
}

// ---------------------------------------------------------------- template planes (F-038)

/**
 * The named reference planes (and the level) each family template starts with, so a recipe that uses them isn't told
 * they're "not made earlier". The table is the fallback; the planes read from the template the first time a build
 * opens it (FMC_Template_Planes.json) take over. In Metric Door.rft the plane named Exterior sits at +75 mm Y and
 * Interior at -75 mm (the template's 150 mm host wall), so exterior is +y there, not -y.
 */
export const TEMPLATE_PLANES: Record<string, string[]> = {
  "metric door.rft": ["Center (Left/Right)", "Center (Front/Back)", "Left", "Right", "Exterior", "Interior", "Head", "Ref. Level"],
  "metric window.rft": ["Center (Left/Right)", "Center (Front/Back)", "Left", "Right", "Exterior", "Interior", "Head", "Sill", "Ref. Level"],
  "metric generic model.rft": ["Center (Left/Right)", "Center (Front/Back)", "Ref. Level"],
  "metric profile.rft": ["Center (Left/Right)", "Center (Front/Back)"],
  // the plant recipes (docs/RECIPES.md, Planting forms); a build's own read of the template takes over
  "metric planting.rft": ["Center (Left/Right)", "Center (Front/Back)", "Ref. Level"],
};
const ALWAYS = ["Center (Left/Right)", "Center (Front/Back)", "Ref. Level"];

export function templatePlanesFile(reportsDir: string) { return path.join(reportsDir, "FMC_Template_Planes.json"); }

export function templatePlanes(template: string, reportsDir?: string): { planes: string[]; source: string } {
  const key = win.basename(template).toLowerCase();
  if (reportsDir) {
    try {
      const cache = JSON.parse(fs.readFileSync(templatePlanesFile(reportsDir), "utf8"));
      if (Array.isArray(cache[key]?.planes)) return { planes: [...new Set([...ALWAYS, ...cache[key].planes])], source: `read from ${win.basename(template)} on ${cache[key].read ?? "first use"}` };
    } catch { /* no cache yet */ }
  }
  if (TEMPLATE_PLANES[key]) return { planes: TEMPLATE_PLANES[key], source: `the table of ${win.basename(template)}'s planes` };
  return { planes: ALWAYS, source: `${win.basename(template) || "this template"} isn't in the table: only the centre planes and Ref. Level are assumed` };
}

/** Keeps the planes a template showed when a build opened it (fmc_doc open's reference_planes). */
export function rememberTemplatePlanes(reportsDir: string, template: string, planes: unknown) {
  if (!Array.isArray(planes) || !planes.length) return;
  try {
    const file = templatePlanesFile(reportsDir);
    let cache: Record<string, unknown> = {};
    try { cache = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* new */ }
    cache[win.basename(template).toLowerCase()] = { planes: planes.map(String), read: new Date().toISOString().slice(0, 10) };
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2));
  } catch {
    // the table still answers
  }
}

/** Drops "not made earlier" notes about planes the template already has. */
export function dropTemplateNotes(notes: string[], planes: string[]): { notes: string[]; dropped: number } {
  const have = new Set(planes);
  const kept = notes.filter((n) => {
    const m = /reference plane "([^"]+)"/.exec(n);
    return !(m && have.has(m[1]));
  });
  return { notes: kept, dropped: notes.length - kept.length };
}
