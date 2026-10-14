/**
 * Reports (board manage/PaneReports, U21). Pure.
 *
 *   MAN 13.1  every number comes from a saved, dated file, so a report can be traced
 *   MAN 14.5  activity counts work per model and discipline, never ranks people
 * The sources are files the plugin already keeps: QA history, the review register, the sync log, issue folders,
 * issue exceptions and the action log. Client reports leave out names, logs and internal notes.
 */
import { Register, overdue } from "./review.js";

export const KINDS = ["Weekly project report", "Model health and QA", "Review register", "Sync log and workshare",
  "Ready to issue record", "Rule exceptions", "Activity log"] as const;
export type Kind = (typeof KINDS)[number];
export const PERIODS = ["Last 7 days", "Since last issue", "This month", "Whole project"] as const;
export type Period = (typeof PERIODS)[number];
export const AUDIENCES = ["Team", "Client", "BIM Manager"] as const;
export type Audience = (typeof AUDIENCES)[number];

export interface Sources {
  qa: Record<string, Array<{ at: string; failing: string[] }>>;   // FMC_QA_History.json: "<model>|<gate>" → runs
  reviews: Register | null;
  syncs: Array<{ at: string; model: string; message: string }>;    // FMC_Sync_Log.csv (the user column is never read)
  issues: Array<{ folder: string; date: string; revision: string; result: string }>;
  exceptions: Array<{ recorded: string; sheet: string; item: string; why: string; approved_by: string; until: string }>;
  log: Array<{ at: string; action: string; result: string }>;      // FMC_MCP_FileLog.csv
}

/** The first day the period covers (YYYY-MM-DD); "" means since the beginning. */
export function periodStart(period: Period, today: string, issues: Sources["issues"]): string {
  const d = new Date(today + "T00:00:00Z");
  if (period === "Last 7 days") return new Date(d.getTime() - 6 * 86400000).toISOString().slice(0, 10);
  if (period === "This month") return today.slice(0, 8) + "01";
  if (period === "Since last issue") return [...issues].map((i) => i.date).sort().pop() ?? "";
  return "";
}

const inPeriod = (at: string, from: string) => !from || at.slice(0, 10) >= from;

/** What each report holds. */
export const SECTIONS: Record<Kind, string[]> = {
  "Weekly project report": ["Summary", "QA", "Reviews", "Syncs", "Issue status"],
  "Model health and QA": ["QA"],
  "Review register": ["Reviews"],
  "Sync log and workshare": ["Syncs"],
  "Ready to issue record": ["Issue status", "Exceptions"],
  "Rule exceptions": ["Exceptions"],
  "Activity log": ["Activity"],
};

export interface Row { section: string; key: string; value: string | number }
export interface Built { title: string; markdown: string; rows: Row[]; left_out: string[] }

export function buildReport(kind: Kind, src: Sources, opts: { project: string; period: Period; audience: Audience; disciplines: string[]; today: string }): Built {
  const from = periodStart(opts.period, opts.today, src.issues);
  const client = opts.audience === "Client";
  const disc = new Set(opts.disciplines.map((d) => d.toUpperCase()));
  const rows: Row[] = [];
  const md: string[] = [];
  const leftOut: string[] = [];
  const add = (section: string, key: string, value: string | number) => rows.push({ section, key, value });
  const title = `${opts.project || "Project"} · ${kind} · ${opts.today}`;
  md.push(`# ${title}`, "", `Period: ${opts.period}${from ? ` (from ${from})` : ""} · for ${opts.audience}${disc.size ? ` · disciplines ${[...disc].join(", ")}` : ""}`, "");

  let sections = SECTIONS[kind];
  if (client && sections.includes("Activity")) { sections = sections.filter((s) => s !== "Activity"); leftOut.push("Activity log (internal)"); }

  // Reviews in scope (the disciplines filter applies here).
  const items = (src.reviews?.items ?? []).filter((i) => !disc.size || i.disciplines.some((d) => disc.has(d)));
  const open = items.filter((i) => i.status !== "Closed");
  const late = items.filter((i) => overdue(i, opts.today));
  const syncs = src.syncs.filter((s) => inPeriod(s.at, from));
  const issues = src.issues.filter((i) => inPeriod(i.date, from));

  for (const section of sections) {
    if (section === "Summary") {
      md.push("## Summary", "");
      const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
      const lines = [`${n(open.length, "open review item", "open review items")}, ${late.length} overdue`, n(syncs.length, "sync", "syncs"),
        n(issues.length, "issue prepared", "issues prepared")];
      lines.forEach((l) => md.push(`- ${l}`));
      md.push("");
      add("Summary", "open review items", open.length); add("Summary", "overdue review items", late.length);
      add("Summary", "syncs", syncs.length); add("Summary", "issues prepared", issues.length);
    }
    if (section === "QA") {
      md.push("## QA (latest run per model and gate)", "");
      const keys = Object.keys(src.qa).filter((k) => !opts.project || k.toUpperCase().startsWith(opts.project.toUpperCase()));
      if (!keys.length) md.push("No QA runs saved for this project yet.");
      else {
        md.push("| Model | Gate | Last run | Failing | Since the run before |", "|---|---|---|---|---|");
        for (const k of keys.sort()) {
          const runs = src.qa[k].filter((r) => inPeriod(r.at, from));
          if (!runs.length) continue;
          const last = runs[runs.length - 1], prev = runs.length > 1 ? runs[runs.length - 2] : null;
          const [model, gate] = k.split("|");
          const trend = prev ? `${last.failing.filter((f) => !prev.failing.includes(f)).length} new, ${prev.failing.filter((f) => !last.failing.includes(f)).length} resolved` : "first run";
          md.push(`| ${model} | ${gate} | ${last.at.slice(0, 10)} | ${last.failing.length} | ${trend} |`);
          add("QA", `${model} ${gate} failing`, last.failing.length);
        }
      }
      md.push("", "Source: FMC_QA_History.json (each run's report is in the QA folder).", "");
    }
    if (section === "Reviews") {
      md.push("## Open review items", "");
      if (!src.reviews) md.push("No review register yet (01_WIP\\_Reviews).");
      else if (!open.length) md.push("None open.");
      else {
        // Client reports leave out names: items are grouped by lead discipline instead of owner.
        md.push(client ? "| Item | Lead | Due | Status |" : "| Item | Owner | Lead | Due | Status |", client ? "|---|---|---|---|" : "|---|---|---|---|---|");
        for (const i of [...open].sort((a, b) => a.due.localeCompare(b.due)))
          md.push(client ? `| ${i.id} ${i.title} | ${i.lead} | ${i.due} | ${overdue(i, opts.today) ? "Overdue" : i.status} |`
            : `| ${i.id} ${i.title} | ${i.owner} | ${i.lead} | ${i.due} | ${overdue(i, opts.today) ? "Overdue" : i.status} |`);
        if (client) leftOut.push("Review owners' names");
      }
      const raised = items.filter((i) => inPeriod(i.raised_at, from)).length;
      const closed = items.filter((i) => i.status === "Closed" && i.history.some((h) => h.what.startsWith("Accepted") && inPeriod(h.at, from))).length;
      md.push("", `Raised in the period: ${raised} · closed: ${closed}. Source: 01_WIP\\_Reviews\\FMC_Review_Register.json.`, "");
      add("Reviews", "open", open.length); add("Reviews", "overdue", late.length); add("Reviews", "raised", raised); add("Reviews", "closed", closed);
    }
    if (section === "Syncs") {
      md.push("## Syncs per model (counts, not people: MAN 14.5)", "");
      const per = new Map<string, number>();
      for (const s of syncs) per.set(s.model, (per.get(s.model) ?? 0) + 1);
      if (!per.size) md.push("No syncs logged in the period (01_WIP\\FMC_Sync_Log.csv).");
      else { md.push("| Model | Syncs |", "|---|---|"); for (const [m, n] of [...per].sort()) { md.push(`| ${m} | ${n} |`); add("Syncs", m, n); } }
      md.push("");
    }
    if (section === "Issue status") {
      md.push("## Issues prepared", "");
      if (!issues.length) md.push("No issue folders in the period (01_WIP\\_Issue).");
      else { md.push("| Date | Revision | Readiness |", "|---|---|---|"); for (const i of issues) { md.push(`| ${i.date} | ${i.revision} | ${i.result} |`); add("Issue status", `${i.date} ${i.revision}`, i.result); } }
      md.push("");
    }
    if (section === "Exceptions") {
      md.push("## Approved exceptions in force", "");
      const live = src.exceptions.filter((e) => !e.until || !/^\d{4}-\d{2}-\d{2}$/.test(e.until) || e.until >= opts.today);
      if (!live.length) md.push("None.");
      else {
        md.push(client ? "| Sheet | Item | Why | Until |" : "| Sheet | Item | Why | Approved by | Until |", client ? "|---|---|---|---|" : "|---|---|---|---|---|");
        for (const e of live) md.push(client ? `| ${e.sheet} | ${e.item} | ${e.why} | ${e.until} |` : `| ${e.sheet} | ${e.item} | ${e.why} | ${e.approved_by} | ${e.until} |`);
        if (client) leftOut.push("Approvers' names");
      }
      add("Exceptions", "in force", live.length);
      md.push("");
    }
    if (section === "Activity") {
      md.push("## Tool activity (counts per action)", "");
      const per = new Map<string, number>();
      for (const l of src.log.filter((x) => inPeriod(x.at, from))) per.set(`${l.action} · ${l.result}`, (per.get(`${l.action} · ${l.result}`) ?? 0) + 1);
      if (!per.size) md.push("No logged actions in the period.");
      else { md.push("| Action · result | Count |", "|---|---|"); for (const [k, n] of [...per].sort((a, b) => b[1] - a[1])) { md.push(`| ${k} | ${n} |`); add("Activity", k, n); } }
      md.push("", "Source: FMC_MCP_FileLog.csv.", "");
    }
  }
  if (leftOut.length) md.push(`_Left out for the client: ${[...new Set(leftOut)].join(", ")}._`, "");
  return { title, markdown: md.join("\n"), rows, left_out: [...new Set(leftOut)] };
}

/** Tidy CSV (section, key, value) for Power BI. */
export function reportCsv(rows: Row[], csv: (cells: Array<string | number>) => string): string {
  return csv(["section", "key", "value"]) + rows.map((r) => csv([r.section, r.key, r.value])).join("");
}

/** Report container name (MAN 4.1): [Project]-[Originator]-ZZ-ZZ-RP-Z-[Number], numbered after the reports already made. */
export function reportName(code: string, originator: string, existing: string[]): string {
  const prefix = `${code}-${originator}-ZZ-ZZ-RP-Z-`;
  const n = existing.reduce((m, f) => { const x = f.startsWith(prefix) ? Number(f.slice(prefix.length, prefix.length + 4)) : 0; return Number.isNaN(x) ? m : Math.max(m, x); }, 0) + 1;
  return prefix + String(n).padStart(4, "0");
}
