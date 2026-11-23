/**
 * A short pass/fail list from a Run-FmcBatch log and from result JSON files.
 * Read-only. A batch line is the id, how many ops, how many ok, how many failed, and the FMC codes.
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
}

const CODE = /FMC-[A-Z0-9-]+/g;
const BATCH = /\b(B\d{2,}[A-Z0-9-]*|batch[-_ ]?[A-Za-z0-9-]+)\b/i;

function codesIn(text: string): string[] {
  return [...new Set((text.match(CODE) ?? []))];
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function batchIdOf(body: Record<string, unknown>, file: string): string {
  for (const key of ["batch_id", "batch", "label", "id"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return path.basename(file, path.extname(file));
}

function fromOps(ops: unknown[]): { ops: number; ok: number; failed: number; codes: string[] } {
  let ok = 0;
  let failed = 0;
  const codes: string[] = [];
  for (const op of ops) {
    if (!op || typeof op !== "object") { failed += 1; continue; }
    const row = op as Record<string, unknown>;
    const text = JSON.stringify(row);
    codes.push(...codesIn(text));
    const bad = row.ok === false || row.applied === false || row.refused === true || typeof row.error === "string" || typeof row.code === "string";
    if (bad) failed += 1;
    else ok += 1;
  }
  return { ops: ops.length, ok, failed, codes: [...new Set(codes)] };
}

/** One result JSON object, or a file that holds several. */
export function summariseResult(body: unknown, source: string): RunRow[] {
  if (Array.isArray(body)) return body.flatMap((item, index) => summariseResult(item, `${source}#${index}`));
  if (!body || typeof body !== "object") return [];
  const row = body as Record<string, unknown>;
  if (Array.isArray(row.batches)) return summariseResult(row.batches, source);
  if (Array.isArray(row.results)) return summariseResult(row.results, source);
  const id = batchIdOf(row, source);
  if (Array.isArray(row.ops)) {
    const count = fromOps(row.ops);
    const extra = codesIn(JSON.stringify({ code: row.code, error: row.error, codes: row.codes }));
    return [{ batch_id: id, ops: count.ops, ok: count.ok, failed: count.failed, codes: [...new Set([...count.codes, ...extra])], source }];
  }
  const ops = asNumber(row.ops) ?? asNumber(row.op_count) ?? 0;
  const failed = asNumber(row.failed) ?? asNumber(row.fail) ?? (row.ok === false || row.passed === false ? 1 : 0);
  const ok = asNumber(row.ok_count) ?? asNumber(row.passed_ops) ?? (typeof row.ok === "number" ? row.ok : Math.max(0, ops - failed));
  const listed = Array.isArray(row.codes) ? row.codes.map((item) => String(item)) : [];
  const codes = [...new Set([...listed, ...codesIn(JSON.stringify(row))])];
  if (!ops && !failed && !ok && !codes.length && row.ok !== true && row.passed !== true) return [];
  return [{ batch_id: id, ops, ok, failed, codes, source }];
}

/** RUN_ALL_log.txt lines. A line names a batch and PASS, FAIL, OK or ERROR. */
export function summariseLog(text: string, source: string): RunRow[] {
  const rows: RunRow[] = [];
  for (const line of text.split(/\r?\n/)) {
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
    rows.push({ batch_id: id, ops, ok, failed, codes: codesIn(trimmed), source });
  }
  return rows;
}

export function summarisePath(target: string): { rows: RunRow[]; errors: string[] } {
  const rows: RunRow[] = [];
  const errors: string[] = [];
  const stat = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!stat) return { rows, errors: [`Not found: ${target}`] };
  const files = stat.isDirectory()
    ? fs.readdirSync(target).map((name) => path.join(target, name)).filter((file) => fs.statSync(file).isFile())
    : [target];
  for (const file of files) {
    const base = path.basename(file);
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
    rows.push(...summariseLog(text, base));
  }
  return { rows, errors };
}

export function formatRows(rows: RunRow[]): string {
  if (!rows.length) return "No batches.";
  return rows.map((row) => {
    const mark = row.failed > 0 ? "FAIL" : "PASS";
    const codes = row.codes.length ? ` ${row.codes.join(",")}` : "";
    return `${mark} ${row.batch_id} ops=${row.ops} ok=${row.ok} failed=${row.failed}${codes}`;
  }).join("\n");
}
