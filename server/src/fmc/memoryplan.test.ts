import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_PAUSE_MB, MEMORY_RESUME_MB, planFree, planPurge } from "./memoryplan.js";
import { runFmcMemory } from "../tools/fmc_memory.js";

test("the gate thresholds stay 1024 and 1536", () => {
  assert.equal(MEMORY_PAUSE_MB, 1024);
  assert.equal(MEMORY_RESUME_MB, 1536);
});

test("free closes unmodified families and spare projects, and keeps the last document", () => {
  const plan = planFree([
    { title: "Host", path: "C:\\Host.rvt", active: true, modified: false, workshared: true },
    { title: "Door", path: "C:\\Door.rfa", family: true, modified: false },
    { title: "Dirty", path: "C:\\Dirty.rfa", family: true, modified: true },
    { title: "Sketch", path: "C:\\Sketch.rvt", workshared: false, active: false, modified: false },
    { title: "Local", path: "C:\\Local.rvt", workshared: true, active: false, modified: false },
  ]);
  assert.deepEqual(plan.close.map((doc) => doc.title), ["Door", "Sketch"]);
  assert.match(plan.kept.join(" "), /Dirty/);
  assert.match(plan.kept.join(" "), /workshared/);
  assert.match(plan.api_limits.join(" "), /undo stack/);
  const only = planFree([{ title: "Only", path: "C:\\Only.rfa", family: true, modified: false, active: false }]);
  assert.equal(only.close.length, 0);
});

test("purge_unused is a dry run until a lease is passed, and names the adviser", async () => {
  const dry = await runFmcMemory({
    action: "purge_unused", document: "E_USER", categories: ["Electrical Equipment"], only_categories: [], dry_run: true, batch_lease: "",
  }, { status: async () => ({ free_mb: 4000, revit_working_set_mb: 800, documents: [] }) });
  assert.match(dry.content[0].text, /PerformanceAdviser/);
  assert.match(dry.content[0].text, /mb_before":4000/);
  assert.match(dry.content[0].text, /1024/);
  const plan = planPurge("E_USER", ["Doors"], true);
  assert.equal(plan.dry_run, true);
  let applied = false;
  const write = await runFmcMemory({
    action: "free", document: "", categories: [], only_categories: [], dry_run: false, batch_lease: "",
  }, {
    status: async () => ({ free_mb: 2000, revit_working_set_mb: 900, documents: [{ title: "Door", path: "C:\\Door.rfa", family: true, modified: false }, { title: "Host", path: "C:\\Host.rvt", active: true }] }),
    apply: async () => { applied = true; return { closed: ["Door"] }; },
  });
  assert.equal(write.isError, true);
  assert.match(write.content[0].text, /FMC-BATCH-LOCKED/);
  assert.equal(applied, false);
});

test("research 58: only_categories with the categories alias, free skipped when empty, status for one document", async () => {
  const { onlyCategories, statusDocuments } = await import("../tools/fmc_memory.js");
  assert.deepEqual(onlyCategories({ only_categories: ["Doors"], categories: ["Walls"] }), ["Doors"]);
  assert.deepEqual(onlyCategories({ only_categories: [], categories: ["Walls"] }), ["Walls"]);
  const docs = [{ title: "plumbing_USER", path: "D:\\W\\plumbing_USER.rvt", active: true, workshared: true }, { title: "electrical_USER", path: "D:\\W\\electrical_USER.rvt", workshared: true }];
  assert.deepEqual(statusDocuments(docs, "electrical_user").map((d) => d.title), ["electrical_USER"]);
  const status = JSON.parse((await runFmcMemory({ action: "status", document: "electrical_USER", categories: [], only_categories: [], dry_run: true, batch_lease: "" }, { status: async () => ({ free_mb: 2816, revit_working_set_mb: 1035, documents: docs }) })).content[0].text);
  assert.equal(status.found, true);
  assert.equal(status.documents.length, 1);
  assert.equal(status.open_documents, 2);
  const dry = JSON.parse((await runFmcMemory({ action: "purge_unused", document: "E_USER", categories: ["Walls"], only_categories: ["Doors"], dry_run: true, batch_lease: "" }, {
    status: async () => ({ free_mb: 4000, revit_working_set_mb: 800, documents: [] }),
  })).content[0].text);
  assert.deepEqual(dry.only_categories, ["Doors"]);
  let applied = false;
  const free = JSON.parse((await runFmcMemory({ action: "free", document: "", categories: [], only_categories: [], dry_run: false, batch_lease: "lease-1" }, {
    status: async () => ({ free_mb: 2000, revit_working_set_mb: 900, documents: docs }),
    apply: async () => { applied = true; return {}; },
  })).content[0].text);
  assert.equal(free.skipped, true);
  assert.equal(applied, false);
});
