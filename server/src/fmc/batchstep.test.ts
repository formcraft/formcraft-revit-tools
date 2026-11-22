import { test } from "node:test";
import assert from "node:assert/strict";
import { pollBackgroundJob, pollDelayMs, prepareLibraryStep, waitWhileBusy } from "./batchstep.js";
import { validateManifest } from "./scriptlib.js";

const manifest = validateManifest({
  id: "sheets",
  entry: "Run.cs",
  runner: "csharp",
  inputs: [],
  outputs: [],
  revit_version: "2025",
  kit_version: "2.2",
  references: { kit: "kit-ref", standards: "std-ref", rulebook: "book-ref" },
  dry_run: true,
  writes_model: true,
  workshared_safe: true,
  target_doc_rules: { path_includes: "01_WIP" },
  replaces_plugin_tools: [],
  est_ai_calls_saved: 2,
});

test("a library step fills references, and preview-only is a dry run", () => {
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  const step = prepareLibraryStep({ tool: "library", id: "sheets", arguments: { level: "01" } }, manifest.manifest, { previewOnly: true });
  assert.equal(step.dry_run, true);
  assert.equal(step.mode, "preview");
  assert.equal(step.action, "run");
  assert.deepEqual(step.arguments.references, { kit: "kit-ref", standards: "std-ref", rulebook: "book-ref" });
  assert.equal(step.problems.length, 0);
});

test("apply checks revit_version, workshared_safe and target_doc_rules before it runs", () => {
  assert.equal(manifest.ok, true);
  if (!manifest.ok) return;
  const bad = prepareLibraryStep({ tool: "library", id: "sheets", arguments: {} }, manifest.manifest, {
    revitVersion: "2024",
    document: { title: "A", path: "D:\\Archive\\A.rvt", workshared: true },
  });
  assert.equal(bad.mode, "apply");
  assert.equal(bad.dry_run, false);
  assert.ok(bad.problems.some((line) => /2024/.test(line)));
  assert.ok(bad.problems.some((line) => /01_WIP/.test(line)));
  const good = prepareLibraryStep({ tool: "library", id: "sheets", arguments: {} }, manifest.manifest, {
    revitVersion: "2025.4",
    document: { title: "A", path: "D:\\Jobs\\01_WIP\\A.rvt", workshared: true },
  });
  assert.deepEqual(good.problems, []);
});

test("background polls from 5 s up to 30 s and logs result_ref", async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(pollDelayMs), [5000, 10000, 15000, 20000, 25000, 30000, 30000]);
  const waits: number[] = [];
  const lines: string[] = [];
  let n = 0;
  const row = await pollBackgroundJob({
    job_id: "sj1",
    status: () => {
      n += 1;
      return n < 3 ? { state: "queued" } : { state: "finished", result_ref: "C:\\Local\\Formcraft\\jobs\\sj1" };
    },
    sleep: async (ms) => { waits.push(ms); },
    log: (line) => lines.push(line),
  });
  assert.deepEqual(waits, [5000, 10000]);
  assert.equal(row.state, "finished");
  assert.match(lines.at(-1) ?? "", /result_ref C:\\Local\\Formcraft\\jobs\\sj1/);
});

test("a not-idle Revit is waited on, not failed, and cancel stops the wait", async () => {
  const waits: number[] = [];
  let idle = false;
  let beats = 0;
  const outcome = await waitWhileBusy({
    isIdle: () => idle,
    cancelled: () => false,
    sleep: async (ms) => { waits.push(ms); if (waits.length === 2) idle = true; },
    heartbeat: () => { beats += 1; },
  });
  assert.equal(outcome, "idle");
  assert.deepEqual(waits, [5000, 10000]);
  assert.equal(beats, 2);
  const stopped = await waitWhileBusy({
    isIdle: () => false,
    cancelled: () => true,
    sleep: async () => { throw new Error("should not sleep"); },
  });
  assert.equal(stopped, "cancelled");
});
