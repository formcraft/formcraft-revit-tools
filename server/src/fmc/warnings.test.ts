import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS, loadConfig } from "./policy.js";
import {
  CSV_HEADER, NONE, filterRows, historyFile, isReviewPath, readHistory, snapshotOf, ticketDrafts, trend, triage, valuesOf, warningKey, warningsCsv, writeHistory, type WarningRow,
} from "./warnings.js";
import { runFmcWarnings, FMC_WARNINGS_SHAPE, type FmcWarningsArgs } from "../tools/fmc_warnings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const G_JOIN = "11111111-1111-1111-1111-111111111111";
const G_OVERLAP = "22222222-2222-2222-2222-222222222222";
const G_ROOM = "33333333-3333-3333-3333-333333333333";

const el = (id: number, level: string, workset: string, owner: string, role = "failing") => ({ id, level, workset, owner, category: "Walls", role });
const row = (failure_id: string, description: string, elements: ReturnType<typeof el>[], severity = "Warning"): WarningRow => ({ failure_id, description, severity, elements });

function sample(): WarningRow[] {
  return [
    row(G_JOIN, "Highlighted joins overlap", [el(1, "L1", "Shell", "anna"), el(2, "L1", "Shell", "anna")]),
    row(G_JOIN, "Highlighted joins overlap", [el(3, "L1", "Shell", "anna")]),
    row(G_JOIN, "Highlighted joins overlap", [el(4, "L2", "Shell", "bob")]),
    row(G_OVERLAP, "Highlighted walls overlap", [el(5, "L2", "Interior", "bob"), el(6, "L2", "Interior", "", "additional")]),
    row(G_OVERLAP, "Highlighted walls overlap", [el(7, "L2", "Interior", "")]),
    row(G_ROOM, "Room is not enclosed", [el(8, "", "", "")], "Error"),
  ];
}

/** Every test writes under its own temp folder. Never a real project folder. */
function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "fmcwarn-")); }
function guardFor(dir: string, writeRoots: string[]) {
  const file = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(file, JSON.stringify({ write_roots: writeRoots, reports_dir: path.join(dir, "reports") }));
  return loadConfig(file).config;
}
function listAll(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? listAll(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

test("triage counts by failure id, level, workset and owner", () => {
  const t = triage(sample());
  assert.equal(t.total, 6);
  assert.deepEqual(t.by_failure.map((f) => [f.failure_id, f.warnings]), [[G_JOIN, 3], [G_OVERLAP, 2], [G_ROOM, 1]]);
  assert.equal(t.by_failure[0].share_percent, 50);
  assert.deepEqual(t.by_failure[0].failing_ids, [1, 2, 3, 4]);
  assert.equal(t.by_failure[0].failing_count, 4);
  assert.equal(t.by_failure[0].additional_count, 0);
  assert.deepEqual(t.by_level.map((l) => [l.key, l.warnings]), [["L2", 3], ["L1", 2], [NONE, 1]]);
  assert.deepEqual(t.by_workset.map((l) => [l.key, l.warnings]), [["Shell", 3], ["Interior", 2], [NONE, 1]]);
  assert.deepEqual(Object.fromEntries(t.by_owner.map((o) => [o.key, o.warnings])), { anna: 2, bob: 2, [NONE]: 2 });
  const anna = t.by_owner.find((o) => o.key === "anna")!;
  assert.equal(anna.top_failures[0].failure_id, G_JOIN);
  assert.deepEqual(t.by_severity, [{ key: "Warning", warnings: 5 }, { key: "Error", warnings: 1 }]);
  assert.match(t.advice.join(" "), /errors/);
  assert.match(t.advice.join(" "), /Highlighted joins overlap/);
});

test("every group lists failing and additional element ids, capped, with a count", () => {
  const t = triage(sample());
  const overlap = t.by_failure.find((f) => f.failure_id === G_OVERLAP)!;
  assert.deepEqual(overlap.failing_ids, [5, 7]);
  assert.deepEqual(overlap.additional_ids, [6]);
  assert.equal(overlap.failing_count, 2);
  assert.equal(overlap.additional_count, 1);
  const l2 = t.by_level.find((l) => l.key === "L2")!;
  assert.deepEqual(l2.failing_ids, [4, 5, 7]);
  assert.deepEqual(l2.additional_ids, [6]);
  const interior = t.by_workset.find((l) => l.key === "Interior")!;
  assert.equal(interior.failing_count, 2);
  assert.equal(interior.additional_count, 1);
  const bob = t.by_owner.find((o) => o.key === "bob")!;
  assert.deepEqual(bob.failing_ids, [4, 5]);
  // the cap cuts the lists, never the counts
  const capped = triage(sample(), { id_cap: 1 });
  const joins = capped.by_failure.find((f) => f.failure_id === G_JOIN)!;
  assert.deepEqual(joins.failing_ids, [1]);
  assert.equal(joins.failing_count, 4);
  assert.deepEqual(joins.levels.find((l) => l.key === "L1")!.failing_ids, [1]);
  assert.equal(joins.levels.find((l) => l.key === "L1")!.failing_count, 3);
  const none = triage(sample(), { id_cap: 0 });
  assert.deepEqual(none.by_failure[0].failing_ids, []);
  assert.equal(none.by_failure[0].failing_count, 4);
});

test("a warning counts once per distinct value; additional elements do not decide the owner", () => {
  const r = row(G_JOIN, "x", [el(1, "L1", "A", "anna"), el(2, "L2", "A", "anna"), el(3, "L9", "Z", "zed", "additional")]);
  assert.deepEqual(valuesOf(r, "level"), ["L1", "L2"]);
  assert.deepEqual(valuesOf(r, "owner"), ["anna"]);
  const onlyExtra = row(G_JOIN, "x", [el(3, "L9", "Z", "zed", "additional")]);
  assert.deepEqual(valuesOf(onlyExtra, "owner"), ["zed"]);
  assert.deepEqual(valuesOf(row(G_JOIN, "x", []), "workset"), [NONE]);
});

test("filters narrow the rows, case-insensitively", () => {
  const rows = sample();
  assert.equal(filterRows(rows, { level: "l2" }).length, 3);
  assert.equal(filterRows(rows, { owner: "ANNA" }).length, 2);
  assert.equal(filterRows(rows, { failure_id: G_ROOM }).length, 1);
  assert.equal(filterRows(rows, { severity: "error" }).length, 1);
  assert.equal(filterRows(rows, { workset: "interior", level: "L2" }).length, 2);
  assert.equal(triage([]).total, 0);
  assert.deepEqual(triage([]).advice, ["No warnings in the model."]);
});

test("trend compares with the previous snapshot: totals, new and resolved, and change per failure id, level, workset and owner", () => {
  const before = sample();
  const after = [...before.slice(1), row(G_JOIN, "Highlighted joins overlap", [el(9, "L3", "Roof", "cy")]), row(G_JOIN, "Highlighted joins overlap", [el(10, "L3", "Roof", "cy")])];
  const older = { ...snapshotOf(before.slice(2), "2026-10-30T00:00:00.000Z") };
  const prior = { version: 1 as const, document: "M", history: [older, snapshotOf(before, "2026-11-01T00:00:00.000Z")], keys: before.map(warningKey) };
  const t = trend(prior, snapshotOf(after, "2026-11-02T00:00:00.000Z"), after.map(warningKey));
  assert.equal(t.has_previous, true);
  assert.equal(t.since, "2026-11-01T00:00:00.000Z", "the previous snapshot is the last one saved, not an older one");
  assert.equal(t.total_before, 6);
  assert.equal(t.total_after, 7);
  assert.equal(t.total_delta, 1);
  assert.equal(t.direction, "up");
  assert.equal(t.new_warnings, 2);
  assert.equal(t.resolved_warnings, 1);
  assert.deepEqual(t.by_failure, [{ key: G_JOIN, before: 3, after: 4, delta: 1 }]);
  assert.deepEqual(t.by_level?.map((d) => [d.key, d.delta]), [["L3", 2], ["L1", -1]]);
  assert.deepEqual(t.by_workset?.map((d) => [d.key, d.delta]), [["Roof", 2], ["Shell", -1]]);
  assert.deepEqual(t.by_owner?.map((d) => [d.key, d.delta]), [["cy", 2], ["anna", -1]]);
  assert.match(t.advice.join(" "), /up by 1/);
  assert.match(t.advice.join(" "), /Growing most/);
  assert.equal(trend(undefined, snapshotOf(after, "x"), []).has_previous, false);
  const same = trend({ version: 1, document: "M", history: [snapshotOf(before, "a")], keys: before.map(warningKey) }, snapshotOf(before, "b"), before.map(warningKey));
  assert.equal(same.direction, "flat");
  assert.equal(same.new_warnings, 0);
  assert.deepEqual(same.by_failure, []);
});

test("the snapshot store round-trips, is capped, refuses a review path, and a corrupt file is reported not trusted", () => {
  const dir = temp();
  const file = historyFile(dir, "My Model: A/B", "C:\\x\\m.rvt");
  assert.match(path.basename(file), /^warnings-My_Model_A_B-[0-9a-f]{8}\.json$/);
  assert.deepEqual(readHistory(file), {});
  let prior = undefined as ReturnType<typeof readHistory>["history"];
  for (let i = 0; i < 65; i++) {
    writeHistory(file, "M", prior, snapshotOf(sample(), `t${i}`), ["k"]);
    prior = readHistory(file).history;
  }
  assert.equal(prior!.history.length, 60);
  assert.equal(prior!.history[59].at, "t64");
  fs.writeFileSync(file, "{not json");
  assert.match(readHistory(file).problem ?? "", /could not be read/);
  fs.writeFileSync(file, JSON.stringify({ version: 2 }));
  assert.match(readHistory(file).problem ?? "", /unknown shape/);
  const bad = path.join(dir, "01_WIP", "_Reviews", "warnings-x.json");
  assert.throws(() => writeHistory(bad, "M", undefined, snapshotOf(sample(), "t"), []), /review/);
  assert.equal(fs.existsSync(path.dirname(bad)), false);
  assert.ok(isReviewPath("D:\\P\\01_WIP\\_Reviews\\x.json"));
  assert.ok(isReviewPath("D:\\P\\FMC_Review_Register.json"));
  assert.ok(!isReviewPath("D:\\P\\06_QA\\Warnings\\x.json"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the CSV is long format, Power BI friendly, and safe from formulas", () => {
  const rows = [...sample().slice(0, 2), row(G_ROOM, 'Room "A", not enclosed', [], "Error"), row(G_JOIN, "=HYPERLINK(\"x\")", [el(11, "L1", "Shell", "a,b")])];
  const csv = warningsCsv(rows, "M", "2026-11-28T10:00:00.000Z");
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], CSV_HEADER.join(","));
  assert.equal(lines.length, 1 + 2 + 1 + 1 + 1);
  assert.match(lines[1], /^2026-11-28T10:00:00.000Z,M,1111/);
  assert.ok(lines.some((l) => l.includes('"Room ""A"", not enclosed"')));
  assert.ok(lines.some((l) => l.includes("'=HYPERLINK")), "a leading = is neutralised");
  assert.ok(lines.some((l) => l.includes('"a,b"')));
});

test("ticket drafts are text for a person: never raised, owner only suggested", () => {
  const drafts = ticketDrafts(triage(sample()), "M", 2);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].failure_id, G_JOIN);
  assert.equal(drafts[0].draft, true);
  assert.equal(drafts[0].raised, false);
  assert.equal(drafts[0].priority, "High");
  assert.equal(drafts[0].suggested_owner, "anna");
  assert.deepEqual(drafts[0].element_ids, [1, 2, 3, 4]);
  assert.ok(drafts[0].needs.length >= 2);
  assert.equal(ticketDrafts(triage(sample()), "M", 0).length, 0);
});

const args = (over: Partial<FmcWarningsArgs> = {}): FmcWarningsArgs => z.object(FMC_WARNINGS_SHAPE).parse({ document: "M", ...over });
const revitReply = (rows: WarningRow[], extra: Record<string, unknown> = {}) => ({ title: "M", path: "C:\\m.rvt", is_workshared: true, total: rows.length, returned: rows.length, truncated: false, read_problems: { elements_unread: 0, failure_id_missing: 0 }, warnings: rows, ...extra });
const parse = (r: { content: Array<{ text: string }>; isError?: boolean }) => JSON.parse(r.content[0].text);

test("fmc_warnings: document is required, and the schema says so", async () => {
  assert.throws(() => z.object(FMC_WARNINGS_SHAPE).parse({}));
  let called = false;
  const r = await runFmcWarnings({ ...args(), document: "  " }, { guard: guardFor(temp(), []), read: async () => { called = true; return revitReply([]); } });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, "FMC-DOC-REQUIRED");
  assert.equal(called, false);
});

test("fmc_warnings: the snapshot goes to <project>\\06_QA\\Warnings when the guard allows, the second run shows the trend, the CSV sits beside it", async () => {
  const dir = temp();
  const project = path.join(dir, "Projects", "F1");
  const guard = guardFor(dir, [path.join(project, "06_QA")]);
  let n = 0;
  const calls: Array<Record<string, unknown>> = [];
  const io = (rows: WarningRow[]) => ({ guard, now: () => new Date(Date.UTC(2026, 10, 28, 10, n++)), read: async (b: Record<string, unknown>) => { calls.push(b); return revitReply(rows); } });
  const first = parse(await runFmcWarnings(args({ project_folder: project, csv: true }), io(sample())));
  assert.equal(first.tool, "fmc_warnings");
  assert.equal(first.read_only, true);
  assert.equal(first.model_changed, false);
  assert.equal(first.deleted_warnings, 0);
  assert.equal(first.triage.total, 6);
  assert.equal(first.trend.has_previous, false);
  assert.ok(first.snapshot.startsWith(path.join(project, "06_QA", "Warnings")), first.snapshot);
  assert.ok(fs.existsSync(first.snapshot));
  assert.equal(first.csv.written, true);
  assert.ok(first.csv.file.startsWith(path.join(project, "06_QA", "Warnings")));
  const text = fs.readFileSync(first.csv.file, "utf8");
  assert.ok(text.startsWith("\uFEFF" + CSV_HEADER.join(",")));
  assert.equal(first.csv.rows, 8);
  const second = parse(await runFmcWarnings(args({ project_folder: project }), io(sample().slice(2))));
  assert.equal(second.trend.has_previous, true);
  assert.equal(second.trend.total_delta, -2);
  assert.equal(second.trend.direction, "down");
  assert.equal(second.trend.resolved_warnings, 2);
  assert.equal(calls[0].document, "M");
  assert.equal(calls[0].max_rows, 10000);
  // only the warnings folder was written: no review folder, no register, nothing in 01_WIP, nothing in the reports folder
  const written = listAll(dir).filter((f) => !f.endsWith("fmc_guard.json"));
  assert.ok(written.every((f) => f.startsWith(path.join(project, "06_QA", "Warnings"))), written.join("\n"));
  assert.equal(written.length, 2);
  assert.equal(fs.existsSync(path.join(project, "01_WIP")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_warnings: where the guard refuses the project, snapshots use reports_dir and the CSV is skipped with the reason", async () => {
  const dir = temp();
  const project = path.join(dir, "Projects", "F2");
  const guard = guardFor(dir, [path.join(dir, "Projects", "F1", "06_QA")]);
  const out = parse(await runFmcWarnings(args({ project_folder: project, csv: true }), { guard, read: async () => revitReply(sample()) }));
  assert.ok(out.snapshot.startsWith(path.join(dir, "reports", "Warnings")), out.snapshot);
  assert.equal(out.csv.written, false);
  assert.match(out.csv.reason, /project folder only/);
  assert.match(out.problems.join(" "), /Not written to the project folder/);
  assert.equal(fs.existsSync(project), false);
  const noProject = parse(await runFmcWarnings(args({ csv: true }), { guard, read: async () => revitReply(sample()) }));
  assert.equal(noProject.csv.written, false);
  assert.match(noProject.csv.reason, /no project_folder/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_warnings: a project folder that is the review folder is never written", async () => {
  const dir = temp();
  const reviews = path.join(dir, "Projects", "F1", "01_WIP", "_Reviews");
  const guard = guardFor(dir, [path.join(dir, "Projects", "F1")]);
  const out = parse(await runFmcWarnings(args({ project_folder: reviews, csv: true }), { guard, read: async () => revitReply(sample()) }));
  assert.equal(out.csv.written, false);
  assert.equal(fs.existsSync(reviews), false);
  assert.ok(!listAll(dir).some((f) => /_reviews/i.test(f)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_warnings: ticket drafts come back as text and nothing is raised or written for them", async () => {
  const dir = temp();
  const guard = guardFor(dir, []);
  const out = parse(await runFmcWarnings(args({ ticket_drafts: true, ticket_top: 2, save_snapshot: false, trend: false }), { guard, read: async () => revitReply(sample()) }));
  assert.equal(out.ticket_drafts.length, 2);
  assert.ok(out.ticket_drafts.every((d: { raised: boolean; draft: boolean }) => d.draft === true && d.raised === false));
  assert.match(out.ticket_note, /Drafts only/);
  assert.deepEqual(listAll(dir).filter((f) => !f.endsWith("fmc_guard.json")), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_warnings: a filtered run narrows the triage and never saves or compares", async () => {
  const dir = temp();
  const guard = guardFor(dir, []);
  const out = parse(await runFmcWarnings(args({ owner: "anna" }), { guard, read: async () => revitReply(sample()) }));
  assert.equal(out.filtered, true);
  assert.equal(out.triage.total, 2);
  assert.equal(out.revit_total, 6);
  assert.equal(out.snapshot, undefined);
  assert.deepEqual(listAll(dir).filter((f) => !f.endsWith("fmc_guard.json")), []);
  assert.match(out.trend.advice[0], /filtered/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_warnings: a bad or missing reply is an error, never 'no warnings'", async () => {
  const guard = guardFor(temp(), []);
  for (const bad of [undefined, null, "x", {}, { title: "M", warnings: "nope" }]) {
    const r = await runFmcWarnings(args({ save_snapshot: false }), { guard, read: async () => bad });
    assert.equal(r.isError, true, JSON.stringify(bad));
    assert.equal(parse(r).code, "FMC-WARNINGS-BAD-REPLY");
  }
  const mismatch = await runFmcWarnings(args({ save_snapshot: false }), { guard, read: async () => revitReply(sample(), { total: 9 }) });
  assert.equal(mismatch.isError, true);
  const thrown = await runFmcWarnings(args(), { guard, read: async () => { throw new Error("[FMC-DOC-NOT-FOUND] No open document has title or path \"M\"."); } });
  assert.equal(thrown.isError, true);
  assert.equal(parse(thrown).code, "FMC-DOC-NOT-FOUND");
});

test("fmc_warnings: a cut-short read says so and is not saved or compared; unread details are reported", async () => {
  const dir = temp();
  const guard = guardFor(dir, []);
  const cut = parse(await runFmcWarnings(args({ max_rows: 3 }), { guard, read: async () => revitReply(sample().slice(0, 3), { total: 6, truncated: true }) }));
  assert.match(cut.problems.join(" "), /only the first 3 rows/);
  assert.equal(cut.snapshot, undefined);
  assert.deepEqual(listAll(dir).filter((f) => !f.endsWith("fmc_guard.json")), []);
  const unread = parse(await runFmcWarnings(args({ save_snapshot: false, trend: false }), { guard, read: async () => revitReply(sample(), { read_problems: { elements_unread: 2, failure_id_missing: 1 } }) }));
  assert.match(unread.problems.join(" "), /2 element\(s\) unread, 1 warning/);
  assert.equal(unread.trend, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_warnings is a read command; the Revit side never writes or deletes; the server never reaches the network or a review register", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_warnings"));
  assert.ok(!WRITE_COMMANDS.has("fmc_warnings"));
  const handler = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcWarningsHandler.cs"), "utf8");
  assert.match(handler, /doc\.GetWarnings\(\)/);
  assert.match(handler, /GetFailureDefinitionId\(\)\.Guid/);
  assert.match(handler, /EDITED_BY/);
  assert.match(handler, /FmcTarget\.Resolve\(app, Parameters, mayOpen: false\)/);
  assert.doesNotMatch(handler, /new Transaction|TransactionGroup|DeleteWarning|\.Delete\(|SetParameter|\.DeleteElements?\(/);
  const cmd = fs.readFileSync(path.join(root, "commandset", "Commands", "Fmc", "FmcWarningsCommand.cs"), "utf8");
  assert.match(cmd, /CommandName => "fmc_warnings"/);
  const parsed = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8"));
  const commands = (Array.isArray(parsed) ? parsed : parsed.commands) as Array<{ commandName: string }>;
  assert.ok(commands.some((c) => c.commandName === "fmc_warnings"), "command.json lists fmc_warnings");
  for (const file of [path.join("server", "src", "tools", "fmc_warnings.ts"), path.join("server", "src", "fmc", "warnings.ts")]) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(src, /FMC_Review_Register|registerFile|from "node:https?"|from "node:net"|fetch\(|powerbi\.com|api\.powerbi/i, file);
  }
});