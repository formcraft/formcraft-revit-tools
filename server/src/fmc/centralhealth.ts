/**
 * Central model health (Builder 9: Model & Central Health). Pure: no Revit, no file is opened or written here.
 *
 * Reports the size and growth of a central model, its backup folder, stale local copies and borrowed worksets and
 * elements, and plans a scheduled audit and compact. It is read-and-plan only (Rule 6): every audit, compact, sync or
 * relinquish in the plan is a recommendation for a person, and no function here runs one.
 *
 * File facts come through an injected FsLike (name, size, modified time: metadata only, never the model's content),
 * so the tests use a mock and never touch a .rvt file.
 */
import path from "node:path";

const win = path.win32;
const DAY = 86_400_000;
const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface FileFact { path: string; name: string; size_bytes: number; mtime_ms: number }
export interface DirFact { dir: string; exists: boolean; files: FileFact[]; truncated: boolean }
/** Metadata-only file access. The real one is in tools/fmc_central_health.ts; tests pass a mock. */
export interface FsLike {
  /** Size and modified time of a file, or null when it is not there. Never reads the content. */
  stat(p: string): FileFact | null;
  /** Files in a folder (recursive or not), at most `max`. */
  list(dir: string, recursive: boolean, max: number): DirFact;
}

export interface Sample { at: string; size_bytes: number }
export type History = Record<string, Sample[]>;

export interface WorksetLite { name: string; owner: string }
export interface CentralFacts {
  workshared: boolean;
  central: string;
  cloud: boolean;
  user: string;
  worksets: WorksetLite[];
  /** Elements borrowed per owner, when the add-in reports them; null when it does not. */
  borrowed_elements: { owner: string; count: number }[] | null;
}

/** Thresholds are this tool's own defaults, not Revit limits; each can be set per call. */
export const DEFAULTS = {
  stale_days: 14,
  growth_warn_pct: 20,
  growth_window_days: 30,
  central_warn_mb: 500,
  central_act_mb: 1000,
  backup_warn_gb: 20,
  backup_warn_count: 100,
  backup_quiet_days: 7,
  audit_every_days: 30,
  compact_every_days: 90,
} as const;
export type Thresholds = { [K in keyof typeof DEFAULTS]: number };
export interface Options extends Thresholds { last_audit: string; last_compact: string }

export type Level = "info" | "watch" | "act";
export interface Finding { code: string; level: Level; message: string }

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const iso = (ms: number) => new Date(ms).toISOString();
const ageDays = (nowMs: number, mtime: number) => round1(Math.max(0, nowMs - mtime) / DAY);

/** A time the person typed (ISO date or date-time). Null when blank or not a date. */
export function parseWhen(s: string | undefined | null): number | null {
  if (!s || !s.trim()) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : null;
}

export function centralBase(centralPath: string): string {
  return win.basename(centralPath.replace(/[\\/]+$/, "")).replace(/\.rvt$/i, "");
}

/** Where Revit keeps a central's backups by convention: <central folder>\<central name>_backup. */
export function defaultBackupDir(centralPath: string): string {
  const base = centralBase(centralPath);
  const dir = win.dirname(centralPath);
  return win.join(dir, `${base}_backup`);
}

export type CentralKind = "file" | "revit_server" | "cloud" | "unknown";
export function centralKind(centralPath: string, cloud: boolean): CentralKind {
  if (cloud) return "cloud";
  if (!centralPath.trim()) return "unknown";
  if (/^rsn:\/\//i.test(centralPath.trim())) return "revit_server";
  return "file";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A local copy of this central is named <central>_<user>.rvt (Revit's default). Returns the user part, or null. */
export function localUserOf(centralName: string, fileName: string): string | null {
  const base = centralName.replace(/\.rvt$/i, "");
  const m = new RegExp(`^${escapeRe(base)}_(.+)\\.rvt$`, "i").exec(fileName);
  return m ? m[1] : null;
}

/** Revit's own facts, defensively read (the add-in may be older than this server). */
export function normalizeFacts(raw: unknown): CentralFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const worksets = Array.isArray(r.worksets)
    ? (r.worksets as unknown[]).filter((w) => w && typeof w === "object").map((w) => {
        const x = w as Record<string, unknown>;
        return { name: String(x.name ?? ""), owner: String(x.owner ?? "") };
      })
    : [];
  let borrowed: CentralFacts["borrowed_elements"] = null;
  if (Array.isArray(r.borrowed_elements)) {
    borrowed = (r.borrowed_elements as unknown[]).filter((b) => b && typeof b === "object").map((b) => {
      const x = b as Record<string, unknown>;
      return { owner: String(x.owner ?? ""), count: Number(x.count ?? 0) || 0 };
    });
  }
  return {
    workshared: !!r.workshared,
    central: String(r.central ?? ""),
    cloud: !!r.cloud,
    user: String(r.user ?? ""),
    worksets,
    borrowed_elements: borrowed,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// History (size over time)
// ---------------------------------------------------------------------------------------------------------------

export function historyKey(centralPath: string): string {
  return centralPath.trim().toLowerCase();
}

export function parseHistory(text: string): History {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: History = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      out[k] = (v as unknown[])
        .filter((s) => s && typeof s === "object")
        .map((s) => ({ at: String((s as Record<string, unknown>).at ?? ""), size_bytes: Number((s as Record<string, unknown>).size_bytes) }))
        .filter((s) => Number.isFinite(Date.parse(s.at)) && Number.isFinite(s.size_bytes) && s.size_bytes >= 0);
    }
    return out;
  } catch {
    return {};
  }
}

/** Adds one sample unless the last one is the same size and less than `minGapHours` old. Keeps the newest `max`. */
export function addSample(history: History, key: string, sample: Sample, minGapHours = 6, max = 500): { history: History; added: boolean } {
  const list = [...(history[key] ?? [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = list[list.length - 1];
  if (last && last.size_bytes === sample.size_bytes && Date.parse(sample.at) - Date.parse(last.at) < minGapHours * 3_600_000) {
    return { history: { ...history, [key]: list }, added: false };
  }
  list.push(sample);
  return { history: { ...history, [key]: list.slice(-max) }, added: true };
}

export interface GrowthReport {
  status: "no_size" | "insufficient_history" | "stable" | "growing" | "shrinking";
  flagged: boolean;
  samples_in_window: number;
  window_days: number;
  baseline_at: string | null;
  baseline_bytes: number | null;
  current_bytes: number | null;
  delta_bytes: number | null;
  delta_pct: number | null;
  per_day_bytes: number | null;
  days_to_act_size: number | null;
}

export function growthReport(history: Sample[], currentBytes: number | null, nowMs: number,
  o: Pick<Thresholds, "growth_warn_pct" | "growth_window_days" | "central_act_mb">): GrowthReport {
  const empty: GrowthReport = {
    status: "no_size", flagged: false, samples_in_window: 0, window_days: o.growth_window_days, baseline_at: null, baseline_bytes: null,
    current_bytes: currentBytes, delta_bytes: null, delta_pct: null, per_day_bytes: null, days_to_act_size: null,
  };
  if (currentBytes == null) return empty;
  const windowStart = nowMs - o.growth_window_days * DAY;
  const inWindow = history
    .map((s) => ({ t: Date.parse(s.at), size: s.size_bytes }))
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.size) && s.t >= windowStart && s.t <= nowMs)
    .sort((a, b) => a.t - b.t);
  const base = inWindow[0];
  const days = base ? (nowMs - base.t) / DAY : 0;
  if (!base || days < 1) return { ...empty, status: "insufficient_history", samples_in_window: inWindow.length };
  const delta = currentBytes - base.size;
  const pct = base.size > 0 ? round1((delta / base.size) * 100) : null;
  const perDay = delta / days;
  const actBytes = o.central_act_mb * MB;
  const status: GrowthReport["status"] = pct == null ? "stable" : pct >= 1 ? "growing" : pct <= -1 ? "shrinking" : "stable";
  return {
    status,
    flagged: pct != null && pct >= o.growth_warn_pct,
    samples_in_window: inWindow.length,
    window_days: o.growth_window_days,
    baseline_at: iso(base.t),
    baseline_bytes: base.size,
    current_bytes: currentBytes,
    delta_bytes: delta,
    delta_pct: pct,
    per_day_bytes: Math.round(perDay),
    days_to_act_size: perDay > 0 && currentBytes < actBytes ? Math.ceil((actBytes - currentBytes) / perDay) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Backups, stale locals, borrowed
// ---------------------------------------------------------------------------------------------------------------

export interface BackupReport {
  folder: string;
  state: "not_checked" | "not_found" | "empty" | "ok" | "watch";
  count: number;
  total_bytes: number;
  total_human: string;
  newest_at: string | null;
  oldest_at: string | null;
  newest_age_days: number | null;
  ratio_to_central: number | null;
  largest: { name: string; size_human: string }[];
  truncated: boolean;
  warnings: string[];
}

export function backupReport(folder: string, d: DirFact | null, centralBytes: number | null, nowMs: number,
  o: Pick<Thresholds, "backup_warn_gb" | "backup_warn_count" | "backup_quiet_days">): BackupReport {
  const base: BackupReport = {
    folder, state: "not_checked", count: 0, total_bytes: 0, total_human: formatBytes(0), newest_at: null, oldest_at: null,
    newest_age_days: null, ratio_to_central: null, largest: [], truncated: false, warnings: [],
  };
  if (!folder || !d) return base;
  if (!d.exists) return { ...base, state: "not_found", warnings: [`Backup folder not found: ${folder}`] };
  const files = d.files;
  if (!files.length) return { ...base, state: "empty", truncated: d.truncated, warnings: ["The backup folder has no files"] };
  const total = files.reduce((n, f) => n + f.size_bytes, 0);
  const newest = Math.max(...files.map((f) => f.mtime_ms));
  const oldest = Math.min(...files.map((f) => f.mtime_ms));
  const warnings: string[] = [];
  if (total >= o.backup_warn_gb * GB) warnings.push(`Backups use ${formatBytes(total)} (warn at ${o.backup_warn_gb} GB)`);
  if (files.length >= o.backup_warn_count) warnings.push(`${files.length} backup files${d.truncated ? " or more" : ""} (warn at ${o.backup_warn_count})`);
  const quiet = ageDays(nowMs, newest);
  if (quiet >= o.backup_quiet_days) warnings.push(`Newest backup file is ${quiet} days old (no new backup in ${o.backup_quiet_days}+ days)`);
  return {
    folder,
    state: warnings.length ? "watch" : "ok",
    count: files.length,
    total_bytes: total,
    total_human: formatBytes(total),
    newest_at: iso(newest),
    oldest_at: iso(oldest),
    newest_age_days: quiet,
    ratio_to_central: centralBytes && centralBytes > 0 ? round1(total / centralBytes) : null,
    largest: [...files].sort((a, b) => b.size_bytes - a.size_bytes).slice(0, 3).map((f) => ({ name: f.name, size_human: formatBytes(f.size_bytes) })),
    truncated: d.truncated,
    warnings,
  };
}

export interface LocalCopy {
  user: string;
  name: string;
  path: string;
  size_bytes: number;
  size_human: string;
  modified_at: string;
  age_days: number;
  stale: boolean;
  needs_person: true;
  recommendation: string;
}

/** Locals of this central found in the given folders: <central>_<user>.rvt, never the central itself. Oldest first. */
export function localCopies(centralName: string, folders: DirFact[], nowMs: number, staleDays: number): LocalCopy[] {
  const seen = new Set<string>();
  const out: LocalCopy[] = [];
  for (const d of folders) {
    for (const f of d.files) {
      if (f.name.toLowerCase() === centralName.toLowerCase()) continue;
      const user = localUserOf(centralName, f.name);
      if (!user || seen.has(f.path.toLowerCase())) continue;
      seen.add(f.path.toLowerCase());
      const age = ageDays(nowMs, f.mtime_ms);
      const stale = age >= staleDays;
      out.push({
        user, name: f.name, path: f.path, size_bytes: f.size_bytes, size_human: formatBytes(f.size_bytes), modified_at: iso(f.mtime_ms), age_days: age,
        stale, needs_person: true,
        recommendation: stale
          ? `Ask ${user} to open it and Reload Latest, or make a new local from the central if it is far behind. Nothing is deleted or synced by this tool.`
          : "",
      });
    }
  }
  return out.sort((a, b) => b.age_days - a.age_days);
}

export interface BorrowedReport {
  available: boolean;
  workshared: boolean | null;
  worksets_total: number;
  worksets_unowned: number;
  owners: { owner: string; mine: boolean; worksets: string[]; elements: number | null }[];
  elements_borrowed: number | null;
  elements_note: string;
}

export function borrowedReport(facts: CentralFacts | null): BorrowedReport {
  if (!facts) {
    return { available: false, workshared: null, worksets_total: 0, worksets_unowned: 0, owners: [], elements_borrowed: null,
      elements_note: "Revit facts were not available (Revit closed, use_revit false, or no connection)" };
  }
  if (!facts.workshared) {
    return { available: true, workshared: false, worksets_total: 0, worksets_unowned: 0, owners: [], elements_borrowed: null, elements_note: "The open model is not workshared" };
  }
  const byOwner = new Map<string, string[]>();
  let unowned = 0;
  for (const w of facts.worksets) {
    if (!w.owner) { unowned++; continue; }
    byOwner.set(w.owner, [...(byOwner.get(w.owner) ?? []), w.name]);
  }
  const elementsByOwner = new Map<string, number>();
  for (const b of facts.borrowed_elements ?? []) elementsByOwner.set(b.owner, (elementsByOwner.get(b.owner) ?? 0) + b.count);
  const owners = new Set<string>([...byOwner.keys(), ...elementsByOwner.keys()]);
  const list = [...owners].sort().map((owner) => ({
    owner,
    mine: !!facts.user && owner === facts.user,
    worksets: (byOwner.get(owner) ?? []).sort(),
    elements: facts.borrowed_elements ? (elementsByOwner.get(owner) ?? 0) : null,
  }));
  return {
    available: true,
    workshared: true,
    worksets_total: facts.worksets.length,
    worksets_unowned: unowned,
    owners: list,
    elements_borrowed: facts.borrowed_elements ? [...elementsByOwner.values()].reduce((a, b) => a + b, 0) : null,
    elements_note: facts.borrowed_elements ? "" : "This add-in build reports workset owners only, not borrowed elements; a live check with a newer add-in is needed for element counts",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Gather, analyse, plan
// ---------------------------------------------------------------------------------------------------------------

export interface Gathered {
  central_path: string;
  central_kind: CentralKind;
  central: FileFact | null;
  backup_dir: string;
  backups: DirFact | null;
  local_folders: DirFact[];
}

export interface GatherArgs { central_path: string; backup_dir: string; local_dirs: string[] }

/** Reads metadata only. A cloud or Revit Server central has no file to stat, so only the Revit facts apply. */
export function gather(fsl: FsLike, args: GatherArgs, facts: CentralFacts | null): Gathered {
  const centralPath = (args.central_path || facts?.central || "").trim();
  const kind = centralKind(centralPath, !!facts?.cloud);
  const central = kind === "file" ? fsl.stat(centralPath) : null;
  const backupDir = (args.backup_dir || (kind === "file" ? defaultBackupDir(centralPath) : "")).trim();
  const backups = backupDir ? fsl.list(backupDir, true, 5000) : null;
  const localFolders = args.local_dirs.map((d) => d.trim()).filter(Boolean).map((d) => fsl.list(d, false, 2000));
  return { central_path: centralPath, central_kind: kind, central, backup_dir: backupDir, backups, local_folders: localFolders };
}

export interface PlanItem {
  id: "audit" | "compact" | "review_stale_locals" | "review_backups" | "ask_relinquish";
  kind: "audit" | "compact" | "locals" | "backups" | "borrowed";
  title: string;
  recommended: boolean;
  due: "now" | "scheduled" | "not_due";
  due_at: string | null;
  last_done: string | null;
  why: string[];
  steps: string[];
  when: string;
  /** Always true: a person does every one of these in Revit or on the file system. The tool never does. */
  needs_person: true;
  executed_by_tool: false;
}

export interface Plan {
  read_and_plan_only: true;
  executes_nothing: true;
  needs_person: true;
  note: string;
  items: PlanItem[];
  schedule: { id: PlanItem["id"]; due: PlanItem["due"]; due_at: string | null; title: string }[];
}

const WINDOW =
  "Out of hours, with the team's agreement and nobody editing the model. A person chooses the slot; this plan only suggests the earliest sensible date.";

function cadence(lastRaw: string, everyDays: number, nowMs: number) {
  const last = parseWhen(lastRaw);
  if (last == null) return { last: null as number | null, dueMs: null as number | null, dueNow: true, never: true };
  const dueMs = last + everyDays * DAY;
  return { last, dueMs, dueNow: dueMs <= nowMs, never: false };
}

export interface Analysis {
  generated_at: string;
  central: {
    path: string;
    kind: CentralKind;
    found: boolean;
    size_bytes: number | null;
    size_human: string | null;
    modified_at: string | null;
    age_days: number | null;
    size_level: "ok" | "watch" | "act" | "unknown";
  };
  growth: GrowthReport;
  backups: BackupReport;
  locals: { folders_checked: number; found: number; stale: number; stale_days: number; copies: LocalCopy[] };
  borrowed: BorrowedReport;
  findings: Finding[];
  status: "ok" | "watch" | "act";
  plan: Plan;
}

export interface AnalyzeInput {
  nowMs: number;
  gathered: Gathered;
  facts: CentralFacts | null;
  history: Sample[];
  options: Options;
}

export function analyze(inp: AnalyzeInput): Analysis {
  const { nowMs, gathered: g, facts, options: o } = inp;
  const findings: Finding[] = [];
  const add = (code: string, level: Level, message: string) => findings.push({ code, level, message });

  // Central file
  const size = g.central ? g.central.size_bytes : null;
  let sizeLevel: Analysis["central"]["size_level"] = "unknown";
  if (!g.central_path) {
    add("FMC-CENTRAL-NO-PATH", "act", "No central path: name central_path, or open the workshared model in Revit so its central is read");
  } else if (g.central_kind === "file" && !g.central) {
    add("FMC-CENTRAL-NOT-FOUND", "act", `The central file was not found or cannot be reached: ${g.central_path}`);
  } else if (g.central_kind === "revit_server" || g.central_kind === "cloud") {
    add("FMC-CENTRAL-NO-FILE", "info", `The central is on ${g.central_kind === "cloud" ? "the cloud" : "Revit Server"}: its file size and backups are not readable from here, so only the Revit facts apply`);
  }
  if (size != null) {
    sizeLevel = size >= o.central_act_mb * MB ? "act" : size >= o.central_warn_mb * MB ? "watch" : "ok";
    if (sizeLevel === "act") add("FMC-CENTRAL-SIZE-ACT", "act", `The central is ${formatBytes(size)} (act at ${o.central_act_mb} MB)`);
    else if (sizeLevel === "watch") add("FMC-CENTRAL-SIZE-WATCH", "watch", `The central is ${formatBytes(size)} (watch at ${o.central_warn_mb} MB)`);
  }

  // Growth
  const growth = growthReport(inp.history, size, nowMs, o);
  if (growth.flagged) add("FMC-CENTRAL-GROWTH", "watch", `The central grew ${growth.delta_pct}% in ${growth.window_days} days (warn at ${o.growth_warn_pct}%)`);
  else if (size != null && growth.status === "insufficient_history") add("FMC-CENTRAL-HISTORY-THIN", "info", "Not enough size history yet to judge growth: record a sample (record true, dry_run false) now and again on later days");

  // Backups
  const backups = backupReport(g.backup_dir, g.backups, size, nowMs, o);
  if (backups.state === "not_found") add("FMC-CENTRAL-BACKUP-MISSING", "watch", backups.warnings[0]);
  else if (backups.state === "empty") add("FMC-CENTRAL-BACKUP-EMPTY", "watch", backups.warnings[0]);
  else if (backups.state === "watch") for (const w of backups.warnings) add("FMC-CENTRAL-BACKUP-WATCH", "watch", w);

  // Stale locals
  const centralName = g.central_path ? win.basename(g.central_path) : "";
  const copies = centralName ? localCopies(centralName, g.local_folders, nowMs, o.stale_days) : [];
  const stale = copies.filter((c) => c.stale);
  if (stale.length) add("FMC-CENTRAL-STALE-LOCAL", "watch", `${stale.length} local cop${stale.length === 1 ? "y" : "ies"} not touched for ${o.stale_days}+ days: ${stale.map((c) => c.user).join(", ")}`);

  // Borrowed
  const borrowed = borrowedReport(facts);
  const others = borrowed.owners.filter((x) => !x.mine);
  if (borrowed.workshared === false) add("FMC-CENTRAL-NOT-WORKSHARED", "info", "The open model is not workshared, so there are no worksets to report");
  else if (others.length) add("FMC-CENTRAL-BORROWED-OTHERS", "info", `Worksets or elements held by others: ${others.map((x) => x.owner).join(", ")}. Only they can relinquish; this tool never does`);
  if (!facts) add("FMC-CENTRAL-NO-REVIT", "info", "Revit facts were not read; file checks only");

  const rank: Record<Level, number> = { info: 0, watch: 1, act: 2 };
  const worst = findings.reduce((n, f) => Math.max(n, rank[f.level]), 0);
  const plan = buildPlan({ nowMs, options: o, sizeLevel, growth, backups, stale, others: others.length, centralPath: g.central_path });

  return {
    generated_at: iso(nowMs),
    central: {
      path: g.central_path, kind: g.central_kind, found: !!g.central, size_bytes: size, size_human: size == null ? null : formatBytes(size),
      modified_at: g.central ? iso(g.central.mtime_ms) : null, age_days: g.central ? ageDays(nowMs, g.central.mtime_ms) : null, size_level: sizeLevel,
    },
    growth,
    backups,
    locals: { folders_checked: g.local_folders.length, found: copies.length, stale: stale.length, stale_days: o.stale_days, copies },
    borrowed,
    findings,
    status: worst === 2 ? "act" : worst === 1 ? "watch" : "ok",
    plan,
  };
}

interface PlanInput {
  nowMs: number;
  options: Options;
  sizeLevel: Analysis["central"]["size_level"];
  growth: GrowthReport;
  backups: BackupReport;
  stale: LocalCopy[];
  others: number;
  centralPath: string;
}

/** A plan for a person. Every item is needs_person true and executed_by_tool false: nothing here runs. */
export function buildPlan(p: PlanInput): Plan {
  const { nowMs, options: o } = p;
  const items: PlanItem[] = [];
  const dueAt = (ms: number | null) => (ms == null ? null : iso(ms));

  // Audit
  const a = cadence(o.last_audit, o.audit_every_days, nowMs);
  const auditWhy: string[] = [];
  if (a.never) auditWhy.push("No audit date was given (last_audit), so none is on record");
  else if (a.dueNow) auditWhy.push(`The last audit was ${o.audit_every_days}+ days ago (every ${o.audit_every_days} days)`);
  if (p.sizeLevel === "act") auditWhy.push("The central is over the act size");
  if (p.growth.flagged) auditWhy.push("The central is growing faster than the warn rate");
  const auditRec = auditWhy.length > 0;
  items.push({
    id: "audit", kind: "audit", title: "Audit the central model", recommended: auditRec,
    due: auditRec ? "now" : "scheduled", due_at: auditRec ? null : dueAt(a.dueMs), last_done: dueAt(a.last),
    why: auditWhy.length ? auditWhy : [`Next audit due ${dueAt(a.dueMs)} (every ${o.audit_every_days} days)`],
    steps: [
      "Tell the team the window; everyone syncs, relinquishes (Collaborate > Relinquish All Mine) and closes the model.",
      "Take a fresh copy of the central first (a person copies the file).",
      "In Revit: File > Open, pick the central, tick Detach from Central and Audit on the copy to see what the audit finds. Audit the live central only after that, by a person.",
      "Record the date and the result; pass it back as last_audit next time.",
    ],
    when: WINDOW, needs_person: true, executed_by_tool: false,
  });

  // Compact
  const c = cadence(o.last_compact, o.compact_every_days, nowMs);
  const compactWhy: string[] = [];
  if (p.sizeLevel === "act" || p.sizeLevel === "watch") compactWhy.push("The central is over the watch size");
  if (p.growth.flagged) compactWhy.push("The central is growing faster than the warn rate");
  if (!c.never && c.dueNow) compactWhy.push(`The last compact was ${o.compact_every_days}+ days ago (every ${o.compact_every_days} days)`);
  const compactRec = compactWhy.length > 0;
  items.push({
    id: "compact", kind: "compact", title: "Compact the central model", recommended: compactRec,
    due: compactRec ? "now" : c.never ? "not_due" : "scheduled", due_at: compactRec ? null : dueAt(c.dueMs), last_done: dueAt(c.last),
    why: compactWhy.length ? compactWhy : [c.never ? "No compact date was given (last_compact) and the size is under the watch level" : `Next compact due ${dueAt(c.dueMs)} (every ${o.compact_every_days} days)`],
    steps: [
      "Do it after an audit window, when nobody is in the model.",
      "In Revit: Collaborate > Synchronize with Central > Synchronize Now, with Compact Central Model (slow) ticked, by a person.",
      "Re-run fmc_central_health afterwards and compare the size; record the date as last_compact.",
    ],
    when: WINDOW, needs_person: true, executed_by_tool: false,
  });

  // Stale locals
  if (p.stale.length) {
    items.push({
      id: "review_stale_locals", kind: "locals", title: `Review ${p.stale.length} stale local cop${p.stale.length === 1 ? "y" : "ies"}`, recommended: true, due: "now", due_at: null, last_done: null,
      why: p.stale.map((s) => `${s.user}: ${s.age_days} days old, ${s.size_human}`),
      steps: ["Ask each person to open their local, Reload Latest, and sync, or to make a new local from the central.", "Do not sync a very old local without Reload Latest first."],
      when: "Next working day", needs_person: true, executed_by_tool: false,
    });
  }

  // Backups
  if (p.backups.state === "watch" || p.backups.state === "empty" || p.backups.state === "not_found") {
    items.push({
      id: "review_backups", kind: "backups", title: "Review the backup folder", recommended: true, due: "now", due_at: null, last_done: null,
      why: p.backups.warnings,
      steps: ["A person decides what to archive or remove; the tool never deletes a backup.", "If the folder is missing or empty, check where backups are kept for this central and that the server job runs."],
      when: "At the next audit window, or sooner if the disk is short", needs_person: true, executed_by_tool: false,
    });
  }

  // Borrowed
  if (p.others > 0) {
    items.push({
      id: "ask_relinquish", kind: "borrowed", title: "Ask owners to relinquish before an audit or compact", recommended: false, due: "scheduled", due_at: null, last_done: null,
      why: [`${p.others} other owner(s) hold worksets or elements`],
      steps: ["Ask each owner to sync and Relinquish All Mine. Only the owner (or an admin in Revit) can do it; this tool never relinquishes."],
      when: "Just before the audit window", needs_person: true, executed_by_tool: false,
    });
  }

  const order = { now: 0, scheduled: 1, not_due: 2 } as const;
  const schedule = [...items]
    .sort((x, y) => order[x.due] - order[y.due] || (x.due_at ?? "9").localeCompare(y.due_at ?? "9"))
    .map((i) => ({ id: i.id, due: i.due, due_at: i.due_at, title: i.title }));
  return {
    read_and_plan_only: true, executes_nothing: true, needs_person: true,
    note: "A plan for a person. This tool never runs an audit, a compact, a sync or a relinquish; each line needs a person in Revit (Rule 6).",
    items, schedule,
  };
}
