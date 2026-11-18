import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RevitInstance, portRefusal, resolvePort } from "./connect.js";
import { describeInstance } from "./httpservice.js";
import { ageWords, inFlightJob, ownChunkJob, setModalDialogReader } from "./notidle.js";
import type { Recipe } from "./recipes.js";

const one = (port: number, pid = 12296): RevitInstance => ({
  pid, port, revit: "2025", user: "USER", started: "2026-11-18T16:00:00Z", updated: "2026-11-18T16:00:00Z", build: "ed5e130",
  documents: [{ title: "Model", path: "C:\\Model.rvt", active: true, family: false, workshared: true }],
});

function home(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-idle-"));
  fs.mkdirSync(path.join(dir, "Formcraft", "instances"), { recursive: true });
  return { dir, env: { APPDATA: dir, REVIT_PORT: "" } as NodeJS.ProcessEnv };
}

test("a heartbeating job is not a stale listener, and a dead port with no job still says to toggle AI", () => {
  const now = Date.now();
  const started = new Date(now - 6 * 60 * 1000).toISOString();
  const lines = [
    { at: started, job: "fmc_doc_35f7ff63", command: "fmc_doc_apply", pid: 12296, event: "queued", started },
    { at: new Date(now - 20_000).toISOString(), job: "fmc_doc_35f7ff63", command: "fmc_doc_apply", pid: 12296, event: "heartbeat", started },
    { at: new Date(now - 60_000).toISOString(), job: "old", command: "fmc_doc_apply", pid: 12296, event: "finished", started: new Date(now - 120_000).toISOString() },
    { at: new Date(now).toISOString(), job: "other", command: "x", pid: 9, event: "heartbeat" },
  ];
  const flight = inFlightJob(lines, 12296, now)!;
  assert.equal(flight.job, "fmc_doc_35f7ff63");
  assert.equal(flight.command, "fmc_doc_apply");
  assert.equal(flight.age_s, 6 * 60);
  assert.equal(ageWords(6 * 60), "6 min");
  assert.equal(inFlightJob([{ at: new Date(now).toISOString(), job: "done", pid: 12296, event: "finished", started: new Date(now - 60000).toISOString() }], 12296, now), null);

  const { dir, env } = home();
  fs.writeFileSync(path.join(dir, "Formcraft", "FMC_Jobs_Revit.jsonl"), lines.filter((row) => row.pid === 12296).map((row) => JSON.stringify(row)).join("\n") + "\n");
  setModalDialogReader(() => "Family Types");
  try {
    const forgotten: number[] = [];
    assert.throws(
      () => resolvePort(undefined, [one(8080)], env, undefined, { probe: () => "reset", forget: (instance) => forgotten.push(instance.pid) }),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /\[FMC-REVIT-NOT-IDLE\]/);
        assert.match(message, /fmc_doc_35f7ff63/);
        assert.match(message, /fmc_doc_apply/);
        assert.match(message, /6 min/);
        assert.match(message, /Family Types/);
        assert.match(message, /do not toggle AI or kill anything/);
        assert.doesNotMatch(message, /turn AI off and on/);
        return true;
      },
    );
    assert.deepEqual(forgotten, []);
    const quiet = portRefusal(8080, "refused", one(8080), { APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "fmc-idle-empty-")) } as NodeJS.ProcessEnv);
    assert.equal(quiet.notIdle, false);
    assert.match(quiet.message, /turn AI off and on/);
    assert.match(quiet.message, /ECONNRESET|nothing is accepting/);
  } finally {
    setModalDialogReader(null);
  }
});

test("health names a waiting Revit instead of calling the port dead", () => {
  const pid = 4242;
  const now = Date.now();
  const started = new Date(now - 40 * 60 * 1000).toISOString();
  const lines = [
    { at: new Date(now).toISOString(), job: "fmc_doc_35f7ff63", command: "fmc_doc_apply", pid, event: "heartbeat", started },
    { at: new Date(now).toISOString(), job: "fmc_doc_35f7ff63", command: "fmc_doc_apply", pid, event: "dialog", message: "Save changes to Project1?" },
  ];
  const row = describeInstance(one(8080, pid), "reset", lines, now, "Save changes to Project1?");
  assert.equal(row.verdict, "waiting_for_idle");
  assert.equal(row.answering, false);
  assert.equal(row.busy?.job, "fmc_doc_35f7ff63");
  assert.equal(row.busy?.command, "fmc_doc_apply");
  assert.equal(row.busy?.since_s, 40 * 60);
  assert.equal(row.busy?.dialog, "Save changes to Project1?");
  const quiet = describeInstance(one(8080, pid), "refused", [], now, "");
  assert.equal(quiet.verdict, "refused");
  assert.equal(quiet.busy, null);
});

test("a recipe chunk that is still the build's own job is followed, and the template stays open", async () => {
  const { buildRecipe } = await import("../tools/fmc_recipe_build.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-chunk-"));
  const recipe = {
    schema: "fmc-recipe/0.1", family: "FMC_Test_Chunk", template: "Metric Generic Model.rft",
    ops: [{ op: "set_category", name: "OST_GenericModel" }],
  } as Recipe;
  const base = {
    recipeFile: "r.json", template: recipe.template, target: path.join(dir, "out.rfa"), overwrite: false,
    chunkSize: 20, reportsDir: dir, sharedParameterFile: "", notes: [] as string[], sources: {}, stepwise: true, dry: true,
  };
  const held = "[FMC-JOB-RUNNING] fmc_doc_apply is still running in Revit after 50 s (not failed). Job abc12345.";
  assert.equal(ownChunkJob(held), "abc12345");
  assert.equal(ownChunkJob("[FMC-BRIDGE-BUSY] Revit is still running fmc_doc_apply since 2026-11-18 16:27:55 (job abc12345)"), "abc12345");
  assert.equal(ownChunkJob("op 1 failed, nothing was changed"), null);

  const waiting: string[] = [];
  const waitDoc = async (args: Record<string, unknown>) => {
    waiting.push(String(args.action));
    if (args.action === "open") return { ok: true, session: "s1" };
    if (args.action === "apply") return { ok: false, error: held };
    if (args.action === "close") return { ok: true, closed: true };
    return { ok: true };
  };
  const waited = await buildRecipe(recipe, { ...base, resume: false }, {
    doc: waitDoc, gate: async () => ({ verdict: "Pass", lines: [] }), maxWaitMs: 1000,
    followChunk: async () => "waiting",
  });
  assert.equal(waited.body.state, "running in Revit");
  assert.equal(waited.body.failed, undefined);
  assert.deepEqual(waiting, ["open", "apply"]);

  const doneCalls: string[] = [];
  const done = await buildRecipe(recipe, { ...base, resume: false, reportsDir: path.join(dir, "done") }, {
    doc: async (args) => {
      doneCalls.push(String(args.action));
      if (args.action === "open") return { ok: true, session: "s1" };
      if (args.action === "apply") return { ok: false, error: "[FMC-BRIDGE-BUSY] Revit is still running fmc_doc_apply since 2026-11-18 16:27:55 (job abc12345): waited 300 s" };
      if (args.action === "close") return { ok: true, closed: true };
      return { ok: true };
    },
    gate: async () => ({ verdict: "Pass", lines: [] }),
    followChunk: async () => "done",
  });
  assert.equal(done.body.dry_run, true, JSON.stringify(done.body));
  assert.equal(done.body.failed, undefined);
  assert.deepEqual(doneCalls, ["open", "apply", "close"]);

  const failedCalls: string[] = [];
  const failed = await buildRecipe(recipe, { ...base, resume: false, reportsDir: path.join(dir, "fail") }, {
    doc: async (args) => {
      failedCalls.push(String(args.action));
      if (args.action === "open") return { ok: true, session: "s1" };
      if (args.action === "apply") return { ok: false, error: "fmc_doc_apply: op 1 failed, nothing was changed: nope" };
      if (args.action === "close") return { ok: true, closed: true };
      if (args.action === "background") return { ok: true, sessions: [], other_background: [] };
      return { ok: true };
    },
    gate: async () => ({ verdict: "Pass", lines: [] }),
    followChunk: async () => "done",
  });
  assert.equal(failed.body.failed, true);
  assert.ok(failedCalls.includes("close"));
});
