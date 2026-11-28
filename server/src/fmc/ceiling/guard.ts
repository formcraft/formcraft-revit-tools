import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { QueueItem, approvalFor, claimApproval, enqueue, readItem } from "../aiuse_io.js";
import { roomOutline } from "./engine.js";

const win = path.win32;

/**
 * fmc_ceiling hardening (owner 28 Nov 2026, proposals in tool-research/fmc_ceiling.md):
 *   - a real person's approval for every real pack/place/edit/drawings (reuses the AI approval queue: the pane's
 *     ai_approve is CLI-only and never an MCP tool; the approval is bound to the exact batch and claimed once)
 *   - a design hash, so place and edit can verify they place the design that was checked
 *   - the placement record written BEFORE the Revit change, then finished, rolled back or left marked
 *   - the origin checked against the model's room boundary
 */

export const CEILING_APPROVAL = "fmc_ceiling_approval";

// ---------------------------------------------------------------- hash

/** Canonical JSON: sorted keys, no undefined, Sets and Maps as arrays. */
export function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (x instanceof Set) return [...x].map(norm).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (x instanceof Map) return norm(Object.fromEntries(x));
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as object).filter(([, y]) => y !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, y]) => [k, norm(y)]));
    return x;
  };
  return JSON.stringify(norm(v));
}

export const sha = (v: unknown, len = 16) => crypto.createHash("sha256").update(typeof v === "string" ? v : canonical(v)).digest("hex").slice(0, len);

/** What the design is: its kind, the inputs it came from, the evaluated geometry and the kit files it was made with. */
export function designHash(parts: { kind: string; input: unknown; design: unknown; kit_revisions: Record<string, string> }): string {
  return sha(parts, 20);
}

/** Revision of a kit file: the first 12 hex digits of its SHA-256 (or "missing"). */
export function revisionOf(text: string | null): string { return text === null ? "missing" : sha(text, 12); }

// ---------------------------------------------------------------- origin vs the model's room

export interface Bbox { x0: number; y0: number; x1: number; y1: number }
export const ORIGIN_TOLERANCE_MM = 150;

export function outlineBbox(outline: Array<[number, number] | number[]>, origin: { x: number; y: number }): Bbox {
  const xs = outline.map((p) => p[0] + origin.x), ys = outline.map((p) => p[1] + origin.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** The room in the model (from fmc_room or the room's bounding box) against where the design's room lands with this origin. */
export function originCheck(room: Parameters<typeof roomOutline>[0], origin: { x: number; y: number }, model: Bbox | undefined, tol = ORIGIN_TOLERANCE_MM): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || Math.abs(origin.x) > 1e7 || Math.abs(origin.y) > 1e7)
    problems.push(`place.origin_mm (${origin.x}, ${origin.y}) isn't a usable position in mm`);
  if (!model) {
    warnings.push("place.room_bbox_mm was not given, so the origin was not checked against the room's boundary in the model (read the room with fmc_room and pass its bounding box)");
    return { problems, warnings };
  }
  if (!(model.x1 > model.x0) || !(model.y1 > model.y0)) { problems.push("place.room_bbox_mm must have x1 > x0 and y1 > y0"); return { problems, warnings }; }
  const mine = outlineBbox(roomOutline(room), origin);
  const off = { x0: mine.x0 - model.x0, y0: mine.y0 - model.y0, x1: mine.x1 - model.x1, y1: mine.y1 - model.y1 };
  const worst = Math.max(...Object.values(off).map(Math.abs));
  if (worst > tol)
    problems.push(`The design's room lands at x ${Math.round(mine.x0)}..${Math.round(mine.x1)}, y ${Math.round(mine.y0)}..${Math.round(mine.y1)} mm with this origin, ` +
      `but the room in the model is x ${Math.round(model.x0)}..${Math.round(model.x1)}, y ${Math.round(model.y0)}..${Math.round(model.y1)} mm (off by up to ${Math.round(worst)} mm; tolerance ${tol}). Check place.origin_mm`);
  return { problems, warnings };
}

// ---------------------------------------------------------------- person's approval

export interface ApprovalAsk {
  /** A person's own click in the pane (FMC_CALLER=pane, not through MCP). Their click is the approval. */
  person: boolean;
  env: NodeJS.ProcessEnv;
  /** The exact batch: the queue item is keyed by it and must hold the same parameters. */
  binding: Record<string, unknown>;
  docPath: string;
  elements: number;
  details: string[];
  now?: Date;
}

export type ApprovalResult =
  | { ok: true; by: string; id: string | null; claim: () => boolean }
  | { ok: false; id: string; message: string };

/**
 * Who may say yes. A person in the pane: yes. Anyone else (an AI over MCP, Ask Claude, a script): only a batch a person
 * approved in the pane's Approvals list (ai_approve is CLI-only), with the same parameters. `claim` marks it used, once.
 */
export function ceilingApproval(a: ApprovalAsk): ApprovalResult {
  if (a.person) return { ok: true, by: "person (pane)", id: null, claim: () => true };
  const item = approvalFor(CEILING_APPROVAL, a.binding, a.docPath, a.env);
  if (item) {
    const held = readItem(item.id, a.env)?.params;
    if (held !== undefined && canonical(held) === canonical(a.binding))
      return { ok: true, by: item.by || "person", id: item.id, claim: () => claimApproval(item.id, a.env, a.now) };
  }
  const q: QueueItem = enqueue(CEILING_APPROVAL, a.binding, a.docPath, "fmc_ceiling", "ceiling", a.elements, a.env, a.now ?? new Date(), a.details);
  return { ok: false, id: q.id, message: `A person has to approve this in the Formcraft pane (Approvals, batch ${q.id}); an AI's confirm=true is not an approval. ` +
    `Wait with fmc_ai wait id ${q.id}, then send exactly the same call again.` };
}

// ---------------------------------------------------------------- placement record, written first

export type RecordStatus = "pending" | "placed" | "failed";

export interface PlacedRecord {
  room: string; design: string; level: string; placed_at: string; made: string[]; elements: Array<{ unique_id: string; key: string }>;
  /** Added by the hardening; records written before it have none of these and count as placed. */
  status?: RecordStatus;
  design_hash?: string;
  placement_hash?: string;
  kit_revisions?: Record<string, string>;
  origin_mm?: { x: number; y: number };
  action?: string;
  approved_by?: string;
  approval_id?: string | null;
  started_at?: string;
  finished_at?: string;
  error?: string;
  /** edit: the record this one replaced, restored if the Revit change fails */
  previous?: PlacedRecord | null;
  last_failed_attempt?: { at: string; action: string; error: string; design_hash?: string };
}

export const statusOf = (r: PlacedRecord): RecordStatus => r.status ?? "placed";

export function writeRecordAtomic(file: string, rec: PlacedRecord): void {
  fs.mkdirSync(win.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
}

export function readRecord(file: string): PlacedRecord | null {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) : null;
}

/** Can this record be placed over (place) or replaced (edit)? A pending place that may or may not have run blocks both. */
export function recordBlocks(rec: PlacedRecord | null, action: "place" | "edit", room: string): string | null {
  if (!rec) return null;
  const st = statusOf(rec);
  if (st === "pending" && rec.made.length === 0)
    return `${room}: a ${rec.action ?? "place"} started ${rec.started_at ?? ""} was never finished (approval ${rec.approval_id ?? "-"}) and what it made is unknown. ` +
      "Look in the model (fmc_job status, the 'FMC:CEILING:<room>' elements); a person then deletes the record file or sends its ids before the next " + action;
  if (action === "place" && st !== "failed") return `${room} was placed on ${rec.placed_at} (${rec.made.length} elements): use edit to replace them with this design`;
  if (action === "edit" && st === "failed" && rec.made.length === 0) return `Nothing is recorded as placed for ${room}: the last place failed (${rec.error ?? ""}); use place`;
  return null;
}

export interface Intent {
  action: "place" | "edit";
  room: string; design: string; level: string; design_hash: string; placement_hash: string; kit_revisions: Record<string, string>;
  origin_mm: { x: number; y: number }; approved_by: string; approval_id: string | null; now: Date;
}

/** Step 1, before Revit: the record says what is about to happen. An edit keeps the previous elements as `made`, so a crash loses nothing. */
export function writePending(file: string, before: PlacedRecord | null, i: Intent): PlacedRecord {
  const rec: PlacedRecord = {
    room: i.room, design: i.design, level: i.level, placed_at: before?.placed_at ?? i.now.toISOString(),
    made: before ? [...before.made] : [], elements: before ? [...before.elements] : [],
    status: "pending", design_hash: i.design_hash, placement_hash: i.placement_hash, kit_revisions: i.kit_revisions, origin_mm: i.origin_mm,
    action: i.action, approved_by: i.approved_by, approval_id: i.approval_id, started_at: i.now.toISOString(),
    previous: before ? stripPrevious(before) : null,
  };
  writeRecordAtomic(file, rec);
  return rec;
}

const stripPrevious = (r: PlacedRecord): PlacedRecord => { const { previous: _p, ...rest } = r; return rest as PlacedRecord; };

/** Step 3a: Revit succeeded. Retried; if the file still can't be written the ids go to a side file next to it and the caller is told. */
export function finishRecord(file: string, pending: PlacedRecord, elements: Array<{ unique_id: string; key: string }>, now: Date,
  write: (f: string, r: PlacedRecord) => void = writeRecordAtomic): { ok: boolean; side_file?: string; error?: string } {
  const { previous: _p, ...base } = pending;
  const rec: PlacedRecord = { ...base, status: "placed", placed_at: now.toISOString(), made: elements.map((x) => x.unique_id), elements, finished_at: now.toISOString(), previous: undefined };
  let last = "";
  for (let n = 0; n < 3; n++) {
    try { write(file, rec); return { ok: true }; } catch (e) { last = e instanceof Error ? e.message : String(e); }
  }
  const side = `${file}.${now.toISOString().replace(/[:.]/g, "")}.orphan.json`;
  try { fs.writeFileSync(side, JSON.stringify(rec, null, 2)); return { ok: false, side_file: side, error: last }; } catch (e) { return { ok: false, error: `${last}; side file: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** Step 3b: Revit refused or failed (and is known not to be still running). A place is marked failed; an edit goes back to what it was. */
export function rollBackRecord(file: string, pending: PlacedRecord, error: string, now: Date): PlacedRecord {
  const attempt = { at: now.toISOString(), action: pending.action ?? "place", error: error.slice(0, 500), design_hash: pending.design_hash };
  let rec: PlacedRecord;
  if (pending.previous) rec = { ...pending.previous, last_failed_attempt: attempt };
  else rec = { ...pending, status: "failed", error: error.slice(0, 500), finished_at: now.toISOString(), previous: undefined, last_failed_attempt: attempt };
  writeRecordAtomic(file, rec);
  return rec;
}

/** The answer is not known (Revit still running, or the connection dropped): the record stays pending, and says why. */
export function markUnknown(file: string, pending: PlacedRecord, why: string): void {
  try { writeRecordAtomic(file, { ...pending, error: `unconfirmed: ${why}`.slice(0, 500) }); } catch { /* the pending record is already on disk */ }
}
