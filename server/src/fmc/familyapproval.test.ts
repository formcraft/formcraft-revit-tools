/**
 * F134: the family_overwrite gate (FINAL APPROVED 2026-11-28, FG-T01–T21). Offline: an in-memory file system with
 * Windows paths, a mock recipe builder, no Revit, no MCP endpoint, no real kit or project path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSharedParameters } from "./specs.js";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import { APPROVAL_TTL_MS, readApprovals, recipePlan, requireFamilyApproval, protectedRootVerdict, type FsLike } from "./familyapproval.js";
import { setStatus, paneFamilyApproval } from "./familyapproval_pane.js";
import { forbiddenProject, mentions } from "./forbidden.js";
import { runFmcGenerateBind, FMC_GENERATE_BIND_SHAPE, type FmcGenerateBindArgs } from "../tools/fmc_generate_bind.js";
import { runFmcRecipe, familyTargetVerdict, FMC_RECIPE_SHAPE, PROVISIONAL_NOTE, type RecipeIo } from "../tools/fmc_recipe.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const win = path.win32;

// ---- an in-memory file system with Windows paths ------------------------------------------------------------------

class MemFs implements FsLike {
  files = new Map<string, { name: string; data: Buffer; mtime: number }>();
  dirs = new Map<string, string>();
  clock = 1_000;
  k(p: string) { return win.normalize(p).replace(/\\+$/, "").toLowerCase(); }
  err(code: string, p: string) { return Object.assign(new Error(`${code}: ${p}`), { code }); }
  constructor() { this.dirs.set("c:", "C:"); }
  existsSync(p: string) { const k = this.k(p); return this.files.has(k) || this.dirs.has(k); }
  readFileSync(p: string) { const f = this.files.get(this.k(p)); if (!f) throw this.err("ENOENT", p); return Buffer.from(f.data); }
  writeFileSync(p: string, d: string | Buffer) {
    if (!this.dirs.has(this.k(win.dirname(p)))) throw this.err("ENOENT", p);
    if (this.dirs.has(this.k(p))) throw this.err("EISDIR", p);
    this.files.set(this.k(p), { name: win.normalize(p), data: Buffer.from(d), mtime: ++this.clock });
  }
  statSync(p: string) {
    const f = this.files.get(this.k(p));
    if (f) return { size: f.data.length, mtimeMs: f.mtime, isDirectory: () => false };
    if (this.dirs.has(this.k(p))) return { size: 0, mtimeMs: 0, isDirectory: () => true };
    throw this.err("ENOENT", p);
  }
  readdirSync(p: string) {
    const k = this.k(p);
    if (!this.dirs.has(k)) throw this.err("ENOENT", p);
    const out: string[] = [];
    for (const [key, f] of this.files) if (this.k(win.dirname(key)) === k) out.push(win.basename(f.name));
    for (const [key, name] of this.dirs) if (key !== k && this.k(win.dirname(key)) === k) out.push(win.basename(name));
    return out;
  }
  mkdirSync(p: string) {
    const parts = win.normalize(p).replace(/\\+$/, "").split("\\");
    let cur = parts[0];
    for (const part of parts.slice(1)) {
      cur = cur + "\\" + part;
      if (this.files.has(this.k(cur))) throw this.err("EEXIST", cur);
      if (!this.dirs.has(this.k(cur))) this.dirs.set(this.k(cur), cur);
    }
    return undefined;
  }
  copyFileSync(a: string, b: string) { this.writeFileSync(b, this.readFileSync(a)); }
  renameSync(a: string, b: string) {
    const f = this.files.get(this.k(a)); if (!f) throw this.err("ENOENT", a);
    if (!this.dirs.has(this.k(win.dirname(b)))) throw this.err("ENOENT", b);
    this.files.delete(this.k(a)); this.files.set(this.k(b), { ...f, name: win.normalize(b) });
  }
  unlinkSync(p: string) { if (!this.files.delete(this.k(p))) throw this.err("ENOENT", p); }
  put(p: string, d: string | Buffer) { this.mkdirSync(win.dirname(p)); this.writeFileSync(p, d); }
  under(dir: string) { const k = this.k(dir) + "\\"; return [...this.files.keys()].filter((f) => f.startsWith(k)); }
}

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

// ---- the kit's eleven (as in generatebind.test.ts) ----------------------------------------------------------------

const KIT_ROWS: Array<[string, string, string, number]> = [
  ["FMC_Frame_Spec", "7a163363-b62c-57f9-8d75-66d6b9aad4c6", "TEXT", 25], ["FMC_Glazing_Spec", "0dbd1462-d156-50f3-9038-a0ed6baa5880", "TEXT", 25],
  ["FMC_Ironmongery_Set", "1f71895f-a957-5735-b684-00aa31d91721", "TEXT", 25], ["FMC_Finish_Primary", "75a7af00-35cb-5c87-94cd-5571ba88ee94", "TEXT", 6],
  ["FMC_Fire_Resistance_Min", "2f80614a-7f11-5b2a-91a6-a8431863183e", "INTEGER", 6], ["FMC_Acoustic_Rating_Rw", "171b8d36-974e-58af-bc1f-5285962d6598", "INTEGER", 6],
  ["FMC_Vent_Type", "cfd77ccf-d77d-53e0-b769-10b62e8aa1d5", "TEXT", 6], ["FMC_Fanlight_Height_mm", "425ed7f1-679a-5ee8-98dc-4fad02fde0ed", "INTEGER", 6],
  ["FMC_Mosquito_Mesh", "5ec6628e-e5ce-55d7-a8c1-d1737876b897", "YESNO", 6], ["FMC_Glazed_Area_m2", "c3c61f30-7abb-515e-9902-4cf9a3b72200", "AREA", 6],
  ["FMC_Openable_Area_m2", "6919d4a2-ffd3-5f03-bbd5-4715a375a99d", "AREA", 6],
];
const KIT = parseSharedParameters([
  "# This is a Revit shared parameter file.", "*META\tVERSION\tMINVERSION", "META\t2\t1",
  "*GROUP\tID\tNAME", "GROUP\t6\tFMC_06_Architecture_Interiors", "GROUP\t25\tFMC_25_Doors_Windows",
  "*PARAM\tGUID\tNAME\tDATATYPE\tDATACATEGORY\tGROUP\tVISIBLE\tDESCRIPTION\tUSERMODIFIABLE\tHIDEWHENNOVALUE",
  ...KIT_ROWS.map(([n, g, t, grp]) => `PARAM\t${g}\t${n}\t${t}\t\t${grp}\t1\t\t1\t0`), "",
].join("\n"));

// ---- a temp-like tree (never a real kit or project path) -----------------------------------------------------------

const ROOT = "C:\\FG-Test\\Fomcraft";
const STAGING = `${ROOT}\\FMC_PROJECTS_27\\Proj\\01_WIP\\Staging`;
const REPORTS = `${ROOT}\\reports`;
const STORE = "C:\\FG-Test\\state\\approvals\\family_overwrite.json";
const FAMILY = "FMC_A_Door_Legend_hinged_left";
const TARGET = `${STAGING}\\A\\${FAMILY}.rfa`;

type Mode = "production" | "testing" | "testing-no-auto" | "production-auto";
function guard(mode: Mode = "production", over: Partial<GuardConfig> = {}): GuardConfig {
  const ai = mode === "testing" ? { on: true, mode: "testing", auto_approve: true }
    : mode === "testing-no-auto" ? { on: true, mode: "testing", auto_approve: false }
    : mode === "production-auto" ? { on: true, mode: "strict", auto_approve: true } : { on: true, mode: "strict" };
  return { ...DEFAULT_CONFIG, write_roots: [`${ROOT}\\FMC_PROJECTS_27`], family_staging_root: STAGING, shared_parameter_file: "C:\\FG-Test\\kit.txt",
    reports_dir: REPORTS, family_template_dir: "C:\\FG-Test\\templates", protected_roots: [], ai_modeller: ai, ...over } as GuardConfig;
}

interface World { mem: MemFs; builds: string[]; clock: { t: number }; io: RecipeIo }
function world(mode: Mode = "production", over: Partial<GuardConfig> = {}): World {
  const mem = new MemFs();
  const builds: string[] = [];
  const clock = { t: Date.parse("2026-11-28T09:30:00Z") };
  const io: RecipeIo = {
    guard: guard(mode, over), fs: mem, dictionary: KIT, log: () => {},
    approvals: { store: STORE, now: () => new Date(clock.t), caller: "test" },
    build: (async (recipe: { family: string }, o: { target: string; dry: boolean }) => {
      builds.push(recipe.family);
      if (!o.dry) mem.put(o.target, `NEW ${recipe.family} ${builds.length}`);
      return { body: { built: o.target, gate: { verdict: "Pass" } }, isError: false };
    }) as unknown as RecipeIo["build"],
  };
  return { mem, builds, clock, io };
}
/** Seed an already-staged family: the .rfa, a .0001 backup, its .recipe.json and .gate.json, with known bytes. */
function seed(w: World, target = TARGET) {
  const files = { rfa: target, backup: target.replace(/\.rfa$/, ".0001.rfa"), recipe: target.replace(/\.rfa$/, ".recipe.json"), gate: target.replace(/\.rfa$/, ".gate.json") };
  for (const [k, f] of Object.entries(files)) w.mem.put(f, `OLD ${k} of ${win.basename(target)}`);
  return files;
}
const snapshot = (w: World, files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([k, f]) => [k, w.mem.existsSync(f) ? sha(w.mem.readFileSync(f)) : null]));
const archiveDir = (target = TARGET) => win.join(win.dirname(target), "_Archive");

const gbArgs = (over: Partial<FmcGenerateBindArgs> = {}): FmcGenerateBindArgs => z.object(FMC_GENERATE_BIND_SHAPE).parse({
  kind: "door", operation: "hinged_left", types: [{ width_mm: 900, height_mm: 2100 }], ...over }) as FmcGenerateBindArgs;
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
async function gb(w: World, over: Partial<FmcGenerateBindArgs> = {}) {
  const io = { guard: w.io.guard, dictionary: KIT, exists: (f: string) => w.mem.existsSync(f), log: () => {}, kitStamp: () => "kit-1", recipe: w.io };
  const dry = body(await runFmcGenerateBind(gbArgs({ ...over, dry_run: true }), io));
  const r = await runFmcGenerateBind(gbArgs({ confirm: true, plan_id: dry.plan_id, ...over, dry_run: false }), io);
  return { dry, r, b: body(r) };
}

// ---- first builds -------------------------------------------------------------------------------------------------

test("FG-T01: a first build needs only the dry run, confirm and plan_id: one build, no approval, no _Archive (overwrite true is a no-op)", async () => {
  for (const overwrite of [false, true]) {
    const w = world();
    const { r, b } = await gb(w, { overwrite });
    assert.equal(r.isError, false, JSON.stringify(b));
    assert.equal(b.saved, true);
    assert.equal(b.waiting_for_approval, undefined);
    assert.deepEqual(w.builds, [FAMILY]);
    assert.equal(w.mem.existsSync(archiveDir()), false);
    assert.deepEqual(readApprovals({ fs: w.mem, store: STORE }), []);
  }
});

test("FG-T02: no confirm, no plan_id or another plan's plan_id is FMC-GB-DRY-RUN-FIRST: nothing built or written", async () => {
  const w = world();
  const io = { guard: w.io.guard, dictionary: KIT, exists: (f: string) => w.mem.existsSync(f), log: () => {}, kitStamp: () => "kit-1", recipe: w.io };
  const dry = body(await runFmcGenerateBind(gbArgs(), io));
  const other = body(await runFmcGenerateBind(gbArgs({ frame_depth_mm: 120 }), io));
  for (const a of [{ confirm: false, plan_id: dry.plan_id }, { confirm: true, plan_id: "" }, { confirm: true, plan_id: other.plan_id }]) {
    const b = body(await runFmcGenerateBind(gbArgs({ dry_run: false, ...a }), io));
    assert.equal(b.code, "FMC-GB-DRY-RUN-FIRST");
  }
  assert.deepEqual(w.builds, []);
  assert.deepEqual([...w.mem.files.keys()], []);
});

// ---- overwrites ---------------------------------------------------------------------------------------------------

test("FG-T03: target exists, overwrite false: FMC-GB-EXISTS, file byte-identical, no archive, no build", async () => {
  const w = world("testing");
  const files = seed(w);
  const before = snapshot(w, files);
  const { b } = await gb(w);
  assert.equal(b.code, "FMC-GB-EXISTS");
  assert.deepEqual(snapshot(w, files), before);
  assert.equal(w.mem.existsSync(archiveDir()), false);
  assert.deepEqual(w.builds, []);
});

for (const [id, mode] of [["FG-T04", "production"], ["FG-T11", "testing-no-auto"], ["FG-T12", "production-auto"]] as const) {
  test(`${id}: overwrite true in ${mode} with no approval waits for a person: approval_id, expires_at, no build, no archive`, async () => {
    const w = world(mode);
    const files = seed(w);
    const before = snapshot(w, files);
    const { r, b } = await gb(w, { overwrite: true });
    assert.equal(r.isError, false);
    assert.equal(b.waiting_for_approval, true);
    assert.match(b.approval_id, /^fo-/);
    assert.equal(Date.parse(b.expires_at) - w.clock.t, APPROVAL_TTL_MS);
    assert.deepEqual(w.builds, []);
    assert.deepEqual(snapshot(w, files), before);
    assert.equal(w.mem.existsSync(archiveDir()), false);
    const recs = readApprovals({ fs: w.mem, store: STORE });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].status, "pending");
    assert.equal(recs[0].sha256, sha(Buffer.from(`OLD rfa of ${FAMILY}.rfa`)));
    // asking again is the same record, not a new one each call
    assert.equal((await gb(w, { overwrite: true })).b.approval_id, b.approval_id);
    assert.equal(readApprovals({ fs: w.mem, store: STORE }).length, 1);
  });
}

test("FG-T05, FG-T06: testing + auto_approve: a bound record, archive first (4 files, hashes match), one build, record used; the same approval_id again is refused", async () => {
  const w = world("testing");
  const files = seed(w);
  const before = snapshot(w, files);
  const { r, b } = await gb(w, { overwrite: true });
  assert.equal(r.isError, false, JSON.stringify(b));
  assert.equal(b.saved, true);
  assert.equal(b.approval.status, "used");
  assert.equal(b.approval.auto, true);
  assert.equal(b.archived.length, 4);
  for (const a of b.archived as Array<{ from: string; to: string; sha256: string }>) {
    assert.ok(a.to.startsWith(archiveDir() + "\\"), a.to);
    assert.match(win.basename(a.to), /^\d{8}-\d{6}_/);
    assert.equal(sha(w.mem.readFileSync(a.to)), a.sha256);
  }
  const kinds = Object.keys(files) as Array<keyof typeof files>;
  for (const k of kinds) assert.ok((b.archived as Array<{ from: string; sha256: string }>).some((a) => a.from.toLowerCase() === files[k].toLowerCase() && a.sha256 === before[k]), k);
  assert.deepEqual(w.builds, [FAMILY]);
  const rec = readApprovals({ fs: w.mem, store: STORE })[0];
  assert.equal(rec.status, "used");
  assert.equal(rec.archived!.length, 4);
  // T06: the used record again
  const archivedBefore = w.mem.under(archiveDir()).length;
  const again = await gb(w, { overwrite: true, approval_id: rec.id });
  assert.equal(again.b.refused, true);
  assert.equal(again.b.code, "FMC-GB-APPROVAL");
  assert.match(again.b.reasons.join(" "), /already used/);
  assert.deepEqual(w.builds, [FAMILY]);
  assert.equal(w.mem.under(archiveDir()).length, archivedBefore);
});

test("FG-T07: the staged file changes after the record is bound: refused, the changed file stays, no build, no archive", async () => {
  const w = world();
  seed(w);
  const first = await gb(w, { overwrite: true });
  assert.equal(setStatus(first.b.approval_id, "approved", "Lead A", { fs: w.mem, store: STORE, now: () => new Date(w.clock.t) }).error, undefined);
  w.mem.put(TARGET, "CHANGED BY SOMEONE");
  const { b } = await gb(w, { overwrite: true, approval_id: first.b.approval_id });
  assert.equal(b.code, "FMC-GB-APPROVAL");
  assert.match(b.reasons.join(" "), /changed since approval/);
  assert.equal(w.mem.readFileSync(TARGET).toString(), "CHANGED BY SOMEONE");
  assert.deepEqual(w.builds, []);
  assert.equal(w.mem.existsSync(archiveDir()), false);
});

test("FG-T08: an input changes the plan: the old plan_id is refused, and the old approval doesn't fit the new plan", async () => {
  const w = world();
  const files = seed(w);
  const before = snapshot(w, files);
  const first = await gb(w, { overwrite: true });
  setStatus(first.b.approval_id, "approved", "Lead A", { fs: w.mem, store: STORE, now: () => new Date(w.clock.t) });
  const io = { guard: w.io.guard, dictionary: KIT, exists: (f: string) => w.mem.existsSync(f), log: () => {}, kitStamp: () => "kit-1", recipe: w.io };
  const stale = body(await runFmcGenerateBind(gbArgs({ dry_run: false, confirm: true, overwrite: true, plan_id: first.dry.plan_id, frame_depth_mm: 120, approval_id: first.b.approval_id }), io));
  assert.equal(stale.code, "FMC-GB-DRY-RUN-FIRST");
  const fresh = await gb(w, { overwrite: true, frame_depth_mm: 120, approval_id: first.b.approval_id });
  assert.equal(fresh.b.code, "FMC-GB-APPROVAL");
  assert.match(fresh.b.reasons.join(" "), /another plan/);
  assert.deepEqual(w.builds, []);
  assert.deepEqual(snapshot(w, files), before);
});

test("FG-T09: a record bound to family A is refused on family B; B unchanged", async () => {
  const w = world();
  seed(w);
  const targetB = `${STAGING}\\A\\FMC_A_Door_Legend_hinged_right.rfa`;
  const filesB = seed(w, targetB);
  const beforeB = snapshot(w, filesB);
  const a = await gb(w, { overwrite: true });
  setStatus(a.b.approval_id, "approved", "Lead A", { fs: w.mem, store: STORE, now: () => new Date(w.clock.t) });
  const b = await gb(w, { overwrite: true, operation: "hinged_right", approval_id: a.b.approval_id });
  assert.equal(b.b.code, "FMC-GB-APPROVAL");
  assert.match(b.b.reasons.join(" "), /is for .*hinged_left/);
  assert.deepEqual(snapshot(w, filesB), beforeB);
  assert.deepEqual(w.builds, []);
});

test("FG-T10: an approved record past expires_at is refused", async () => {
  const w = world();
  const files = seed(w);
  const before = snapshot(w, files);
  const a = await gb(w, { overwrite: true });
  setStatus(a.b.approval_id, "approved", "Lead A", { fs: w.mem, store: STORE, now: () => new Date(w.clock.t) });
  w.clock.t += APPROVAL_TTL_MS + 1000;
  const { b } = await gb(w, { overwrite: true, approval_id: a.b.approval_id });
  assert.equal(b.code, "FMC-GB-APPROVAL");
  assert.match(b.reasons.join(" "), /expired/);
  assert.deepEqual(w.builds, []);
  assert.deepEqual(snapshot(w, files), before);
  // the pane can't approve an expired record either
  assert.match(setStatus(a.b.approval_id, "approved", "Lead A", { fs: w.mem, store: STORE, now: () => new Date(w.clock.t) }).error!, /not pending|expired/);
});

test("FG-T13: the archive fails (_Archive is a file): refused, originals byte-identical, no build, record still approved; a retry after the fix proceeds", async () => {
  const w = world("testing");
  const files = seed(w);
  const before = snapshot(w, files);
  w.mem.put(archiveDir(), "I am a file, not a folder");
  const { b } = await gb(w, { overwrite: true });
  assert.equal(b.code, "FMC-GB-ARCHIVE", JSON.stringify(b));
  assert.deepEqual(snapshot(w, files), before);
  assert.deepEqual(w.builds, []);
  const rec = readApprovals({ fs: w.mem, store: STORE })[0];
  assert.equal(rec.status, "approved");
  w.mem.unlinkSync(archiveDir());
  const retry = await gb(w, { overwrite: true, approval_id: rec.id });
  assert.equal(retry.b.saved, true, JSON.stringify(retry.b));
  assert.deepEqual(w.builds, [FAMILY]);
  assert.equal(readApprovals({ fs: w.mem, store: STORE })[0].status, "used");
});

// ---- a direct fmc_recipe build (RC-3) and the batch -----------------------------------------------------------------

async function plannedRecipe(): Promise<Record<string, unknown>> {
  const w = world();
  const io = { guard: w.io.guard, dictionary: KIT, exists: () => false, log: () => {}, kitStamp: () => "kit-1" };
  return body(await runFmcGenerateBind(gbArgs(), io)).recipe;
}
const recipeArgs = (over: Record<string, unknown>) => z.object(FMC_RECIPE_SHAPE).parse({ action: "build", dry_run: false, ...over });

test("FG-T14: a direct fmc_recipe build over a staged family, not testing, no approval: waits, same as T04", async () => {
  const w = world();
  const files = seed(w);
  const before = snapshot(w, files);
  const r = await runFmcRecipe(recipeArgs({ recipe: await plannedRecipe(), overwrite: true }), w.io);
  const b = body(r);
  assert.equal(b.waiting_for_approval, true, JSON.stringify(b));
  assert.match(b.approval_id, /^fo-/);
  assert.deepEqual(w.builds, []);
  assert.deepEqual(snapshot(w, files), before);
  assert.equal(w.mem.existsSync(archiveDir()), false);
});

test("FG-T15: the same direct fmc_recipe build in testing + auto_approve: archive, one build, record used", async () => {
  const w = world("testing");
  seed(w);
  const b = body(await runFmcRecipe(recipeArgs({ recipe: await plannedRecipe(), overwrite: true }), w.io));
  assert.equal(b.approval.status, "used", JSON.stringify(b));
  assert.equal(b.archived.length, 4);
  assert.deepEqual(w.builds, [FAMILY]);
});

test("FG-T16: a dry run with the target present writes, archives and consumes nothing, and says a real overwrite moves the old files to _Archive", async () => {
  for (const overwrite of [false, true]) {
    const w = world("testing");
    const files = seed(w);
    const before = snapshot(w, files);
    const io = { guard: w.io.guard, dictionary: KIT, exists: (f: string) => w.mem.existsSync(f), log: () => {}, kitStamp: () => "kit-1", recipe: w.io };
    const b = body(await runFmcGenerateBind(gbArgs({ overwrite }), io));
    assert.equal(b.dry_run, true);
    assert.equal(b.wrote, false);
    assert.match(b.plan_id, /^gb-/);
    assert.match(b.overwrite_note, /_Archive/);
    assert.deepEqual(snapshot(w, files), before);
    assert.equal(w.mem.existsSync(archiveDir()), false);
    assert.deepEqual(readApprovals({ fs: w.mem, store: STORE }), []);
  }
  // fmc_recipe's own dry build of an overwrite: no record, no archive
  const w = world("testing");
  seed(w);
  const b = body(await runFmcRecipe(recipeArgs({ recipe: await plannedRecipe(), overwrite: true, dry_run: true }), w.io));
  assert.match(b.overwrite_note, /_Archive/);
  assert.equal(w.mem.existsSync(archiveDir()), false);
  assert.deepEqual(readApprovals({ fs: w.mem, store: STORE }), []);
});

test("FG-T17: a refused build leaves <reports>\\Recipes\\<family>.recipe.json byte-identical", async () => {
  const kept = `${REPORTS}\\Recipes\\${FAMILY}.recipe.json`;
  for (const mode of ["production", "testing"] as const) {
    const w = world(mode, mode === "testing" ? { write_roots: ["C:\\Elsewhere"] } : {});
    if (mode === "production") seed(w);
    w.mem.put(kept, "THE RECIPE A PERSON KEPT");
    const recipe = await plannedRecipe();
    // production: overwrite false (EXISTS), then overwrite true (waiting); testing: a path refusal
    const calls = mode === "production" ? [{ overwrite: false }, { overwrite: true }] : [{ overwrite: false }];
    for (const c of calls) {
      const b = body(await runFmcRecipe(recipeArgs({ recipe, ...c }), w.io));
      assert.ok(b.refused || b.waiting_for_approval, JSON.stringify(b));
      assert.equal(w.mem.readFileSync(kept).toString(), "THE RECIPE A PERSON KEPT");
    }
    assert.deepEqual(w.builds, []);
  }
});

test("batch: a rebuild of a staged family waits for its approval; with testing auto_approve it is archived before the job is sent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-fo-"));
  const file = path.join(dir, "batch.json");
  fs.writeFileSync(file, JSON.stringify([await plannedRecipe()]));
  for (const mode of ["production", "testing"] as const) {
    const w = world(mode);
    const files = seed(w);
    const before = snapshot(w, files);
    const sent: unknown[] = [];
    w.io.sendBatch = async (p) => { sent.push(p); return { ok: true }; };
    const args = z.object(FMC_RECIPE_SHAPE).parse({ action: "batch", recipe_files: [file], rebuild: true, dry_run: true });
    const dry = body(await runFmcRecipe(args, w.io));
    assert.deepEqual(dry.overwrites, [FAMILY]);
    assert.match(dry.overwrite_note, /_Archive/);
    assert.deepEqual(readApprovals({ fs: w.mem, store: STORE }), []);
    const real = body(await runFmcRecipe({ ...args, dry_run: false }, w.io));
    if (mode === "production") {
      assert.equal(real.waiting_for_approval[0].family, FAMILY, JSON.stringify(real));
      assert.equal(sent.length, 0);
      assert.deepEqual(snapshot(w, files), before);
    } else {
      assert.equal(sent.length, 1, JSON.stringify(real));
      assert.equal(real.archived[FAMILY].length, 4);
      assert.equal(w.mem.existsSync(TARGET), false);
      assert.equal(readApprovals({ fs: w.mem, store: STORE })[0].status, "used");
    }
  }
});

// ---- who may approve ----------------------------------------------------------------------------------------------

test("FG-T18: no MCP tool reaches setStatus or claimApproval; no tool argument can approve a record", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const toolsDir = path.join(here, "..", "tools");
  const srcTools = [toolsDir, path.join(here, "..", "..", "src", "tools")].find((d) => fs.existsSync(d) && fs.readdirSync(d).some((f) => f.endsWith(".ts")))
    ?? toolsDir;
  const ext = fs.readdirSync(srcTools).some((f) => f.endsWith(".ts") && !f.endsWith(".d.ts")) ? ".ts" : ".js";
  const scanned = fs.readdirSync(srcTools).filter((x) => x.endsWith(ext));
  assert.ok(scanned.length > 50 && scanned.some((f) => f.startsWith("fmc_recipe.")), `tools scanned: ${scanned.length}`);
  let gated = 0;
  for (const f of scanned) {
    const text = fs.readFileSync(path.join(srcTools, f), "utf8");
    assert.doesNotMatch(text, /familyapproval_pane/, `${f} imports the pane's approval module`);
    const imp = text.match(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/fmc\/familyapproval\.js"/);
    if (imp) { gated++; assert.doesNotMatch(imp[1], /\b(setStatus|claimApproval|writeApprovals)\b/, `${f} imports a status setter`); }
  }
  assert.ok(gated >= 2, "fmc_recipe and fmc_generate_bind import the gate");
  const mod = await import("./familyapproval.js");
  assert.equal("claimApproval" in mod, false);
  assert.equal("setStatus" in mod, false);
  // every confirm-ish field together: the record stays pending, nothing written
  const w = world();
  const files = seed(w);
  const before = snapshot(w, files);
  const sneaky = { confirmed_by: "Emlyn", approved: true, status: "approved", auto_approve: true } as Record<string, unknown>;
  const r = await runFmcRecipe(z.object(FMC_RECIPE_SHAPE).parse({ action: "build", dry_run: false, recipe: await plannedRecipe(), overwrite: true, plan_id: "gb-x", ...sneaky }), w.io);
  assert.equal(body(r).waiting_for_approval, true);
  assert.equal(readApprovals({ fs: w.mem, store: STORE })[0].status, "pending");
  assert.deepEqual(snapshot(w, files), before);
});

test("FG-T21: a person approves in the pane (production): archive, one build, record used", async () => {
  const w = world();
  seed(w);
  const a = await gb(w, { overwrite: true });
  const approved = paneFamilyApproval("family_overwrite_approve", { approval_id: a.b.approval_id }, "Lead A", { fs: w.mem, store: STORE, now: () => new Date(w.clock.t) });
  assert.equal((approved as { approval: { status: string } }).approval.status, "approved");
  const { b } = await gb(w, { overwrite: true, approval_id: a.b.approval_id });
  assert.equal(b.saved, true, JSON.stringify(b));
  assert.equal(b.archived.length, 4);
  assert.equal(b.approval.approved_by, "Lead A");
  assert.deepEqual(w.builds, [FAMILY]);
  assert.equal(readApprovals({ fs: w.mem, store: STORE })[0].status, "used");
  // a rejected record never builds
  const w2 = world();
  seed(w2);
  const a2 = await gb(w2, { overwrite: true });
  paneFamilyApproval("family_overwrite_reject", { approval_id: a2.b.approval_id }, "Lead A", { fs: w2.mem, store: STORE, now: () => new Date(w2.clock.t) });
  assert.match((await gb(w2, { overwrite: true, approval_id: a2.b.approval_id })).b.reasons.join(" "), /rejected/);
  assert.deepEqual(w2.builds, []);
});

// ---- protected_roots and the forbidden projects ----------------------------------------------------------------------

test("FG-T19: a project tree with Fomcraft in its path, in write_roots, protected_roots empty: allowed", async () => {
  const w = world();
  assert.deepEqual(familyTargetVerdict(TARGET, w.io.guard!).reasons, []);
  assert.equal(protectedRootVerdict(TARGET, w.io.guard!).ok, true);
  const { b } = await gb(w);
  assert.equal(b.saved, true, JSON.stringify(b));
});

test("FG-T20: a target inside a named protected_roots entry is refused (fail closed): no build, nothing written there", async () => {
  const originals = `${ROOT}\\FMC_PROJECTS_27\\Proj`;
  const w = world("testing", { protected_roots: [originals] });
  const { b } = await gb(w, { overwrite: true });
  assert.equal(b.code, "FMC-GB-PATH");
  assert.match(b.reasons.join(" "), /named originals folder/);
  assert.deepEqual(w.builds, []);
  assert.deepEqual(w.mem.under(originals), []);
  // a sibling not inside the named entry is not refused for its name
  assert.equal(protectedRootVerdict(`${ROOT}\\FMC_PROJECTS_27\\Other\\x.rfa`, w.io.guard!).ok, true);
  // the archive destination is checked as well
  assert.equal(familyTargetVerdict(`${originals}\\_Archive\\x.rfa`, w.io.guard!, { checkName: false }).ok, false);
});

test("O6: forbiddenProject's floor is A-0001 and HEBERT HOSTELS as whole words; A-00012 is not blocked; config only adds", () => {
  const none = () => null;
  assert.equal(forbiddenProject("C:\\X\\A-0001\\01_WIP\\a.rfa", null, none), "A-0001");
  assert.equal(forbiddenProject("C:\\X\\a-0001_USER\\a.rfa", null, none), "A-0001");
  assert.equal(forbiddenProject("C:\\X\\HEBERT_HOSTELS\\a.rfa", null, none), "HEBERT HOSTELS");
  assert.equal(forbiddenProject("C:\\X\\hebert  hostels 2\\a.rfa", null, none), "HEBERT HOSTELS");
  assert.equal(forbiddenProject("C:\\X\\A-00012\\01_WIP\\a.rfa", null, none), null);
  assert.equal(forbiddenProject("C:\\X\\OGALA\\a.rfa", { forbidden_projects: ["Ogala"] } as Partial<GuardConfig>, none), "Ogala");
  assert.equal(forbiddenProject("C:\\X\\A-0001\\a.rfa", { forbidden_projects: [] } as Partial<GuardConfig>, none), "A-0001");
  assert.equal(forbiddenProject("C:\\J\\link\\a.rfa", null, () => "D:\\Real\\HEBERT HOSTELS\\a.rfa"), "HEBERT HOSTELS");
  assert.equal(mentions("C:\\X\\A-00012", "A-0001"), false);
});

test("O7: Gate A and the dry run say the eleven are provisional", async () => {
  assert.equal(PROVISIONAL_NOTE, "parameter set is provisional (owner not signed off)");
  const w = world();
  const io = { guard: w.io.guard, dictionary: KIT, exists: () => false, log: () => {}, kitStamp: () => "kit-1" };
  const b = body(await runFmcGenerateBind(gbArgs(), io));
  assert.equal(b.parameter_set, PROVISIONAL_NOTE);
});

test("O4: the plan_id covers the target, kit and overwrite as well as the recipe", async () => {
  const w = world();
  const id = async (over: Partial<FmcGenerateBindArgs>, kit = "kit-1", g = w.io.guard!) =>
    body(await runFmcGenerateBind(gbArgs(over), { guard: g, dictionary: KIT, exists: () => false, log: () => {}, kitStamp: () => kit })).plan_id;
  const base = await id({});
  assert.equal(await id({}), base);
  assert.notEqual(await id({ overwrite: true }), base);
  assert.notEqual(await id({}, "kit-2"), base);
  assert.notEqual(await id({}, "kit-1", { ...w.io.guard!, family_staging_root: `${STAGING}2`, write_roots: [ROOT] }), base);
  assert.equal(recipePlan({ a: 1 }, "C:\\A\\b.rfa"), recipePlan({ a: 1 }, "c:\\a\\B.rfa"));
});

test("requireFamilyApproval: a missing target is a first build whatever overwrite says", () => {
  const mem = new MemFs();
  const g = requireFamilyApproval({ family: FAMILY, target: TARGET, plan: "p", overwrite: true, cfg: guard("testing"), checkDest: () => ({ ok: true, reasons: [] }) }, false, { fs: mem, store: STORE });
  assert.deepEqual(g, { ok: true, overwrite: false });
  assert.equal(mem.existsSync(STORE), false);
});
