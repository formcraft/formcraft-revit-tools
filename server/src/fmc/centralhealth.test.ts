import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DEFAULTS, DirFact, FileFact, FsLike, Options, addSample, analyze, backupReport, borrowedReport, buildPlan, centralBase, centralKind,
  defaultBackupDir, formatBytes, gather, growthReport, historyKey, localCopies, localUserOf, normalizeFacts, parseHistory, parseWhen,
} from "./centralhealth.js";
import { FMC_CENTRAL_HEALTH_SHAPE, FmcCentralHealthArgs, registerFmcCentralHealthTool, runFmcCentralHealth } from "../tools/fmc_central_health.js";

const DAY = 86_400_000;
const MB = 1024 * 1024;
const GB = 1024 * MB;
const NOW = Date.parse("2026-11-28T10:00:00Z");
const CENTRAL = "\\\\server\\Projects\\F26001\\02_Shared\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt";
const opts = (over: Partial<Options> = {}): Options => ({ ...DEFAULTS, last_audit: "", last_compact: "", ...over });
const file = (p: string, size: number, daysOld: number): FileFact => ({ path: p, name: p.split("\\").pop() as string, size_bytes: size, mtime_ms: NOW - daysOld * DAY });

/** A mock file system that records every call, so a test can prove only metadata is asked for. */
function mockFs(central: FileFact | null, dirs: Record<string, FileFact[]>) {
  const calls: string[] = [];
  const fsl: FsLike = {
    stat(p) { calls.push(`stat ${p}`); return central && p === central.path ? central : null; },
    list(dir, recursive, max): DirFact {
      calls.push(`list ${dir} ${recursive}`);
      const files = dirs[dir];
      return files ? { dir, exists: true, files: files.slice(0, max), truncated: files.length > max } : { dir, exists: false, files: [], truncated: false };
    },
  };
  return { fsl, calls };
}

test("sizes and names", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(1.5 * MB), "1.5 MB");
  assert.equal(formatBytes(2.25 * GB), "2.25 GB");
  assert.equal(centralBase(CENTRAL), "F26001-FMC-ZZ-ZZ-M3-A-0001");
  assert.equal(defaultBackupDir(CENTRAL), "\\\\server\\Projects\\F26001\\02_Shared\\F26001-FMC-ZZ-ZZ-M3-A-0001_backup");
  assert.equal(localUserOf("Model.rvt", "Model_JSMITH.rvt"), "JSMITH");
  assert.equal(localUserOf("Model.rvt", "model_a_b.RVT"), "a_b");
  assert.equal(localUserOf("Model.rvt", "Model.0001.rvt"), null);
  assert.equal(localUserOf("Model.rvt", "Other_JSMITH.rvt"), null);
  assert.equal(localUserOf("A.B.rvt", "A.B_X.rvt"), "X"); // dots in the name are literal
  assert.equal(centralKind("RSN://srv/Model.rvt", false), "revit_server");
  assert.equal(centralKind(CENTRAL, true), "cloud");
  assert.equal(centralKind("", false), "unknown");
  assert.equal(parseWhen("2026-11-01"), Date.parse("2026-11-01"));
  assert.equal(parseWhen("not a date"), null);
  assert.equal(parseWhen(""), null);
});

test("growth: a flagged rise, a projection, and honest thin history", () => {
  const th = { growth_warn_pct: 20, growth_window_days: 30, central_act_mb: 1000 };
  const hist = [
    { at: new Date(NOW - 40 * DAY).toISOString(), size_bytes: 100 * MB }, // outside the window: ignored
    { at: new Date(NOW - 20 * DAY).toISOString(), size_bytes: 400 * MB },
    { at: new Date(NOW - 10 * DAY).toISOString(), size_bytes: 450 * MB },
  ];
  const g = growthReport(hist, 600 * MB, NOW, th);
  assert.equal(g.status, "growing");
  assert.equal(g.flagged, true);
  assert.equal(g.delta_pct, 50);
  assert.equal(g.samples_in_window, 2);
  assert.equal(g.baseline_bytes, 400 * MB);
  assert.equal(g.per_day_bytes, Math.round((200 * MB) / 20));
  assert.equal(g.days_to_act_size, 40); // (1000 - 600) / 10 per day

  assert.equal(growthReport([], 600 * MB, NOW, th).status, "insufficient_history");
  assert.equal(growthReport([{ at: new Date(NOW - 3_600_000).toISOString(), size_bytes: 1 }], 600 * MB, NOW, th).status, "insufficient_history");
  assert.equal(growthReport(hist, null, NOW, th).status, "no_size");
  const flat = growthReport([{ at: new Date(NOW - 10 * DAY).toISOString(), size_bytes: 600 * MB }], 601 * MB, NOW, th);
  assert.equal(flat.status, "stable");
  assert.equal(flat.flagged, false);
  const shrunk = growthReport([{ at: new Date(NOW - 10 * DAY).toISOString(), size_bytes: 900 * MB }], 600 * MB, NOW, th);
  assert.equal(shrunk.status, "shrinking");
  assert.equal(shrunk.days_to_act_size, null);
});

test("history: parse defensively, add a sample, skip a duplicate", () => {
  assert.deepEqual(parseHistory("not json"), {});
  assert.deepEqual(parseHistory("[1,2]"), {});
  const parsed = parseHistory(JSON.stringify({ a: [{ at: "2026-11-01T00:00:00Z", size_bytes: 5 }, { at: "bad", size_bytes: 5 }, { at: "2026-11-02T00:00:00Z", size_bytes: -1 }], b: "x" }));
  assert.deepEqual(Object.keys(parsed), ["a"]);
  assert.equal(parsed.a.length, 1);
  const key = historyKey(" \\\\Server\\X.rvt ");
  assert.equal(key, "\\\\server\\x.rvt");
  const one = addSample({}, key, { at: new Date(NOW).toISOString(), size_bytes: 10 });
  assert.equal(one.added, true);
  const dup = addSample(one.history, key, { at: new Date(NOW + 3_600_000).toISOString(), size_bytes: 10 });
  assert.equal(dup.added, false);
  assert.equal(addSample(one.history, key, { at: new Date(NOW + 3_600_000).toISOString(), size_bytes: 11 }).added, true);
  assert.equal(addSample(one.history, key, { at: new Date(NOW + DAY).toISOString(), size_bytes: 10 }).added, true);
  const many = addSample({ [key]: Array.from({ length: 3 }, (_, i) => ({ at: new Date(NOW - (10 - i) * DAY).toISOString(), size_bytes: i })) }, key, { at: new Date(NOW).toISOString(), size_bytes: 99 }, 6, 3);
  assert.equal(many.history[key].length, 3);
  assert.equal(many.history[key][2].size_bytes, 99);
});

test("backups: not found, empty, ok, and the watch cases", () => {
  const o = { backup_warn_gb: 20, backup_warn_count: 100, backup_quiet_days: 7 };
  assert.equal(backupReport("", null, null, NOW, o).state, "not_checked");
  assert.equal(backupReport("X", { dir: "X", exists: false, files: [], truncated: false }, null, NOW, o).state, "not_found");
  assert.equal(backupReport("X", { dir: "X", exists: true, files: [], truncated: false }, null, NOW, o).state, "empty");
  const good = backupReport("X", { dir: "X", exists: true, truncated: false, files: [file("X\\a.rvt", 300 * MB, 1), file("X\\b.rvt", 200 * MB, 3)] }, 400 * MB, NOW, o);
  assert.equal(good.state, "ok");
  assert.equal(good.count, 2);
  assert.equal(good.total_bytes, 500 * MB);
  assert.equal(good.ratio_to_central, 1.3);
  assert.equal(good.newest_age_days, 1);
  assert.equal(good.largest[0].name, "a.rvt");
  const big = backupReport("X", { dir: "X", exists: true, truncated: false, files: [file("X\\a.rvt", 25 * GB, 10)] }, null, NOW, o);
  assert.equal(big.state, "watch");
  assert.equal(big.warnings.length, 2); // too big, and quiet for 10 days
  const many = backupReport("X", { dir: "X", exists: true, truncated: true, files: Array.from({ length: 100 }, (_, i) => file(`X\\${i}.rvt`, 1, 0)) }, null, NOW, o);
  assert.match(many.warnings[0], /100 backup files or more/);
});

test("stale locals: only <central>_<user>.rvt, never the central, oldest first", () => {
  const dir = "L";
  const d: DirFact = {
    dir, exists: true, truncated: false,
    files: [
      file("L\\F26001_ANN.rvt", 200 * MB, 2),
      file("L\\F26001_BOB.rvt", 180 * MB, 30),
      file("L\\F26001.rvt", 500 * MB, 90), // the central itself
      file("L\\F26001.0001.rvt", 1, 90), // a Revit backup name
      file("L\\Other_CAT.rvt", 1, 90),
    ],
  };
  const out = localCopies("F26001.rvt", [d, d], NOW, 14);
  assert.deepEqual(out.map((c) => [c.user, c.stale]), [["BOB", true], ["ANN", false]]);
  assert.equal(out[0].needs_person, true);
  assert.match(out[0].recommendation, /Reload Latest/);
  assert.equal(out[1].recommendation, "");
});

test("borrowed: owners, mine, and what the add-in cannot say", () => {
  assert.equal(borrowedReport(null).available, false);
  assert.equal(borrowedReport(normalizeFacts({ workshared: false })).workshared, false);
  const facts = normalizeFacts({
    workshared: true, central: CENTRAL, user: "ANN",
    worksets: [{ name: "A_Shell", owner: "ANN" }, { name: "A_Interior", owner: "BOB" }, { name: "S_Frame", owner: "BOB" }, { name: "Z_Grids_Levels", owner: "" }],
  });
  const b = borrowedReport(facts);
  assert.equal(b.worksets_total, 4);
  assert.equal(b.worksets_unowned, 1);
  assert.deepEqual(b.owners.map((x) => [x.owner, x.mine, x.worksets.length, x.elements]), [["ANN", true, 1, null], ["BOB", false, 2, null]]);
  assert.equal(b.elements_borrowed, null);
  assert.match(b.elements_note, /not borrowed elements/);
  const withEls = borrowedReport(normalizeFacts({ workshared: true, user: "ANN", worksets: [{ name: "A_Shell", owner: "ANN" }], borrowed_elements: [{ owner: "BOB", count: 12 }, { owner: "BOB", count: 3 }] }));
  assert.equal(withEls.elements_borrowed, 15);
  assert.deepEqual(withEls.owners.map((x) => [x.owner, x.elements]), [["ANN", 0], ["BOB", 15]]);
  assert.equal(normalizeFacts("x"), null);
});

function healthyInput(over: { size?: number; backupFiles?: FileFact[]; localFiles?: FileFact[]; history?: { at: string; size_bytes: number }[]; o?: Partial<Options>; facts?: unknown } = {}) {
  const central = file(CENTRAL, over.size ?? 300 * MB, 0.5);
  const bdir = defaultBackupDir(CENTRAL);
  const { fsl, calls } = mockFs(central, { [bdir]: over.backupFiles ?? [file(`${bdir}\\a.rvt`, 300 * MB, 1)], L: over.localFiles ?? [] });
  const facts = normalizeFacts(over.facts === undefined ? { workshared: true, central: CENTRAL, user: "ANN", worksets: [{ name: "A_Shell", owner: "ANN" }] } : over.facts);
  const g = gather(fsl, { central_path: "", backup_dir: "", local_dirs: ["L"] }, facts);
  return { calls, report: analyze({ nowMs: NOW, gathered: g, facts, history: over.history ?? [], options: opts(over.o) }) };
}

test("a healthy central reports ok, with a plan that still needs a person", () => {
  const { report, calls } = healthyInput({ o: { last_audit: new Date(NOW - 5 * DAY).toISOString(), last_compact: new Date(NOW - 5 * DAY).toISOString() },
    history: [{ at: new Date(NOW - 10 * DAY).toISOString(), size_bytes: 299 * MB }] });
  assert.equal(report.status, "ok");
  assert.equal(report.central.size_level, "ok");
  assert.equal(report.central.size_human, "300.0 MB");
  assert.equal(report.growth.status, "stable");
  assert.equal(report.backups.state, "ok");
  assert.deepEqual(report.findings, []);
  const audit = report.plan.items.find((i) => i.id === "audit");
  assert.equal(audit?.recommended, false);
  assert.equal(audit?.due, "scheduled");
  assert.equal(audit?.due_at, new Date(NOW + 25 * DAY).toISOString());
  assert.equal(report.plan.items.find((i) => i.id === "compact")?.due_at, new Date(NOW + 85 * DAY).toISOString());
  // only metadata is asked for: stat the central, list the folders
  assert.ok(calls.every((c) => /^(stat|list) /.test(c)));
  assert.equal(calls.filter((c) => c.startsWith("stat ")).length, 1);
});

test("a big, growing central with a stale local asks for action and plans an audit and compact", () => {
  const { report } = healthyInput({
    size: 1200 * MB,
    history: [{ at: new Date(NOW - 15 * DAY).toISOString(), size_bytes: 800 * MB }],
    localFiles: [file("L\\F26001-FMC-ZZ-ZZ-M3-A-0001_BOB.rvt", 1, 40)],
    backupFiles: [file("B\\a.rvt", 30 * GB, 20)],
    facts: { workshared: true, central: CENTRAL, user: "ANN", worksets: [{ name: "A_Interior", owner: "BOB" }] },
  });
  const codes = report.findings.map((f) => f.code);
  for (const c of ["FMC-CENTRAL-SIZE-ACT", "FMC-CENTRAL-GROWTH", "FMC-CENTRAL-STALE-LOCAL", "FMC-CENTRAL-BORROWED-OTHERS"]) assert.ok(codes.includes(c), c);
  assert.equal(report.status, "act");
  const ids = report.plan.items.map((i) => i.id);
  for (const id of ["audit", "compact", "review_stale_locals", "ask_relinquish"]) assert.ok(ids.includes(id as never), id);
  assert.equal(report.plan.items.find((i) => i.id === "audit")?.recommended, true);
  assert.equal(report.plan.items.find((i) => i.id === "compact")?.recommended, true);
  assert.equal(report.plan.schedule[0].due, "now");
});

test("every plan line needs a person and none is executed by the tool", () => {
  const { report } = healthyInput({ size: 1200 * MB, localFiles: [file("L\\F26001-FMC-ZZ-ZZ-M3-A-0001_BOB.rvt", 1, 40)], backupFiles: [] });
  assert.equal(report.plan.read_and_plan_only, true);
  assert.equal(report.plan.executes_nothing, true);
  assert.equal(report.plan.needs_person, true);
  assert.ok(report.plan.items.length >= 3);
  for (const item of report.plan.items) {
    assert.equal(item.needs_person, true, item.id);
    assert.equal(item.executed_by_tool, false, item.id);
  }
  // a plan built with every option on is the same
  const p = buildPlan({ nowMs: NOW, options: opts(), sizeLevel: "act", growth: report.growth, backups: report.backups, stale: [], others: 2, centralPath: CENTRAL });
  assert.ok(p.items.every((i) => i.needs_person === true && i.executed_by_tool === false));
  // the steps never tell the tool to do it: they name a person's action in Revit
  const audit = p.items.find((i) => i.id === "audit");
  assert.ok(audit?.steps.some((s) => /Detach from Central and Audit/.test(s)));
  assert.ok(p.items.find((i) => i.id === "compact")?.steps.some((s) => /Compact Central Model/.test(s)));
});

test("never recorded is stated, and compact is not nagged for on a small central", () => {
  const { report } = healthyInput({});
  const audit = report.plan.items.find((i) => i.id === "audit");
  const compact = report.plan.items.find((i) => i.id === "compact");
  assert.equal(audit?.recommended, true);
  assert.match(audit?.why[0] ?? "", /No audit date/);
  assert.equal(compact?.recommended, false);
  assert.equal(compact?.due, "not_due");
  assert.ok(report.findings.some((f) => f.code === "FMC-CENTRAL-HISTORY-THIN"));
});

test("missing central, cloud central and no Revit are said plainly", () => {
  const { fsl } = mockFs(null, {});
  const none = analyze({ nowMs: NOW, gathered: gather(fsl, { central_path: CENTRAL, backup_dir: "", local_dirs: [] }, null), facts: null, history: [], options: opts() });
  assert.deepEqual(none.findings.map((f) => f.code).sort(), ["FMC-CENTRAL-BACKUP-MISSING", "FMC-CENTRAL-NOT-FOUND", "FMC-CENTRAL-NO-REVIT"].sort());
  assert.equal(none.status, "act");
  const nopath = analyze({ nowMs: NOW, gathered: gather(fsl, { central_path: "", backup_dir: "", local_dirs: [] }, null), facts: null, history: [], options: opts() });
  assert.ok(nopath.findings.some((f) => f.code === "FMC-CENTRAL-NO-PATH"));
  const cloudFacts = normalizeFacts({ workshared: true, cloud: true, central: "Autodesk Docs://Proj/Model.rvt", user: "ANN", worksets: [] });
  const cloud = analyze({ nowMs: NOW, gathered: gather(fsl, { central_path: "", backup_dir: "", local_dirs: [] }, cloudFacts), facts: cloudFacts, history: [], options: opts() });
  assert.ok(cloud.findings.some((f) => f.code === "FMC-CENTRAL-NO-FILE"));
  assert.equal(cloud.central.found, false);
  assert.equal(cloud.backups.state, "not_checked");
});

// ---- the tool -------------------------------------------------------------------------------------------------

function toolArgs(over: Partial<FmcCentralHealthArgs> = {}): FmcCentralHealthArgs {
  const defaults = Object.fromEntries(Object.entries(FMC_CENTRAL_HEALTH_SHAPE).map(([k, v]) => [k, (v as { parse(x: unknown): unknown }).parse(undefined)]));
  return { ...(defaults as FmcCentralHealthArgs), ...over };
}
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

test("the tool is dry-run first: a record request writes nothing until dry_run is false", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-central-health-"));
  try {
    const bdir = defaultBackupDir(CENTRAL);
    const { fsl } = mockFs(file(CENTRAL, 300 * MB, 1), { [bdir]: [file(`${bdir}\\a.rvt`, 1 * MB, 1)] });
    const deps = { fsl, now: () => NOW, facts: async () => ({ workshared: true, central: CENTRAL, user: "ANN", worksets: [] }), reportsDir: dir };
    const histFile = path.join(dir, "FMC_CentralHealth_History.json");

    const defaults = body(await runFmcCentralHealth(toolArgs({ record: true }), deps));
    assert.equal(defaults.dry_run, true);
    assert.equal(defaults.read_and_plan_only, true);
    assert.equal(defaults.history_record.recorded, false);
    assert.equal(defaults.history_record.would_record.size_bytes, 300 * MB);
    assert.equal(fs.existsSync(histFile), false);

    const noRecord = body(await runFmcCentralHealth(toolArgs({ dry_run: false }), deps));
    assert.equal(noRecord.history_record.requested, false);
    assert.equal(fs.existsSync(histFile), false);

    const written = body(await runFmcCentralHealth(toolArgs({ record: true, dry_run: false }), deps));
    assert.equal(written.history_record.recorded, true);
    assert.equal(fs.existsSync(histFile), true);
    const saved = parseHistory(fs.readFileSync(histFile, "utf8"));
    assert.equal(saved[historyKey(CENTRAL)].length, 1);

    const again = body(await runFmcCentralHealth(toolArgs({ record: true, dry_run: false }), deps));
    assert.equal(again.history_record.recorded, false);

    // a day later, with the central grown: the growth shows
    const later = { ...deps, now: () => NOW + 5 * DAY, fsl: mockFs(file(CENTRAL, 450 * MB, 0), {}).fsl };
    const grown = body(await runFmcCentralHealth(toolArgs(), later));
    assert.equal(grown.growth.status, "growing");
    assert.equal(grown.growth.flagged, true);
    assert.equal(grown.growth.delta_pct, 50);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the tool still answers when Revit is not reachable, and when use_revit is false", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-central-health-"));
  try {
    const { fsl } = mockFs(file(CENTRAL, 300 * MB, 1), {});
    const down = body(await runFmcCentralHealth(toolArgs({ central_path: CENTRAL }), { fsl, now: () => NOW, facts: async () => { throw new Error("no Revit"); }, reportsDir: dir }));
    assert.equal(down.central.found, true);
    assert.ok(down.findings.some((f: { code: string }) => f.code === "FMC-CENTRAL-NO-REVIT"));
    let asked = false;
    await runFmcCentralHealth(toolArgs({ central_path: CENTRAL, use_revit: false }), { fsl, now: () => NOW, facts: async () => { asked = true; return {}; }, reportsDir: dir });
    assert.equal(asked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fmc_central_health registers as one tool and its description promises no execution", () => {
  const seen: { name: string; description: string }[] = [];
  registerFmcCentralHealthTool({ tool: (name: string, description: string) => { seen.push({ name, description }); } } as unknown as McpServer);
  assert.deepEqual(seen.map((s) => s.name), ["fmc_central_health"]);
  assert.match(seen[0].description, /never runs an audit, a compact, a sync or a relinquish/);
  assert.match(seen[0].description, /needs_person true/);
});
