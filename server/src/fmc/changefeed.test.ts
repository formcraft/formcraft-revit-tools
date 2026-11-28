import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANGE_FEED_COMMANDS, DEFAULT_SOURCES, changeFeedDir, createdEntries, csvRecords, docKey, externalEntries, feedCounts, filterFeed, flowEntries, ledgerEntries,
  pageFeed, parseCsvLine, persistedEntries, readPersistedLog, revitEntries, sameDocument, sortFeed, syncLogEntries, syncStateEntries, syncSummary,
} from "./changefeed.js";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS, activityOf } from "./policy.js";
import { FMC_CHANGE_FEED_SHAPE, runFmcChangeFeed } from "../tools/fmc_change_feed.js";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8");
const now = new Date("2026-11-28T08:00:00Z");
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text) as Record<string, any>;

function tmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-feed-"));
  const ledger = path.join(dir, "ledger");
  fs.mkdirSync(ledger, { recursive: true });
  return { dir, ledger, env: { FMC_LEDGER_DIR: ledger, FMC_CREATED_DIR: ledger, APPDATA: path.join(dir, "Roaming") } as NodeJS.ProcessEnv };
}

const revitReply = {
  read_only: true, transaction: false, saved: false, synced: false, worksharing_touched: false,
  resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", path: "C:\\Work\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt" },
  workshared: true, user: "emlyn", version: { guid: "11111111-2222-3333-4444-555555555555", saves: 12 },
  journal: {
    listening: true, since: "2026-11-28T06:00:00.000Z", last_seq: 3, next_after_seq: 3, more: false, gap: false, dropped: 0,
    entries: [
      { seq: 1, at: "2026-11-28T06:10:00.000Z", document: "C:\\Work\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", kind: "change", label: "Walls", user: "emlyn", by: "person",
        added: 2, modified: 1, deleted: 0, added_ids: [10, 11], modified_ids: [5], deleted_ids: [], ids_truncated: false },
      { seq: 2, at: "2026-11-28T06:20:00.000Z", document: "C:\\Work\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", kind: "synced", label: "Succeeded", user: "emlyn", by: "person" },
      { seq: 3, at: "2026-11-28T06:30:00.000Z", document: "C:\\Work\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", kind: "change", label: "Formcraft: tags", user: "emlyn", by: "ai",
        added: 1, modified: 0, deleted: 0, added_ids: [12], modified_ids: [], deleted_ids: [], ids_truncated: false },
    ],
  },
  diff: {
    base_version: "aaaaaaaa-0000-0000-0000-000000000000", counts: { created: 1, modified: 1, deleted: 1 },
    created: [{ id: 12, exists: true, unique_id: "u12", category: "Door Tags", name: "Tag", creator: "emlyn", last_changed_by: "emlyn", owner: "" }],
    modified: [{ id: 5, exists: true, unique_id: "u5", category: "Walls", name: "Basic Wall", creator: "cenk", last_changed_by: "emlyn", owner: "emlyn" }],
    deleted_ids: [7], deleted_available: true, truncated: false,
  },
  notes: [],
};

test("ledger and hook lines become entries: tool, action, result and who started it, never the arguments", () => {
  const e = ledgerEntries([
    { at: "2026-11-28T07:00:00Z", tool: "fmc_tags", action: "apply", ok: true, ms: 120, project: "F26901", started_by: "ai" },
    { at: "bad", tool: "x" }, null, { tool: "no time" },
  ]);
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].what, e[0].who, e[0].project, e[0].ok, e[0].kind], ["fmc_tags apply", "ai", "F26901", true, "call"]);
  const x = externalEntries([{ at: "2026-11-28T07:00:00Z", kind: "pyrevit", script: "renumber", ok: false, ms: 3 }]);
  assert.deepEqual([x[0].what, x[0].who, x[0].ok], ["pyrevit renumber", "person", false]);
});

test("created ids are one entry per batch and document, with categories", () => {
  const e = createdEntries([
    { at: "2026-11-28T07:01:00Z", batch_id: "b1", document: "A.rvt", id: "1", category: "Doors", source: "modify_model" },
    { at: "2026-11-28T07:00:00Z", batch_id: "b1", document: "a", id: "2", category: "Doors", source: "modify_model" },
    { at: "2026-11-28T07:02:00Z", batch_id: "b2", document: "A.rvt", id: "3", source: "fmc_tags" },
  ]);
  assert.equal(e.length, 2);
  const b1 = e.find((x) => (x.detail as any).batch_id === "b1")!;
  assert.equal(b1.at, "2026-11-28T07:00:00.000Z");
  assert.match(b1.what, /^2 elements created by batch b1/);
  assert.deepEqual((b1.detail as any).categories, { Doors: 2 });
});

test("the sync log and the managed clocks are read, quoted fields and all", () => {
  assert.deepEqual(parseCsvLine('a,"b, c","d ""e"""'), ["a", "b, c", 'd "e"']);
  assert.equal(csvRecords('h1,h2\r\n"x\ny",2\r\n').length, 2);
  const s = syncLogEntries('timestamp,model,user,message\r\n2026-11-28T06:20:00Z,A-0002.rvt,emlyn,"F26901 | A | walls, doors"\r\n');
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, "sync_message");
  assert.equal(s[0].who, "emlyn");
  assert.match(s[0].what, /walls, doors/);
  const c = syncStateEntries([{ document: "A-0002", changedAt: Date.parse("2026-11-28T07:00:00Z"), lastSyncAt: Date.parse("2026-11-28T06:00:00Z"), lastSaveAt: null, lastError: null }]);
  assert.deepEqual(c.map((x) => x.kind).sort(), ["changed", "synced"]);
});

test("Revit's journal and version diff become entries with the Revit user and ai or person", () => {
  const e = revitEntries(revitReply, now);
  const kinds = e.map((x) => x.kind);
  assert.deepEqual(kinds, ["change", "synced", "change", "element_created", "element_modified", "element_deleted"]);
  assert.equal(e[0].what, "Walls (+2 ~1 -0)");
  assert.equal(e[0].who, "emlyn · person");
  assert.equal(e[2].who, "emlyn · ai");
  assert.match(e[1].what, /^Synced with central/);
  assert.equal(e[4].who, "emlyn");
  assert.match(e[4].what, /Walls: Basic Wall \(5\)/);
  assert.equal(revitEntries({ ...revitReply, diff: { code: "FMC-CHANGES-VERSION", message: "x" } }, now).length, 3);
});

test("filter, sort newest first, page with a cursor, and count by source and kind only (never by person)", () => {
  const entries = [...revitEntries(revitReply, now), ...ledgerEntries([{ at: "2026-11-28T07:00:00Z", tool: "fmc_qa", project: "OTHER", started_by: "ai" }])];
  const kept = sortFeed(filterFeed(entries, { project: "F26901", document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER" }));
  assert.ok(!kept.some((x) => x.project === "OTHER"));
  for (let i = 1; i < kept.length; i++) assert.ok(kept[i - 1].at >= kept[i].at);
  const p1 = pageFeed(kept, 2);
  assert.equal(p1.entries.length, 2);
  assert.equal(p1.next_cursor, "o:2");
  const p2 = pageFeed(kept, 100, p1.next_cursor!);
  assert.equal(p2.entries.length, kept.length - 2);
  assert.equal(p2.next_cursor, null);
  const counts = feedCounts(kept);
  assert.deepEqual(Object.keys(counts).sort(), ["by_kind", "by_source"]);
  assert.doesNotMatch(JSON.stringify(counts), /emlyn|cenk/);
  const windowed = filterFeed(entries, { since: "2026-11-28T06:15:00Z", until: "2026-11-28T06:25:00Z" });
  assert.deepEqual(windowed.map((x) => x.kind), ["synced"]);
  assert.equal(docKey("C:\\W\\A-0002.RVT"), "a-0002");
  assert.ok(sameDocument("A-0002", "C:/W/a-0002.rvt"));
});

test("the sync summary reports and never acts", () => {
  const s = syncSummary(revitEntries(revitReply, now).filter((e) => !e.kind.startsWith("element_")), "F26901-FMC-ZZ-ZZ-M3-A-0002_USER");
  assert.equal(s.last_sync_at, "2026-11-28T06:20:00.000Z");
  assert.equal(s.changed_since_last_sync, true);
  assert.match(s.action, /never syncs/);
  assert.equal(syncSummary([], "").changed_since_last_sync, false);
  assert.equal(flowEntries([{ kind: "part", what: "p.3dm", why: "newer", affects: ["F"] }], now)[0].kind, "flag");
});

test("the tool merges every source, lists each with what was read, and passes back the next version and sequence", async () => {
  const t = tmpEnv();
  fs.writeFileSync(path.join(t.ledger, "calls-2026-11.jsonl"), JSON.stringify({ at: "2026-11-28T07:00:00Z", tool: "fmc_tags", action: "apply", ok: true, ms: 5, project: "F26901", started_by: "pane" }) + "\n");
  let sent: Record<string, unknown> | null = null;
  const args = z.object(FMC_CHANGE_FEED_SHAPE).parse({ document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", since_version: "aaaaaaaa-0000-0000-0000-000000000000", after_seq: 0, sources: [...DEFAULT_SOURCES, "flows"] });
  const body = parse(await runFmcChangeFeed(args, {
    env: t.env, reportsDir: t.dir, now: () => now,
    revit: async (b) => { sent = b; return revitReply; },
    flows: async () => [{ kind: "flow", what: "Robot results", why: "older than the model", affects: ["robot"] }],
  }));
  assert.equal(sent!.document, "F26901-FMC-ZZ-ZZ-M3-A-0002_USER");
  assert.equal(sent!.since_version, "aaaaaaaa-0000-0000-0000-000000000000");
  assert.equal(body.read_only, true);
  assert.equal(body.saved, false);
  assert.equal(body.synced, false);
  assert.equal(body.transaction, false);
  assert.deepEqual(body.sources.map((s: any) => s.source).sort(), ["created", "external", "flows", "ledger", "revit", "syncs"]);
  assert.ok(body.sources.every((s: any) => typeof s.note === "string"));
  assert.equal(body.next.since_version, "11111111-2222-3333-4444-555555555555");
  assert.equal(body.next.after_seq, 3);
  assert.ok(body.entries.some((e: any) => e.source === "ledger" && e.what === "fmc_tags apply" && e.who === "pane"));
  assert.ok(body.entries.some((e: any) => e.source === "flows"));
  assert.equal(body.sync.changed_since_last_sync, true);
  assert.match(body.worksharing, /never touched/);
});

test("without document Revit is not called and the reply says why; a failed Revit read is listed, not hidden", async () => {
  const t = tmpEnv();
  let called = 0;
  const none = parse(await runFmcChangeFeed(z.object(FMC_CHANGE_FEED_SHAPE).parse({}), { env: t.env, reportsDir: t.dir, now: () => now, revit: async () => { called++; return {}; } }));
  assert.equal(called, 0);
  const revit = none.sources.find((s: any) => s.source === "revit");
  assert.equal(revit.read, false);
  assert.match(revit.note, /Pass document/);
  const failed = parse(await runFmcChangeFeed(z.object(FMC_CHANGE_FEED_SHAPE).parse({ document: "X" }), {
    env: t.env, reportsDir: t.dir, now: () => now, revit: async () => { throw new Error("[FMC-DOC-NOT-FOUND] X isn't open"); },
  }));
  const r2 = failed.sources.find((s: any) => s.source === "revit");
  assert.equal(r2.read, false);
  assert.match(r2.note, /FMC-DOC-NOT-FOUND/);
  assert.equal(failed.read_only, true);
});

// ---- the hard limit: read only, never a sync, a save or worksharing -------------------------------------------------

test("policy classifies the feed's only add-in command as a read, never a write", () => {
  assert.deepEqual([...CHANGE_FEED_COMMANDS], ["fmc_change_feed_read"]);
  for (const c of CHANGE_FEED_COMMANDS) {
    assert.ok(READ_VIA_SEND_COMMAND.has(c), `${c} must be in READ_VIA_SEND_COMMAND`);
    assert.ok(!WRITE_COMMANDS.has(c), `${c} must not be in WRITE_COMMANDS`);
    assert.equal(activityOf(c, {}), "read");
  }
  const manifest = JSON.parse(read("command.json")) as { commands: Array<{ commandName: string }> };
  assert.ok(manifest.commands.some((c) => c.commandName === "fmc_change_feed_read"));
});

test("the server side sends only fmc_change_feed_read and never saves, syncs, writes files or runs another Revit command", () => {
  const tool = read("server", "src", "tools", "fmc_change_feed.ts");
  const logic = read("server", "src", "fmc", "changefeed.ts");
  const sent = [...tool.matchAll(/send(?:Command|Raw)\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sent, ["fmc_change_feed_read"]);
  for (const src of [tool, logic]) {
    const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, /writeFileSync|appendFileSync|mkdirSync|renameSync|unlinkSync|rmSync|copyFileSync|createWriteStream/);
    assert.doesNotMatch(code, /saveSyncState|appendLedger|appendCreated|batchline|syncauto|fmc_revit_file|fmc_post_command|send_code_to_revit|fmc_sync|sync_now/);
    assert.doesNotMatch(code, /SynchronizeWithCentral|ReloadLatest|RelinquishOwnership|\.Save\(|sendRaw\(/);
  }
});

test("the add-in side never syncs, saves, reloads latest, relinquishes, opens, closes or starts a transaction", () => {
  const files = [
    ["commandset", "Services", "Fmc", "ChangeFeed", "FmcChangeFeed.cs"],
    ["commandset", "Services", "Fmc", "ChangeFeed", "FmcChangeFeedRead.cs"],
    ["commandset", "Services", "Fmc", "ChangeFeed", "ChangeFeedCore.cs"],
    ["commandset", "Services", "Fmc", "ChangeFeed", "ChangeFeedLog.cs"],
    ["commandset", "Services", "Fmc", "ChangeFeed", "ChangeFeedParams.cs"],
    ["commandset", "Commands", "Fmc", "FmcChangeFeedReadCommand.cs"],
    ["plugin", "Fmc", "ChangeFeedSession.cs"],
    ["plugin", "Shell", "RevitChangeFeedTools.cs"],
    ["shell", "Formcraft.Shell", "ViewModels", "ChangesPage.cs"],
  ];
  const forbidden = [
    /SynchronizeWithCentral\s*\(/, /ReloadLatest\s*\(/, /RelinquishOwnership\s*\(/, /\.Save\s*\(/, /\.SaveAs\s*\(/, /\.Close\s*\(/,
    /new\s+Transaction\s*\(/, /new\s+TransactionGroup\s*\(/, /new\s+SubTransaction\s*\(/, /\.Commit\s*\(/, /\.Assimilate\s*\(/,
    /CheckoutElements\s*\(/, /CheckoutWorksets\s*\(/, /GetModelUpdatesStatus\s*\(/, /PostCommand\s*\(/, /OpenDocumentFile\s*\(/,
    /OpenAndActivateDocument\s*\(/, /EnableWorksharing\s*\(/, /mayOpen\s*:\s*true/,
  ];
  for (const f of files) {
    const code = read(...f).split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    for (const p of forbidden) assert.doesNotMatch(code, p, `${f.join("/")} must not match ${p}`);
  }
  const handler = read("commandset", "Services", "Fmc", "ChangeFeed", "FmcChangeFeedRead.cs");
  assert.match(handler, /mayOpen:\s*false/);
  assert.match(handler, /FMC-DOC-REQUIRED/);
  assert.match(handler, /\["saved"\] = false/);
  assert.match(handler, /\["synced"\] = false/);
  assert.match(read("commandset", "Commands", "Fmc", "FmcChangeFeedReadCommand.cs"), /CommandName => "fmc_change_feed_read"/);
  assert.doesNotMatch(read("commandset", "Bridge", "FmcAiJob.cs"), /FmcChangeFeed\.Hook/);
  assert.match(read("plugin", "Core", "Application.cs"), /ChangeFeedSession\.Hook\(/);
  assert.match(read("plugin", "Fmc", "ChangeFeedSession.cs"), /DocumentOpened/);
  assert.match(read("plugin", "Fmc", "ChangeFeedSession.cs"), /DocumentChanged/);
});

test("the read path never writes a file or prunes the log", () => {
  const files = [
    ["commandset", "Services", "Fmc", "ChangeFeed", "FmcChangeFeedRead.cs"],
    ["commandset", "Commands", "Fmc", "FmcChangeFeedReadCommand.cs"],
    ["plugin", "Shell", "RevitChangeFeedTools.cs"],
    ["shell", "Formcraft.Shell", "ViewModels", "ChangesPage.cs"],
  ];
  const write = [
    /File\.Write/, /File\.Append/, /File\.Delete\s*\(/, /File\.Move\s*\(/, /File\.Copy\s*\(/, /File\.Create\s*\(/,
    /FileMode\.Append/, /FileAccess\.Write/, /Directory\.CreateDirectory\s*\(/, /Directory\.Delete\s*\(/,
    /ChangeFeedLog\.Append\s*\(/, /ChangeFeedLog\.PruneOlder\s*\(/, /ChangeFeedLog\.MarkListening\s*\(/, /\.PruneOlder\s*\(/,
  ];
  for (const f of files) {
    const code = read(...f).split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    for (const p of write) assert.doesNotMatch(code, p, `${f.join("/")} must not match ${p}`);
  }
});

test("counts are by source and kind only, never per person", async () => {
  const t = tmpEnv();
  const body = parse(await runFmcChangeFeed(z.object(FMC_CHANGE_FEED_SHAPE).parse({ document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", sources: [...DEFAULT_SOURCES] }), {
    env: t.env, reportsDir: t.dir, now: () => now, revit: async () => revitReply,
  }));
  assert.deepEqual(Object.keys(body.counts).sort(), ["by_kind", "by_source"]);
  assert.equal(body.counts.by_user, undefined);
  assert.equal(body.counts.by_who, undefined);
  assert.doesNotMatch(JSON.stringify(body.counts), /emlyn|cenk|leaderboard|ranking|by_user|by_who|per_user/);
});

test("the lasting JSONL log is read as revit entries, with zone-labeled times and before/after params", async () => {
  const t = tmpEnv();
  const dir = path.join(t.dir, "model-changes");
  fs.mkdirSync(dir, { recursive: true });
  t.env.FMC_CHANGE_FEED_DIR = dir;
  const line = {
    seq: 1, at: "2026-11-28T08:10:00.000Z", at_local: "2026-11-28 11:10:00 EAT (UTC+3)", tz: "EAT",
    document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", kind: "change", label: "Walls", user: "emlyn", by: "person",
    added: 0, modified: 1, deleted: 0, modified_ids: [5],
    elements: [{ id: 5, action: "modified", category: "Walls", name: "Basic Wall", params: [{ name: "Mark", before: "A1", after: "A2" }] }],
  };
  fs.writeFileSync(path.join(dir, "F26901-FMC-ZZ-ZZ-M3-A-0002_USER-2026-11.jsonl"), JSON.stringify(line) + "\n");
  assert.equal(changeFeedDir(t.env), dir);
  const loaded = persistedEntries(readPersistedLog(dir, "F26901-FMC-ZZ-ZZ-M3-A-0002_USER"));
  assert.equal(loaded.length, 1);
  assert.equal((loaded[0].detail as any).at_local, "2026-11-28 11:10:00 EAT (UTC+3)");
  assert.equal((loaded[0].detail as any).elements[0].params[0].after, "A2");
  const body = parse(await runFmcChangeFeed(z.object(FMC_CHANGE_FEED_SHAPE).parse({ document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", sources: ["revit"] }), {
    env: t.env, reportsDir: t.dir, now: () => now, revit: async () => revitReply,
  }));
  const fromLog = body.entries.filter((e: any) => e.detail && e.detail.at_local);
  assert.ok(fromLog.some((e: any) => e.what.startsWith("Walls") && e.detail.elements[0].params[0].before === "A1"));
});

