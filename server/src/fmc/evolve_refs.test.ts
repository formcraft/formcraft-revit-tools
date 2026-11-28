import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { INDEX_SCHEMA, PROTECTED_MODEL, RefsIo, catalogueFiles, gateProblems, indexFile, planRepoint, readIndex, readNewVersion, reloadSteps, repointCatalogue,
  repointIndex, repointToken, whereUsed, writeProblems } from "./evolve_refs.js";
import { EvolveIo, FMC_FAMILY_EVOLVE_SHAPE, runFmcFamilyEvolve } from "../tools/fmc_family_evolve.js";
import { z } from "zod";
import type { GuardConfig } from "./policy.js";

const win = path.win32;
const STAGING = "Z:\\00_Standards\\04_Families\\_Staging";
const ORIGINAL = win.join(STAGING, "A", "FMC_A_Door_SteelFanlight.rfa");
const BACKUP = win.join(STAGING, "A", "_Evolve", "FMC_A_Door_SteelFanlight", "v001", "FMC_A_Door_SteelFanlight.rfa");
const V2 = win.join(STAGING, "A", "_Evolve", "FMC_A_Door_SteelFanlight", "v002", "FMC_A_Door_SteelFanlight.rfa");
const V3 = win.join(STAGING, "A", "_Evolve", "FMC_A_Door_SteelFanlight", "v003", "FMC_A_Door_SteelFanlight.rfa");
const PROJ = "D:\\Jobs\\F26901";
const cfg = {
  write_roots: [STAGING], library_roots: [STAGING], template_roots: [], blocked_segments: ["02_Shared", "03_Published", "04_Archive", "05_Incoming"],
  family_staging_root: STAGING, reports_dir: "C:\\FMC_Reports_test", max_backups: 3, live_model_lock: true,
} as unknown as GuardConfig;

const key = (p: string) => win.normalize(p).toLowerCase();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

interface Mem extends RefsIo { fs: Map<string, string>; writes: string[]; reads: string[]; logs: string[]; set(p: string, t: string): void; state: { lease: { id: string; documents: string[] } | null; ai: { on: boolean; stop: boolean } | null; docs: RefsIo["openDocuments"] extends () => infer R ? R : never } }

/** An in-memory disk: files by path, folders from the paths. Every read and write is recorded. */
function mem(over: Partial<Mem["state"]> = {}): Mem {
  const files = new Map<string, string>();
  const names = new Map<string, string>();
  const state: Mem["state"] = { lease: { id: "L-1", documents: ["F26901-FMC-ZZ-ZZ-M3-A-0002"] }, ai: { on: true, stop: false }, docs: [], ...over };
  const m: Mem = {
    fs: files, writes: [], reads: [], logs: [], state,
    config: cfg, now: () => new Date("2026-11-28T09:00:00Z"),
    set(p, t) { files.set(key(p), t); names.set(key(p), p); },
    exists: (p) => files.has(key(p)),
    sha256: (p) => (files.has(key(p)) ? sha(files.get(key(p))!) : null),
    readText: (p) => { m.reads.push(p); return files.has(key(p)) ? files.get(key(p))! : null; },
    writeText: (p, t) => { m.writes.push(p); m.set(p, t); },
    mkdir: () => {},
    files: (d) => [...names.values()].filter((p) => key(win.dirname(p)) === key(d)).map((p) => win.basename(p)),
    dirs: (d) => [...new Set([...names.values()].filter((p) => key(p).startsWith(key(d) + "\\") && key(win.dirname(p)) !== key(d)).map((p) => win.relative(d, p).split("\\")[0]))],
    openDocuments: () => state.docs,
    lease: () => state.lease, ai: () => state.ai, client: () => "test-client",
  };
  return m;
}

/** The disk after `fmc_family_evolve apply`: the original, its backup, version 2 and its record. */
function evolved(m: Mem, version = V2, n = "v002") {
  m.set(ORIGINAL, "original-bytes");
  m.set(BACKUP, "original-bytes");
  m.set(version, "version-bytes-" + n);
  m.set(version.replace(/\.rfa$/i, ".evolve.json"), JSON.stringify({ backup: false, version: n, of: ORIGINAL, from_backup: BACKUP, sha256: sha("version-bytes-" + n), token: "EV-abc", at: "2026-11-28T08:00:00Z" }));
  return m;
}

const SEED_USE = JSON.stringify({ node: "ICU.Room", elements: [{ key: "door:1", family: "FMC_A_Door_SteelFanlight", type_name: "900x2100_Std" }, { key: "door:2", family: "FMC_A_Door_SteelFanlight" }, { key: "w", type_name: "Generic - 200mm" }] });

test("the index: the new version becomes current, the original is listed and superseded, nothing is removed", () => {
  const m = evolved(mem());
  const v = readNewVersion(V2, m).v!;
  assert.equal(v.family, "FMC_A_Door_SteelFanlight");
  assert.equal(v.version, "v002");
  assert.equal(v.backupSha, sha("original-bytes"));
  const first = repointIndex(null, v, m.now());
  assert.equal(first.change.change, "create");
  const entries = first.next.families[v.family].entries;
  assert.deepEqual(entries.map((e) => [e.version, e.status]), [["original", "superseded"], ["v002", "current"]]);
  assert.equal(entries[0].superseded_by, V2);
  assert.equal(entries[0].file, ORIGINAL, "the old entry is kept with its path");
  assert.equal(entries[0].backup, BACKUP);
  // the same version again changes nothing
  const again = repointIndex(first.next, v, m.now());
  assert.equal(again.change.change, "skip");
  assert.deepEqual(again.next, first.next);
  // a later version supersedes v002, and the list only grows
  const v3 = readNewVersion(V3, evolved(mem(), V3, "v003")).v!;
  const third = repointIndex(first.next, v3, m.now());
  assert.equal(third.change.change, "update");
  assert.deepEqual(third.next.families[v.family].entries.map((e) => [e.version, e.status]), [["original", "superseded"], ["v002", "superseded"], ["v003", "current"]]);
  assert.deepEqual(third.change.superseded.map((s) => s.version), ["v002"]);
  assert.equal(third.next.families[v.family].entries[1].superseded_by, V3);
});

test("a version whose record is missing, or that changed after apply, is refused", () => {
  const m = mem();
  m.set(V2, "x");
  assert.match(readNewVersion(V2, m).problems[0], /no version record/);
  evolved(m);
  m.set(V2, "edited by hand");
  assert.match(readNewVersion(V2, m).problems[0], /changed after apply/);
  assert.match(readNewVersion(ORIGINAL.replace(/\.rfa$/, ".txt"), m).problems[0], /\.rfa/);
  assert.match(readNewVersion(win.join(STAGING, "A", "Nope.rfa"), m).problems[0], /Not found/);
});

test("a staging catalogue: its row is repointed, the old row stays as superseded, other rows and other catalogues are untouched", () => {
  const m = evolved(mem());
  const v = readNewVersion(V2, m).v!;
  const cat = JSON.stringify({ families: [{ family: "FMC_A_Door_SteelFanlight", file: ORIGINAL, role: "A" }, { family: "FMC_A_Door_Other", file: win.join(STAGING, "A", "FMC_A_Door_Other.rfa") }] });
  const r = repointCatalogue(cat, "x", v);
  assert.equal(r.change.change, "update");
  const rows = JSON.parse(r.next!).families;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((x: any) => [x.family, x.status ?? "", x.file]), [["FMC_A_Door_SteelFanlight", "", V2], ["FMC_A_Door_SteelFanlight", "superseded", ORIGINAL], ["FMC_A_Door_Other", "", win.join(STAGING, "A", "FMC_A_Door_Other.rfa")]]);
  assert.equal(rows[1].superseded_by, V2);
  assert.equal(rows[0].version, "v002");
  // again: already there, so a skip
  assert.equal(repointCatalogue(r.next!, "x", v).change.change, "skip");
  // a plain array, a catalogue with no row for it, and text that isn't JSON
  assert.equal(repointCatalogue(JSON.stringify([{ name: "FMC_A_Door_SteelFanlight", path: ORIGINAL }]), "x", v).change.repointed, 1);
  assert.equal(repointCatalogue(JSON.stringify({ rows: [{ family: "FMC_A_Door_Other" }] }), "x", v).change.change, "none");
  assert.equal(repointCatalogue("not json", "x", v).change.change, "none");
  // only a catalogue-named file beside the family or in the staging root is looked at, never inside _Evolve
  m.set(win.join(STAGING, "A", "FMC_A_catalogue.json"), cat);
  m.set(win.join(STAGING, "FMC_Staging_Catalogue.json"), cat);
  m.set(win.join(STAGING, "A", "notes.json"), cat);
  m.set(win.join(STAGING, "A", "_Evolve", "catalogue.json"), cat);
  assert.deepEqual(catalogueFiles(v, m).map(key).sort(), [win.join(STAGING, "A", "FMC_A_catalogue.json"), win.join(STAGING, "FMC_Staging_Catalogue.json")].map(key).sort());
});

test("where used reads only plugin records (.json / .jsonl) and never a project file", () => {
  const m = evolved(mem({ docs: [
    { title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: PROJ + "\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", workshared: true, family: false },
    { title: "FMC_A_Door_SteelFanlight", path: ORIGINAL, family: true },
  ] }));
  m.set(PROJ + "\\01_WIP\\_Tree\\rooms\\ICU.Room.json", SEED_USE);
  m.set(PROJ + "\\01_WIP\\_Tree\\FMC_Recipe_Tree.json", JSON.stringify({ root: { children: [{ inputs: { items: [{ family: "FMC_A_Door_SteelFanlight: 900x2100_Std" }, { family: "FMC_A_Door_Other" }] } }] } }));
  m.set(PROJ + "\\01_WIP\\_Ceilings\\_Placed\\C.json", JSON.stringify({ room: "x", elements: [] }));
  m.set(PROJ + "\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", "RVT BYTES");
  m.set(PROJ + "\\01_WIP\\_Tree\\rooms\\shot.rvt", "RVT BYTES");
  m.set(PROJ + "\\01_WIP\\_Tree\\notes.txt", "FMC_A_Door_SteelFanlight");
  m.set(PROJ + "\\01_WIP\\_Other\\x.json", SEED_USE);
  const wu = whereUsed(["FMC_A_Door_SteelFanlight"], V2, [], m);
  assert.equal(wu.read_only, true);
  assert.equal(wu.projects, 1, "the project came from the open document's 01_WIP path");
  assert.equal(wu.rows.length, 1, "one open document: the family document is not a project file");
  const row = wu.rows[0];
  assert.equal(row.project, PROJ);
  assert.equal(row.open, true);
  assert.equal(row.workshared, true);
  assert.deepEqual(row.evidence.map((e) => [e.source, e.count]).sort(), [["recipe tree", 1], ["room record", 2]]);
  assert.match(row.reload_plan.join("\n"), /Insert > Load Family > Z:.*v002/);
  assert.match(row.reload_plan.join("\n"), /synchronises with central after/);
  assert.equal(row.listed_only, false);
  // nothing outside the plugin's record folders, and no .rvt or .txt, was read; nothing was written
  assert.equal(m.reads.some((p) => /\.(rvt|txt)$/i.test(p)), false);
  assert.equal(m.reads.some((p) => /_Other/.test(p)), false);
  assert.equal(m.writes.length, 0);
  assert.equal(wu.files_read, 3);
  assert.ok(wu.not_covered.length >= 3);
  // a named project with no open model: a row with the 'not open' plan, and this tool never opens it
  m.set("D:\\Jobs\\F26902\\01_WIP\\_Tree\\rooms\\R.json", SEED_USE);
  const closed = whereUsed(["FMC_A_Door_SteelFanlight"], V2, ["D:\\Jobs\\F26902\\"], m);
  const c = closed.rows.find((r) => r.project === "D:\\Jobs\\F26902")!;
  assert.equal(c.open, false);
  assert.equal(c.document, null);
  assert.match(c.reload_plan[1], /is not open.*never opens a project file/);
  // a project with no record of the family has no row
  assert.equal(whereUsed(["FMC_A_Door_Nothing"], V2, [], m).rows.length, 0);
});

test("A-0001 and HEBERT HOSTELS are listed read only, with no action step", () => {
  assert.equal(PROTECTED_MODEL.test("F26901-FMC-ZZ-ZZ-M3-A-0001"), true);
  assert.equal(PROTECTED_MODEL.test("F26901-FMC-ZZ-ZZ-M3-A-0002"), false);
  assert.equal(PROTECTED_MODEL.test("F26901-FMC-ZZ-ZZ-M3-A-0001_USER"), true, "the central-model suffix does not hide it");
  assert.equal(PROTECTED_MODEL.test("F26901-FMC-ZZ-ZZ-M3-A-00012"), false);
  assert.equal(PROTECTED_MODEL.test("HEBERT HOSTELS_USER"), true);
  const m = evolved(mem({ docs: [
    { title: "F26901-FMC-ZZ-ZZ-M3-A-0001_USER", path: PROJ + "\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0001_USER.rvt", workshared: true },
    { title: "HEBERT HOSTELS_USER", path: "D:\\Jobs\\HEBERT HOSTELS\\01_WIP\\A\\HEBERT HOSTELS_USER.rvt", workshared: true },
  ] }));
  m.set(PROJ + "\\01_WIP\\_Tree\\rooms\\R.json", SEED_USE);
  m.set("D:\\Jobs\\HEBERT HOSTELS\\01_WIP\\_Tree\\rooms\\R.json", SEED_USE);
  const wu = whereUsed(["FMC_A_Door_SteelFanlight"], V2, [], m);
  assert.equal(wu.rows.length, 2);
  for (const r of wu.rows) {
    assert.equal(r.listed_only, true);
    assert.equal(r.reload_plan.length, 1);
    assert.match(r.reload_plan[0], /Listed only.*takes no action/);
    assert.doesNotMatch(r.reload_plan[0], /Load Family/);
  }
  assert.match(reloadSteps({ document: "x", open: true, workshared: true, listed_only: true }, V2)[0], /protected/);
});

test("the gate: a real repoint needs a held lease and the AI gate", () => {
  const ok = mem();
  assert.deepEqual(gateProblems(ok), []);
  assert.match(gateProblems(mem({ lease: null }))[0], /needs a batch lease/);
  assert.match(gateProblems(mem({ lease: { id: "L-9", documents: [] } }))[0], /isn't held by this session/);
  assert.match(gateProblems(mem({ lease: { id: "L-1", documents: ["F26901-FMC-ZZ-ZZ-M3-A-0001"] } }))[0], /protected model/);
  assert.match(gateProblems(mem({ ai: null }))[0], /no valid ai_modeller/);
  assert.match(gateProblems(mem({ ai: { on: true, stop: true } }))[0], /Stop AI is on/);
  assert.match(gateProblems(mem({ ai: { on: false, stop: false } }))[0], /firm-wide AI switch is off/);
  assert.equal(gateProblems(mem({ lease: null, ai: null })).length, 2);
});

test("writes stay inside staging and the library roots, and the write roots", () => {
  assert.deepEqual(writeProblems(indexFile(STAGING), cfg), []);
  assert.deepEqual(writeProblems(win.join(STAGING, "A", "FMC_A_catalogue.json"), cfg), []);
  assert.ok(writeProblems("D:\\Jobs\\F26901\\01_WIP\\_Tree\\x.json", cfg).length >= 1, "a project folder is refused");
  assert.ok(writeProblems("Z:\\00_Standards\\04_Families\\A\\catalogue.json", cfg).length >= 1, "a released library folder is not a write root");
  assert.ok(writeProblems("Z:\\00_Standards\\04_Archive\\x.json", cfg).length >= 1);
  assert.equal(indexFile(STAGING), win.join(STAGING, "_Evolve", "FMC_Evolve_Index.json"));
});

// ---------------------------------------------------------------- the tool

const args = (o: Record<string, unknown>) => z.object(FMC_FAMILY_EVOLVE_SHAPE).parse({ action: "repoint", file: V2, ...o });
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
function toolIo(m: Mem, withRefs = true): EvolveIo {
  return { config: cfg, now: m.now, exists: m.exists, sha256: m.sha256, readText: m.readText, writeText: m.writeText, mkdir: m.mkdir,
    log: (a, t, r, d) => m.logs.push(`${a}|${r}|${d}`),
    copy: () => { throw new Error("no copy"); }, replace: () => { throw new Error("no replace"); }, list: () => [], kit: () => { throw new Error("no kit"); },
    inspect: async () => { throw new Error("no inspect"); }, doc: async () => { throw new Error("no doc"); },
    ...(withRefs ? { refs: { files: m.files, dirs: m.dirs, openDocuments: m.openDocuments, lease: m.lease, ai: m.ai, client: m.client } } : {}) } as EvolveIo;
}

test("repoint is a dry run by default: it plans, answers a token and writes nothing", async () => {
  const m = evolved(mem());
  m.set(win.join(STAGING, "A", "FMC_A_catalogue.json"), JSON.stringify([{ family: "FMC_A_Door_SteelFanlight", file: ORIGINAL }]));
  m.set(PROJ + "\\01_WIP\\_Tree\\rooms\\R.json", SEED_USE);
  m.state.docs = [{ title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: PROJ + "\\01_WIP\\A\\x.rvt", workshared: true }];
  const before = new Map(m.fs);
  const r = body(await runFmcFamilyEvolve(args({}), toolIo(m)));
  assert.equal(r.dry_run, true);
  assert.match(r.token, /^RP-[0-9a-f]{16}$/);
  assert.equal(r.index.change, "create");
  assert.equal(r.index.superseded[0].file, ORIGINAL);
  assert.equal(r.catalogues[0].repointed, 1);
  assert.equal(r.where_used.rows.length, 1);
  assert.deepEqual(r.apply_needs, []);
  assert.equal(m.writes.length, 0);
  assert.deepEqual(new Map(m.fs), before);
  assert.match(r.next, /dry_run false, token RP-/);
});

test("a real repoint refuses without the token, with a stale token, with no lease, and with the AI gate closed; nothing is written", async () => {
  const mk = (over: Partial<Mem["state"]> = {}) => { const m = evolved(mem(over)); m.set(PROJ + "\\01_WIP\\_Tree\\rooms\\R.json", SEED_USE); return m; };
  const dry = body(await runFmcFamilyEvolve(args({}), toolIo(mk())));
  const run = async (m: Mem, token: string) => body(await runFmcFamilyEvolve(args({ dry_run: false, token }), toolIo(m)));
  let m = mk();
  assert.match((await run(m, "")).reasons.join(), /needs the token/);
  assert.match((await run(m, "RP-0000000000000000")).reasons.join(), /token is stale/);
  assert.equal(m.writes.length, 0);
  m = mk({ lease: null });
  assert.match((await run(m, dry.token)).reasons.join(), /needs a batch lease/);
  m = mk({ ai: { on: true, stop: true } });
  assert.match((await run(m, dry.token)).reasons.join(), /Stop AI is on/);
  m = mk({ ai: null });
  assert.match((await run(m, dry.token)).reasons.join(), /ai_modeller/);
  assert.equal(m.writes.length, 0);
  assert.equal(m.fs.has(key(indexFile(STAGING))), false);
});

test("a real repoint writes the index and the catalogue, keeps the old entries as superseded, and touches nothing else", async () => {
  const m = evolved(mem());
  const catFile = win.join(STAGING, "A", "FMC_A_catalogue.json");
  m.set(catFile, JSON.stringify({ entries: [{ family: "FMC_A_Door_SteelFanlight", file: ORIGINAL }] }));
  m.set(PROJ + "\\01_WIP\\_Tree\\rooms\\R.json", SEED_USE);
  m.state.docs = [{ title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: PROJ + "\\01_WIP\\A\\x.rvt", workshared: true }];
  const dry = body(await runFmcFamilyEvolve(args({}), toolIo(m)));
  const original = new Map(m.fs);
  const r = body(await runFmcFamilyEvolve(args({ dry_run: false, token: dry.token }), toolIo(m)));
  assert.equal(r.repointed, true);
  assert.equal(r.project_files_written, 0);
  assert.equal(r.lease, "L-1");
  // the library index
  const idx = readIndex(indexFile(STAGING), m);
  assert.equal(idx.invalid, false);
  assert.equal(idx.index!.schema, INDEX_SCHEMA);
  const entries = idx.index!.families.FMC_A_Door_SteelFanlight.entries;
  assert.deepEqual(entries.map((e) => [e.version, e.status, e.file]), [["original", "superseded", ORIGINAL], ["v002", "current", V2]]);
  assert.deepEqual(idx.index!.history.map((h) => [h.version, h.lease, h.client, h.token]), [["v002", "L-1", "test-client", dry.token]]);
  // the catalogue repointed, the old row kept, the previous file saved beside it
  const rows = JSON.parse(m.fs.get(key(catFile))!).entries;
  assert.deepEqual(rows.map((x: any) => [x.status ?? "current", x.file]), [["current", V2], ["superseded", ORIGINAL]]);
  assert.equal(m.fs.get(key(catFile + "." + dry.token + ".bak")), JSON.stringify({ entries: [{ family: "FMC_A_Door_SteelFanlight", file: ORIGINAL }] }));
  // only library and staging files were written; the originals, the versions and the project are byte for byte as before
  for (const w of m.writes) assert.ok(w.startsWith(STAGING), w);
  for (const [k, v] of original) if (k !== key(catFile)) assert.equal(m.fs.get(k), v, k);
  assert.equal(m.writes.some((w) => w.startsWith("D:")), false);
  // doing it again is a skip: nothing more is written
  const n = m.writes.length;
  const dry2 = body(await runFmcFamilyEvolve(args({}), toolIo(m)));
  assert.equal(dry2.index.change, "skip");
  assert.match(dry2.next, /Nothing to repoint/);
  await runFmcFamilyEvolve(args({ dry_run: false, token: dry2.token }), toolIo(m));
  assert.equal(m.writes.length, n);
});

test("a catalogue outside the write roots is skipped with its reason, the index is still written", async () => {
  const m = evolved(mem());
  const released = "Z:\\00_Standards\\04_Families\\A";
  const rcfg = { ...cfg, library_roots: [STAGING, released] } as GuardConfig;
  const o = evolved(mem());
  o.set(win.join(win.dirname(ORIGINAL), "FMC_catalogue.json"), JSON.stringify([{ family: "FMC_A_Door_SteelFanlight", file: ORIGINAL }]));
  void m; void rcfg; void o;
  // a catalogue the plan finds is always in the original's folder or the staging root; make the original sit in the released library
  const rel = win.join(released, "FMC_A_Door_SteelFanlight.rfa");
  const mm = mem();
  mm.set(rel, "original-bytes"); mm.set(BACKUP, "original-bytes"); mm.set(V2, "version-bytes-v002");
  mm.set(V2.replace(/\.rfa$/i, ".evolve.json"), JSON.stringify({ backup: false, version: "v002", of: rel, from_backup: BACKUP, sha256: sha("version-bytes-v002"), token: "EV-1" }));
  mm.set(win.join(released, "FMC_catalogue.json"), JSON.stringify([{ family: "FMC_A_Door_SteelFanlight", file: rel }]));
  const io = { ...toolIo(mm), config: { ...cfg, library_roots: [STAGING, released] } } as EvolveIo;
  const dry = body(await runFmcFamilyEvolve(args({}), io));
  assert.equal(dry.catalogues[0].change, "update");
  const r = body(await runFmcFamilyEvolve(args({ dry_run: false, token: dry.token }), io));
  assert.equal(r.repointed, true);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /Not inside an allowed write folder/);
  assert.equal(JSON.parse(mm.fs.get(key(win.join(released, "FMC_catalogue.json")))!)[0].file, rel, "the released library's catalogue was not touched");
  assert.equal(mm.writes.length, 1, "only the index");
});

test("a file in the index path that isn't ours is never overwritten", async () => {
  const m = evolved(mem());
  m.set(indexFile(STAGING), "{ \"something\": \"else\" }");
  const r = body(await runFmcFamilyEvolve(args({}), toolIo(m)));
  assert.match(r.next, /isn't a fmc-evolve-index\/1 file/);
  assert.equal(r.token, "");
  const real = body(await runFmcFamilyEvolve(args({ dry_run: false, token: "RP-1" }), toolIo(m)));
  assert.equal(real.refused, true);
  assert.equal(m.writes.length, 0);
});

test("where_used as a tool action is read only, and repoint is refused where the add-in has no refs", async () => {
  const m = evolved(mem());
  m.set(PROJ + "\\01_WIP\\_Tree\\rooms\\R.json", SEED_USE);
  const r = body(await runFmcFamilyEvolve(args({ action: "where_used", project_folders: [PROJ] }), toolIo(m)));
  assert.equal(r.read_only, true);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].open, false);
  assert.equal(m.writes.length, 0);
  assert.deepEqual(r.families, ["FMC_A_Door_SteelFanlight"]);
  const none = body(await runFmcFamilyEvolve(args({}), toolIo(m, false)));
  assert.equal(none.refused, true);
  assert.equal(planRepoint(V2, [], m) !== null, true);
  assert.match(repointToken(planRepoint(V2, [], m) as any), /^RP-/);
});