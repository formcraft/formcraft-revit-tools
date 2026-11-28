import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS, loadConfig } from "./policy.js";
import { filterLedger, isReviewPath, ledgerFileProblem, ledgerFilesFor, ledgerName, modelSlug, parseLedger, summarize, type LedgerRow } from "./watch.js";
import { FMC_WATCH_SHAPE, runFmcWatch, type FmcWatchArgs } from "../tools/fmc_watch.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const row = (t: string, user: string, id: number, cat: string, type: string, tx = "Move walls", extra: Partial<LedgerRow> = {}): LedgerRow => ({ t, user, doc: "M", op: "TransactionCommitted", tx, id, cat, type, ...extra });

/** A day of changes by two people, written the way the add-in writes them (local time with an offset). */
function ledger(): LedgerRow[] {
  return [
    { t: "2026-11-28T08:00:00.0000000+03:00", user: "anna", doc: "M", type: "watch_started", note: "scope model" },
    row("2026-11-28T09:05:00.0000000+03:00", "anna", 1, "Walls", "added", "Create walls"),
    row("2026-11-28T09:05:00.0000000+03:00", "anna", 2, "Walls", "added", "Create walls"),
    row("2026-11-28T09:40:00.0000000+03:00", "anna", 1, "Walls", "geometry", "Move walls"),
    row("2026-11-28T10:15:00.0000000+03:00", "bob", 3, "Doors", "parameter", "Edit mark"),
    row("2026-11-28T10:20:00.0000000+03:00", "bob", 4, "Doors", "deleted", "Delete doors"),
    row("2026-11-28T10:20:00.0000000+03:00", "bob", 5, "(unknown)", "deleted", "Delete doors"),
    row("2026-11-29T11:00:00.0000000+03:00", "bob", 6, "Rooms", "modified", "Undo", { op: "TransactionUndone" }),
    { t: "2026-11-29T11:00:00.0000000+03:00", user: "bob", doc: "M", op: "TransactionUndone", tx: "Undo", type: "summary", not_listed: 7 },
    { t: "2026-11-29T18:00:00.0000000+03:00", user: "anna", doc: "M", type: "watch_stopped", note: "stop" },
  ];
}
const lines = (rows: LedgerRow[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Every test writes under its own temp folder. Never a real project folder. */
function temp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "fmcwatch-")); }
function guardFor(dir: string, writeRoots: string[]) {
  const file = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(file, JSON.stringify({ write_roots: writeRoots, reports_dir: path.join(dir, "reports") }));
  return loadConfig(file).config;
}
function listAll(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? listAll(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}

test("the ledger parser keeps good lines, skips a BOM and blanks, and counts bad lines", () => {
  const good = lines(ledger());
  const whole = parseLedger(good);
  assert.equal(whole.rows.length, 10);
  assert.equal(whole.bad, 0);
  const messy = parseLedger("\uFEFF" + good + "\n{not json\n" + JSON.stringify({ nope: 1 }) + "\n" + good.split("\n")[1].slice(0, 30));
  assert.equal(messy.rows.length, 10);
  assert.equal(messy.bad, 3);
});

test("filters: user, category, change type, element, and a time window", () => {
  const rows = ledger();
  assert.equal(filterLedger(rows, {}).length, 7, "meta rows are not changes");
  assert.equal(filterLedger(rows, { user: "BOB" }).length, 4);
  assert.equal(filterLedger(rows, { category: "doors" }).length, 2);
  assert.equal(filterLedger(rows, { change_type: "deleted" }).length, 2);
  assert.equal(filterLedger(rows, { element_id: "1" }).length, 2);
  assert.equal(filterLedger(rows, { since: "2026-11-28T10:00:00+03:00", until: "2026-11-29T00:00:00+03:00" }).length, 3);
  assert.equal(filterLedger(rows, { since: "2026-11-29" }).length, 1);
  assert.throws(() => filterLedger(rows, { since: "yesterday" }), /not a date/);
});

test("summary by user, category, change type, transaction and time", () => {
  const s = summarize(ledger(), {}, { bucket: "hour" });
  assert.equal(s.changes, 7);
  assert.equal(s.elements, 6);
  assert.equal(s.first, "2026-11-28T09:05:00.0000000+03:00");
  assert.deepEqual(s.by_user.map((g) => [g.key, g.changes, g.elements]), [["bob", 4, 4], ["anna", 3, 2]]);
  const anna = s.by_user.find((g) => g.key === "anna")!;
  assert.deepEqual([anna.added, anna.geometry, anna.deleted], [2, 1, 0]);
  assert.deepEqual(s.by_category.map((g) => [g.key, g.changes]), [["Walls", 3], ["Doors", 2], ["(unknown)", 1], ["Rooms", 1]]);
  assert.deepEqual(s.by_type, [{ key: "added", changes: 2 }, { key: "deleted", changes: 2 }, { key: "geometry", changes: 1 }, { key: "modified", changes: 1 }, { key: "parameter", changes: 1 }]);
  assert.equal(s.by_transaction[0].key, "Create walls");
  assert.deepEqual(s.by_time.map((b) => [b.bucket, b.changes]), [["2026-11-28T09:00", 3], ["2026-11-28T10:00", 3], ["2026-11-29T11:00", 1]]);
  assert.equal(s.not_listed, 7);
  assert.equal(s.watch_starts, 1);
  assert.equal(s.watch_stops, 1);
  assert.match(s.advice.join(" "), /bob made 4 of 7/);
  assert.match(s.advice.join(" "), /Most changed category: Walls/);
  assert.match(s.advice.join(" "), /not listed/);
  const days = summarize(ledger(), {}, { bucket: "day" });
  assert.deepEqual(days.by_time, [{ bucket: "2026-11-28", changes: 6 }, { bucket: "2026-11-29", changes: 1 }]);
  const none = summarize(ledger(), { user: "nobody" });
  assert.equal(none.changes, 0);
  assert.deepEqual(none.advice, ["No changes in the ledger for this filter."]);
});

test("ledger names and the file rules: a .jsonl in a Watch folder, never a review path", () => {
  assert.equal(modelSlug("D:\\P\\F26901 Model:A.rvt"), "F26901_Model_A");
  assert.equal(ledgerName("F26901-M3.rvt", new Date(2026, 10, 28, 9, 5)), "FMC_Watch_F26901-M3_20261128-0905.jsonl");
  assert.equal(ledgerFileProblem("D:\\P\\F1\\06_QA\\Watch\\FMC_Watch_M_1.jsonl"), "");
  assert.match(ledgerFileProblem("D:\\P\\F1\\06_QA\\Watch\\x.json"), /jsonl/);
  assert.match(ledgerFileProblem("D:\\P\\F1\\06_QA\\Health\\x.jsonl"), /Watch/);
  assert.match(ledgerFileProblem("D:\\P\\F1\\01_WIP\\_Reviews\\Watch\\x.jsonl"), /review/);
  assert.match(ledgerFileProblem("Watch\\x.jsonl"), /absolute/);
  assert.match(ledgerFileProblem(""), /required/);
  assert.ok(isReviewPath("D:\\P\\01_WIP\\_Reviews\\x") && isReviewPath("D:\\P\\FMC_Review_Register.json") && !isReviewPath("D:\\P\\06_QA\\Watch\\x.jsonl"));
  const dir = temp();
  const watch = path.join(dir, "Watch");
  fs.mkdirSync(watch);
  fs.writeFileSync(path.join(watch, "FMC_Watch_M_20261128-0900.jsonl"), "");
  fs.writeFileSync(path.join(watch, "FMC_Watch_Other_20261128-0900.jsonl"), "");
  assert.deepEqual(ledgerFilesFor(watch, "M.rvt").map((f) => path.basename(f)), ["FMC_Watch_M_20261128-0900.jsonl"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

const args = (over: Partial<FmcWatchArgs> = {}): FmcWatchArgs => z.object(FMC_WATCH_SHAPE).parse({ action: "start", document: "M", ...over });
const parse = (r: { content: Array<{ text: string }>; isError?: boolean }) => JSON.parse(r.content[0].text);

/** A stand-in for Revit: start creates the ledger the way the add-in does, stop reports it. */
function fakeRevit(rows: LedgerRow[] = ledger()) {
  const calls: Array<Record<string, unknown>> = [];
  const watches = new Map<string, string>();
  const send = async (body: Record<string, unknown>) => {
    calls.push(body);
    if (body.action === "start") {
      const file = String(body.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines(rows));
      watches.set(String(body.document), file);
      return { action: "start", running: true, document: body.document, file, scope: body.scope, already_running: false, model_changed: false };
    }
    if (body.action === "stop") {
      const file = watches.get(String(body.document)) ?? "";
      watches.delete(String(body.document));
      return { action: "stop", running: false, was_running: Boolean(file), file, document: body.document, model_changed: false };
    }
    return { action: "status", watching: watches.size, watches: [...watches].map(([document, file]) => ({ document, file, running: true })) };
  };
  return { send, calls };
}

test("fmc_watch start: the ledger goes to <project>\\06_QA\\Watch when the guard allows, and Revit is told the exact file", async () => {
  const dir = temp();
  const project = path.join(dir, "Projects", "F1");
  const guard = guardFor(dir, [path.join(project, "06_QA")]);
  const revit = fakeRevit();
  const out = parse(await runFmcWatch(args({ project_folder: project }), { guard, send: revit.send, now: () => new Date(2026, 10, 28, 9, 5) }));
  assert.equal(out.where, "project");
  assert.equal(out.model_changed, false);
  assert.equal(out.file, path.join(project, "06_QA", "Watch", "FMC_Watch_M_20261128-0905.jsonl"));
  assert.equal(revit.calls[0].action, "start");
  assert.equal(revit.calls[0].file, out.file);
  assert.equal(revit.calls[0].scope, "model");
  assert.equal(fs.existsSync(path.join(project, "01_WIP")), false);
  assert.ok(listAll(dir).every((f) => f.endsWith("fmc_guard.json") || f.startsWith(path.join(project, "06_QA", "Watch"))));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_watch start: where the guard refuses the project, or it is a review folder, the reports folder is used", async () => {
  const dir = temp();
  const guard = guardFor(dir, [path.join(dir, "Projects", "F1", "06_QA")]);
  const a = parse(await runFmcWatch(args({ project_folder: path.join(dir, "Projects", "F2") }), { guard, send: fakeRevit().send }));
  assert.equal(a.where, "reports");
  assert.ok(a.file.startsWith(path.join(dir, "reports", "Watch")), a.file);
  assert.match(a.notes.join(" "), /Not written to the project folder/);
  const reviews = path.join(dir, "Projects", "F1", "01_WIP", "_Reviews");
  const b = parse(await runFmcWatch(args({ project_folder: reviews }), { guard: guardFor(dir, [path.join(dir, "Projects", "F1")]), send: fakeRevit().send }));
  assert.equal(b.where, "reports");
  assert.ok(!listAll(dir).some((f) => /_reviews/i.test(f)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_watch start: document is required, and a reply that does not say 'running' is an error", async () => {
  const guard = guardFor(temp(), []);
  let called = false;
  const none = await runFmcWatch(args({ document: " " }), { guard, send: async () => { called = true; return {}; } });
  assert.equal(none.isError, true);
  assert.equal(parse(none).code, "FMC-DOC-REQUIRED");
  assert.equal(called, false);
  for (const bad of [undefined, null, {}, { running: false }]) {
    const r = await runFmcWatch(args(), { guard, send: async () => bad });
    assert.equal(r.isError, true, JSON.stringify(bad));
    assert.equal(parse(r).code, "FMC-WATCH-BAD-REPLY");
  }
  const thrown = await runFmcWatch(args(), { guard, send: async () => { throw new Error("[FMC-DOC-NOT-FOUND] No open document has title or path \"M\"."); } });
  assert.equal(parse(thrown).code, "FMC-DOC-NOT-FOUND");
  assert.equal(thrown.isError, true);
});

test("fmc_watch stop returns a summary of the ledger; stop needs a document or all", async () => {
  const dir = temp();
  const guard = guardFor(dir, []);
  const revit = fakeRevit();
  await runFmcWatch(args(), { guard, send: revit.send });
  const stop = parse(await runFmcWatch(args({ action: "stop" }), { guard, send: revit.send }));
  assert.equal(stop.was_running, true);
  assert.equal(stop.summaries.length, 1);
  assert.equal(stop.summaries[0].summary.changes, 7);
  const all = parse(await runFmcWatch(args({ action: "stop", document: "", all: true }), { guard, send: async () => ({ action: "stop", stopped: [] }) }));
  assert.deepEqual(all.summaries, []);
  const need = await runFmcWatch(args({ action: "stop", document: "" }), { guard, send: revit.send });
  assert.equal(parse(need).code, "FMC-DOC-REQUIRED");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_watch read and summary come from the ledger file and need no Revit", async () => {
  const dir = temp();
  const project = path.join(dir, "Projects", "F1");
  const guard = guardFor(dir, [path.join(project, "06_QA")]);
  await runFmcWatch(args({ project_folder: project }), { guard, send: fakeRevit().send, now: () => new Date(2026, 10, 28, 9, 5) });
  const noRevit = async () => { throw new Error("Revit must not be asked"); };
  const sum = parse(await runFmcWatch(args({ action: "summary", project_folder: project, bucket: "day" }), { guard, send: noRevit }));
  assert.equal(sum.summary.changes, 7);
  assert.deepEqual(sum.summary.by_time.map((b: { bucket: string }) => b.bucket), ["2026-11-28", "2026-11-29"]);
  assert.equal(sum.bad_lines, 0);
  const read = parse(await runFmcWatch(args({ action: "read", project_folder: project, user: "bob", limit: 2 }), { guard, send: noRevit }));
  assert.equal(read.matching, 4);
  assert.equal(read.shown, 2);
  assert.deepEqual(read.rows.map((r: LedgerRow) => r.id), [5, 6]);
  const byFile = parse(await runFmcWatch(args({ action: "summary", document: "", file: sum.files[0], category: "Doors" }), { guard, send: noRevit }));
  assert.equal(byFile.summary.changes, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_watch read refuses a file that is not a ledger, a review path, or a model with no ledger", async () => {
  const dir = temp();
  const guard = guardFor(dir, []);
  const send = async () => ({});
  for (const file of [path.join(dir, "notes.txt"), path.join(dir, "06_QA", "Health", "x.jsonl"), path.join(dir, "01_WIP", "_Reviews", "Watch", "x.jsonl")]) {
    const r = await runFmcWatch(args({ action: "read", file }), { guard, send });
    assert.equal(r.isError, true, file);
    assert.equal(parse(r).code, "FMC-WATCH-LEDGER");
  }
  const none = await runFmcWatch(args({ action: "summary", document: "Nothing" }), { guard, send });
  assert.equal(none.isError, true);
  assert.match(parse(none).message, /no ledger found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fmc_watch status lists the running watches and ledger files; a reply with no list is an error", async () => {
  const dir = temp();
  const guard = guardFor(dir, []);
  const revit = fakeRevit();
  await runFmcWatch(args(), { guard, send: revit.send });
  const s = parse(await runFmcWatch(args({ action: "status" }), { guard, send: revit.send }));
  assert.equal(s.watching, 1);
  assert.equal(s.ledgers.length, 1);
  assert.ok(s.ledgers[0].bytes > 0);
  const bad = await runFmcWatch(args({ action: "status" }), { guard, send: async () => ({}) });
  assert.equal(bad.isError, true);
  assert.equal(parse(bad).code, "FMC-WATCH-BAD-REPLY");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the Revit side (source): an updater that only reads and never throws, unregistered on stop and on close; the ledger path is checked", () => {
  const src = fs.readFileSync(path.join(root, "commandset", "Bridge", "FmcWatch.cs"), "utf8");
  const updater = src.slice(src.indexOf("public sealed class WatchUpdater"));
  assert.match(updater, /public void Execute\(UpdaterData data\)\s*\{\s*try \{ FmcWatch\.FromUpdater/);
  assert.match(updater, /catch \(Exception e\) \{ try \{ FmcWatch\.Fail/);
  assert.match(updater, /: IUpdater/);
  // the updater half does no file I/O and nothing that writes a model
  const fromUpdater = src.slice(src.indexOf("internal static void FromUpdater"), src.indexOf("private static void Note"));
  assert.doesNotMatch(updater + fromUpdater, /File\.|StreamWriter|new Transaction|TransactionGroup|SubTransaction|\.Delete\(|\.DeleteElements|SetParameter|\.Set\(|doc\.Regenerate|SaveAs|Synchronize/);
  assert.doesNotMatch(src, /new Transaction|TransactionGroup|SubTransaction|DeleteElements|\.Delete\(|SetParameter|SaveAs|SynchronizeWithCentral|HttpClient|WebClient|Socket/);
  // registered per document, optional, with all four change types
  assert.match(src, /RegisterUpdater\(updater, doc, true\)/);
  for (const t of ["GetChangeTypeElementAddition", "GetChangeTypeElementDeletion", "GetChangeTypeGeometry", "GetChangeTypeAny"]) assert.match(src, new RegExp(`Element\\.${t}\\(\\)`));
  // unregistered on stop and on DocumentClosing
  assert.match(src.slice(src.indexOf("public static Session Stop")), /TryUnregister\(s\.Id, doc\)/);
  assert.match(src, /DocumentClosing \+= OnClosing/);
  assert.match(src.slice(src.indexOf("private static void OnClosing"), src.indexOf("// ---- plumbing")), /TryUnregister\(s\.Id, doc\)/);
  assert.match(src, /DocumentChanged \+= OnChanged/);
  assert.match(src, /DocumentChanged -= OnChanged/);
  // the only file written is the ledger, appended; failures are counted, never thrown
  assert.match(src, /File\.AppendAllText\(s\.File/);
  assert.equal((src.match(/File\.[A-Z]\w+\(/g) ?? []).filter((x) => x !== "File.AppendAllText(").length, 0);
  assert.match(src, /catch \(Exception ex\)\s*\{\s*s\.Dropped/);
  // the path rules the server applies are applied again here
  const rules = src.slice(src.indexOf("public static string FileProblem"), src.indexOf("public static Session Find"));
  assert.match(rules, /\.jsonl/);
  assert.match(rules, /"Watch"/);
  assert.match(rules, /_reviews/);
  assert.match(rules, /review_register/);
  const handler = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcWatchHandler.cs"), "utf8");
  assert.match(handler, /FmcTarget\.Resolve\(app, Parameters, mayOpen: false\)/);
  assert.doesNotMatch(handler, /new Transaction|TransactionGroup|\.Delete\(|SetParameter/);
  const cmd = fs.readFileSync(path.join(root, "commandset", "Commands", "Fmc", "FmcWatchCommand.cs"), "utf8");
  assert.match(cmd, /CommandName => "fmc_watch"/);
});

test("fmc_watch is registered: command.json, the read list, and the server never reaches a network or a review register", () => {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8"));
  const commands = (Array.isArray(parsed) ? parsed : parsed.commands) as Array<{ commandName: string }>;
  assert.ok(commands.some((c) => c.commandName === "fmc_watch"), "command.json lists fmc_watch");
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_watch"));
  assert.ok(!WRITE_COMMANDS.has("fmc_watch"));
  for (const file of [path.join("server", "src", "tools", "fmc_watch.ts"), path.join("server", "src", "fmc", "watch.ts")]) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(src, /FMC_Review_Register|registerFile|from "node:https?"|from "node:net"|fetch\(|powerbi\.com/i, file);
  }
});
