/**
 * A short pass/fail list from a Run-FmcBatch log and from result JSON files.
 * Read-only. A batch line is the id, how many ops, how many ok, how many failed, and the FMC codes.
 *
 * Two real shapes (Run-FmcBatch.cmd, F26901 night runs):
 * - RUN_ALL_log.txt: one section per batch. "==== <job file name> <date> <time>", then Server, "Batch  <label> on <document>",
 *   Lease, "Preview:", "Apply:", "Verify:" each followed by "  -> <tool>" lines (one per tool call) and the tool replies as JSON
 *   arrays, then "Result log: <file>". The summary is the section's tool calls and what the replies say.
 * - <job>.result-<stamp>.json: { label, ok, applied, declined, error, steps: [{ tool, result }], preview, apply, verify, release }.
 * An op is one item of a modify_model style reply's ops array, or one tool call when the reply has no ops array.
 * A one-line log ("B10 FAIL ops=12 ok=9 failed=3 code=FMC-BATCH-LOCKED") and a result with ops, ok and failed numbers still work.
 */
import fs from "node:fs";
import path from "node:path";

export interface RunRow {
  batch_id: string;
  ops: number;
  ok: number;
  failed: number;
  codes: string[];
  source: string;
  /** Ops that changed nothing and were not errors (a reply with applied false and a reason). Only set when above 0. */
  skipped?: number;
  /** The job file name when the log or result gives one (B03_A_door_window_room_tags). */
  name?: string;
  document?: string;
  /** RN-8: PASS, FAIL, RUNNING (the job was still running or Revit was busy), BLOCKED (refused by a rule or a lock), INCOMPLETE (RN-1). */
  status?: RunStatus;
  /** RN-1: tool calls that printed no reply (a killed runner, a crash, a cut-off log). */
  unknown?: number;
  /** RN-4: when the batch ran, from the section header or the result file's stamp (box-local time, no zone). */
  at?: string;
  /** The result file a log section names (P-fmc_runlog-04). */
  result_file?: string;
}

export type RunStatus = "PASS" | "FAIL" | "RUNNING" | "BLOCKED" | "INCOMPLETE";
export const RUNNING_CODES = new Set(["FMC-JOB-RUNNING", "FMC-BRIDGE-BUSY", "FMC-REVIT-NOT-IDLE"]);
export const BLOCKED_CODES = new Set(["FMC-REGISTER-STATUS", "FMC-BATCH-LOCKED"]);

/** RN-8: one status per row. */
export function rowStatus(row: RunRow, complete = true): RunStatus {
  if (!complete || (row.unknown ?? 0) > 0) return "INCOMPLETE";
  if (row.codes.some((c) => RUNNING_CODES.has(c))) return "RUNNING";
  if (row.failed > 0 && row.codes.some((c) => BLOCKED_CODES.has(c))) return "BLOCKED";
  if (row.failed > 0) return "FAIL";
  return "PASS";
}

/** RN-4: "Mon 11/23/2026  1:25:09.40" (cmd %date% %time%) or a "20261123-012558" stamp into "2026-11-23T01:25:09". */
export function parseRunTime(text: string): string {
  const p = (n: string) => n.padStart(2, "0");
  const us = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/.exec(text);
  if (us) return `${us[3]}-${p(us[1])}-${p(us[2])}T${p(us[4])}:${us[5]}:${us[6]}`;
  const stamp = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(text);
  if (stamp) return `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}`;
  return "";
}

/** A code in free text is written [FMC-X-Y]. A bare FMC-... is also a document name (FMC-ZZ-ZZ-M3-A-0002), so only a code field or a bracket counts. */
const BRACKET_CODE = /\[(FMC-[A-Z0-9]+(?:-[A-Z0-9]+)*)\]/g;
const LOOSE_CODE = /FMC-[A-Z0-9-]+/g;
const BATCH = /\b(B\d{2,}[A-Z0-9-]*|batch[-_ ]?[A-Za-z0-9-]+)\b/i;

function looseCodes(text: string): string[] {
  return [...new Set((text.match(LOOSE_CODE) ?? []))];
}

function bracketCodes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(BRACKET_CODE)) out.push(m[1]);
  return out;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** "B03_A_door_window_room_tags.result-20261123-012558.json" is the job B03_A_door_window_room_tags. */
function jobName(file: string): string {
  return path.basename(file).replace(/\.json$/i, "").replace(/\.result-\d{8}-\d{6}$/i, "");
}

function batchIdOf(body: Record<string, unknown>, file: string): string {
  const release = rec(body.release);
  for (const value of [body.batch_id, body.batch, release?.batch_id, body.label, release?.label, body.id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return jobName(file);
}

/** Codes a tool reply carries: code and codes fields, and [FMC-...] in its text, error and reason. Never a document name. */
function codesOfReply(reply: Record<string, unknown>): string[] {
  const found: string[] = [];
  const take = (v: unknown) => { if (typeof v === "string") found.push(...bracketCodes(v), ...(/^FMC-[A-Z0-9-]+$/.test(v) ? [v] : [])); };
  take(reply.code);
  if (Array.isArray(reply.codes)) reply.codes.forEach(take);
  for (const key of ["text", "error", "reason", "message", "detail"]) {
    const v = reply[key];
    if (typeof v === "string") found.push(...bracketCodes(v));
  }
  return found;
}

function badOp(op: unknown): boolean {
  const row = rec(op);
  if (!row) return true;
  return row.ok === false || row.applied === false && typeof row.error === "string" || row.refused === true
    || (typeof row.error === "string" && row.error.length > 0) || typeof row.code === "string";
}

interface Tally { ops: number; ok: number; failed: number; skipped: number; codes: string[]; running?: number }

/** One tool call of a batch: { tool, result }. */
function tallyStep(step: unknown, into: Tally): void {
  const row = rec(step);
  const reply = rec(row?.result) ?? rec(step);
  if (!reply) { into.ops += 1; into.failed += 1; return; }
  into.codes.push(...codesOfReply(reply));
  if (Array.isArray(reply.ops)) {
    for (const op of reply.ops) {
      into.ops += 1;
      const opRow = rec(op);
      if (opRow) into.codes.push(...codesOfReply(opRow));
      if (badOp(op)) into.failed += 1;
      else into.ok += 1;
    }
    return;
  }
  into.ops += 1;
  const text = typeof reply.text === "string" ? reply.text : "";
  const failedText = /\b(execution failed|compile error|error CS\d+)\b/i.test(text);
  // RN-2: one rule for a reply and an op. A failing code fails it, unless it says the job is still running.
  const code = typeof reply.code === "string" && /^FMC-/.test(reply.code) ? reply.code : "";
  if (reply.ok === false || reply.isError === true || reply.refused === true || typeof reply.error === "string" && reply.error.length > 0 || failedText) into.failed += 1;
  else if (reply.applied === false && typeof reply.reason === "string") into.skipped += 1;
  else if (code && RUNNING_CODES.has(code)) into.running = (into.running ?? 0) + 1;
  else if (code && reply.ok !== true) into.failed += 1;
  else if (reply.applied === false) into.failed += 1;
  else into.ok += 1;
}

function rowFrom(id: string, source: string, tally: Tally, extra: Partial<RunRow> = {}, complete = true): RunRow {
  const row: RunRow = { batch_id: id, ops: tally.ops, ok: tally.ok, failed: tally.failed, codes: [...new Set(tally.codes)], source };
  if (tally.skipped > 0) row.skipped = tally.skipped;
  if (extra.name) row.name = extra.name;
  if (extra.document) row.document = extra.document;
  if (extra.unknown) row.unknown = extra.unknown;
  if (extra.at) row.at = extra.at;
  if (extra.result_file) row.result_file = extra.result_file;
  row.status = rowStatus(row, complete);
  return row;
}

/** The batch's own error or a ok:false is a failure even when every tool call replied. */
function applyBatchOutcome(body: Record<string, unknown>, tally: Tally): void {
  const err = body.error;
  const errText = typeof err === "string" ? err : err && typeof err === "object" ? JSON.stringify(err) : "";
  if (errText) tally.codes.push(...bracketCodes(errText), ...(rec(err) && typeof rec(err)?.code === "string" ? [String(rec(err)?.code)] : []));
  if ((errText || body.ok === false) && tally.failed === 0) tally.failed = 1;
}

/** One result JSON object, or a file that holds several. */
export function summariseResult(body: unknown, source: string): RunRow[] {
  if (Array.isArray(body)) return body.flatMap((item, index) => summariseResult(item, `${source}#${index}`));
  const row = rec(body);
  if (!row) return [];
  if (Array.isArray(row.batches)) return summariseResult(row.batches, source);
  if (Array.isArray(row.results)) return summariseResult(row.results, source);
  const id = batchIdOf(row, source);
  const at = parseRunTime(path.basename(source)) || str(row.finished_at) || str(row.started_at);
  const extra = { name: jobName(source), document: str(row.document) || str(rec(row.release)?.document), ...(at ? { at } : {}) };
  // RN-6: a result that ran no step and has no ops is a row, INCOMPLETE, not nothing
  if (Array.isArray(row.steps) && row.steps.length === 0 && !Array.isArray(row.ops) && asNumber(row.ops) == null) {
    const tally: Tally = { ops: 0, ok: 0, failed: 0, skipped: 0, codes: [] };
    applyBatchOutcome(row, tally);
    return [rowFrom(id, source, tally, extra, false)];
  }
  // Run-FmcBatch result: the tool calls are steps (or preview, apply and verify in order)
  const steps = Array.isArray(row.steps) ? row.steps
    : ["preview", "apply", "verify"].flatMap((k) => (Array.isArray(row[k]) ? row[k] as unknown[] : []));
  if (steps.length > 0 && !Array.isArray(row.ops)) {
    const tally: Tally = { ops: 0, ok: 0, failed: 0, skipped: 0, codes: [] };
    for (const step of steps) tallyStep(step, tally);
    applyBatchOutcome(row, tally);
    return [rowFrom(id, source, tally, extra)];
  }
  if (Array.isArray(row.ops)) {
    const tally: Tally = { ops: 0, ok: 0, failed: 0, skipped: 0, codes: [] };
    for (const op of row.ops) {
      tally.ops += 1;
      const opRow = rec(op);
      if (opRow) tally.codes.push(...codesOfReply(opRow));
      if (badOp(op)) tally.failed += 1;
      else tally.ok += 1;
    }
    tally.codes.push(...looseCodes(JSON.stringify({ code: row.code, error: row.error, codes: row.codes })));
    return [rowFrom(id, source, tally, extra)];
  }
  const ops = asNumber(row.ops) ?? asNumber(row.op_count) ?? 0;
  const failed = asNumber(row.failed) ?? asNumber(row.fail) ?? (row.ok === false || row.passed === false ? 1 : 0);
  const ok = asNumber(row.ok_count) ?? asNumber(row.passed_ops) ?? (typeof row.ok === "number" ? row.ok : Math.max(0, ops - failed));
  const listed = Array.isArray(row.codes) ? row.codes.map((item) => String(item)) : [];
  const codes = [...new Set([...listed, ...looseCodes(JSON.stringify(row))])];
  if (!ops && !failed && !ok && !codes.length && row.ok !== true && row.passed !== true) return [];
  const plain: RunRow = { batch_id: id, ops, ok, failed, codes, source, ...(extra.name ? { name: extra.name } : {}), ...(extra.at ? { at: extra.at } : {}) };
  plain.status = rowStatus(plain);
  return [plain];
}

const SECTION = /^====\s+(\S+)(?:\s+(.*))?$/;

/**
 * Replies in a log are printed as JSON arrays that start with "[" in column 0 and end with "]" in column 0.
 * Returns the parsed arrays, or the raw text when a block does not parse (a cut-off log).
 */
function replyBlocks(lines: string[]): { blocks: unknown[]; text: string[] } {
  const blocks: unknown[] = [];
  const text: string[] = [];
  let buffer: string[] | null = null;
  for (const line of lines) {
    if (buffer) {
      buffer.push(line);
      if (line.startsWith("]")) {
        try { blocks.push(...(JSON.parse(buffer.join("\n")) as unknown[])); } catch { text.push(buffer.join("\n")); }
        buffer = null;
      }
      continue;
    }
    // a reply block opens with "[" alone or "[{"; a runner line such as "[FMC-BATCH-LOCKED] ..." is plain text
    if (line.trimEnd() === "[]") continue;
    if (line.trimEnd() === "[" || /^\[\s*\{/.test(line)) {
      if (line.trim().length > 1 && line.trim().endsWith("]")) {
        try { blocks.push(...(JSON.parse(line) as unknown[])); } catch { text.push(line); }
        continue;
      }
      buffer = [line];
      continue;
    }
    text.push(line);
  }
  if (buffer) text.push(buffer.join("\n"));
  return { blocks, text };
}

/** One "==== job" section of RUN_ALL_log.txt. */
function summariseSection(name: string, lines: string[], source: string, header = ""): RunRow | null {
  const { blocks, text } = replyBlocks(lines);
  let label = "";
  let document = "";
  let arrows = 0;
  let closed = false;
  let resultFile = "";
  const codes: string[] = [];
  let errored = false;
  for (const raw of text) {
    const line = raw.trim();
    const batch = /^Batch\s+(\S+)(?:\s+on\s+(.+))?$/.exec(line);
    if (batch) { label = batch[1]; document = (batch[2] ?? "").trim(); continue; }
    if (/^->\s*\S+/.test(line)) { arrows += 1; continue; }
    const result = /^Result log:\s*(.+)$/.exec(line);
    if (result) { closed = true; resultFile = path.win32.basename(result[1].trim()); continue; }
    if (/^DONE\b/.test(line)) { closed = true; continue; }
    if (!line || /^(Server|Lease)\b/.test(line) || /^(Preview|Apply|Verify):/.test(line)) continue;
    // anything else the runner printed outside a reply: an error line, a refusal, a decline
    codes.push(...bracketCodes(line), ...looseCodes(line).filter((c) => !/^FMC-[A-Z]{2}-[A-Z]{2}-/.test(c)));
    if (/\b(FAIL(ED)?|ERROR|REFUSED|DECLINED|ABORT(ED)?)\b/i.test(line)) errored = true;
  }
  const tally: Tally = { ops: 0, ok: 0, failed: 0, skipped: 0, codes };
  for (const step of blocks) tallyStep(step, tally);
  // RN-1: a tool call that printed no parseable reply still counts as an op, but it is unknown, never ok
  const unknown = Math.max(0, arrows - blocks.length);
  tally.ops += unknown;
  if (errored && tally.failed === 0) tally.failed = 1;
  if (tally.ops === 0 && !errored) return null;
  const at = parseRunTime(header);
  return rowFrom(label || name, source, tally, { name, document, unknown, ...(at ? { at } : {}), ...(resultFile ? { result_file: resultFile } : {}) }, closed);
}

/** RUN_ALL_log.txt. Sections ("==== job ...") are the real format; a one-line "B09 PASS ops=4 ok=4 failed=0" log still works. */
export function summariseLog(text: string, source: string): RunRow[] {
  const all = text.split(/\r?\n/);
  if (all.some((line) => SECTION.test(line))) {
    const rows: RunRow[] = [];
    let name = "";
    let header = "";
    let chunk: string[] = [];
    const flush = () => {
      if (!name) return;
      const row = summariseSection(name, chunk, source, header);
      if (row) rows.push(row);
    };
    for (const line of all) {
      const head = SECTION.exec(line);
      if (head) { flush(); name = head[1]; header = head[2] ?? ""; chunk = []; continue; }
      chunk.push(line);
    }
    flush();
    return rows;
  }
  const rows: RunRow[] = [];
  for (const line of all) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const id = BATCH.exec(trimmed)?.[1];
    if (!id) continue;
    const pass = /\b(PASS|OK)\b/i.test(trimmed) && !/\b(FAIL|ERROR)\b/i.test(trimmed);
    const fail = /\b(FAIL|ERROR)\b/i.test(trimmed);
    if (!pass && !fail) continue;
    const ops = Number(/ops[=: ]+(\d+)/i.exec(trimmed)?.[1] ?? 0);
    const ok = Number(/(?:ok|passed)[=: ]+(\d+)/i.exec(trimmed)?.[1] ?? (pass ? ops : 0));
    const failed = Number(/fail(?:ed)?[=: ]+(\d+)/i.exec(trimmed)?.[1] ?? (fail ? 1 : 0));
    const one: RunRow = { batch_id: id, ops, ok, failed, codes: looseCodes(trimmed), source };
    one.status = rowStatus(one);
    rows.push(one);
  }
  return rows;
}

/**
 * P-fmc_runlog-04: in a folder, a log section and the result JSON of the same run are one batch. The result row is kept
 * (it has the steps); the log row goes when it names that result file, or the same job's result is stamped within an hour after it.
 */
export function dedupeRuns(rows: RunRow[]): { rows: RunRow[]; dropped: number } {
  const results = rows.filter((r) => /\.json(#\d+)?$/i.test(r.source));
  const isDup = (log: RunRow) => results.some((res) => {
    if (log.result_file && res.source.split("#")[0].toLowerCase() === log.result_file.toLowerCase()) return true;
    if (!log.name || res.name !== log.name || !log.at || !res.at) return false;
    const gap = Date.parse(res.at) - Date.parse(log.at);
    return Number.isFinite(gap) && gap >= 0 && gap <= 3600_000;
  });
  const out = rows.filter((r) => /\.json(#\d+)?$/i.test(r.source) || !isDup(r));
  return { rows: out, dropped: rows.length - out.length };
}

/** RN-4: since (a date or date-time, box-local) and the latest row per job. */
export function filterRuns(rows: RunRow[], opts: { since?: string; latest_per_job?: boolean }): RunRow[] {
  let out = rows;
  if (opts.since && opts.since.trim()) {
    const since = opts.since.trim();
    out = out.filter((r) => !!r.at && r.at >= since);
  }
  if (opts.latest_per_job) {
    const best = new Map<string, RunRow>();
    for (const r of out) {
      const key = r.name || r.batch_id;
      const prev = best.get(key);
      if (!prev || (r.at ?? "") >= (prev.at ?? "")) best.set(key, r);
    }
    out = [...best.values()];
  }
  return out;
}

export const RUNLOG_MAX_BYTES = 20 * 1024 * 1024;

export function summarisePath(target: string, maxBytes = RUNLOG_MAX_BYTES): { rows: RunRow[]; errors: string[]; skipped_files: string[]; duplicates_dropped: number; found: boolean } {
  const rows: RunRow[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  let stat: fs.Stats | null = null;
  try { stat = fs.existsSync(target) ? fs.statSync(target) : null; } catch (error) { errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!stat) return { rows, errors: errors.length ? errors : [`Not found: ${target}`], skipped_files: skipped, duplicates_dropped: 0, found: false };
  // RN-5: a broken link or a locked file is a skipped file, not a failed call
  const sizeOf = (file: string): number | null => { try { const s = fs.statSync(file); return s.isFile() ? s.size : null; } catch { skipped.push(`${path.basename(file)}: unreadable`); return null; } };
  let files: string[] = [];
  try {
    files = stat.isDirectory() ? fs.readdirSync(target).map((name) => path.join(target, name)) : [target];
  } catch (error) { errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`); }
  for (const file of files) {
    const base = path.basename(file);
    const size = sizeOf(file);
    if (size == null) continue;
    if (size > maxBytes) { skipped.push(`${base}: ${Math.round(size / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB limit`); continue; }
    let text = "";
    try { text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""); } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (base.toLowerCase().endsWith(".json")) {
      try { rows.push(...summariseResult(JSON.parse(text), base)); }
      catch (error) { errors.push(`${base}: ${error instanceof Error ? error.message : String(error)}`); }
      continue;
    }
    // a folder holds the job files, the .cmd and the README next to the log: only a log is read as one
    if (stat.isDirectory() && !/\.(txt|log)$/i.test(base)) continue;
    rows.push(...summariseLog(text, base));
  }
  const deduped = stat.isDirectory() ? dedupeRuns(rows) : { rows, dropped: 0 };
  return { rows: deduped.rows, errors, skipped_files: skipped, duplicates_dropped: deduped.dropped, found: true };
}

export function formatRows(rows: RunRow[]): string {
  if (!rows.length) return "No batches.";
  const lines = rows.map((row) => {
    const mark = row.status ?? rowStatus(row);
    const codes = row.codes.length ? ` ${row.codes.join(",")}` : "";
    const skipped = row.skipped ? ` skipped=${row.skipped}` : "";
    const unknown = row.unknown ? ` unknown=${row.unknown}` : "";
    return `${mark} ${row.batch_id} ops=${row.ops} ok=${row.ok} failed=${row.failed}${skipped}${unknown}${codes}`;
  });
  const incomplete = rows.filter((r) => (r.status ?? rowStatus(r)) === "INCOMPLETE").length;
  if (incomplete) lines.push(`${rows.length} batches, ${incomplete} incomplete`);
  return lines.join("\n");
}
