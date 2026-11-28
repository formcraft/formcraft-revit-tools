/**
 * The fmc_health tool's view of the health report (Tool Research, fmc_health).
 * - warnings[]: a Revit not answering or held by a dialog, a hard memory pause, a sync error on an open document,
 *   a server and add-in built from different commits, a tool module that failed to register.
 * - ok is false when any warning is an error. server_ok keeps the old meaning (every tool module registered),
 *   which HTTP /health and the updater's health check still use.
 * - document narrows instances and sync rows to one model; summary drops the long sections.
 * - A sync error for a document that is not open now is history: it moves to stale_error and raises no warning.
 * Pure: no Revit call, no file read.
 */
import { documentKey } from "./batchline.js";
import type { HealthReport } from "./httpservice.js";

export interface HealthWarning {
  code: string;
  severity: "error" | "warn";
  message: string;
  document?: string;
  pid?: number;
}

export interface HealthViewOptions {
  document?: string;
  summary?: boolean;
}

function stripDirty(commit: string): string {
  return String(commit ?? "").replace(/\+.*$/, "").trim();
}

/** True when every announced add-in build is the server commit (prefix either way). Null when nothing to compare. */
export function buildMatch(server: string, addins: string[]): boolean | null {
  const running = stripDirty(server);
  const builds = addins.map(stripDirty).filter((b) => b && b !== "unknown");
  if (!running || running === "unknown" || builds.length === 0) return null;
  return builds.every((b) => b.startsWith(running) || running.startsWith(b));
}

function sameDocument(a: string, b: string): boolean {
  if (!a || !b) return false;
  return documentKey(a) === documentKey(b);
}

type SyncRow = Record<string, unknown> & { document?: string; last_error?: unknown };

/** Sync rows with errors for closed documents moved to stale_error. */
export function ageSyncRows(rows: SyncRow[], openNames: string[]): SyncRow[] {
  return rows.map((row) => {
    const name = String(row.document ?? "");
    const open = openNames.some((n) => sameDocument(n, name));
    if (open || row.last_error == null || row.last_error === "") return { ...row, open };
    const { last_error, ...rest } = row;
    return { ...rest, open, last_error: null, stale_error: last_error };
  });
}

export function healthWarnings(report: HealthReport, syncs: SyncRow[]): HealthWarning[] {
  const warnings: HealthWarning[] = [];
  for (const f of report.registration.failed) {
    warnings.push({ code: "FMC-HEALTH-REGISTRATION", severity: "error", message: `Tool module ${f.file} failed to register: ${f.error}` });
  }
  for (const row of report.instances) {
    if (row.verdict === "waiting_for_idle" && row.busy) {
      const dialog = row.busy.dialog ? ` A dialog is open (${row.busy.dialog}): a person must answer it.` : "";
      warnings.push({
        code: row.busy.dialog ? "FMC-HEALTH-REVIT-DIALOG" : "FMC-HEALTH-REVIT-BUSY",
        severity: row.busy.dialog ? "error" : "warn", pid: row.pid,
        message: `Revit pid ${row.pid} is running ${row.busy.command || "a job"} for ${row.busy.since_s} s.${dialog}`,
      });
    } else if (!row.answering) {
      warnings.push({ code: "FMC-HEALTH-REVIT-NOT-ANSWERING", severity: "error", pid: row.pid, message: `Revit pid ${row.pid} on port ${row.port} does not answer (${row.verdict}).` });
    }
  }
  const mem = report.memory as unknown as { tier?: string; paused?: boolean; free_mb?: number; reason?: string } | undefined;
  if (mem && (mem.paused || mem.tier === "hard")) {
    warnings.push({ code: "FMC-MEMORY-HARD", severity: "error", message: mem.reason || `${mem.free_mb} MB free. Model-changing calls wait.` });
  } else if (mem && mem.tier === "soft") {
    warnings.push({ code: "FMC-MEMORY-SOFT", severity: "warn", message: mem.reason || `${mem.free_mb} MB free.` });
  }
  for (const row of syncs) {
    if (row.open && row.last_error != null && row.last_error !== "") {
      warnings.push({ code: "FMC-HEALTH-SYNC-ERROR", severity: "error", document: String(row.document ?? ""), message: String(row.last_error) });
    }
  }
  const match = buildMatch(report.server.commit, report.addin);
  if (match === false) {
    warnings.push({
      code: "FMC-HEALTH-BUILD-MISMATCH", severity: "warn",
      message: `The server runs ${stripDirty(report.server.commit)} but Revit's add-in is ${report.addin.join(", ")}. If an install just ran: quit the Claude app completely (also from the system tray), reopen it, and restart Revit when no one is working in it.`,
    });
  }
  return warnings;
}

/** The reply fmc_health returns. */
export function healthView(report: HealthReport, options: HealthViewOptions = {}): Record<string, unknown> {
  const doc = (options.document ?? "").trim();
  const openNames = report.instances.flatMap((row) => row.documents.flatMap((d) => [d.title, d.path].filter(Boolean)));
  const batches = (report.batches ?? {}) as Record<string, unknown>;
  const rawSyncs = Array.isArray(batches.syncs) ? (batches.syncs as SyncRow[]) : [];
  let syncs = ageSyncRows(rawSyncs, openNames);
  let instances = report.instances;
  let resolved = report.resolved_document;
  let documentNote: string | undefined;
  if (doc) {
    instances = report.instances.filter((row) => row.documents.some((d) => sameDocument(d.title, doc) || sameDocument(d.path, doc)));
    syncs = syncs.filter((row) => sameDocument(String(row.document ?? ""), doc));
    const hit = report.instances.flatMap((row) => row.documents).find((d) => sameDocument(d.title, doc) || sameDocument(d.path, doc));
    resolved = hit ? { title: hit.title, path: hit.path } : null;
    if (!hit) documentNote = `[FMC-DOC-NOT-FOUND] No open document has title or path "${doc}". Open: ${[...new Set(report.instances.flatMap((r) => r.documents.map((d) => d.title)))].join(", ") || "(none)"}.`;
  }
  let warnings = healthWarnings({ ...report, instances }, syncs);
  if (doc) warnings = warnings.filter((w) => w.code !== "FMC-HEALTH-SYNC-ERROR" || sameDocument(w.document ?? "", doc));
  const serverOk = report.registration.failed.length === 0;
  const ok = serverOk && !warnings.some((w) => w.severity === "error") && !documentNote;
  const head = {
    ok,
    server_ok: serverOk,
    warnings,
    build: report.build,
    addin: report.addin,
    build_match: buildMatch(report.server.commit, report.addin),
    ...(documentNote ? { note: documentNote } : {}),
  };
  if (options.summary) {
    const mem = report.memory as unknown as { free_mb?: number; tier?: string; paused?: boolean } | undefined;
    return {
      ...head,
      summary: true,
      uptime_s: report.uptime_s,
      resolved_document: resolved,
      instances: instances.map((row) => ({
        pid: row.pid, port: row.port, answering: row.answering, verdict: row.verdict, busy_reason: row.busy_reason,
        documents: row.documents.filter((d) => !d.family).map((d) => (d.active ? `${d.title} (active)` : d.title)),
      })),
      memory: mem ? { free_mb: mem.free_mb, tier: mem.tier, paused: mem.paused } : null,
      registration: { registered: report.registration.registered, skipped: report.registration.skipped, failed: report.registration.failed.length },
      queue_waiting: ((report.queue ?? []) as unknown as Array<{ waiting?: number }>).reduce((n, q) => n + (Number(q?.waiting) || 0), 0),
      syncs: syncs.filter((row) => row.open).map((row) => ({ document: row.document, last_sync_at: row.last_sync_at ?? null, next_sync_at: row.next_sync_at ?? null, last_error: row.last_error ?? null })),
      jobs: report.jobs,
      next: "summary:false returns the full report (batch line, coordination, hardware, schedule).",
    };
  }
  const { ok: _ok, ...rest } = report;
  return {
    ...head,
    ...rest,
    resolved_document: resolved,
    instances,
    batches: { ...batches, syncs },
    schedule: syncs,
  };
}