/**
 * The automation balance (F74, docs/AUTOMATION_BALANCE.md). Pure: everything here reads ledger lines (fmc/ledger.ts)
 * and returns numbers. The goal is to move work from AI-written code (send_code_to_revit) into plugin tools and saved
 * scripts, and to see the balance:
 *
 *   AI code              send_code_to_revit
 *   Plugin tools         fmc_* and the other built-in tools, split by who started them (ai, pane, job, schedule, cli)
 *   Saved add-ons        fmc_scripts addon_run (the coming add-on runner)
 *   External automation  pyRevit, Dynamo, Python, Grasshopper, JS, PowerShell, batch… (the one-line hooks)
 *
 * Shares are of calls (runs); time is summed too. Nothing here counts or ranks people (rule 9): the ledger holds no names.
 */
import type { Home } from "./balance_homes.js";

export const KINDS = ["ai_code", "plugin_tool", "saved_addon", "external"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABELS: Record<Kind, string> = {
  ai_code: "AI code", plugin_tool: "Plugin tools", saved_addon: "Saved add-ons", external: "External automation",
};

export const EXTERNAL_KINDS = ["pyrevit", "dynamo", "python", "grasshopper", "js", "powershell", "batch", "other"] as const;

/** One call or run, whatever recorded it. */
export interface Event {
  at: string;
  week: string;
  kind: Kind;
  /** The tool (server calls) or the external kind (pyrevit, dynamo, …). */
  sub: string;
  started_by: string;
  project: string;
  ok: boolean;
  ms: number;
  tool: string;
  action: string;
  purpose: string;
  code_hash: string;
  script: string;
}

/** A server call's kind: send_code_to_revit is AI code; fmc_scripts addon_run is a saved add-on; every other tool is a plugin tool. */
export function classify(tool: string, action: string): Kind {
  if (tool === "send_code_to_revit") return "ai_code";
  if (tool === "fmc_scripts" && /^addon_run/.test(action)) return "saved_addon";
  return "plugin_tool";
}

/** The hooks' kind, in one spelling: pyrevit, dynamo, python, grasshopper, js, powershell, batch or other. */
export function externalKind(k: unknown): string {
  const s = String(k ?? "").trim().toLowerCase();
  if (/^(pyrevit|ironpython|pyrevit[-_ ]?cpython)$/.test(s)) return "pyrevit";
  if (/^dynamo/.test(s)) return "dynamo";
  if (/^(grasshopper|gh|ghpython|gh[-_ ]?python|rhino[-_ ]?python)$/.test(s)) return "grasshopper";
  if (/^(python|py|cpython|python3)$/.test(s)) return "python";
  if (/^(js|javascript|node|nodejs|ts|typescript)$/.test(s)) return "js";
  if (/^(powershell|pwsh|ps|ps1)$/.test(s)) return "powershell";
  if (/^(batch|bat|cmd)$/.test(s)) return "batch";
  return "other";
}

const DAY = 86400000;
const day = (d: Date) => d.toISOString().slice(0, 10);

/** The Monday (UTC) of the week a time falls in, YYYY-MM-DD: the week key for trends and Power BI. */
export function weekStart(at: string): string {
  const d = new Date(at.length === 10 ? at + "T00:00:00Z" : at);
  if (Number.isNaN(d.getTime())) return "";
  const back = (d.getUTCDay() + 6) % 7;
  return day(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - back * DAY));
}

/** The period of the last `weeks` whole weeks up to today: from that Monday to today (YYYY-MM-DD, both included). */
export function lastWeeks(today: string, weeks: number): { from: string; to: string } {
  const monday = new Date(weekStart(today) + "T00:00:00Z");
  return { from: day(new Date(monday.getTime() - (Math.max(1, Math.floor(weeks)) - 1) * 7 * DAY)), to: today };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Ledger lines (calls and external runs) as events; lines that aren't one are skipped. */
export function toEvents(calls: any[], externals: any[]): Event[] {
  const out: Event[] = [];
  for (const c of calls) {
    if (!c || typeof c.at !== "string" || typeof c.tool !== "string") continue;
    const action = str(c.action);
    out.push({ at: c.at, week: weekStart(c.at), kind: classify(c.tool, action), sub: c.tool, started_by: str(c.started_by) || "cli",
      project: str(c.project), ok: c.ok !== false, ms: Number(c.ms) || 0, tool: c.tool, action, purpose: str(c.purpose),
      code_hash: str(c.code_hash), script: str(c.addon) });
  }
  for (const e of externals) {
    if (!e || typeof e.at !== "string") continue;
    const sub = externalKind(e.kind);
    out.push({ at: e.at, week: weekStart(e.at), kind: "external", sub, started_by: str(e.started_by) || "person",
      project: str(e.project), ok: e.ok !== false, ms: Number(e.ms) || 0, tool: "", action: "", purpose: "", code_hash: "",
      script: str(e.script) });
  }
  return out.filter((e) => e.week).sort((a, b) => a.at.localeCompare(b.at));
}

/** The events in from..to (days, both included), for one project when named. */
export function inScope(events: Event[], from: string, to: string, project = ""): Event[] {
  const p = project.trim().toUpperCase();
  return events.filter((e) => (!from || e.at.slice(0, 10) >= from) && (!to || e.at.slice(0, 10) <= to) && (!p || e.project.toUpperCase() === p));
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);

export interface Share { key: string; label: string; calls: number; share: number; errors: number; ms: number }

function shares(events: Event[], keyOf: (e: Event) => string, keys: readonly string[], label: (k: string) => string = (k) => k): Share[] {
  const all = [...new Set([...keys, ...events.map(keyOf)])];
  return all.map((k) => {
    const mine = events.filter((e) => keyOf(e) === k);
    return { key: k, label: label(k), calls: mine.length, share: pct(mine.length, events.length), errors: mine.filter((e) => !e.ok).length,
      ms: mine.reduce((s, e) => s + e.ms, 0) };
  }).filter((s) => s.calls > 0 || keys.includes(s.key));
}

export interface WeekRow { week: string; total: number; ai_share: number; automation_share: number; by_kind: Record<Kind, number> }

function byKind(events: Event[]): Record<Kind, number> {
  return Object.fromEntries(KINDS.map((k) => [k, events.filter((e) => e.kind === k).length])) as Record<Kind, number>;
}

/** Every week from..to, empty weeks too, so a trend has no gaps. */
export function weeks(events: Event[], from: string, to: string): WeekRow[] {
  const out: WeekRow[] = [];
  const start = weekStart(from || (events[0]?.at ?? to));
  for (let w = start; w && w <= to; w = day(new Date(new Date(w + "T00:00:00Z").getTime() + 7 * DAY))) {
    const mine = events.filter((e) => e.week === w);
    const ai = mine.filter((e) => e.kind === "ai_code").length;
    out.push({ week: w, total: mine.length, ai_share: pct(ai, mine.length), automation_share: mine.length ? pct(mine.length - ai, mine.length) : 0, by_kind: byKind(mine) });
    if (out.length > 260) break;
  }
  return out;
}

export interface Summary {
  from: string;
  to: string;
  project: string;
  total: number;
  ai_share: number;
  automation_share: number;
  by_kind: Share[];
  by_started_by: Share[];
  /** The plugin tools alone, by who started them: how much of the automation an AI still drives. */
  plugin_by_started_by: Share[];
  external_by_kind: Share[];
  projects: Array<{ project: string; total: number; ai_share: number; by_kind: Record<Kind, number> }>;
  weeks: WeekRow[];
  note: string;
}

export function summary(all: Event[], opts: { from: string; to: string; project?: string }): Summary {
  const events = inScope(all, opts.from, opts.to, opts.project);
  const ai = events.filter((e) => e.kind === "ai_code").length;
  const projects = [...new Set(events.map((e) => e.project))].sort().map((p) => {
    const mine = events.filter((e) => e.project === p);
    return { project: p || "(none given)", total: mine.length, ai_share: pct(mine.filter((e) => e.kind === "ai_code").length, mine.length), by_kind: byKind(mine) };
  });
  const plugin = events.filter((e) => e.kind === "plugin_tool");
  return {
    from: opts.from, to: opts.to, project: opts.project?.trim() || "all", total: events.length,
    ai_share: pct(ai, events.length), automation_share: events.length ? pct(events.length - ai, events.length) : 0,
    by_kind: shares(events, (e) => e.kind, KINDS, (k) => KIND_LABELS[k as Kind] ?? k),
    by_started_by: shares(events, (e) => e.started_by, []),
    plugin_by_started_by: shares(plugin, (e) => e.started_by, []),
    external_by_kind: shares(events.filter((e) => e.kind === "external"), (e) => e.sub, []),
    projects,
    weeks: weeks(events, opts.from, opts.to),
    note: "Counts calls and runs per kind, project and week; never people (rule 9).",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The move list: AI-code calls grouped by purpose (or by the code's hash), each with a suggested home.

export type FeatureRow = { id: string; feature: string; status: string };

/** The tracker's status in the words of the move list: planned, in progress, built (merged, Revit check due) or tested. */
export function trackerToStatus(s: string): string {
  if (/^tested/i.test(s)) return "tested";
  if (/^built/i.test(s)) return "built";
  if (/^(in progress|waiting)/i.test(s)) return "in progress";
  return "planned";
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first home whose keywords start a word in the purpose. */
export function matchHome(purpose: string, homes: Home[]): Home | null {
  const p = purpose.toLowerCase();
  if (!p) return null;
  return homes.find((h) => h.keywords.some((k) => k && new RegExp(`(^|[^a-z0-9])${escape(k.toLowerCase())}`).test(p))) ?? null;
}

/** The home's status: its tracker feature when it names one (or when a feature names its tool action), else its own. */
export function homeStatus(h: Home, features: FeatureRow[]): { status: string; tracker_status: string; feature: string } {
  let f = h.feature ? features.find((x) => x.id === h.feature) : undefined;
  if (!f) {
    const tool = h.home.match(/fmc_[a-z_]+ [a-z_]+/)?.[0];
    if (tool) f = features.find((x) => x.feature.includes(tool));
  }
  if (f) return { status: trackerToStatus(f.status), tracker_status: f.status, feature: f.id };
  return { status: h.status || "planned", tracker_status: "", feature: "" };
}

export interface BacklogItem {
  rank: number;
  key: string;
  purpose: string;
  code_hashes: number;
  calls: number;
  errors: number;
  ms: number;
  projects: string[];
  first: string;
  last: string;
  home: string;
  home_id: string;
  scripts: string;
  priority: string;
  status: string;
  tracker_status: string;
  feature: string;
}

const norm = (p: string) => p.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The AI-code calls grouped: by purpose when the AI gave one, else by the code's hash. A call without a purpose joins
 * the purpose its code was sent with before. Ranked by calls, then time: the top of the list is what to move first.
 */
export function backlog(all: Event[], homes: Home[], features: FeatureRow[]): BacklogItem[] {
  const ai = all.filter((e) => e.kind === "ai_code");
  const purposeOfHash = new Map<string, string>();
  for (const e of ai) if (e.purpose && e.code_hash && !purposeOfHash.has(e.code_hash)) purposeOfHash.set(e.code_hash, e.purpose);
  const groups = new Map<string, Event[]>();
  const shown = new Map<string, string>();
  for (const e of ai) {
    const purpose = e.purpose || purposeOfHash.get(e.code_hash) || "";
    const key = purpose ? "purpose:" + norm(purpose) : e.code_hash ? "code:" + e.code_hash : "unknown";
    if (!groups.has(key)) { groups.set(key, []); shown.set(key, purpose); }
    groups.get(key)!.push(e);
  }
  const items = [...groups].map(([key, evs]) => {
    const purpose = shown.get(key) ?? "";
    const h = matchHome(purpose, homes);
    const st = h ? homeStatus(h, features) : { status: "", tracker_status: "", feature: "" };
    return {
      rank: 0, key, purpose: purpose || (key === "unknown" ? "(no purpose, no code)" : `(no purpose) code ${key.slice(5)}`),
      code_hashes: new Set(evs.map((e) => e.code_hash).filter(Boolean)).size, calls: evs.length, errors: evs.filter((e) => !e.ok).length,
      ms: evs.reduce((s, e) => s + e.ms, 0), projects: [...new Set(evs.map((e) => e.project).filter(Boolean))].sort(),
      first: evs[0].at, last: evs[evs.length - 1].at,
      home: h ? h.home : purpose ? "No match in the mapping: add one (FMC_Balance_Homes.json)" : "Unknown: ask the AI to pass purpose",
      home_id: h?.id ?? "", scripts: h?.scripts ?? "", priority: h?.priority ?? "", ...st,
    };
  });
  items.sort((a, b) => b.calls - a.calls || b.ms - a.ms || a.key.localeCompare(b.key));
  items.forEach((x, i) => { x.rank = i + 1; });
  return items;
}

// ---------------------------------------------------------------------------------------------------------------------
// The kit's scripts beside how often each actually ran.

export interface InventoryRow { name: string; type: string; file: string; runs: number; errors: number; ms: number; last: string }

const base = (f: string) => f.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.replace(/\.(py|dyn|pushbutton|ps1|bat|cmd|js|ghx|gh)$/i, "").toLowerCase();

/** Which kit script an external run was, by its name, its file's name or (pyRevit) its button folder. */
function scriptKeys(s: { name: string; file: string }): string[] {
  const keys = [s.name.toLowerCase(), base(s.file)];
  if (/script\.py$/i.test(s.file)) keys.push(base(s.file.replace(/[\\/]script\.py$/i, "")).replace(/^\d+_/, ""));
  return keys.filter(Boolean);
}

export function inventory(scripts: Array<{ name: string; type: string; file: string }>, all: Event[]):
  { scripts: InventoryRow[]; not_in_kit: Array<{ script: string; kind: string; runs: number; last: string }>; by_type: Array<{ type: string; scripts: number; ran: number; runs: number }> } {
  const ext = all.filter((e) => e.kind === "external");
  const used = new Set<Event>();
  const rows = scripts.map((s) => {
    const keys = scriptKeys(s);
    const mine = ext.filter((e) => { const k = base(e.script); return keys.includes(k) || keys.includes(k.replace(/^\d+_/, "")); });
    mine.forEach((e) => used.add(e));
    return { name: s.name, type: s.type, file: s.file, runs: mine.length, errors: mine.filter((e) => !e.ok).length,
      ms: mine.reduce((t, e) => t + e.ms, 0), last: mine.length ? mine[mine.length - 1].at : "" };
  });
  const other = new Map<string, Event[]>();
  for (const e of ext) if (!used.has(e)) { const k = `${e.sub}|${e.script}`; other.set(k, [...(other.get(k) ?? []), e]); }
  const types = [...new Set(scripts.map((s) => s.type))];
  return {
    scripts: rows,
    not_in_kit: [...other].map(([k, evs]) => ({ script: k.split("|").slice(1).join("|") || "(unnamed)", kind: k.split("|")[0], runs: evs.length, last: evs[evs.length - 1].at })),
    by_type: types.map((t) => { const r = rows.filter((x) => x.type === t); return { type: t, scripts: r.length, ran: r.filter((x) => x.runs > 0).length, runs: r.reduce((n, x) => n + x.runs, 0) }; }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The weekly report's section and the Power BI tables.

export interface Digest {
  week: { from: string; to: string; total: number; by_kind: Share[]; ai_share: number };
  last_week: { from: string; to: string; total: number; ai_share: number };
  /** AI code's share this week minus last week's, in percentage points: below zero is the goal. */
  change_ai_pts: number;
  top: BacklogItem[];
}

/** This week (Monday to today) against last week, and the top five of the move list over the last four weeks. */
export function digest(all: Event[], today: string, homes: Home[], features: FeatureRow[], project = ""): Digest {
  const monday = weekStart(today);
  const lastMonday = day(new Date(new Date(monday + "T00:00:00Z").getTime() - 7 * DAY));
  const lastSunday = day(new Date(new Date(monday + "T00:00:00Z").getTime() - DAY));
  const now = summary(all, { from: monday, to: today, project });
  const before = summary(all, { from: lastMonday, to: lastSunday, project });
  const four = lastWeeks(today, 4);
  return {
    week: { from: monday, to: today, total: now.total, by_kind: now.by_kind, ai_share: now.ai_share },
    last_week: { from: lastMonday, to: lastSunday, total: before.total, ai_share: before.ai_share },
    change_ai_pts: Math.round((now.ai_share - before.ai_share) * 10) / 10,
    top: backlog(inScope(all, four.from, four.to, project), homes, features).slice(0, 5),
  };
}

const secs = (ms: number) => (ms >= 60000 ? `${Math.round(ms / 6000) / 10} min` : `${Math.round(ms / 100) / 10} s`);

/** The weekly report's "Automation balance" section (Markdown lines). */
export function digestMarkdown(d: Digest): string[] {
  const md = ["## Automation balance (calls, not people: rule 9)", ""];
  if (!d.week.total && !d.last_week.total) {
    md.push("No calls recorded in the ledger this week or last (%APPDATA%\\Formcraft\\ledger).", "");
    return md;
  }
  md.push(`This week (${d.week.from} to ${d.week.to}): ${d.week.total} calls.`, "", "| Kind | Calls | Share |", "|---|---|---|");
  for (const s of d.week.by_kind) md.push(`| ${s.label} | ${s.calls} | ${s.share}% |`);
  const dir = d.change_ai_pts < 0 ? "down" : d.change_ai_pts > 0 ? "up" : "no change";
  md.push("", `AI code: ${d.week.ai_share}% this week, ${d.last_week.ai_share}% last week (${dir}${d.change_ai_pts ? ` ${Math.abs(d.change_ai_pts)} points` : ""}; ${d.last_week.total} calls last week).`, "");
  if (d.top.length) {
    md.push("Top of the move list (last 4 weeks): AI code to move into tools.", "", "| # | Purpose | Calls | Time | Suggested home | Status |", "|---|---|---|---|---|---|");
    for (const t of d.top) md.push(`| ${t.rank} | ${t.purpose.replace(/\|/g, "/")} | ${t.calls} | ${secs(t.ms)} | ${t.home.replace(/\|/g, "/")} | ${t.status || "-"} |`);
    md.push("");
  }
  md.push("Source: the call ledger (%APPDATA%\\Formcraft\\ledger), fmc_balance.", "");
  return md;
}

/** Power BI: calls by week, project, kind, sub (tool or script kind) and started_by, with errors and time. */
export function callsTable(events: Event[]): Array<Array<string | number>> {
  const rows = new Map<string, { k: string[]; calls: number; errors: number; ms: number }>();
  for (const e of events) {
    const k = [e.week, e.project, e.kind, e.sub, e.started_by];
    const id = k.join("\u0001");
    const r = rows.get(id) ?? { k, calls: 0, errors: 0, ms: 0 };
    r.calls++; if (!e.ok) r.errors++; r.ms += e.ms;
    rows.set(id, r);
  }
  return [["week_start", "project", "kind", "sub", "started_by", "calls", "errors", "ms"],
    ...[...rows.values()].sort((a, b) => a.k.join().localeCompare(b.k.join())).map((r) => [...r.k, r.calls, r.errors, r.ms])];
}

/** Power BI: the move list. */
export function backlogTable(items: BacklogItem[]): Array<Array<string | number>> {
  return [["rank", "purpose", "calls", "errors", "ms", "code_hashes", "projects", "home", "priority", "status", "tracker_status", "feature", "first", "last"],
    ...items.map((i) => [i.rank, i.purpose, i.calls, i.errors, i.ms, i.code_hashes, i.projects.join(" "), i.home, i.priority, i.status, i.tracker_status, i.feature, i.first, i.last])];
}
