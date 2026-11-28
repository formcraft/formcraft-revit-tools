/**
 * The standards bank for fmc_permit_check: FMC_Standards_Building.json (values) and FMC_Standards_Sources.json (gaps,
 * conflicts, lost digits). Read at run time from a configurable folder (defaults.ts). The guard config file is not read.
 * Nothing here holds a regulation value: a key missing from the bank is reported as missing, never defaulted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface BankEntry {
  value: unknown; uses?: Record<string, unknown>; unit?: string; note?: string; status?: string; clause?: string; sources?: string[];
}

export interface Bank {
  file: string; found: boolean; bytes: number; sha256: string; version: string; status: string;
  entries: Record<string, BankEntry>; error?: string;
}

export interface SourceGapRef { id: string; source: string; what: string; where: string; kind: string; status: string }
export interface SourcesIndex { file: string; found: boolean; gaps: Record<string, SourceGapRef>; error?: string }

export interface Cited {
  key: string; found: boolean; value: unknown; unit: string; status: string; clause: string; note: string;
}

export type Reader = (file: string) => string;
const defaultReader: Reader = (file) => fs.readFileSync(file, "utf8");

function parse(text: string): unknown { return JSON.parse(text.replace(/^\uFEFF/, "")); }

/** Loads the bank from text or a file. A missing or broken file gives found false and no entries. */
export function loadBank(file: string, read: Reader = defaultReader): Bank {
  let text = "";
  try { text = read(file); } catch (e) {
    return { file, found: false, bytes: 0, sha256: "", version: "", status: "", entries: {}, error: `not readable: ${e instanceof Error ? e.message : String(e)}` };
  }
  return bankFromText(file, text);
}

export function bankFromText(file: string, text: string): Bank {
  const sha256 = crypto.createHash("sha256").update(text).digest("hex");
  try {
    const json = parse(text) as { version?: string; status?: string; standards?: Record<string, BankEntry> };
    const entries = json && typeof json.standards === "object" && json.standards ? json.standards : {};
    return { file, found: true, bytes: Buffer.byteLength(text), sha256, version: String(json.version ?? ""), status: String(json.status ?? ""), entries };
  } catch (e) {
    return { file, found: false, bytes: Buffer.byteLength(text), sha256, version: "", status: "", entries: {}, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function loadSources(file: string, read: Reader = defaultReader): SourcesIndex {
  let text = "";
  try { text = read(file); } catch (e) { return { file, found: false, gaps: {}, error: `not readable: ${e instanceof Error ? e.message : String(e)}` }; }
  try {
    const json = parse(text) as { sources?: Array<{ id?: string; gaps?: Array<Partial<SourceGapRef>> }> };
    const gaps: Record<string, SourceGapRef> = {};
    for (const s of json.sources ?? []) for (const g of s.gaps ?? []) {
      if (!g.id) continue;
      gaps[g.id] = { id: g.id, source: String(s.id ?? ""), what: String(g.what ?? ""), where: String(g.where ?? ""), kind: String(g.kind ?? ""), status: String(g.status ?? "") };
    }
    return { file, found: true, gaps };
  } catch (e) { return { file, found: false, gaps: {}, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
}

export function bankPaths(dir: string, buildingFile: string, sourcesFile: string): { building: string; sources: string } {
  // path.win32 joins a Windows folder correctly; a POSIX folder (tests on a POSIX box) keeps POSIX separators.
  const join = dir.includes("\\") || /^[a-z]:/i.test(dir) ? path.win32.join : path.join;
  return { building: join(dir, buildingFile), sources: join(dir, sourcesFile) };
}

/** The status a value carries: its own, else the file's ("0.5-proposed" reads as proposed). */
function statusOf(bank: Bank, e: BankEntry): string {
  if (e.status) return e.status;
  return /^approved/i.test(bank.status) ? "approved" : "proposed";
}

/** One bank value: the use's value when `use` is given and present, else value. Missing keys say so. */
export function cite(bank: Bank, key: string, fallbackClause = "", use?: string): Cited {
  const e = bank.entries[key];
  if (!e || typeof e !== "object") return { key, found: false, value: null, unit: "", status: "missing", clause: fallbackClause, note: "" };
  const value = use && e.uses && use in e.uses ? e.uses[use] : e.value;
  return {
    key, found: value !== undefined && value !== null, value: value ?? null, unit: e.unit ?? "", status: statusOf(bank, e),
    clause: (e.clause ?? "").trim() || fallbackClause, note: String(e.note ?? "").split(" | was:")[0],
  };
}

/** A finite number, from a number or a numeric string. */
export function num(x: unknown): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** A field of an object value ({ max_floor_area_m2: 30 } -> 30). */
export function field(c: Cited, name: string): unknown {
  return c.value && typeof c.value === "object" && !Array.isArray(c.value) ? (c.value as Record<string, unknown>)[name] : undefined;
}

export function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.map((v) => String(v)).filter((v) => v.trim().length > 0) : [];
}

/** Parses a bank scale text: "1:100, 1:50 or 1:20" -> list; "1:2500 to 1:100" -> range. */
export function parseScales(text: unknown): { list: number[]; range?: [number, number] } {
  const t = String(text ?? "");
  const all = [...t.matchAll(/1\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  if (/\bto\b/i.test(t) && all.length === 2) return { list: [], range: [Math.min(...all), Math.max(...all)] };
  return { list: all };
}

export function scaleAllowed(scale: number, allowed: { list: number[]; range?: [number, number] }): boolean {
  if (allowed.range) return scale >= allowed.range[0] && scale <= allowed.range[1];
  return allowed.list.includes(scale);
}

export function fingerprint(bank: Bank, sources: SourcesIndex) {
  return {
    building_file: bank.file, building_found: bank.found, building_bytes: bank.bytes, building_sha256: bank.sha256,
    building_version: bank.version, building_status: bank.status, keys: Object.keys(bank.entries).length,
    sources_file: sources.file, sources_found: sources.found, gap_ids: Object.keys(sources.gaps).length,
    ...(bank.error ? { building_error: bank.error } : {}), ...(sources.error ? { sources_error: sources.error } : {}),
  };
}
