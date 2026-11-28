import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_PAUSE_MB, MEMORY_RESUME_MB, planFree, planPurge } from "./memoryplan.js";
import { runFmcMemory } from "../tools/fmc_memory.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NEVER } from "./aiuse.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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
    action: "purge_unused", document: "E_USER", categories: ["Electrical Equipment"], dry_run: true, batch_lease: "",
  }, { status: async () => ({ free_mb: 4000, revit_working_set_mb: 800, documents: [] }) });
  assert.match(dry.content[0].text, /PerformanceAdviser/);
  assert.match(dry.content[0].text, /mb_before":4000/);
  assert.match(dry.content[0].text, /1024/);
  const plan = planPurge("E_USER", ["Doors"], true);
  assert.equal(plan.dry_run, true);
  let applied = false;
  const write = await runFmcMemory({
    action: "free", document: "", categories: [], dry_run: false, batch_lease: "",
  }, {
    status: async () => ({ free_mb: 2000, revit_working_set_mb: 900, documents: [{ title: "Door", path: "C:\\Door.rfa", family: true, modified: false }, { title: "Host", path: "C:\\Host.rvt", active: true }] }),
    apply: async () => { applied = true; return { closed: ["Door"] }; },
  });
  assert.equal(write.isError, true);
  assert.match(write.content[0].text, /FMC-BATCH-LOCKED/);
  assert.equal(applied, false);
});

test("free never closes a never-saved document as unmodified, and flags the sandbox question", () => {
  const plan = planFree([
    { title: "plumbing_USER", path: "C:\\P\\plumbing_USER.rvt", active: true, workshared: true, modified: false },
    { title: "Project1", path: "", workshared: false, active: false, modified: false },
    { title: "Door", path: "C:\\Door.rfa", family: true, modified: false },
  ]);
  assert.deepEqual(plan.close.map((doc) => doc.title), ["Door"]);
  assert.match(plan.kept.join(" "), /Project1: never saved/);
  assert.match(plan.open_question ?? "", /Emlyn/);
  const clean = planFree([{ title: "A", path: "C:\\A.rvt", active: true }, { title: "B", path: "C:\\B.rfa", family: true }]);
  assert.equal(clean.open_question, undefined);
  const csharp = fs.readFileSync(path.join(repo, "commandset", "Services", "Fmc", "FmcMemoryWork.cs"), "utf8");
  assert.match(csharp, /IsNullOrEmpty\(doc\.PathName\)\) \{ kept\.Add\(title \+ ": never saved/);
  assert.match(csharp, /if \(wanted\.Count == 0\)/);
});

test("a real free with nothing to close never calls the add-in (an empty list used to mean every document)", async () => {
  let applied = 0;
  const reply = await runFmcMemory({ action: "free", document: "", categories: [], dry_run: false, batch_lease: "L1" }, {
    status: async () => ({ free_mb: 2000, revit_working_set_mb: 900, documents: [{ title: "Host", path: "C:\\Host.rvt", active: true }, { title: "Project1", path: "" }] }),
    apply: async () => { applied += 1; return { closed: [] }; },
  });
  assert.equal(reply.isError, false);
  assert.equal(applied, 0);
  assert.match(reply.content[0].text, /add-in was not called/);
});

test("purge_unused: categories are kept, only_categories limits, and an older add-in deletes nothing", async () => {
  const plan = planPurge("E_USER", ["Doors"], true, ["Generic Models"]);
  assert.deepEqual(plan.keep_categories, ["Doors"]);
  assert.deepEqual(plan.only_categories, ["Generic Models"]);
  const sent: Array<Record<string, unknown>> = [];
  const status = async () => ({ free_mb: 3000, revit_working_set_mb: 900, documents: [] });
  const ok = await runFmcMemory({ action: "purge_unused", document: "E_USER", categories: ["Doors"], only_categories: [], dry_run: false, batch_lease: "L1" }, {
    status, apply: async (body) => { sent.push(body); return { purged: 3, candidates: 3, rules: 2, saved: false }; },
  });
  assert.equal(ok.isError, false);
  assert.equal(sent[0].action, "purge_unused_v2");
  assert.deepEqual(sent[0].keep_categories, ["Doors"]);
  assert.equal("categories" in sent[0], false);
  const old = await runFmcMemory({ action: "purge_unused", document: "E_USER", categories: ["Doors"], dry_run: false, batch_lease: "L1" }, {
    status, apply: async () => ({ free_mb: 3000, documents: [] }),
  });
  assert.equal(old.isError, true);
  assert.match(old.content[0].text, /FMC-MEMORY-ADDIN/);
  const csharp = fs.readFileSync(path.join(repo, "commandset", "Services", "Fmc", "FmcMemoryWork.cs"), "utf8");
  assert.match(csharp, /action == "purge_unused_v2"/);
  assert.match(csharp, /if \(keep\.Contains\(category\)\) continue;/);
});

test("fmc_memory_apply is in the purge group of the AI gate", () => {
  assert.equal(NEVER.fmc_memory_apply, "purging (deleting)");
  assert.equal(NEVER.fmc_memory_apply, NEVER.fmc_material_purge);
});
