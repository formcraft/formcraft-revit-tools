import { test } from "node:test";
import assert from "node:assert/strict";
import { Sources, buildReport, periodStart, reportCsv, reportName } from "./report.js";
import { csvLine } from "./policy.js";
import { Register, raise } from "./review.js";

const now = new Date("2026-10-14T09:00:00Z");
function sources(): Sources {
  const reviews: Register = { project: "F26001", items: [] };
  raise(reviews, { title: "Beam vs ceiling", description: "x", disciplines: ["A"], lead: "S", owner: "NAME F", priority: "High", raised_by: "NAME A", model: "", view: "", element_ids: [] }, now);
  raise(reviews, { title: "Fire door", description: "y", disciplines: [], lead: "A", owner: "NAME A", priority: "High", due: "2026-10-15", raised_by: "NAME E", model: "", view: "", element_ids: [] }, now);
  return {
    qa: { "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt|wip_to_shared": [{ at: "2026-10-10T08:00:00Z", failing: ["NAM-021", "SHT-022"] }, { at: "2026-10-13T08:00:00Z", failing: ["SHT-022", "SHT-001"] }],
          "F99999-OTHER.rvt|weekly": [{ at: "2026-10-13T08:00:00Z", failing: ["X"] }] },
    reviews,
    syncs: [{ at: "2026-10-13T10:00:00Z", model: "A model", message: "m" }, { at: "2026-10-13T11:00:00Z", model: "A model", message: "m" }, { at: "2026-09-01T10:00:00Z", model: "S model", message: "old" }],
    issues: [{ folder: "2026-10-02_C01", date: "2026-10-02", revision: "C01", result: "Ready" }],
    exceptions: [{ recorded: "", sheet: "A-2001", item: "approval", why: "Agreed by phone", approved_by: "NAME A", until: "C03" }],
    log: [{ at: "2026-10-13T10:00:00Z", action: "qa_run", result: "done" }, { at: "2026-10-13T11:00:00Z", action: "qa_run", result: "done" }],
  };
}
const opts = { project: "F26001", period: "Last 7 days" as const, audience: "Team" as const, disciplines: [] as string[], today: "2026-10-20" };

test("periods: last 7 days, this month, since the last issue", () => {
  assert.equal(periodStart("Last 7 days", "2026-10-20", []), "2026-10-14");
  assert.equal(periodStart("This month", "2026-10-20", []), "2026-10-01");
  assert.equal(periodStart("Since last issue", "2026-10-20", sources().issues), "2026-10-02");
  assert.equal(periodStart("Whole project", "2026-10-20", []), "");
});

test("the weekly report traces every number to a file and counts syncs per model", () => {
  const r = buildReport("Weekly project report", sources(), { ...opts, period: "This month" });
  assert.match(r.markdown, /2 open review items, 1 overdue/);
  assert.match(r.markdown, /\| F26001-FMC-ZZ-ZZ-M3-A-0001\.rvt \| wip_to_shared \| 2026-10-13 \| 2 \| 1 new, 1 resolved \|/);
  assert.doesNotMatch(r.markdown, /F99999/);
  assert.match(r.markdown, /\| A model \| 2 \|/);
  assert.doesNotMatch(r.markdown, /S model/);
  assert.match(r.markdown, /\| NAME F \|/);
});

test("client reports leave out names and the activity log", () => {
  const r = buildReport("Weekly project report", sources(), { ...opts, audience: "Client", period: "Whole project" });
  assert.doesNotMatch(r.markdown, /NAME [AEF]/);
  assert.deepEqual(r.left_out, ["Review owners' names"]);
  const a = buildReport("Activity log", sources(), { ...opts, audience: "Client" });
  assert.doesNotMatch(a.markdown, /Tool activity/);
  assert.deepEqual(a.left_out, ["Activity log (internal)"]);
});

test("the CSV is tidy for Power BI and report names count up", () => {
  const r = buildReport("Review register", sources(), opts);
  assert.match(reportCsv(r.rows, csvLine), /^section,key,value\r\nReviews,open,2\r\n/);
  assert.equal(reportName("F26001", "FMC", ["F26001-FMC-ZZ-ZZ-RP-Z-0006.md", "notes.md"]), "F26001-FMC-ZZ-ZZ-RP-Z-0007");
});

test("RT-3/RT-4/RT-7: role-filtered QA and syncs, models left out are named, an invalid until is not in force", async () => {
  const { modelDiscipline, untilState } = await import("./report.js");
  assert.equal(modelDiscipline("F26001-FMC-ZZ-ZZ-M3-S-0001"), "S");
  assert.equal(modelDiscipline("Project1"), "");
  assert.equal(untilState("C03", "2026-10-20"), "in_force");
  assert.equal(untilState("2026-13-45", "2026-10-20"), "invalid");
  assert.equal(untilState("next week", "2026-10-20"), "invalid");
  assert.equal(untilState("2026-10-01", "2026-10-20"), "expired");
  const s: Sources = {
    qa: { "F26001-FMC-ZZ-ZZ-M3-S-0001|G1": [{ at: "2026-10-19", failing: ["x"] }], "F26001-FMC-ZZ-ZZ-M3-A-0001|G1": [{ at: "2026-10-19", failing: [] }], "Project1|G1": [{ at: "2026-10-19", failing: [] }] },
    reviews: null, syncs: [{ at: "2026-10-19", model: "F26001-FMC-ZZ-ZZ-M3-A-0001", message: "" }], issues: [],
    exceptions: [{ recorded: "", sheet: "S-1", item: "a", why: "w", approved_by: "N", until: "2026-02-30" }], log: [],
  };
  const built = buildReport("Weekly project report", s, { project: "F26001", period: "Last 7 days", audience: "Team", disciplines: ["S"], today: "2026-10-20" });
  assert.deepEqual(built.qa_models?.counted, ["F26001-FMC-ZZ-ZZ-M3-S-0001"]);
  assert.ok(built.qa_models?.left_out.includes("Project1"));
  assert.ok(built.disciplines?.not_filtered.includes("Issue status"));
  assert.match(built.markdown, /No syncs logged/);
  assert.match(built.markdown, /No balance for F26001/);
  const ex = buildReport("Rule exceptions", s, { project: "F26001", period: "Last 7 days", audience: "Team", disciplines: [], today: "2026-10-20" });
  assert.equal(ex.invalid_until?.length, 1);
  assert.ok(ex.rows.some((r) => r.key === "in force" && r.value === 0));
});
