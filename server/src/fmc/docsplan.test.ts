import { test } from "node:test";
import assert from "node:assert/strict";
import { localPathFor, planClose, planOpen } from "./docsplan.js";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import { runFmcDocs } from "../tools/fmc_docs.js";

const guard = { ...DEFAULT_CONFIG, protected_roots: ["D:\\Live"], save_exclude: ["SECRET"] } as GuardConfig;

test("a workshared central opens as a new local in Documents, and detach does not", () => {
  const plan = planOpen({ path: "D:\\Models\\F26901-FMC-ZZ-ZZ-M3-E-0001.rvt", workshared: true, central: true, documents: "C:\\Users\\USER\\Documents" });
  assert.equal(plan.as_local, true);
  assert.equal(plan.local_path, localPathFor("D:\\Models\\F26901-FMC-ZZ-ZZ-M3-E-0001.rvt", "C:\\Users\\USER\\Documents"));
  assert.match(plan.local_path, /E-0001_USER\.rvt$/);
  assert.equal(plan.worksets, "all");
  const detached = planOpen({ path: "D:\\Models\\Central.rvt", workshared: true, central: true, detach: true, worksets: "last" });
  assert.equal(detached.as_local, false);
  assert.equal(detached.detach, true);
  assert.equal(detached.worksets, "last");
});

test("close refuses a dirty document, the last document, a protected save and HEBERT HOSTELS_USER", () => {
  const open = [
    { title: "E_USER", path: "C:\\Docs\\E_USER.rvt", modified: true, workshared: false, active: true },
    { title: "Family", path: "C:\\Fam.rfa", family: true, modified: false },
  ];
  const dirty = planClose({ document: "E_USER", save: false, open, guard });
  assert.equal(dirty.ok, false);
  assert.match(dirty.reasons.join(" "), /modified/);
  const last = planClose({ document: "Only", save: false, open: [{ title: "Only", path: "C:\\Only.rvt", modified: false }], guard });
  assert.match(last.reasons.join(" "), /last open document/);
  const hostel = planClose({
    document: "HEBERT HOSTELS_USER", save: true,
    open: [
      { title: "HEBERT HOSTELS_USER", path: "C:\\Docs\\HEBERT HOSTELS_USER.rvt", modified: true },
      { title: "Other", path: "C:\\Other.rvt", modified: false },
    ],
    guard,
  });
  assert.match(hostel.reasons.join(" "), /HEBERT HOSTELS_USER is never saved/);
  const protectedPath = planClose({
    document: "Live", save: true,
    open: [
      { title: "Live", path: "D:\\Live\\Model.rvt", modified: true, workshared: false },
      { title: "Other", path: "C:\\Other.rvt" },
    ],
    guard,
  });
  assert.match(protectedPath.reasons.join(" "), /protected|Excluded by save_exclude|Under a protected/);
  const clean = planClose({
    document: "Family", save: false,
    open: [
      { title: "Family", path: "C:\\Fam.rfa", family: true, modified: false },
      { title: "E_USER", path: "C:\\Docs\\E_USER.rvt", modified: false, active: true },
    ],
    guard,
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.save, false);
});

test("a real close needs a batch lease, and a dry run does not open anything", async () => {
  let applied = false;
  const dry = await runFmcDocs({
    action: "open", path: "D:\\Models\\Central.rvt", as_local: true, detach: false, worksets: "all",
    workshared: true, central: true, save: false, dry_run: true, batch_lease: "", document: "",
  }, { list: async () => [], apply: async () => { applied = true; return {}; } });
  assert.equal(dry.isError, false);
  assert.match(dry.content[0].text, /as_local":true/);
  assert.equal(applied, false);
  const write = await runFmcDocs({
    action: "close", document: "Family", path: "", save: false, dry_run: false, batch_lease: "",
    as_local: true, detach: false, worksets: "all",
  }, {
    list: async () => [
      { title: "Family", path: "C:\\Fam.rfa", family: true, modified: false },
      { title: "E", path: "C:\\E.rvt", modified: false, active: true },
    ],
    apply: async () => { applied = true; return { closed: true }; },
  });
  assert.equal(write.isError, true);
  assert.match(write.content[0].text, /FMC-BATCH-LOCKED/);
  assert.equal(applied, false);
});

// ---------- research tool 37: list honours document and filters; protected names come from one place ----------
import { filterDocs, neverSaveTitle } from "./docsplan.js";

const openRows = [
  { title: "plumbing_USER", path: "C:\\Users\\USER\\Documents\\plumbing_USER.rvt", workshared: true, active: true, modified: false },
  { title: "electrical_USER", path: "C:\\Users\\USER\\Documents\\electrical_USER.rvt", workshared: true, modified: true },
  { title: "Project1", path: "", modified: true },
  { title: "Family1", path: "C:\\Fam\\Family1.rfa", family: true, modified: false },
];

test("filterDocs matches a title, full path, file name or file name without extension, case-insensitive", () => {
  assert.deepEqual(filterDocs(openRows, { document: "ELECTRICAL_USER" }).map((d) => d.title), ["electrical_USER"]);
  assert.deepEqual(filterDocs(openRows, { document: "C:\\Users\\USER\\Documents\\plumbing_USER.rvt" }).map((d) => d.title), ["plumbing_USER"]);
  assert.deepEqual(filterDocs(openRows, { document: "family1.rfa" }).map((d) => d.title), ["Family1"]);
  assert.deepEqual(filterDocs(openRows, { document: "nope" }), []);
  assert.equal(filterDocs(openRows, {}).length, 4);
});

test("filterDocs flags: family, modified, workshared", () => {
  assert.deepEqual(filterDocs(openRows, { family: true }).map((d) => d.title), ["Family1"]);
  assert.deepEqual(filterDocs(openRows, { family: false, modified: true }).map((d) => d.title), ["electrical_USER", "Project1"]);
  assert.deepEqual(filterDocs(openRows, { workshared: false }).map((d) => d.title), ["Project1", "Family1"]);
});

test("fmc_docs list with document returns only that document (live: same list for every document)", async () => {
  const io = { list: async () => openRows };
  const base = { path: "", as_local: undefined, detach: false, worksets: "all" as const, save: false, dry_run: true, batch_lease: "" };
  const one = JSON.parse((await runFmcDocs({ ...base, action: "list", document: "architectural_USER" }, io)).content[0].text);
  assert.equal(one.refused, true);
  assert.equal(one.code, "FMC-DOC-NOT-OPEN");
  assert.equal(one.total, 4);
  const hit = await runFmcDocs({ ...base, action: "list", document: "electrical_USER" }, io);
  const body = JSON.parse(hit.content[0].text);
  assert.equal(hit.isError, false);
  assert.equal(body.count, 1);
  assert.equal(body.total, 4);
  assert.equal(body.filtered, true);
  assert.equal(body.documents[0].title, "electrical_USER");
  const all = JSON.parse((await runFmcDocs({ ...base, action: "list", document: "" }, io)).content[0].text);
  assert.equal(all.count, 4);
  assert.equal(all.filtered, undefined);
  const mod = JSON.parse((await runFmcDocs({ ...base, action: "list", document: "", modified: true, family: false }, io)).content[0].text);
  assert.deepEqual(mod.documents.map((d: { title: string }) => d.title), ["electrical_USER", "Project1"]);
});

test("neverSaveTitle keeps HEBERT HOSTELS and adds the guard's never_write_titles", () => {
  assert.equal(neverSaveTitle("HEBERT HOSTELS_USER"), true);
  assert.equal(neverSaveTitle("Ogala Live_USER"), false);
  assert.equal(neverSaveTitle("Ogala Live_USER", "", { never_write_titles: ["Ogala Live"] }), true);
  const plan = planClose({ document: "Ogala Live", save: true, open: [{ title: "Ogala Live", path: "C:\\O.rvt" }, { title: "B", path: "C:\\B.rvt" }], guard: { ...DEFAULT_CONFIG, never_write_titles: ["Ogala Live"] } as never });
  assert.match(plan.reasons.join(" "), /Ogala Live is never saved \(protected name Ogala Live\)/);
});
