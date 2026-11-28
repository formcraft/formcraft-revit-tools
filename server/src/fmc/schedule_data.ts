/**
 * fmc_schedule_data (GAP-06): schedule cells out to CSV or XLSX in the project folder, and edited marks, comments and
 * key-schedule values back in as a diff. Pure: no Revit, no files, tested offline. The Revit side is
 * commandset/Services/Fmc/FmcScheduleData.cs.
 */
import path from "node:path";
import { parseCsv, csvField } from "./tables.js";

const win = path.win32;

/** How a field gets its value. Only "parameter" fields can ever be written; the rest are calculated by Revit. */
export type FieldKind = "parameter" | "calculated" | "percentage" | "formula" | "combined" | "count" | "other";

export interface SchedField {
  name: string;
  heading?: string;
  kind: FieldKind;
  /** The built-in parameter name (ALL_MODEL_MARK…) when it is one */
  builtin?: string;
  /** A type parameter: one value for every instance of the type */
  type_param?: boolean;
  read_only?: boolean;
  hidden?: boolean;
}

export interface SchedRow {
  id: string;
  type_id?: string;
  values: Record<string, string>;
  checkout?: string;
  owner?: string;
}

export interface SchedRead {
  schedule: string;
  schedule_id: string;
  is_key: boolean;
  fields: SchedField[];
  rows: SchedRow[];
}

/** Marks and comments: the only fields written outside a key schedule. */
export const MARK_COMMENT_PARAMS = new Set(["ALL_MODEL_MARK", "ALL_MODEL_TYPE_MARK", "ALL_MODEL_INSTANCE_COMMENTS", "ALL_MODEL_TYPE_COMMENTS"]);
const MARK_COMMENT_NAMES = new Set(["mark", "type mark", "comments", "type comments"]);

/** Whether a field may be written, and why not. */
export function fieldEditable(f: SchedField, isKey: boolean): { ok: boolean; reason?: string } {
  if (f.kind !== "parameter") return { ok: false, reason: `${f.name} is a ${f.kind} field (Revit calculates it); it is never written` };
  if (f.read_only) return { ok: false, reason: `${f.name} is read-only` };
  if (isKey) return { ok: true };
  const markLike = f.builtin ? MARK_COMMENT_PARAMS.has(f.builtin) : MARK_COMMENT_NAMES.has(f.name.trim().toLowerCase()) && !f.builtin;
  if (!markLike) return { ok: false, reason: `${f.name}: only marks, comments and key-schedule values are written back` };
  return { ok: true };
}

/** The exported table: ElementId first (the key the import reads back), then each field by name. */
export function tableOf(read: SchedRead, opts: { hidden?: boolean } = {}): string[][] {
  const fields = read.fields.filter((f) => opts.hidden || !f.hidden);
  return [["ElementId", ...fields.map((f) => f.name)], ...read.rows.map((r) => [r.id, ...fields.map((f) => r.values[f.name] ?? "")])];
}

export function toCsv(table: string[][]): string {
  return "\uFEFF" + table.map((row) => row.map((c) => csvField(c)).join(",")).join("\r\n") + "\r\n";
}

export interface EditRow { id: string; values: Record<string, string> }

/** Edited rows from a table read back (CSV text or XLSX rows): the header names the fields, ElementId the element. */
export function editsFromTable(table: string[][]): { rows: EditRow[]; problems: string[] } {
  const problems: string[] = [];
  const clean = table.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (!clean.length) return { rows: [], problems: ["The table is empty"] };
  const header = clean[0].map((h) => String(h ?? "").trim());
  const idCol = header.findIndex((h) => h.toLowerCase() === "elementid");
  if (idCol < 0) return { rows: [], problems: ["No ElementId column (export the schedule with fmc_schedule_data export, edit it, and keep that column)"] };
  const rows: EditRow[] = [];
  for (const r of clean.slice(1)) {
    const id = String(r[idCol] ?? "").trim();
    if (!id) { problems.push("A row has no ElementId"); continue; }
    const values: Record<string, string> = {};
    header.forEach((h, i) => { if (i !== idCol && h) values[h] = String(r[i] ?? ""); });
    rows.push({ id, values });
  }
  return { rows, problems };
}

export function editsFromCsv(text: string): { rows: EditRow[]; problems: string[] } {
  return editsFromTable(parseCsv(text).map((r) => r.cells));
}

export interface CellChange { id: string; field: string; from: string; to: string; type_id?: string }
export interface CellRefusal { id: string; field: string; reason: string }

export interface ScheduleDiff {
  changes: CellChange[];
  refused: CellRefusal[];
  unknown_ids: string[];
  unknown_fields: string[];
  problems: string[];
}

/**
 * The cell diff between what the schedule holds and the edited rows. Unchanged cells are left out. A changed cell in a
 * calculated or formula field, a read-only one, a field that isn't a mark/comment outside a key schedule, or on an
 * element another user owns is refused. Two different values for one type parameter on one type is a problem.
 */
export function diffEdits(read: SchedRead, edits: EditRow[]): ScheduleDiff {
  const byId = new Map(read.rows.map((r) => [r.id, r]));
  const byName = new Map(read.fields.map((f) => [f.name, f]));
  const out: ScheduleDiff = { changes: [], refused: [], unknown_ids: [], unknown_fields: [], problems: [] };
  const unknownFields = new Set<string>();
  const seen = new Set<string>();
  for (const e of edits) {
    if (seen.has(e.id)) out.problems.push(`Element ${e.id} is in the edits twice`);
    seen.add(e.id);
    const row = byId.get(e.id);
    if (!row) { out.unknown_ids.push(e.id); continue; }
    for (const [name, raw] of Object.entries(e.values)) {
      const f = byName.get(name);
      if (!f) { unknownFields.add(name); continue; }
      const from = row.values[name] ?? "";
      const to = raw;
      if (from === to) continue;
      const ok = fieldEditable(f, read.is_key);
      if (!ok.ok) { out.refused.push({ id: e.id, field: name, reason: ok.reason! }); continue; }
      if (row.checkout === "owned_by_other") { out.refused.push({ id: e.id, field: name, reason: `owned by ${row.owner || "another user"}` }); continue; }
      out.changes.push({ id: e.id, field: name, from, to, ...(f.type_param && row.type_id ? { type_id: row.type_id } : {}) });
    }
  }
  out.unknown_fields = [...unknownFields];
  // a type parameter set two ways on one type
  const typeVals = new Map<string, Set<string>>();
  for (const c of out.changes) if (c.type_id) {
    const k = `${c.type_id}|${c.field}`;
    typeVals.set(k, (typeVals.get(k) ?? new Set()).add(c.to));
  }
  for (const [k, v] of typeVals) if (v.size > 1) {
    const [type, field] = k.split("|");
    out.problems.push(`${field} is a type parameter and type ${type} is given ${v.size} different values`);
  }
  return out;
}

/** Changes as the Revit side applies them: one per element and field (type parameters once per type). */
export function applyList(changes: CellChange[]): CellChange[] {
  const seenType = new Set<string>();
  return changes.filter((c) => {
    if (!c.type_id) return true;
    const k = `${c.type_id}|${c.field}`;
    if (seenType.has(k)) return false;
    seenType.add(k);
    return true;
  });
}

/** The project folder above 01_WIP / 02_Shared / 03_Published, from the document's path ("" when it isn't in one). */
export function projectRootOf(docPath: string): string {
  if (!docPath) return "";
  const segs = win.normalize(docPath).split("\\");
  const i = segs.findIndex((s) => /^0[1-7]_[A-Za-z]+$/.test(s));
  return i > 0 ? segs.slice(0, i).join("\\") : "";
}

export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "schedule";
}

export function asRead(raw: unknown): SchedRead | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.fields) || !Array.isArray(r.rows)) return null;
  const kinds: FieldKind[] = ["parameter", "calculated", "percentage", "formula", "combined", "count", "other"];
  return {
    schedule: String(r.schedule ?? ""),
    schedule_id: String(r.schedule_id ?? ""),
    is_key: r.is_key === true,
    fields: (r.fields as Array<Record<string, unknown>>).map((f) => ({
      name: String(f.name ?? ""), heading: f.heading === undefined ? undefined : String(f.heading),
      kind: (kinds as string[]).includes(String(f.kind)) ? f.kind as FieldKind : "other",
      builtin: f.builtin ? String(f.builtin) : undefined, type_param: f.type_param === true, read_only: f.read_only === true, hidden: f.hidden === true,
    })),
    rows: (r.rows as Array<Record<string, unknown>>).map((x) => ({
      id: String(x.id ?? ""), type_id: x.type_id === undefined ? undefined : String(x.type_id),
      values: Object.fromEntries(Object.entries((x.values ?? {}) as Record<string, unknown>).map(([k, v]) => [k, v == null ? "" : String(v)])),
      checkout: x.checkout === undefined ? undefined : String(x.checkout), owner: x.owner === undefined ? undefined : String(x.owner),
    })),
  };
}
