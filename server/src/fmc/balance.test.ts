import { test } from "node:test";
import assert from "node:assert/strict";
import { backlog, backlogTable, callsTable, classify, digest, digestMarkdown, externalKind, homeStatus, inventory, lastWeeks, matchHome,
  summary, toEvents, trackerToStatus, weekStart } from "./balance.js";
import { KISIC_HOMES, mergeHomes } from "./balance_homes.js";
import { buildReport, Sources } from "./report.js";

// A KISIC-like fortnight: last week mostly AI code, this week more tools; one pyRevit button and a Dynamo graph.
const call = (at: string, tool: string, extra: Record<string, unknown> = {}) =>
  ({ at, tool, action: "", ok: true, ms: 1000, project: "KISIC", started_by: "ai", ...extra });
const calls = [
  call("2026-10-07T09:00:00Z", "send_code_to_revit", { purpose: "Export sheet PNGs", code_hash: "aaa111aaa111", ms: 4000 }),
  call("2026-10-07T09:10:00Z", "send_code_to_revit", { code_hash: "aaa111aaa111", ms: 3000, ok: false }),
  call("2026-10-08T09:00:00Z", "send_code_to_revit", { purpose: "LED strips on room walls", code_hash: "bbb", ms: 2000 }),
  call("2026-10-08T10:00:00Z", "send_code_to_revit", { code_hash: "ccc", ms: 500 }),
  call("2026-10-08T11:00:00Z", "fmc_job", { action: "status" }),
  call("2026-10-14T09:00:00Z", "send_code_to_revit", { purpose: "export sheet pngs", code_hash: "aaa222", ms: 4000 }),
  call("2026-10-14T10:00:00Z", "fmc_qa", { action: "run", started_by: "pane" }),
  call("2026-10-15T10:00:00Z", "fmc_report", { action: "make", started_by: "schedule", project: "F26001" }),
  call("2026-10-15T11:00:00Z", "fmc_scripts", { action: "addon_run", addon: "qa_orphans", started_by: "job" }),
];
const externals = [
  { at: "2026-10-14T12:00:00Z", kind: "pyRevit", script: "FMC_CreateSheetsFromRegister", ok: true, ms: 800, started_by: "person" },
  { at: "2026-10-15T12:00:00Z", kind: "Dynamo", script: "FMC_ModelHealth.py", ok: false, ms: 200 },
  { at: "2026-10-15T13:00:00Z", kind: "node", script: "tidy.js", ok: true, ms: 50 },
];
const events = toEvents([...calls, { nonsense: true }], externals);
const today = "2026-10-15";

test("kinds: send_code is AI code, addon_run a saved add-on, every other tool a plugin tool; hooks name their kind", () => {
  assert.equal(classify("send_code_to_revit", ""), "ai_code");
  assert.equal(classify("fmc_scripts", "addon_run"), "saved_addon");
  assert.equal(classify("fmc_scripts", "list"), "plugin_tool");
  assert.equal(classify("get_current_view_info", ""), "plugin_tool");
  assert.deepEqual(["pyRevit", "IronPython", "Dynamo", "GhPython", "py", "node", "pwsh", "bat", "excel"].map(externalKind),
    ["pyrevit", "pyrevit", "dynamo", "grasshopper", "python", "js", "powershell", "batch", "other"]);
  assert.equal(events.length, 12);
});

test("weeks start on Monday; the default period is the last 4 whole weeks", () => {
  assert.equal(weekStart("2026-10-19T08:00:00Z"), "2026-10-19");
  assert.equal(weekStart("2026-10-18T23:00:00Z"), "2026-10-12");
  assert.equal(weekStart("2026-10-15"), "2026-10-12");
  assert.deepEqual(lastWeeks("2026-10-15", 4), { from: "2026-09-21", to: "2026-10-15" });
});

test("summary: shares by kind and by who started them, per project, with a gap-free weekly trend", () => {
  const s = summary(events, { from: "2026-10-05", to: today });
  assert.equal(s.total, 12);
  const kind = Object.fromEntries(s.by_kind.map((k) => [k.key, k.calls]));
  assert.deepEqual(kind, { ai_code: 5, plugin_tool: 3, saved_addon: 1, external: 3 });
  assert.equal(s.ai_share, 41.7);
  assert.equal(s.automation_share, 58.3);
  assert.equal(s.by_kind[0].label, "AI code");
  assert.deepEqual(s.plugin_by_started_by.map((x) => [x.key, x.calls]), [["ai", 1], ["pane", 1], ["schedule", 1]]);
  assert.deepEqual(s.external_by_kind.map((x) => x.key), ["pyrevit", "dynamo", "js"]);
  assert.deepEqual(s.weeks.map((w) => [w.week, w.total, w.ai_share]), [["2026-10-05", 5, 80], ["2026-10-12", 7, 14.3]]);
  assert.deepEqual(s.projects.map((p) => p.project), ["(none given)", "F26001", "KISIC"]);
  const one = summary(events, { from: "2026-10-05", to: today, project: "f26001" });
  assert.equal(one.total, 1);
});

test("the move list groups AI code by purpose (a re-send without one joins it by hash), ranked by count then time", () => {
  const items = backlog(events, KISIC_HOMES, []);
  assert.deepEqual(items.map((i) => [i.rank, i.purpose, i.calls]), [
    [1, "Export sheet PNGs", 3], [2, "LED strips on room walls", 1], [3, "(no purpose) code ccc", 1]]);
  assert.equal(items[0].errors, 1);
  assert.equal(items[0].ms, 11000);
  assert.equal(items[0].code_hashes, 2);
  assert.equal(items[0].home_id, "view_screenshot");
  assert.equal(items[0].priority, "P1");
  assert.equal(items[0].status, "planned");
  assert.equal(items[1].home_id, "strips");
  assert.match(items[2].home, /ask the AI to pass purpose/);
});

test("homes: keywords start a word; the status comes from the tracker when it can, else the mapping", () => {
  assert.equal(matchHome("make the SLD and riser", KISIC_HOMES)?.id, "circuits");
  assert.equal(matchHome("relight after the ceiling change", KISIC_HOMES)?.id, "orphans");
  assert.equal(matchHome("unpanelled", KISIC_HOMES)?.id, undefined);
  const features = [{ id: "F80", feature: "Project screenshots: fmc_view screenshot", status: "Built, Revit check due" },
    { id: "F81", feature: "Legends", status: "Tested in Revit" }];
  assert.deepEqual(homeStatus(KISIC_HOMES[0], features), { status: "built", tracker_status: "Built, Revit check due", feature: "F80" });
  assert.equal(homeStatus({ ...KISIC_HOMES[6], feature: "F81" }, features).status, "tested");
  assert.equal(homeStatus(KISIC_HOMES[2], features).status, "planned");
  assert.deepEqual(["Planned", "Designed", "In progress", "Waiting on you", "Built, Revit check due", "Tested in Revit"].map(trackerToStatus),
    ["planned", "planned", "in progress", "in progress", "built", "tested"]);
  const merged = mergeHomes(KISIC_HOMES, [{ id: "mine", keywords: ["Rebar"], home: "fmc_rebar" }, { id: "legend", keywords: ["legend"], home: "fmc_legend build v2" }, "junk"]);
  assert.equal(merged[0].id, "mine");
  assert.equal(merged[0].keywords[0], "rebar");
  assert.equal(merged.find((h) => h.id === "legend")!.home, "fmc_legend build v2");
  assert.equal(merged.length, KISIC_HOMES.length + 1);
});

test("inventory: the kit's scripts beside how often each ran, and runs of scripts the kit doesn't have", () => {
  const inv = inventory([
    { name: "FMC_CreateSheetsFromRegister", type: "pyRevit", file: "K:\\pyRevit\\FMC.tab\\2_CreateSheets.pushbutton\\script.py" },
    { name: "FMC_ModelHealth", type: "Dynamo (Python node)", file: "K:\\05_Scripts\\Dynamo\\FMC_ModelHealth.py" },
    { name: "fmc_boq_build", type: "Python tool", file: "K:\\05_Scripts\\tools\\fmc_boq_build.py" },
  ], events);
  assert.deepEqual(inv.scripts.map((s) => [s.name, s.runs, s.errors]), [["FMC_CreateSheetsFromRegister", 1, 0], ["FMC_ModelHealth", 1, 1], ["fmc_boq_build", 0, 0]]);
  assert.deepEqual(inv.not_in_kit, [{ script: "tidy.js", kind: "js", runs: 1, last: "2026-10-15T13:00:00Z" }]);
  assert.deepEqual(inv.by_type.map((t) => [t.type, t.ran]), [["pyRevit", 1], ["Dynamo (Python node)", 1], ["Python tool", 0]]);
});

test("the weekly digest: this week's shares, the change since last week and the top five", () => {
  const d = digest(events, today, KISIC_HOMES, []);
  assert.equal(d.week.total, 7);
  assert.equal(d.last_week.total, 5);
  assert.equal(d.week.ai_share, 14.3);
  assert.equal(d.last_week.ai_share, 80);
  assert.equal(d.change_ai_pts, -65.7);
  assert.equal(d.top[0].purpose, "Export sheet PNGs");
  const md = digestMarkdown(d).join("\n");
  assert.match(md, /## Automation balance/);
  assert.match(md, /\| AI code \| 1 \| 14\.3% \|/);
  assert.match(md, /down 65\.7 points/);
  assert.match(md, /\| 1 \| Export sheet PNGs \| 3 \| 11 s \| fmc_view screenshot/);
  assert.match(digestMarkdown(digest([], today, KISIC_HOMES, [])).join("\n"), /No calls recorded/);
});

test("the weekly report carries the balance for the team and leaves it out for a client", () => {
  const src: Sources = { qa: {}, reviews: null, syncs: [], issues: [], exceptions: [], log: [],
    balance: { digest: digest(events, today, KISIC_HOMES, []), scope: "KISIC's calls" } };
  const opts = { project: "KISIC", period: "Last 7 days" as const, audience: "Team" as const, disciplines: [], today };
  const team = buildReport("Weekly project report", src, opts);
  assert.match(team.markdown, /## Automation balance[\s\S]*Counted over KISIC's calls\./);
  assert.ok(team.rows.some((r) => r.section === "Automation balance" && r.key === "AI code share %" && r.value === 14.3));
  const client = buildReport("Weekly project report", src, { ...opts, audience: "Client" });
  assert.doesNotMatch(client.markdown, /## Automation balance/);
  assert.ok(client.left_out.includes("Automation balance (internal)"));
});

test("Power BI tables are tidy: one row per week, project, kind, sub and starter; the move list as rows", () => {
  const t = callsTable(events);
  assert.deepEqual(t[0], ["week_start", "project", "kind", "sub", "started_by", "calls", "errors", "ms"]);
  assert.ok(t.some((r) => r.join() === "2026-10-05,KISIC,ai_code,send_code_to_revit,ai,4,1,9500"));
  assert.ok(t.some((r) => r.join() === "2026-10-12,,external,dynamo,person,1,1,200"));
  const b = backlogTable(backlog(events, KISIC_HOMES, []));
  assert.equal(b[0][0], "rank");
  assert.equal(b.length, 4);
});
