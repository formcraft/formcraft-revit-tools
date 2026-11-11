import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queueClient } from "./fairqueue.js";
import { WRITE_COMMANDS } from "./policy.js";
import {
  BatchBoard, BatchGateError, admitBatchWrite, loadBatchConfig, logBatchRestart, normalizeReferences,
  notifyBatchGranted, resetBatchBoard,
} from "./batchline.js";
import { runFmcBatch } from "../tools/fmc_batch.js";
import { autoSave } from "./aigate.js";
import { batchCareReport, correctionHelp } from "./batchcare.js";

const references = { kit: ["FMC_S_Column"], standards: ["structure.column.300"], rulebook: ["S.FND_01"] };

describe("batch leases", { concurrency: 1 }, () => {
before(() => { resetBatchBoard({ autoSweep: false }).close(); });

function board(partial: ConstructorParameters<typeof BatchBoard>[0] = {}) {
  const clock = { t: 1_700_000_000_000 };
  const logs: string[] = [];
  const { now, ...rest } = partial;
  const made = new BatchBoard({ idleMs: 120_000, maxMs: 1_800_000, autoSweep: false, log: (line) => logs.push(line), ...rest, now: now ?? (() => clock.t) });
  return { board: made, clock, logs };
}

const req = (made: BatchBoard, client: string, document: string, label: string, extra: { batchId?: string; bot?: string; estOps?: number; references?: unknown; correction?: string } = {}) =>
  made.request({ document, label, client, bot: extra.bot ?? client, references: extra.references ?? references, batchId: extra.batchId, estOps: extra.estOps, correction: extra.correction });

const changedRefs = (n: number) => ({ kit: [`FMC_S_Column_${n}`], standards: ["structure.column.300"], rulebook: ["NAM-004"] });

test("a request without kit, standards or rulebook ids is refused and names what is missing", async () => {
  const { board: made } = board();
  const missing = await made.request({ document: "Architecture", label: "grids", client: "a", references: undefined }).then(() => "", (error) => error);
  assert.ok(missing instanceof BatchGateError);
  assert.equal(missing.code, "FMC-BATCH-NOREFS");
  assert.match(missing.message, /Missing: kit, standards, rulebook/);
  const blanks = await made.request({ document: "Architecture", label: "grids", client: "a", references: { kit: ["  "], standards: [], rulebook: ["NAM-1"] } }).then(() => "", (error) => error);
  assert.ok(blanks instanceof BatchGateError);
  assert.match(blanks.message, /Missing: kit, standards/);
  assert.equal((made.snapshot().documents as unknown[]).length, 0);
  const tool = await queueClient.run("a", () => runFmcBatch({ action: "request", document: "Architecture", label: "grids" }));
  assert.equal(tool.isError, true);
  assert.match(tool.content[0].text, /FMC-BATCH-NOREFS/);
});

test("required categories come from config, and the validator hook can refuse an id", async () => {
  const seen: string[] = [];
  const { board: made } = board({
    requiredReferences: ["kit"],
    validator: (refs) => {
      seen.push(...(refs.kit ?? []));
      return refs.kit?.includes("nope") ? { ok: false, message: "kit nope is not in the library" } : { ok: true };
    },
  });
  const granted = await req(made, "a", "Architecture", "grids", { references: { kit: ["FMC_S_Column"] } });
  assert.equal(granted.state, "granted");
  assert.deepEqual(seen, ["FMC_S_Column"]);
  const refused = await made.request({ document: "Architecture", label: "other", client: "b", references: { kit: ["nope"] } }).then(() => "", (error) => error);
  assert.ok(refused instanceof BatchGateError);
  assert.match(refused.message, /\[FMC-BATCH-NOREFS\] kit nope/);
  const presence = await made.request({ document: "Architecture", label: "empty", client: "c" }).then(() => "", (error) => error);
  assert.match((presence as Error).message, /Missing: kit/);
  assert.deepEqual(seen, ["FMC_S_Column", "nope"]);
});

test("normalizeReferences keeps extra categories and drops blank entries", () => {
  const { refs, missing } = normalizeReferences({ kit: [" A "], standards: [""], rulebook: ["R1"], note: ["kept"] }, ["kit", "standards", "rulebook"]);
  assert.deepEqual(missing, ["standards"]);
  assert.deepEqual(refs.kit, ["A"]);
  assert.deepEqual(refs.note, ["kept"]);
});

test("two documents can be held at once, and one document is a FIFO line", async () => {
  const { board: made } = board();
  const arch = await req(made, "arch", "Architecture", "arch-grids");
  const stru = await req(made, "struct", "Structure", "struct-grids");
  assert.equal(arch.state, "granted");
  assert.equal(stru.state, "granted");
  const second = await req(made, "arch2", "Architecture", "arch-walls");
  assert.equal(second.state, "queued");
  assert.equal(second.position, 1);
  assert.equal(second.attempt, 1);
  made.release(String(arch.lease), "ok", "arch", "grids placed");
  assert.equal(made.status(String(second.lease)).state, "granted");
});

test("a failed batch joins the tail and the next request carries attempt + 1", async () => {
  const { board: made, logs } = board();
  const a = await req(made, "a", "Architecture", "grids");
  const b = await req(made, "b", "Architecture", "walls");
  const c = await req(made, "c", "Architecture", "rooms");
  assert.equal(b.position, 1);
  assert.equal(c.position, 2);
  const failed = made.release(String(a.lease), "failed", "a", "row 4 rolled in the bot", "op 4 threw");
  assert.equal(failed.outcome, "failed");
  assert.match(logs.join("\n"), /not rolled back/i);
  assert.equal(made.status(String(b.lease)).state, "granted");
  const again = await req(made, "a", "Architecture", "grids", { correction: "use the wall recipe", references: changedRefs(2) });
  assert.equal(again.state, "queued");
  assert.equal(again.attempt, 2);
  assert.equal(again.position, 2);
  const line = (made.snapshot().documents as Array<{ line: Array<{ label: string }> }>)[0].line.map((row) => row.label);
  assert.deepEqual(line, ["rooms", "grids"]);
  const hist = (made.snapshot().documents as Array<{ history: Array<{ outcome: string; error?: string; references: { kit: string[] }; attempt: number }> }>)[0].history[0];
  assert.equal(hist.outcome, "failed");
  assert.equal(hist.error, "op 4 threw");
  assert.equal(hist.attempt, 1);
  assert.deepEqual(hist.references.kit, ["FMC_S_Column"]);
});

test("a failed batch is never parked, a same retry is refused, and a fourth attempt is only marked struggling", async () => {
  const { board: made } = board();
  for (let attempt = 1; attempt <= 4; attempt++) {
    const row = await req(made, "a", "Architecture", "grids", {
      correction: attempt === 1 ? undefined : `changed the kit id to ${attempt}`,
      references: changedRefs(attempt),
    });
    assert.equal(row.attempt, attempt);
    assert.equal(row.struggling, attempt > 3);
    made.release(String(row.lease), "failed", "a", "still wrong", `miss ${attempt}`);
  }
  const same = await req(made, "a", "Architecture", "grids", { correction: "changed the kit id to 5", references: changedRefs(4) }).then(() => "", (error) => error);
  assert.ok(same instanceof BatchGateError);
  assert.equal(same.code, "FMC-BATCH-SAMEFIX");
  const missing = await req(made, "a", "Architecture", "grids", { references: changedRefs(5) }).then(() => "", (error) => error);
  assert.ok(missing instanceof BatchGateError);
  assert.equal(missing.code, "FMC-BATCH-SAMEFIX");
  const other = await req(made, "b", "Architecture", "walls");
  assert.equal(other.state, "granted");
  const again = await req(made, "a", "Architecture", "grids", { correction: "use NAM-004 fix hint", references: changedRefs(6) });
  assert.equal(again.state, "queued");
  assert.equal(again.attempt, 5);
  assert.equal(again.struggling, true);
  const snap = made.snapshot() as { struggling: Array<{ attempts: number; struggling: boolean }> };
  assert.ok(snap.struggling.some((row) => row.struggling && row.attempts > 3));
  const failed = made.release(String(other.lease), "failed", "b", "check", "rule NAM-004");
  assert.equal(failed.outcome, "failed");
  const correction = failed.correction as { recipes: unknown[]; recipe_to_write: { name: string } | null };
  assert.ok(correction.recipes.length > 0 || correction.recipe_to_write?.name, "a failed release names a recipe or a recipe to write");
  const hinted = correctionHelp(
    { error: "NAM-004 failed", references: { rulebook: ["NAM-004"], kit: ["FMC_S_Column"], standards: ["structure.column.300"] }, label: "grids", bot: "structure" },
    { rules: [{ id: "NAM-004", rule: "Name the grids", fix_hint: "Rename the grid to the kit pattern" }], recipes: [] },
  );
  assert.equal(hinted.fix_hints[0].fix_hint, "Rename the grid to the kit pattern");
  assert.match(hinted.recipe_to_write?.name ?? "", /FMC_S_/);
});

test("a successful release clears the attempt count", async () => {
  const { board: made } = board();
  const first = await req(made, "a", "Architecture", "grids");
  made.release(String(first.lease), "failed", "a", "once", "once");
  const second = await req(made, "a", "Architecture", "grids", { correction: "fixed the op", references: changedRefs(2) });
  assert.equal(second.attempt, 2);
  made.release(String(second.lease), "ok", "a", "fixed");
  const third = await req(made, "a", "Architecture", "grids");
  assert.equal(third.attempt, 1);
  assert.equal(third.state, "granted");
});

test("idle expiry, the hard maximum, and a disconnect count as failed and grant the next bot", async () => {
  const { board: made, clock } = board();
  const notices: string[] = [];
  made.listen((notice) => notices.push(notice.lease));
  const a = await req(made, "a", "Architecture", "grids");
  const b = await req(made, "b", "Architecture", "walls");
  assert.equal(notices.length, 0);
  clock.t += 119_000;
  made.heartbeat(String(a.lease), "a");
  assert.deepEqual(made.sweep(), []);
  clock.t += 120_000;
  assert.deepEqual(made.sweep(), [a.lease]);
  assert.equal(made.status(String(b.lease)).state, "granted");
  assert.equal(notices[0], b.lease);
  const retry = await req(made, "a", "Architecture", "grids", { correction: "heartbeat the next one", references: changedRefs(2) });
  assert.equal(retry.attempt, 2);
  assert.equal(retry.state, "queued");
  const hist = (made.snapshot().documents as Array<{ history: Array<{ end: string; outcome: string }> }>)[0].history[0];
  assert.equal(hist.end, "expired");
  assert.equal(hist.outcome, "failed");
  made.cancel(String(retry.lease), "a");
  made.release(String(b.lease), "ok", "b", "done");

  const c = await req(made, "c", "Structure", "pads");
  made.heartbeat(String(c.lease), "c");
  clock.t += 1_800_000;
  assert.deepEqual(made.sweep(), [c.lease]);
  assert.equal((made.snapshot().documents as Array<{ document: string; history: Array<{ end: string }> }>).find((row) => row.document === "Structure")?.history[0].end, "max_duration");

  const d = await req(made, "d", "Electrical", "boards");
  const e = await req(made, "e", "Electrical", "circuits");
  assert.equal(made.disconnect("d"), 1);
  assert.equal(made.status(String(e.lease)).state, "granted");
  assert.equal((made.snapshot().documents as Array<{ document: string; history: Array<{ end: string }> }>).find((row) => row.document === "Electrical")?.history[0].end, "disconnect");
});

test("cancel leaves the queue without spending an attempt, and a write from the wrong session is refused", async () => {
  const { board: made } = board();
  const a = await req(made, "a", "Architecture", "grids");
  const b = await req(made, "b", "Architecture", "walls");
  const cancelled = made.cancel(String(b.lease), "b");
  assert.equal(cancelled.state, "cancelled");
  const again = await req(made, "b", "Architecture", "walls");
  assert.equal(again.attempt, 1);
  assert.throws(() => made.cancel(String(a.lease), "a"), /release it/);
  assert.throws(() => made.admit("Architecture", undefined, "b"), /FMC-BATCH-LOCKED/);
  assert.throws(() => made.admit("Architecture", String(a.lease), "b"), /FMC-BATCH-LOCKED/);
  assert.match((() => { try { made.admit("Architecture", "nope", "a"); return ""; } catch (error) { return (error as Error).message; } })(), /Your lease is/);
  const admitted = made.admit("Architecture", String(a.lease), "a");
  assert.equal(made.status(String(a.lease)).ops, 1);
  admitted.finish();
  const global = resetBatchBoard({ autoSweep: false, idleMs: 120_000, maxMs: 1_800_000, now: () => 1 });
  const held = await req(global, "holder", "Architecture", "grids");
  assert.equal(admitBatchWrite("fmc_document_info", "Architecture", undefined, "b").finish(), undefined);
  assert.ok(!WRITE_COMMANDS.has("fmc_document_info"));
  assert.throws(() => admitBatchWrite("fmc_model_edit", "Architecture", undefined, "b"), /FMC-BATCH-LOCKED/);
  assert.throws(() => admitBatchWrite("fmc_model_edit", "Architecture", String(held.lease), "b"), /FMC-BATCH-LOCKED/);
  admitBatchWrite("fmc_model_edit", "Architecture", String(held.lease), "holder").finish();
  global.close();
});

test("a write waiting in the fair queue keeps the lease alive, and history keeps the references", async () => {
  const { board: made, clock } = board();
  const a = await req(made, "a", "Architecture.rvt", "grids");
  const held = made.beginCall(String(a.lease), "a");
  clock.t += 120_000;
  assert.deepEqual(made.sweep(), []);
  held.finish();
  clock.t += 120_000;
  assert.deepEqual(made.sweep(), [a.lease]);
  const hist = (made.snapshot().documents as Array<{ history: Array<{ references: { standards: string[] } }> }>)[0].history[0];
  assert.deepEqual(hist.references.standards, ["structure.column.300"]);
  const bots = (made.snapshot().bots as Array<{ last_references: { kit: string[] } | null; failures: number; avg_duration_ms: number }>);
  assert.deepEqual(bots[0].last_references?.kit, ["FMC_S_Column"]);
  assert.equal(bots[0].failures, 1);
  assert.ok(bots[0].avg_duration_ms >= 120_000);
});

test("history keeps the last 20, and per-bot averages cover ok and failed", async () => {
  const { board: made, clock } = board();
  for (let i = 0; i < 25; i++) {
    const row = await req(made, "a", "Architecture", `batch-${i}`, { bot: "structure" });
    clock.t += 1000;
    made.release(String(row.lease), "ok", "a", `done ${i}`);
    clock.t += 500;
  }
  const doc = (made.snapshot().documents as Array<{ history: Array<{ label: string; duration_ms: number }> }>)[0];
  assert.equal(doc.history.length, 20);
  assert.equal(doc.history[0].label, "batch-24");
  const bot = (made.snapshot().bots as Array<{ batches: number; avg_duration_ms: number; avg_wait_ms: number; last_label: string }>)[0];
  assert.equal(bot.batches, 25);
  assert.equal(bot.avg_duration_ms, 1000);
  assert.equal(bot.last_label, "batch-24");
});

test("wait returns when the lease is granted and does not block past the cap", async () => {
  const { board: made } = board({ now: () => Date.now(), idleMs: 60_000 });
  const a = await req(made, "a", "Architecture", "grids");
  const b = await req(made, "b", "Architecture", "walls");
  const pending = made.wait(String(b.lease), 2);
  setTimeout(() => made.release(String(a.lease), "ok", "a", "done"), 20);
  const granted = await pending;
  assert.equal(granted.state, "granted");
  const queued = await req(made, "c", "Architecture", "rooms");
  const immediate = await made.wait(String(queued.lease), 0);
  assert.equal(immediate.state, "queued");
  const timed = await made.wait(String(queued.lease), 0.05);
  assert.equal(timed.state, "queued");
});

test("service config and a restart clear leases without logging a token", async () => {
  const fromFile = loadBatchConfig({} as NodeJS.ProcessEnv, () => JSON.stringify({ port: 8787, batch: { idle_s: 9, max_s: 60, max_attempts: 4, required_references: ["kit"] } }));
  assert.equal(fromFile.idleMs, 9000);
  assert.deepEqual(fromFile.requiredReferences, ["kit"]);
  const fromEnv = loadBatchConfig({ FMC_BATCH_IDLE_S: "15", FMC_BATCH_REQUIRED_REFS: "standards,rulebook" } as NodeJS.ProcessEnv, () => JSON.stringify({ batch: { idle_s: 9, required_references: ["kit"] } }));
  assert.equal(fromEnv.idleMs, 15_000);
  assert.deepEqual(fromEnv.requiredReferences, ["standards", "rulebook"]);
  const lines: string[] = [];
  const prior = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const made = resetBatchBoard({ autoSweep: false, log: (line) => lines.push(line) });
    await req(made, "a", "Architecture", "grids");
    const restarted = logBatchRestart();
    assert.equal((restarted.snapshot().documents as unknown[]).length, 0);
    restarted.close();
  } finally {
    console.error = prior;
  }
  assert.match(lines.join("\n"), /Leases cleared/);
  assert.equal(lines.join("\n").includes("Bearer secret-token"), false);
  const sent = await notifyBatchGranted(async () => { throw new Error("no stream"); }, { client: "a", lease: "x", document: "Architecture", label: "grids", bot: "a", attempt: 1 });
  assert.equal(sent, false);
  let method = "";
  const ok = await notifyBatchGranted(async (name) => { method = name; }, { client: "a", lease: "x", document: "Architecture", label: "grids", bot: "a", attempt: 2 });
  assert.equal(ok, true);
  assert.equal(method, "notifications/fmc/batch_granted");
});

test("auto-save and auto-approve are the existing settings, and a failed save goes to the tail", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-care-"));
  const guard = path.join(dir, "fmc_guard.json");
  const env = { ...process.env, FMC_GUARD_CONFIG: guard, APPDATA: dir } as NodeJS.ProcessEnv;
  fs.writeFileSync(guard, JSON.stringify({ ai_modeller: { on: true, mode: "testing", auto_approve: true, auto_save_minutes: 10 } }));
  const on = batchCareReport(env);
  assert.equal(on.approval, "auto");
  assert.equal(on.autosave_minutes, 10);
  assert.equal(on.sync, "managed");
  assert.equal(on.sync_minutes, 15);
  assert.equal(on.sync_on_batch_end, true);
  assert.match(on.sync_source, /sync_minutes/);
  assert.match(on.approval_does_not_cover.join(" "), /references/);
  fs.writeFileSync(guard, JSON.stringify({ ai_modeller: { on: true, mode: "strict", auto_approve: true, auto_save_minutes: 0 } }));
  const off = batchCareReport(env);
  assert.equal(off.approval, "manual");
  assert.equal(off.autosave_minutes, 0);

  const send = async () => { throw new Error("save must not run"); };
  const detached = { title: "copy", path: "D:\\Fomcraft\\Live\\A.rvt", isFamily: false, isWorkshared: false, isDetached: true, readOnly: true, isActive: true };
  assert.equal(await autoSave(detached, { mode: "testing", auto_save_minutes: 10 }, send, {}, 1_000, () => 0), false);
  const shared = { ...detached, isDetached: false, readOnly: false, isWorkshared: true, path: "C:\\WIP\\A.rvt" };
  assert.equal(await autoSave(shared, { mode: "testing", auto_save_minutes: 10 }, send, {}, 1_000, () => 0), false);

  const { board: made } = board({
    saveStep: async () => {
      assert.equal(made.status(String(heldLease)).state, "granted");
      return { ran: true, ok: false, detail: "the model didn't save itself: disk full" };
    },
  });
  const a = await req(made, "a", "Architecture", "grids");
  const heldLease = String(a.lease);
  const b = await req(made, "b", "Architecture", "walls");
  const failed = await made.releaseWithCare(heldLease, "ok", "a", "placed");
  assert.equal(failed.outcome, "failed");
  assert.match(String(failed.error), /disk full/);
  assert.equal(made.status(String(b.lease)).state, "granted");
  const again = await req(made, "a", "Architecture", "grids", { correction: "saved a copy instead", references: changedRefs(2) });
  assert.equal(again.attempt, 2);
  assert.equal(again.position, 1);
  const hist = (made.snapshot().documents as Array<{ history: Array<{ save?: { ok: boolean }; sync?: { ran: boolean } }> }>)[0].history[0];
  assert.equal(hist.save?.ok, false);
  assert.equal(hist.sync?.ran, false);
});
});
