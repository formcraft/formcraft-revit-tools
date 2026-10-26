import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { Actor, ProjectBook, Roles, applyEdit, checklist, findInBook, newBook, parseBook, progressOf, summary } from "./projectbook.js";
import { bookPaths, loadBook, projectFolderFrom, qaFailing, saveBook } from "./projectbook_io.js";

// The roles proposal (docs/kit-proposals/FMC_Roles.json) is the fixture: the pilot Modeller design-stage checklist.
const here = path.dirname(fileURLToPath(import.meta.url));
const roles: Roles = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "..", "docs", "kit-proposals", "FMC_Roles.json"), "utf8"));
const person = (name: string): Actor => ({ name, kind: "person" });
const agent: Actor = { name: "AI for ama", kind: "agent" };
const fresh = () => newBook({ project: "OGL", stage: "design" }, "D:\\P\\01_WIP\\FMC_Project.json", "ama", new Date("2026-10-26T09:00:00Z"));
function run(b: ProjectBook, edits: Array<[Parameters<typeof applyEdit>[1], Actor]>): ProjectBook {
  for (const [e, a] of edits) { const r = applyEdit(b, e, a, roles); assert.ok(r.ok, `${e.action}: ${r.reason}`); b = r.book; }
  return b;
}

test("a new book is empty and parses back; anything else is refused", () => {
  const b = fresh();
  assert.equal(parseBook(JSON.stringify(b)).book?.project, "OGL");
  assert.match(parseBook('{"schema":"x"}').problem ?? "", /Not a project book/);
  assert.match(parseBook("{").problem ?? "", /Not JSON/);
});

test("people own roles, decisions and reviews; an agent adds notes, ideas, progress, threads and proposals", () => {
  let b = run(fresh(), [[{ action: "set_member", name: "ama", kind: "person", role: "BIM Coordinator" }, person("boss")]]);
  for (const e of [{ action: "set_member", name: "x", kind: "person", role: "Modeller" }, { action: "decide", text: "Brick facade" },
    { action: "set_stage", stage: "construction" }, { action: "review", role: "Modeller", stage: "design", item: "MOD-D-07", approve: true }] as const) {
    const r = applyEdit(b, e as Parameters<typeof applyEdit>[1], agent, roles);
    assert.equal(r.ok, false, e.action);
    assert.match(r.reason ?? "", /Only a person can/, e.action);
  }
  b = run(b, [[{ action: "idea", text: "Use the kit's brick for the facade" }, agent], [{ action: "propose", text: "Brick facade" }, agent]]);
  assert.equal(b.decisions.D1.status, "proposed");
  b = run(b, [[{ action: "decide", id: "D1" }, person("ama")]]);
  assert.equal(b.decisions.D1.status, "decided");
  assert.equal(b.decisions.D1.decided_by, "ama");
});

test("an agent assists a person on the team and never takes a role ranked above theirs", () => {
  const b = run(fresh(), [[{ action: "set_member", name: "ama", kind: "person", role: "QS" }, person("boss")]]);
  const above = applyEdit(b, { action: "set_member", name: "AI-1", kind: "agent", role: "BIM Manager", assists: "ama" }, person("boss"), roles);
  assert.match(above.reason ?? "", /ranks above ama's role/);
  const alone = applyEdit(b, { action: "set_member", name: "AI-1", kind: "agent", role: "Modeller" }, person("boss"), roles);
  assert.match(alone.reason ?? "", /assists a person/);
  const ok = run(b, [[{ action: "set_member", name: "AI-1", kind: "agent", role: "Modeller", assists: "ama" }, person("boss")]]);
  assert.equal(ok.team["AI-1"].role, "Modeller");
  const gone = run(ok, [[{ action: "remove_member", name: "ama" }, person("boss")]]);
  assert.equal(gone.team["AI-1"], undefined, "a person's agents leave with them");
  assert.match(applyEdit(b, { action: "set_member", name: "x", kind: "person", role: "Wizard" }, person("boss"), roles).reason ?? "", /isn't a role in the kit/);
});

test("checklist: script-checked items pass or fail from the latest QA run, the rest need a person's tick", () => {
  const types: Record<string, string> = { "NAM-001": "naming_regex", "NAM-002": "naming_regex", "NAM-007": "value_in_list", "NAM-021": "naming_regex",
    "NAM-023": "naming_regex", "NAM-037": "count_min", "QA-003": "count_min", "QA-010": "count_min", "QA-002": "count_min",
    "QA-006": "count_min", "QA-007": "count_min", "QA-005": "count_min", "QA-017": "human_gate" };
  const b = fresh();
  const before = checklist(b, roles, "Modeller", "design", types, null);
  assert.equal(before.length, 8);
  assert.equal(before.find((l) => l.id === "MOD-D-04")?.state, "Run QA");
  const lines = checklist(b, roles, "Modeller", "design", types, ["QA-002"]);
  assert.equal(lines.find((l) => l.id === "MOD-D-04")?.state, "Fail");
  assert.equal(lines.find((l) => l.id === "MOD-D-01")?.state, "Pass");
  assert.equal(lines.find((l) => l.id === "MOD-D-07")?.kind, "person", "no rules: a person's judgement");
  assert.equal(lines.find((l) => l.id === "MOD-D-08")?.kind, "person", "human_gate: a person's tick");
  assert.deepEqual(progressOf(lines), { done: 5, total: 8, waiting_review: 0 });
});

test("tick, submit, review: agents' ticks need a person; nobody reviews their own; approved items stay approved", () => {
  let b = run(fresh(), [[{ action: "tick", role: "Modeller", stage: "design", item: "MOD-D-07", evidence: "Areas match brief v3" }, agent]]);
  assert.match(applyEdit(b, { action: "tick", role: "Modeller", stage: "design", item: "NOPE" }, agent, roles).reason ?? "", /isn't on the Modeller design checklist/);
  b = run(b, [[{ action: "submit", role: "Modeller", stage: "design" }, agent]]);
  assert.equal(b.ticks["Modeller|design|MOD-D-07"].state, "submitted");
  assert.match(applyEdit(b, { action: "tick", role: "Modeller", stage: "design", item: "MOD-D-07" }, agent, roles).reason ?? "", /changes only through review/);
  b = run(b, [[{ action: "tick", role: "Modeller", stage: "design", item: "MOD-D-08" }, person("ama")], [{ action: "submit", role: "Modeller", stage: "design" }, person("ama")]]);
  assert.match(applyEdit(b, { action: "review", role: "Modeller", stage: "design", item: "MOD-D-08", approve: true }, person("ama"), roles).reason ?? "", /own tick/);
  b = run(b, [[{ action: "review", role: "Modeller", stage: "design", item: "MOD-D-07", approve: true, comment: "ok" }, person("ama")],
    [{ action: "review", role: "Modeller", stage: "design", item: "MOD-D-08", approve: false, comment: "photos missing" }, person("boss")]]);
  assert.equal(b.ticks["Modeller|design|MOD-D-07"].state, "approved");
  assert.equal(b.ticks["Modeller|design|MOD-D-08"].state, "returned");
  assert.equal(summary(b).waiting_review, 0);
});

test("threads keep each task apart and end with the task report; lookups by id or words", () => {
  let b = run(fresh(), [[{ action: "thread_start", title: "First floor walls" }, agent]]);
  b = run(b, [[{ action: "progress", text: "Batch 1 of 3 approved", thread: "T1" }, agent], [{ action: "thread_end", id: "T1", report: "Done; slow step: type lookup" }, agent]]);
  assert.match(applyEdit(b, { action: "note", text: "x", thread: "T9" }, agent, roles).reason ?? "", /No thread T9/);
  assert.match(applyEdit(b, { action: "thread_end", id: "T1", report: "again" }, agent, roles).reason ?? "", /already ended/);
  assert.equal(findInBook(b, "N1")[0].text, "Batch 1 of 3 approved");
  assert.equal(findInBook(b, "first floor")[0].key, "T1");
  assert.deepEqual(summary(b).open_threads, []);
});

test("saved beside the manifest in 01_WIP, atomically, with a journal line; refused outside the write roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-book-"));
  const folder = path.join(root, "OGL Residence");
  const cfg: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [path.join(root, "*", "01_WIP")] };
  const b = run(fresh(), [[{ action: "note", text: "kick-off" }, person("ama")]]);
  assert.ok(saveBook(cfg, folder, b, { action: "note" }).ok);
  assert.equal(loadBook(folder).book?.notes.N1.text, "kick-off");
  assert.equal(fs.readFileSync(bookPaths(folder).journal, "utf8").trim().split("\n").length, 1);
  assert.equal(fs.existsSync(bookPaths(folder).book + ".tmp"), false, "no temp file left");
  assert.equal(saveBook({ ...DEFAULT_CONFIG, write_roots: [] }, folder, b, undefined).ok, false);
  assert.equal(projectFolderFrom(path.join(folder, "01_WIP", "A", "x.rvt")), folder);
  assert.equal(projectFolderFrom("C:\\Temp\\x.rvt"), "");
  assert.deepEqual(qaFailing({ ...cfg, reports_dir: root }, "x"), { failing: null }, "no QA history yet");
});
