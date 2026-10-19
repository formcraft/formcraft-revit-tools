/**
 * Tables by script (hub step T, docs/PLAN_ENGINEERING_HUB.md): Excel ↔ the kit's tables, never through AI.
 *
 * People edit tables in Excel; the tools read the kit's JSON and CSV (03_Master_Data). These pure functions read a kit
 * table, compare a workbook sheet with it by the table's key (rows added, removed and changed, cell by cell, plus
 * problems: a duplicate key, a parameter that isn't a kit parameter (rule 7), a bad type), and write a proposed kit
 * file for a person to publish. Nothing here touches the disk: tools/fmc_tables.ts reads, checks paths and writes.
 */

export type TableKind = "csv" | "json-array" | "json-map";

export interface TableDef {
  /** The name the tool takes (table: "family_register") */
  id: string;
  title: string;
  /** The file in 03_Master_Data */
  file: string;
  /** JSON: the top-level section holding the table */
  section?: string;
  kind: TableKind;
  /** The key column(s); a json-map's key[0] names the column that holds the map's keys */
  key: string[];
  /** json-map of plain values (name → text): the value column's name */
  valueColumn?: string;
  /** The key itself is a parameter name: a new key must be in the shared parameter file */
  paramKey?: boolean;
  /** The kit's own Excel twin of this table, for check */
  twin?: { workbook: string; sheet: string };
}

/**
 * Where the kit keeps its tables: file layout and key columns, not kit values (rule 7 is about values). A table not
 * listed here is named by its file ("FMC_X.csv", "FMC_X.json#section") with a key.
 */
export const KIT_TABLES: TableDef[] = [
  { id: "family_register", title: "Family register", file: "FMC_Family_Register.csv", kind: "csv", key: ["Family"],
    twin: { workbook: "FMC_Revit_Kit.xlsx", sheet: "Family_Register" } },
  { id: "sheet_register", title: "Sheet register", file: "FMC_Sheet_Register.csv", kind: "csv", key: ["SheetNumber"],
    twin: { workbook: "FMC_Revit_Kit.xlsx", sheet: "Sheet_Register" } },
  { id: "legend_map", title: "Legend map", file: "FMC_Legend_Map.csv", kind: "csv", key: ["Family"],
    twin: { workbook: "FMC_Revit_Kit.xlsx", sheet: "Legend_Map" } },
  // A family can have a "new" and an "ext" research row: the key is both columns.
  { id: "family_research", title: "Family research", file: "FMC_Family_Research.csv", kind: "csv", key: ["Family", "Change"] },
  { id: "parameters", title: "Project parameters", file: "FMC_Master_Data.json", section: "params", kind: "json-map",
    key: ["Parameter"], paramKey: true },
  { id: "deprecated_parameters", title: "Deprecated parameters", file: "FMC_Master_Data.json", section: "deprecated_params",
    kind: "json-map", key: ["Parameter"], valueColumn: "Replaced_By", paramKey: true },
  { id: "codes", title: "Element codes", file: "FMC_Master_Data.json", section: "codes", kind: "json-map", key: ["Code"],
    twin: { workbook: "FMC_Master_Data.xlsx", sheet: "Codes" } },
  { id: "family_specs", title: "Family specs", file: "FMC_Family_Specs.json", section: "families", kind: "json-array", key: ["family"] },
];

/** A table by its id, or by its file ("FMC_X.csv", "FMC_X.json#section") with key columns ("Family" or "Family+Change"). */
export function resolveTable(table: string, key = ""): { def?: TableDef; problem?: string } {
  const t = table.trim();
  const keys = key.split("+").map((k) => k.trim()).filter(Boolean);
  const known = KIT_TABLES.find((d) => d.id === t || (d.file + (d.section ? "#" + d.section : "")).toLowerCase() === t.toLowerCase());
  if (known) return { def: keys.length ? { ...known, key: keys } : known };
  const m = /^([^\\/#]+\.(csv|json))(?:#(.+))?$/i.exec(t);
  if (!m) return { problem: `Unknown table "${t}": one of ${KIT_TABLES.map((d) => d.id).join(", ")}, or a file in 03_Master_Data (FMC_X.csv, FMC_X.json#section)` };
  if (/\.json$/i.test(m[1]) && !m[3]) return { problem: `${m[1]}: name the JSON section (${m[1]}#section)` };
  if (!keys.length) return { problem: `${t} isn't a known table: say its key column (key: "Name", or "A+B" for two)` };
  return { def: { id: t, title: t, file: m[1], section: m[3], kind: /\.csv$/i.test(m[1]) ? "csv" : "json-array", key: keys } };
}

// ---------- CSV ----------

/**
 * RFC 4180 CSV: quoted fields may hold commas, quotes ("") and line breaks. Each record keeps its raw text and the line
 * ending after it (some kit files mix CRLF and LF), so an untouched record is written back exactly.
 */
export function parseCsv(text: string): Array<{ cells: string[]; raw: string; eol: string }> {
  const s = text.replace(/^﻿/, "");
  const out: Array<{ cells: string[]; raw: string; eol: string }> = [];
  let cells: string[] = [], cur = "", q = false, start = 0, i = 0;
  const end = (to: number, eol: string) => { cells.push(cur); out.push({ cells, raw: s.slice(start, to), eol }); cells = []; cur = ""; };
  for (; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else if (ch === "\r" || ch === "\n") {
      const crlf = ch === "\r" && s[i + 1] === "\n";
      end(i, crlf ? "\r\n" : ch);
      if (crlf) i++;
      start = i + 1;
    } else cur += ch;
  }
  if (cur !== "" || cells.length || start < s.length) end(s.length, "");
  return out.filter((r) => !(r.cells.length === 1 && r.cells[0] === "" && r.raw === ""));
}

export function csvField(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ---------- the kit table ----------

export type ColType = "text" | "number" | "boolean" | "json" | "any";
export type Row = Record<string, unknown>;

export interface KitRow {
  key: string;
  row: Row;
  /** JSON: the kit's own object (its field order is kept); CSV: the record's raw text (kept when unchanged) */
  orig?: unknown;
  raw?: string;
  /** CSV: the line ending after the record */
  eol?: string;
}

export interface KitTable {
  def: TableDef;
  columns: string[];
  rows: KitRow[];
  types: Record<string, ColType>;
  /** JSON object fields that hold null somewhere (an emptied cell goes back to null) */
  nullable: Set<string>;
  problems: string[];
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "";
const isNum = (s: string) => s.trim() !== "" && Number.isFinite(Number(s.trim()));
const keyOf = (row: Row, key: string[]) => key.map((k) => String(row[k] ?? "").trim()).join(" | ");

function inferTypes(columns: string[], rows: Row[], csv: boolean): Record<string, ColType> {
  const out: Record<string, ColType> = {};
  for (const c of columns) {
    const kinds = new Set<string>();
    for (const r of rows) {
      const v = r[c];
      if (isEmpty(v)) continue;
      if (csv) kinds.add(isNum(String(v)) ? "number" : "text");
      else kinds.add(Array.isArray(v) || typeof v === "object" ? "json" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "text");
    }
    out[c] = kinds.size === 0 ? "any" : kinds.size === 1 ? ([...kinds][0] as ColType) : kinds.has("json") ? "json" : "text";
  }
  return out;
}

/** A kit table from its file's text (CSV, or the JSON file holding the section). */
export function parseKitTable(def: TableDef, text: string): KitTable {
  const problems: string[] = [];
  const nullable = new Set<string>();
  if (def.kind === "csv") {
    const recs = parseCsv(text);
    const columns = (recs[0]?.cells ?? []).map((c) => c.trim());
    const rows: KitRow[] = recs.slice(1).filter((r) => r.cells.some((c) => c !== "")).map((r) => {
      const row: Row = {};
      columns.forEach((c, i) => { row[c] = r.cells[i] ?? ""; });
      return { key: keyOf(row, def.key), row, raw: r.raw, eol: r.eol };
    });
    for (const k of def.key) if (!columns.includes(k)) problems.push(`${def.file} has no "${k}" column (its key)`);
    return { def, columns, rows, types: inferTypes(columns, rows.map((r) => r.row), true), nullable, problems };
  }
  const data = JSON.parse(text.replace(/^﻿/, ""));
  const sec = def.section ? data?.[def.section] : data;
  const columns: string[] = [];
  const add = (c: string) => { if (!columns.includes(c)) columns.push(c); };
  const rows: KitRow[] = [];
  if (def.kind === "json-map" || (sec && typeof sec === "object" && !Array.isArray(sec))) {
    if (!sec || typeof sec !== "object" || Array.isArray(sec)) throw new Error(`${def.file}: "${def.section}" isn't a table (an object of rows)`);
    const keyCol = def.key[0];
    add(keyCol);
    for (const [k, v] of Object.entries(sec)) {
      const row: Row = { [keyCol]: k };
      if (v && typeof v === "object" && !Array.isArray(v)) for (const [f, x] of Object.entries(v)) { add(f); row[f] = x; if (x === null) nullable.add(f); }
      else { const vc = def.valueColumn ?? "Value"; add(vc); row[vc] = v; if (v === null) nullable.add(vc); }
      rows.push({ key: k, row, orig: v });
    }
    def = { ...def, kind: "json-map", key: [keyCol] };
  } else {
    if (!Array.isArray(sec)) throw new Error(`${def.file}: "${def.section}" isn't a table (a list of rows)`);
    for (const v of sec) {
      if (!v || typeof v !== "object" || Array.isArray(v)) { problems.push(`${def.file} ${def.section}: a row isn't an object`); continue; }
      for (const [f, x] of Object.entries(v)) { add(f); if (x === null) nullable.add(f); }
      rows.push({ key: keyOf(v as Row, def.key), row: { ...(v as Row) }, orig: v });
    }
    for (const k of def.key) if (!columns.includes(k)) problems.push(`${def.file} ${def.section}: no "${k}" field (its key)`);
  }
  return { def, columns, rows, types: inferTypes(columns, rows.map((r) => r.row), false), nullable, problems };
}

// ---------- the workbook sheet ----------

export interface SheetTable { header: string[]; headerRow: number; body: Array<{ row: number; cells: string[] }> }

/** The sheet's header (its first row with text) and the rows under it; empty rows are skipped. Rows count from 1. */
export function sheetTable(rows: string[][]): SheetTable {
  const h = rows.findIndex((r) => r.some((c) => (c ?? "").trim() !== ""));
  if (h < 0) return { header: [], headerRow: 0, body: [] };
  return {
    header: rows[h].map((c) => (c ?? "").trim()),
    headerRow: h + 1,
    body: rows.slice(h + 1).map((cells, i) => ({ row: h + 2 + i, cells })).filter((r) => r.cells.some((c) => (c ?? "").trim() !== "")),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Which kit column each workbook column is: the person's own map first, then the same name (case and spacing aside). */
export function matchColumns(kitColumns: string[], header: string[], map: Record<string, string> = {}): Array<string | null> {
  const used = new Set<string>();
  return header.map((h) => {
    if (!h) return null;
    const mapped = map[h];
    const hit = mapped !== undefined ? kitColumns.find((c) => c === mapped) : kitColumns.find((c) => c === h) ?? kitColumns.find((c) => norm(c) === norm(h));
    if (!hit || used.has(hit)) return null;
    used.add(hit);
    return hit;
  });
}

// ---------- compare ----------

export type ProblemKind = "missing key column" | "empty key" | "duplicate key" | "bad type" | "not a kit parameter";
export interface Problem { kind: ProblemKind; row?: number; key?: string; column?: string; detail: string; blocking: boolean }
export interface CellChange { column: string; kit: unknown; workbook: unknown }

export interface TableDiff {
  table: string;
  key: string;
  header_row: number;
  matched_columns: string[];
  /** Workbook columns that aren't kit columns: not imported (a new column is a change to the table's layout) */
  workbook_only_columns: string[];
  /** Kit columns the workbook doesn't have: kept as the kit has them */
  kit_only_columns: string[];
  added: Array<{ key: string; row: number }>;
  removed: Array<{ key: string }>;
  changed: Array<{ key: string; row: number; cells: CellChange[] }>;
  unchanged: number;
  problems: Problem[];
  notes: string[];
}

export interface CompareOptions {
  /** Workbook header → kit column, where the names differ */
  columns?: Record<string, string>;
  /** Every kit parameter name (shared parameter file, master data params): null when not readable */
  kitParameters?: Set<string> | null;
  /** The shared parameter file's names (a new parameter row must be in it): null when not readable */
  dictionary?: Set<string> | null;
  /** Rows the workbook doesn't have stay in the proposed table (a filtered sheet) */
  keepRemoved?: boolean;
}

/** Text the same way on both sides: Excel turns CRLF into LF. */
const text = (v: unknown) => String(v).replace(/\r\n?/g, "\n");

/** The same value, as far as the kit is concerned: empty is empty, numbers by value, lists and objects by content. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (isEmpty(a) || isEmpty(b)) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b) && isNum(String(a)) && isNum(String(b));
  const x = text(a), y = text(b);
  return x === y || (isNum(x) && isNum(y) && Number(x) === Number(y));
}

/** A workbook cell as the kit stores it, by the column's type; a value that doesn't fit is a problem. */
export function cellValue(cell: string, type: ColType, csv: boolean, old: unknown, nullable: boolean): { value?: unknown; problem?: string } {
  const s = text(cell ?? "");
  if (csv) {
    if (type === "number" && s.trim() !== "" && !isNum(s)) return { value: s, problem: `expects a number (every kit value in this column is one), got "${s}"` };
    return { value: s };
  }
  if (s.trim() === "") return { value: old === null || old === "" ? old : type === "text" && !nullable ? "" : old === undefined && type === "text" ? "" : null };
  switch (type) {
    case "number": return isNum(s) ? { value: Number(s.trim()) } : { problem: `expects a number, got "${s}"` };
    case "boolean": {
      const b = s.trim().toLowerCase();
      if (["true", "yes", "1"].includes(b)) return { value: true };
      if (["false", "no", "0"].includes(b)) return { value: false };
      return { problem: `expects true or false, got "${s}"` };
    }
    case "json":
      try {
        const v = JSON.parse(s);
        if (v === null || typeof v !== "object") return { problem: `expects a list or object in JSON, as the export writes it, got "${s}"` };
        return { value: v };
      } catch { return { problem: `expects a list or object in JSON, as the export writes it, got "${s}"` }; }
    case "any": return { value: isNum(s) ? Number(s.trim()) : s };
    default: return { value: s };
  }
}

/** FMC_ names in a cell, without wildcards (FMC_SP_*) or stems (FMC_TB_…_). */
export function parameterTokens(v: unknown): string[] {
  const s = typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v);
  const out: string[] = [];
  for (const m of s.matchAll(/FMC_[A-Za-z0-9_]+/g)) {
    const t = m[0];
    if (s[m.index! + t.length] === "*" || t.endsWith("_")) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

const isParamColumn = (c: string) => /param/i.test(c);

export interface Comparison { diff: TableDiff; proposed: KitRow[]; touched: Set<string> }

/**
 * A workbook sheet against a kit table, by key: what would change, cell by cell, and what's wrong. Only columns both
 * have are compared; the proposed table keeps everything else as the kit has it.
 */
export function compareTable(kit: KitTable, sheetRows: string[][], opts: CompareOptions = {}): Comparison {
  const def = kit.def;
  const csv = def.kind === "csv";
  const sheet = sheetTable(sheetRows);
  const cols = matchColumns(kit.columns, sheet.header, opts.columns);
  const matched = cols.filter((c): c is string => !!c);
  const problems: Problem[] = [];
  const notes: string[] = [...kit.problems];
  const diff: TableDiff = {
    table: def.id, key: def.key.join(" + "), header_row: sheet.headerRow,
    matched_columns: matched,
    workbook_only_columns: sheet.header.filter((h, i) => h && !cols[i]),
    kit_only_columns: kit.columns.filter((c) => !matched.includes(c)),
    added: [], removed: [], changed: [], unchanged: 0, problems, notes,
  };
  const proposed: KitRow[] = [];
  const touched = new Set<string>();
  if (!opts.kitParameters) notes.push("Parameter names weren't checked: the kit's parameters (shared parameter file, master data) weren't readable");
  const missingKey = def.key.filter((k) => !matched.includes(k));
  if (missingKey.length) {
    problems.push({ kind: "missing key column", detail: `The sheet has no ${missingKey.join(" and ")} column (the table's key); nothing can be compared`, blocking: true });
    return { diff, proposed: kit.rows, touched };
  }
  // A parameter table's own key is checked against the dictionary below, not here.
  const paramCols = matched.filter((c) => isParamColumn(c) && !(def.paramKey && def.key.includes(c)));

  const kitByKey = new Map<string, KitRow>();
  for (const r of kit.rows) if (!kitByKey.has(r.key)) kitByKey.set(r.key, r);
  const seen = new Map<string, number>();
  const fromSheet = new Map<string, KitRow>();
  const order: string[] = [];

  for (const { row: rowNo, cells } of sheet.body) {
    const values: Row = {};
    cols.forEach((c, i) => { if (c) values[c] = cells[i] ?? ""; });
    const key = keyOf(values, def.key);
    if (def.key.some((k) => String(values[k] ?? "").trim() === "")) {
      problems.push({ kind: "empty key", row: rowNo, detail: `Row ${rowNo} has no ${def.key.join(" + ")}`, blocking: true });
      continue;
    }
    if (seen.has(key)) {
      problems.push({ kind: "duplicate key", row: rowNo, key, detail: `${key} is on rows ${seen.get(key)} and ${rowNo}`, blocking: true });
      continue;
    }
    seen.set(key, rowNo);
    const old = kitByKey.get(key);
    const next: Row = old ? { ...old.row } : {};
    if (!old) for (const c of kit.columns) next[c] = csv ? "" : kit.types[c] === "text" ? "" : null;
    const changes: CellChange[] = [];
    for (const c of matched) {
      const prev = old?.row[c];
      const raw = String(values[c] ?? "");
      const isKey = def.key.includes(c);
      const v = cellValue(isKey ? raw.trim() : raw, kit.types[c], csv, prev, kit.nullable.has(c));
      if (v.problem) problems.push({ kind: "bad type", row: rowNo, key, column: c, detail: `${c} ${v.problem}`, blocking: !csv });
      if (v.value === undefined) continue;
      if (old && sameValue(prev, v.value)) continue;
      if (!old && isEmpty(v.value)) { next[c] = v.value; continue; }
      next[c] = v.value;
      if (old) changes.push({ column: c, kit: prev ?? null, workbook: v.value });
      // Rule 7: a parameter named in a table must be a kit parameter; only names this edit brings in are checked.
      if (opts.kitParameters && paramCols.includes(c)) {
        const before = new Set(parameterTokens(prev));
        for (const t of parameterTokens(v.value)) if (!before.has(t) && !opts.kitParameters.has(t))
          problems.push({ kind: "not a kit parameter", row: rowNo, key, column: c,
            detail: `${t} isn't a kit parameter (rule 7: add it to the shared parameter file by a kit change request first)`, blocking: true });
      }
    }
    if (!old && def.paramKey) {
      const set = opts.dictionary ?? null;
      if (!set) notes.push(`New parameter ${key} wasn't checked against the shared parameter file (not readable)`);
      else if (!set.has(key)) problems.push({ kind: "not a kit parameter", row: rowNo, key, column: def.key[0],
        detail: `${key} isn't in the shared parameter file (rule 7: the dictionary comes first, by a kit change request)`, blocking: true });
    }
    const kr: KitRow = old ? { ...old, row: next } : { key, row: next };
    fromSheet.set(key, kr);
    order.push(key);
    if (!old) { diff.added.push({ key, row: rowNo }); touched.add(key); }
    else if (changes.length) { diff.changed.push({ key, row: rowNo, cells: changes }); touched.add(key); }
    else diff.unchanged++;
  }

  // The proposal: the kit's order, edited rows in place, removed rows dropped (or kept), new rows at the end.
  for (const r of kit.rows) {
    const s = fromSheet.get(r.key);
    if (s && proposed.some((p) => p.key === r.key)) { proposed.push(r); continue; } // a duplicate in the kit itself stays
    if (s) proposed.push(s);
    else if (opts.keepRemoved || seen.has(r.key)) proposed.push(r);
    else if (!diff.removed.some((x) => x.key === r.key)) { diff.removed.push({ key: r.key }); touched.add(r.key); }
  }
  for (const k of order) if (!kitByKey.has(k)) proposed.push(fromSheet.get(k)!);
  if (opts.keepRemoved) notes.push("keep_removed: rows the sheet doesn't have stay in the proposed table");
  const kitDups = kit.rows.length - kitByKey.size;
  if (kitDups) notes.push(`The kit's own table has ${kitDups} duplicate key(s) for ${def.key.join(" + ")}; they stay as they are`);
  return { diff, proposed, touched };
}

/** Problems that stop an import (the dry run still shows everything). */
export const blocking = (d: TableDiff) => d.problems.filter((p) => p.blocking);

// ---------- writing ----------

/** The proposed kit file: same format, same line endings; untouched CSV records keep their exact text. */
export function writeKitTable(kit: KitTable, rows: KitRow[], originalText: string, touched: Set<string> = new Set()): string {
  const def = kit.def;
  const eol = /\r\n/.test(originalText) ? "\r\n" : "\n";
  const bom = originalText.startsWith("﻿") ? "﻿" : "";
  const trailing = /\r?\n$/.test(originalText);
  if (def.kind === "csv") {
    const recs = parseCsv(originalText);
    const crlf = recs.filter((r) => r.eol === "\r\n").length, lf = recs.filter((r) => r.eol === "\n").length;
    const nl = crlf && crlf >= lf ? "\r\n" : lf ? "\n" : eol;
    const ends = recs.length ? recs[recs.length - 1].eol !== "" : trailing;
    const lines: Array<[string, string]> = [[recs[0]?.raw ?? kit.columns.map(csvField).join(","), recs[0]?.eol || nl]];
    for (const r of rows) lines.push(r.raw !== undefined && !touched.has(r.key)
      ? [r.raw, r.eol || nl] : [kit.columns.map((c) => csvField(String(r.row[c] ?? "")).replace(/\r?\n/g, nl)).join(","), nl]);
    return bom + lines.map(([t, e], i) => t + (i < lines.length - 1 || ends ? e : "")).join("");
  }
  const data = JSON.parse(originalText.replace(/^﻿/, ""));
  const indent = /^\{\r?\n( +|\t)/.exec(originalText.replace(/^﻿/, ""))?.[1] ?? " ";
  const objectOf = (r: KitRow, dropKey: string | null): unknown => {
    const o: Row = r.orig && typeof r.orig === "object" && !Array.isArray(r.orig) ? { ...(r.orig as Row) } : {};
    for (const c of kit.columns) {
      if (c === dropKey) continue;
      const v = r.row[c];
      if (v === undefined && !(c in o)) continue;
      o[c] = v === undefined ? null : v;
    }
    return o;
  };
  let sec: unknown;
  if (def.kind === "json-map") {
    const keyCol = def.key[0];
    const map: Row = {};
    for (const r of rows) {
      const plain = def.valueColumn ?? (kit.columns.length === 2 && kit.rows.every((k) => typeof k.orig !== "object" || k.orig === null) ? kit.columns[1] : null);
      map[String(r.row[keyCol])] = plain ? (r.row[plain] ?? null) : objectOf(r, keyCol);
    }
    sec = map;
  } else sec = rows.map((r) => objectOf(r, null));
  if (def.section) data[def.section] = sec; else return bom + JSON.stringify(sec, null, indent).replace(/\n/g, eol) + (trailing ? eol : "");
  return bom + JSON.stringify(data, null, indent).replace(/\n/g, eol) + (trailing ? eol : "");
}

/** A kit table as sheet rows for people to edit: the header, then each row; lists and objects as JSON text. */
export function tableSheet(kit: KitTable): Array<Array<string | number | boolean | null>> {
  return [kit.columns, ...kit.rows.map((r) => kit.columns.map((c) => {
    const v = r.row[c];
    if (v === null || v === undefined) return null;
    if (typeof v === "object") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean") return v;
    return String(v);
  }))];
}

export const ABOUT_SHEET = "About";

/** The About sheet an export adds, so an import knows the table without being told. */
export function aboutSheet(def: TableDef, kitFile: string, rows: number, at: Date): string[][] {
  return [
    ["Formcraft kit table", def.title],
    ["table", def.id],
    ["key", def.key.join("+")],
    ["kit file", kitFile],
    ["exported", at.toISOString()],
    ["rows", String(rows)],
    ["how", "Edit the first sheet. Keep the header row and the key column. fmc_tables import shows the changes (a dry run), then writes a proposed kit file in staging and a kit change request; the kit changes only when a person publishes it."],
  ];
}

/** The table and key an export's About sheet names, or null. */
export function readAbout(sheets: Map<string, string[][]>): { table: string; key: string } | null {
  const about = sheets.get(ABOUT_SHEET);
  if (!about) return null;
  const get = (name: string) => about.find((r) => (r[0] ?? "").trim() === name)?.[1]?.trim() ?? "";
  const table = get("table");
  return table ? { table, key: get("key") } : null;
}

/** The sheet to compare: the one named, else the table's id or twin sheet, else the first that isn't About. */
export function pickSheet(sheets: Map<string, string[][]>, def: TableDef, name = ""): { name?: string; problem?: string } {
  const names = [...sheets.keys()];
  if (name.trim()) return names.includes(name.trim()) ? { name: name.trim() } : { problem: `The workbook has no sheet "${name}" (it has ${names.join(", ")})` };
  const hit = names.find((n) => n === def.id.slice(0, 31)) ?? names.find((n) => n === def.twin?.sheet) ?? names.find((n) => n !== ABOUT_SHEET);
  return hit ? { name: hit } : { problem: "The workbook has no sheets" };
}

// ---------- the kit change request ----------

const show = (v: unknown) => v === null || v === undefined || v === "" ? "(empty)" : typeof v === "object" ? JSON.stringify(v) : String(v).replace(/\r?\n/g, " ⏎ ");

export interface ChangeRequestInfo {
  id: string; title: string; kitFile: string; proposedFile: string; workbook: string; sheet: string;
  by: string; at: Date; reason: string;
}

/** The kit change request for the person who publishes: every added, removed and changed row, cell by cell. */
export function changeRequestMarkdown(info: ChangeRequestInfo, d: TableDiff): string {
  const L: string[] = [];
  L.push(`# Kit change request ${info.id}: ${info.title}`, "");
  L.push(`- **Kit file:** ${info.kitFile}`, `- **Proposed file (staging):** ${info.proposedFile}`,
    `- **From:** ${info.workbook}, sheet ${info.sheet}`, `- **Raised by:** ${info.by}, ${info.at.toISOString()}`,
    `- **Why:** ${info.reason || "(not given)"}`,
    `- **Summary:** ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.unchanged} unchanged (key ${d.key})`, "");
  if (d.workbook_only_columns.length) L.push(`Columns only in the workbook (not imported): ${d.workbook_only_columns.join(", ")}`, "");
  if (d.kit_only_columns.length) L.push(`Kit columns the workbook doesn't have (kept as they are): ${d.kit_only_columns.join(", ")}`, "");
  if (d.added.length) { L.push("## Added", ""); for (const a of d.added) L.push(`- ${a.key} (row ${a.row})`); L.push(""); }
  if (d.removed.length) { L.push("## Removed", ""); for (const r of d.removed) L.push(`- ${r.key}`); L.push(""); }
  if (d.changed.length) {
    L.push("## Changed", "", "| Key | Column | Kit | Proposed |", "|---|---|---|---|");
    const cell = (s: string) => s.replace(/\|/g, "\\|");
    for (const c of d.changed) for (const x of c.cells) L.push(`| ${cell(c.key)} | ${cell(x.column)} | ${cell(show(x.kit))} | ${cell(show(x.workbook))} |`);
    L.push("");
  }
  if (d.problems.length) { L.push("## Problems", ""); for (const p of d.problems) L.push(`- ${p.blocking ? "**Must fix:** " : ""}${p.detail}`); L.push(""); }
  if (d.notes.length) { L.push("## Notes", ""); for (const n of d.notes) L.push(`- ${n}`); L.push(""); }
  L.push("## To publish (a person, not a tool)", "",
    "1. Compare the proposed file with the kit file and check every change above.",
    "2. Copy it over the kit file in 03_Master_Data, and make the same change in the kit's Excel twin and its build source where it has one.",
    "3. Record it in the kit's ChangeLog with a CR reference and the approver, and update the kit version.",
    "", "No Formcraft tool writes into the kit (CLAUDE.md, rule 2 and 7).", "");
  return L.join("\r\n");
}

/** A one-line summary for the pane and the automation step. */
export function diffSummary(d: TableDiff): string {
  const must = blocking(d).length;
  return `${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed` +
    (d.problems.length ? `; ${d.problems.length} problem${d.problems.length === 1 ? "" : "s"}${must ? ` (${must} to fix)` : ""}` : "");
}

/** The diff for a reply: everything (full), or counts and the first rows of each (summary). */
export function diffForReply(d: TableDiff, detail: "summary" | "full", limit = 25) {
  if (detail === "full") return d;
  const cut = <T>(a: T[]) => a.slice(0, limit);
  return { ...d, added: cut(d.added), removed: cut(d.removed), changed: cut(d.changed), problems: cut(d.problems),
    counts: { added: d.added.length, removed: d.removed.length, changed: d.changed.length, unchanged: d.unchanged, problems: d.problems.length },
    ...(Math.max(d.added.length, d.removed.length, d.changed.length, d.problems.length) > limit ? { more: `Lists are cut at ${limit}; detail: "full" gives every row` } : {}) };
}
