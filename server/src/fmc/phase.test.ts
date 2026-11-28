import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BatchBoard } from "./batchline.js";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { citePhase, PHASE_BANK_SHAPES, PHASE_DEFAULTS, verdictFor } from "./phase_bank.js";
import { appendRevisionLedger, auditPhase, comparePhases, normalizeSnapshot, revisionLedgerPath } from "./phase.js";
import { FMC_PHASE_SHAPE, loadPhaseBank, runFmcPhase, type FmcPhaseArgs } from "../tools/fmc_phase.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function args(partial: Record<string, unknown>): FmcPhaseArgs {
  return z.object(FMC_PHASE_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, unknown> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-phase-"));
  const guard = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(guard, JSON.stringify({
    ai_modeller: { auto_save_minutes: 10, mode: "testing" },
    save_exclude: ["HEBERT HOSTELS"],
    sync_exclude: ["QUIET"],
    protected_paths: ["D:\\Live"],
  }));
  const env = {
    ...process.env,
    APPDATA: dir,
    LOCALAPPDATA: dir,
    FMC_GUARD_CONFIG: guard,
    FMC_LEDGER_DIR: path.join(dir, "ledger"),
    FMC_STANDARDS_FILE: path.join(dir, "standards.json"),
  } as NodeJS.ProcessEnv;
  return { dir, env };
}

const approved = Object.fromEntries(Object.keys(PHASE_DEFAULTS).map((key) => [key, {
  value: PHASE_DEFAULTS[key], status: "approved", clause: "Manual phase clause",
}]));

function element(partial: Record<string, unknown>) {
  return {
    id: "1", category: "Walls", created_phase_id: "2", demolished_phase_id: "",
    host_id: "", host_created_phase_id: "", host_demolished_phase_id: "",
    kind: "model", room_number: "", room_name: "", mark: "", type_name: "Wall",
    ...partial,
  };
}

function base(extra: Record<string, unknown> = {}) {
  return normalizeSnapshot({
    resolved_document: { title: "A-0001", path: "D:\\Jobs\\_Staging\\A-0001.rvt" },
    phases: [
      { id: "1", name: "Existing", sequence: 1 },
      { id: "2", name: "New Construction", sequence: 2 },
    ],
    filters: [
      { id: "10", name: "Show Complete" },
      { id: "11", name: "Show Previous + Demo" },
    ],
    revisions: [{ id: "20", sequence: 1, description: "First", issued: false, date: "01/01/2026", issued_by: "", issued_to: "" }],
    views: [{
      id: "30", name: "Level 1", view_type: "FloorPlan", phase_id: "2", phase_name: "New Construction",
      filter_id: "10", filter_name: "Show Complete", sheet_id: "40", sheet_number: "A101", is_template: false,
    }],
    elements: [element({ id: "300", created_phase_id: "2" })],
    sheets: [{
      id: "40", number: "A101", name: "Plan", set: "Issue", revision_ids: [],
      titleblock_params: { "Current Revision": "P1", "Current Revision Date": "01/01/2026" },
      has_revision_schedule: true,
    }],
    sheet_sets: [{ name: "Issue", sheet_ids: ["40"] }],
    extents: [],
    ...extra,
  });
}

test("provisional never passes, a null uses the default, and draft or approved with a clause can pass", () => {
  const missing = citePhase("phase.existing_name", {});
  assert.equal(missing.source, "provisional");
  assert.equal(missing.value, "Existing");
  assert.equal(verdictFor(true, missing), "PROVISIONAL");
  assert.notEqual(verdictFor(true, missing), "PASS");

  const nulled = citePhase("phase.visible_filters", { "phase.visible_filters": { value: null, status: "approved", clause: "Manual" } });
  assert.equal(nulled.source, "provisional");
  assert.equal(verdictFor(true, nulled), "PROVISIONAL");
  assert.ok(Array.isArray(nulled.value));

  const unknown = citePhase("phase.not_a_key", { "phase.not_a_key": { value: null, status: "approved", clause: "Manual" } });
  assert.equal(unknown.source, "unknown");
  assert.equal(unknown.value, null);
  assert.equal(verdictFor(false, unknown), "UNKNOWN");

  const draft = citePhase("phase.host_match", { "phase.host_match": { value: "same", status: "draft", clause: "Host and family share a phase." } });
  assert.equal(verdictFor(true, draft), "PASS");
  const bare = citePhase("phase.host_match", { "phase.host_match": { value: "same", status: "approved" } });
  assert.equal(verdictFor(true, bare), "PROVISIONAL");
  const provisional = citePhase("phase.host_match", { "phase.host_match": { value: "same", status: "provisional", clause: "A clause does not promote provisional." } });
  assert.equal(verdictFor(true, provisional), "PROVISIONAL");
  assert.equal(verdictFor(false, draft), "FAIL");

  for (const key of Object.keys(PHASE_DEFAULTS)) {
    assert.ok(PHASE_BANK_SHAPES[key], key);
    assert.ok("value" in PHASE_BANK_SHAPES[key], key);
  }
});

test("the standards file is read from FMC_STANDARDS_FILE and a missing file is an empty bank", () => {
  const { dir, env } = tempEnv();
  fs.writeFileSync(env.FMC_STANDARDS_FILE ?? "", JSON.stringify({
    standards: { "phase.existing_name": { value: "Existing", status: "draft", clause: "Manual 8" } },
  }));
  const bank = loadPhaseBank(env);
  assert.equal(citePhase("phase.existing_name", bank).source, "standards");
  assert.equal(citePhase("phase.max_ops", bank).source, "provisional");
  assert.deepEqual(loadPhaseBank({ ...env, FMC_STANDARDS_FILE: path.join(dir, "missing.json") }), {});
  assert.ok(revisionLedgerPath(env).startsWith(dir));
});

test("audit returns counts and ids for each finding, and a clean provisional model is not a pass", async () => {
  const snapshot = base({
    views: [
      { id: "30", name: "Level 1", view_type: "FloorPlan", phase_id: "2", phase_name: "New Construction", filter_id: "11", filter_name: "Show Previous + Demo", sheet_id: "40", sheet_number: "A101", is_template: false },
      { id: "31", name: "Bare", view_type: "FloorPlan", phase_id: "2", phase_name: "New Construction", filter_id: "", filter_name: "", sheet_id: "", sheet_number: "", is_template: false },
    ],
    elements: [
      element({ id: "100", created_phase_id: "2", demolished_phase_id: "1" }),
      element({ id: "101", created_phase_id: "1", demolished_phase_id: "1" }),
      element({ id: "102", category: "Doors", created_phase_id: "2", host_id: "100", host_created_phase_id: "1", kind: "hosted" }),
      element({ id: "200", category: "Rooms", kind: "room", created_phase_id: "1", room_number: "101", room_name: "Bedroom" }),
    ],
  });
  const audited = auditPhase(snapshot, {});
  const byCode = Object.fromEntries(audited.findings.map((row) => [row.code, row]));
  assert.deepEqual(byCode["PHASE-DEMO-BEFORE-CREATE"].ids, ["100"]);
  assert.ok(byCode["PHASE-DEMO-IN-EXISTING"].ids.includes("100"));
  assert.ok(byCode["PHASE-DEMO-IN-EXISTING"].ids.includes("101"));
  assert.deepEqual(byCode["PHASE-HOST-MISMATCH"].ids, ["102"]);
  assert.deepEqual(byCode["PHASE-ROOM-MISSING"].ids, ["200"]);
  assert.deepEqual(byCode["PHASE-VIEW-NO-FILTER"].ids, ["31"]);
  assert.deepEqual(byCode["PHASE-VIEW-SUSPICIOUS-FILTER"].ids, ["30"]);
  assert.ok(audited.findings.every((row) => row.verdict !== "PASS"));

  const many = Array.from({ length: 60 }, (_, index) => element({ id: String(index + 1), created_phase_id: "2", demolished_phase_id: "1" }));
  const capped = auditPhase(base({ elements: many }), {}, 50);
  const before = capped.findings.find((row) => row.code === "PHASE-DEMO-BEFORE-CREATE");
  assert.equal(before?.count, 60);
  assert.equal(before?.ids.length, 50);
  assert.equal(before?.truncated, true);

  const { env } = tempEnv();
  let reads = 0;
  const reply = textOf(await runFmcPhase(args({ action: "audit", document: "A-0001" }), {
    env, bank: {},
    readSnapshot: async () => { reads += 1; return base(); },
  }));
  assert.equal(reads, 1);
  assert.equal(reply.action, "audit");
  assert.equal(reply.pass, false);
  const findings = reply.findings as Array<{ verdict: string }>;
  assert.ok(findings.every((row) => row.verdict === "PROVISIONAL"));
});

test("an approved bank with a clause can PASS a clean audit", async () => {
  const { env } = tempEnv();
  const reply = textOf(await runFmcPhase(args({ action: "audit", document: "A-0001" }), {
    env, bank: approved,
    readSnapshot: async () => base(),
  }));
  assert.equal(reply.pass, true);
  const findings = reply.findings as Array<{ verdict: string; count: number }>;
  assert.ok(findings.every((row) => row.count === 0 && row.verdict === "PASS"));
});

test("a missing document is FMC-DOC-REQUIRED and does not call Revit", async () => {
  let called = false;
  const reply = textOf(await runFmcPhase(args({ action: "phases" }), {
    readSnapshot: async () => { called = true; return base(); },
  }));
  assert.equal(called, false);
  assert.equal(reply.isError, true);
  assert.equal(reply.code, "FMC-DOC-REQUIRED");
  assert.match(String(reply.message), /active document/);
});

test("phases lists sequence and issued state", async () => {
  const { env } = tempEnv();
  const reply = textOf(await runFmcPhase(args({ action: "phases", document: "A-0001" }), {
    env, bank: {}, readSnapshot: async () => base(),
  }));
  const phases = reply.phases as Array<{ name: string; sequence: number }>;
  const revisions = reply.revisions as Array<{ sequence: number; issued: boolean }>;
  assert.deepEqual(phases.map((phase) => [phase.name, phase.sequence]), [["Existing", 1], ["New Construction", 2]]);
  assert.equal(revisions[0].issued, false);
  assert.equal(revisions[0].sequence, 1);
  assert.equal((reply.bank_shapes as Record<string, unknown>)["phase.existing_name"] != null, true);
});

test("batch_check plans the phase fixes, defaults dry_run to true, and caps at 50", async () => {
  const { env } = tempEnv();
  let applied = 0;
  const preview = textOf(await runFmcPhase(args({
    action: "batch_check", document: "A-0001", phase: "New Construction", ids: ["201"], view: "Level 1",
  }), {
    env, bank: {},
    readSnapshot: async () => base({
      elements: [element({ id: "201", created_phase_id: "1" })],
      views: [{ id: "30", name: "Level 1", view_type: "FloorPlan", phase_id: "1", phase_name: "Existing", filter_id: "11", filter_name: "Show Previous + Demo", sheet_id: "", sheet_number: "", is_template: false }],
    }),
    apply: async () => { applied += 1; return { applied: true }; },
  }));
  assert.equal(applied, 0);
  assert.equal(preview.dry_run, true);
  assert.equal(preview.read_only, true);
  const codes = (preview.mismatches as Array<{ code: string }>).map((row) => row.code);
  assert.ok(codes.includes("PHASE-CREATED-MISMATCH"));
  assert.ok(codes.includes("PHASE-VIEW-PHASE"));
  assert.ok(codes.includes("PHASE-VIEW-FILTER"));

  const refused = textOf(await runFmcPhase(args({
    action: "batch_check", document: "A-0001", phase: "New Construction", ids: ["201"], dry_run: false,
  }), { env, bank: {}, readSnapshot: async () => base({ elements: [element({ id: "201", created_phase_id: "1" })], views: [] }) }));
  assert.equal(refused.code, "FMC-BATCH-LOCKED");

  const ids = Array.from({ length: 51 }, (_, index) => String(index + 1));
  const capped = textOf(await runFmcPhase(args({
    action: "batch_check", document: "A-0001", phase: "New Construction", ids, dry_run: false, batch_lease: "lease-1",
  }), {
    env, bank: {},
    readSnapshot: async () => base({ elements: [], views: [] }),
    apply: async () => { applied += 1; return { applied: true }; },
  }));
  assert.equal(capped.code, "FMC-PHASE-CAP");
  assert.equal(applied, 0);
});

test("a write is refused for save_exclude, sync_exclude, protected_paths and HEBERT, and a real fix reports autosave without saving", async () => {
  const { env } = tempEnv();
  const calls: Array<Record<string, unknown>> = [];
  const run = (title: string, file: string) => runFmcPhase(args({
    action: "batch_check", document: title, phase: "New Construction", ids: ["201"], dry_run: false, batch_lease: "lease-1",
  }), {
    env, bank: {},
    readSnapshot: async () => base({
      resolved_document: { title, path: file },
      elements: [element({ id: "201", created_phase_id: "1" })],
      views: [],
    }),
    apply: async (body) => { calls.push(body); return { applied: true, ok: true }; },
  });
  const hostel = textOf(await run("HEBERT HOSTELS_USER", "D:\\Jobs\\_Staging\\HEBERT HOSTELS_USER.rvt"));
  assert.equal(hostel.code, "FMC-PHASE-GUARD");
  assert.match(String(hostel.message), /HEBERT HOSTELS/);
  const quiet = textOf(await run("QUIET", "D:\\Jobs\\_Staging\\QUIET.rvt"));
  assert.match(String(quiet.message), /sync_exclude/);
  const live = textOf(await run("A-0001", "D:\\Live\\A-0001.rvt"));
  assert.match(String(live.message), /protected/i);
  assert.equal(calls.length, 0);

  const fixed = textOf(await run("A-0001", "D:\\Jobs\\_Staging\\A-0001.rvt"));
  assert.equal(fixed.isError, false);
  assert.equal(calls.length, 1);
  const guard = fixed.guard as { auto_save_minutes: number; saved: boolean; synced: boolean };
  assert.equal(guard.auto_save_minutes, 10);
  assert.equal(guard.saved, false);
  assert.equal(guard.synced, false);
  const payload = calls[0];
  assert.equal(payload.action, "batch_check");
  assert.ok((payload.ids as string[]).includes("201"));
  assert.ok((payload.ops as unknown[]).length <= 50);
});

test("fmc_batch stores phase and batch_check reads it from the lease", async () => {
  const { dir, env } = tempEnv();
  const previous = process.env.APPDATA;
  process.env.APPDATA = dir;
  try {
    let stored: Array<{ id: string; phase?: string }> = [];
    const made = new BatchBoard({
      persistLine: (rows) => { stored = rows; },
      autoSweep: false,
      requiredReferences: ["kit", "standards", "rulebook"],
      validator: async () => ({ ok: true }),
      memoryPaused: () => false,
    });
    const granted = await made.request({
      document: "A-0001", label: "walls", client: "bot", phase: "New Construction",
      references: { kit: ["FMC_A_Wall"], standards: ["phase.new_work_name"], rulebook: ["A.WAL_01"] },
    });
    assert.equal(granted.phase, "New Construction");
    assert.equal(made.phaseOf(String(granted.lease)), "New Construction");
    assert.equal(stored[0]?.phase, "New Construction");
    const restored = new BatchBoard({
      persistLine: () => {}, autoSweep: false, requiredReferences: ["kit", "standards", "rulebook"],
      validator: async () => ({ ok: true }), memoryPaused: () => false,
    });
    restored.importLine(stored as never);
    assert.equal(restored.phaseOf(stored[0].id), "New Construction");

    const reply = textOf(await runFmcPhase(args({
      action: "batch_check", document: "A-0001", batch_lease: String(granted.lease), ids: ["300"],
    }), {
      env, bank: {},
      phaseOfLease: (lease) => made.phaseOf(lease),
      readSnapshot: async () => base(),
    }));
    const phase = reply.phase as { name: string };
    assert.equal(phase.name, "New Construction");
    assert.equal((reply.ops as unknown[]).length, 0);
  } finally {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
  }
});

test("revision compare is server-only and the cloud ledger stays in the temp directory", async () => {
  const { dir, env } = tempEnv();
  appendRevisionLedger({
    at: "2026-11-22T00:00:00.000Z", tool: "fmc_phase", action: "revision_cloud", batch_id: "b1",
    revision_id: "20", revision_sequence: 1, revision_description: "First",
    document: { title: "A-0001", path: "D:\\Jobs\\_Staging\\A-0001.rvt" },
    element_ids: ["1", "2"], categories: { "1": "Walls", "2": "Walls" },
    clouds: [{ id: "9", view_id: "30", sheet_id: "40" }], issued: false,
  }, env);
  appendRevisionLedger({
    at: "2026-11-22T01:00:00.000Z", tool: "fmc_phase", action: "revision_cloud", batch_id: "b2",
    revision_id: "21", revision_sequence: 2, revision_description: "Second",
    document: { title: "A-0001", path: "D:\\Jobs\\_Staging\\A-0001.rvt" },
    element_ids: ["2", "3"], categories: { "2": "Walls", "3": "Doors" },
    clouds: [], issued: false,
  }, env);
  let reads = 0;
  const reply = textOf(await runFmcPhase(args({
    action: "compare", by: "revision", document: "A-0001", from: "20", to: "21",
  }), {
    env, bank: {},
    readSnapshot: async () => { reads += 1; return base(); },
  }));
  assert.equal(reads, 0);
  assert.equal(reply.server_only, true);
  assert.equal(reply.revit, false);
  assert.equal(reply.suitable_for, "handoff");
  const walls = (reply.by_category as Record<string, { added: { ids: string[] }; removed: { ids: string[] }; changed: { ids: string[] } }>).Walls;
  assert.deepEqual(walls.removed.ids, ["1"]);
  assert.deepEqual(walls.changed.ids, ["2"]);
  const doors = (reply.by_category as Record<string, { added: { count: number } }>).Doors;
  assert.equal(doors.added.count, 1);
  assert.ok(revisionLedgerPath(env).startsWith(dir));

  const phasePack = comparePhases(base({
    elements: [
      element({ id: "1", created_phase_id: "1", demolished_phase_id: "2", mark: "W1" }),
      element({ id: "2", created_phase_id: "2", mark: "W1", type_name: "New" }),
      element({ id: "3", created_phase_id: "2", mark: "W9" }),
    ],
  }), "Existing", "New Construction");
  assert.equal(phasePack.ok, true);
  if (phasePack.ok) {
    assert.deepEqual(phasePack.pack.by_category.Walls.changed.ids, ["1", "2"]);
    assert.deepEqual(phasePack.pack.by_category.Walls.added.ids, ["3"]);
    assert.equal(phasePack.pack.suitable_for, "handoff");
  }
});

test("revision clouds record batch, revision, elements and clouds, and a dry run does not", async () => {
  const { dir, env } = tempEnv();
  const dry = textOf(await runFmcPhase(args({
    action: "revision_open", document: "A-0001", revision: "First", batch_id: "batch-7", ids: ["300"],
  }), { env, bank: {}, readSnapshot: async () => base() }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.attach, true);
  assert.equal(fs.existsSync(revisionLedgerPath(env)), false);

  const opened = textOf(await runFmcPhase(args({
    action: "revision_open", document: "A-0001", description: "Wall move", batch_id: "batch-7", ids: ["300"],
    dry_run: false, batch_lease: "lease-1",
  }), {
    env, bank: {},
    readSnapshot: async () => base({ revisions: [] }),
    apply: async () => ({ applied: true, ok: true, revision_id: "21", sequence: 2 }),
  }));
  assert.equal(opened.isError, false);
  const lines = fs.readFileSync(revisionLedgerPath(env), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].batch_id, "batch-7");
  assert.equal(lines[0].revision_id, "21");
  assert.deepEqual(lines[0].element_ids, ["300"]);
  assert.ok(revisionLedgerPath(env).startsWith(dir));

  const clouded = textOf(await runFmcPhase(args({
    action: "revision_cloud", document: "A-0001", revision: "20", batch_id: "batch-7", ids: ["300"],
    dry_run: false, batch_lease: "lease-1",
  }), {
    env, bank: {},
    readSnapshot: async () => base({
      extents: [{ element_id: "300", view_id: "30", sheet_id: "40", min_u_mm: 0, min_v_mm: 0, max_u_mm: 1000, max_v_mm: 400 }],
    }),
    apply: async (body) => ({
      applied: true, ok: true,
      clouds: [{ id: "90", view_id: "30", sheet_id: (body.ops as Array<{ sheet_id: string }>)[0].sheet_id }],
    }),
  }));
  assert.equal(clouded.isError, false);
  const second = JSON.parse(fs.readFileSync(revisionLedgerPath(env), "utf8").trim().split("\n")[1]);
  assert.equal(second.batch_id, "batch-7");
  assert.equal(second.revision_id, "20");
  assert.deepEqual(second.element_ids, ["300"]);
  assert.equal(second.clouds[0].id, "90");
  assert.equal(second.clouds[0].sheet_id, "40");
});

test("issue checks the titleblock and the schedule before it marks issued, and unissue rolls that back", async () => {
  const { env } = tempEnv();
  const blocked = textOf(await runFmcPhase(args({
    action: "issue", document: "A-0001", sheet_set: "Issue", batch_lease: "lease-1",
  }), {
    env, bank: {},
    readSnapshot: async () => base({
      sheets: [{ id: "40", number: "A101", name: "Plan", set: "Issue", revision_ids: [], titleblock_params: { "Current Revision": "" }, has_revision_schedule: false }],
    }),
  }));
  assert.equal(blocked.dry_run, true);
  assert.equal(blocked.checks_ok, false);
  assert.equal(blocked.would_mark_issued, false);
  assert.equal(blocked.verdict, "FAIL");
  const provisional = textOf(await runFmcPhase(args({ action: "issue", document: "A-0001", sheet_set: "Issue" }), {
    env, bank: {}, readSnapshot: async () => base(),
  }));
  assert.equal(provisional.checks_ok, true);
  assert.equal(provisional.verdict, "PROVISIONAL");

  let marked = false;
  const issued = textOf(await runFmcPhase(args({
    action: "issue", document: "A-0001", sheet_set: "Issue", dry_run: false, batch_lease: "lease-1", batch_id: "issue-1",
  }), {
    env, bank: approved,
    readSnapshot: async () => base(),
    apply: async (body) => {
      const op = (body.ops as Array<{ mark_issued?: boolean; ids?: string[] }>)[0];
      marked = op.mark_issued === true;
      assert.deepEqual(op.ids, ["40"]);
      return { applied: true, ok: true, revision_id: "22", sequence: 2, issued: true };
    },
  }));
  assert.equal(marked, true);
  assert.equal(issued.verdict, "PASS");
  assert.equal((issued.applied as { issued: boolean }).issued, true);

  const rolled = textOf(await runFmcPhase(args({
    action: "unissue", document: "A-0001", revision: "20", dry_run: false, batch_lease: "lease-1",
  }), {
    env, bank: {},
    readSnapshot: async () => base(),
    apply: async (body) => {
      assert.equal((body.ops as Array<{ op: string }>)[0].op, "unissue");
      return { applied: true, ok: true, revision_id: "20", issued: false };
    },
  }));
  assert.equal((rolled.applied as { issued: boolean }).issued, false);
});

test("the add-in commands are registered and the write goes through sendCommand", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((command) => command.commandName));
  assert.ok(names.has("fmc_phase"));
  assert.ok(names.has("fmc_phase_apply"));
  const tool = fs.readFileSync(path.join(root, "server", "src", "tools", "fmc_phase.ts"), "utf8");
  assert.match(tool, /sendCommand\(\s*"fmc_phase"/);
  assert.match(tool, /sendCommand\(\s*"fmc_phase_apply"/);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_phase"));
  assert.ok(WRITE_COMMANDS.has("fmc_phase_apply"));
  assert.ok(!WRITE_COMMANDS.has("fmc_phase"));
  const read = fs.readFileSync(path.join(root, "commandset", "Commands", "Fmc", "FmcPhaseCommand.cs"), "utf8");
  assert.match(read, /CommandName => "fmc_phase"/);
  assert.match(read, /CommandName => "fmc_phase_apply"/);
});

test("a Revit document error is returned as that FMC code", async () => {
  const reply = textOf(await runFmcPhase(args({ action: "phases", document: "Missing" }), {
    bank: {},
    readSnapshot: async () => { throw new Error("[FMC-DOC-NOT-FOUND] No open document has title or path \"Missing\". Refusing to use the active document."); },
  }));
  assert.equal(reply.code, "FMC-DOC-NOT-FOUND");
  assert.equal(reply.isError, true);
  const ambiguous = textOf(await runFmcPhase(args({ action: "audit", document: "A-0001" }), {
    bank: {},
    readSnapshot: async () => { throw new Error("[FMC-DOC-AMBIGUOUS] \"A-0001\" matches 2 open documents."); },
  }));
  assert.equal(ambiguous.code, "FMC-DOC-AMBIGUOUS");
});
