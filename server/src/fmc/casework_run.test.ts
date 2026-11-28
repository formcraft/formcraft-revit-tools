import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import { packNames } from "./casework.js";
import { exportReport, newRunId, standardsRevision } from "./casework_run.js";
import { FMC_CASEWORK_SHAPE, runFmcCasework } from "../tools/fmc_casework.js";

/** Run id, standards revision and the safe shop-PDF swap, offline: a stand-in for Revit and a kit in a temp folder. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../src/fmc/fixtures/cw_kitchen.json"), "utf8"));
const CODE = "F26901";
const LABEL = "K-01 Kitchen";
const SHOP = packNames(CODE, LABEL).shop;

interface Kit { root: string; project: string; folder: string; config: { config: GuardConfig; problem: string }; log: string }

/** A kit with standards (revision "r7"), the sheet register and the sheets rulebook, and a project folder that is the only write root. */
function kit(standards: unknown = { revision: "r7", ...FIX.standards }): Kit {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-cwrun-"));
  const md = path.join(root, "03_Master_Data");
  fs.mkdirSync(path.join(md, "FMC_Rulebook"), { recursive: true });
  fs.mkdirSync(path.join(root, "07_Materials"), { recursive: true });
  fs.writeFileSync(path.join(md, "FMC_Family_Specs.json"), "{}");
  fs.writeFileSync(path.join(root, "07_Materials", "FMC_Materials.json"), JSON.stringify({ materials: [] }));
  if (standards) fs.writeFileSync(path.join(md, "FMC_Casework_Standards.json"), JSON.stringify(standards));
  fs.writeFileSync(path.join(md, "FMC_Sheet_Register.csv"), [
    "Role,Discipline,SheetNumber,SheetName,Series,Scale,Core,IssueSet,Placed",
    "I,Interior Design,I-4001,Joinery: Kitchen,4xxx Enlarged plans and details,1:20,Core,TENDER+CONSTRUCTION,VT_I_Joinery",
    "I,Interior Design,I-5002,Joinery Cut List,5xxx Schedules,NTS,Optional,CONSTRUCTION,I11_Joinery_Cutlist",
  ].join("\n"));
  fs.writeFileSync(path.join(md, "FMC_Rulebook", "FMC_Rulebook_Sheets.json"), JSON.stringify({ rules: [
    { id: "SHT-011", check: { params: { family: "FMC_TitleBlock", types: ["A0", "A1", "A3"] } } },
    { id: "SHT-013", check: { params: { margin_left_mm: 20, margin_other_mm: 10 } } },
    { id: "SHT-014", check: { params: { drawing_area_mm: [681, 574] } } },
    { id: "SHT-017", check: { params: { a3_scale: 0.5 } } },
  ] }));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const reports = path.join(root, "reports");
  const config: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [project], reports_dir: reports, specs_path: path.join(md, "FMC_Family_Specs.json"),
    rulebooks_dir: path.join(md, "FMC_Rulebook"), materials_file: path.join(root, "07_Materials", "FMC_Materials.json") };
  return { root, project, folder: path.join(project, "01_WIP", "_Casework"), config: { config, problem: "" }, log: path.join(reports, "FMC_MCP_FileLog.csv") };
}

const done = (k: Kit) => fs.rmSync(k.root, { recursive: true, force: true });
const parse = (args: Record<string, unknown>) => z.object(FMC_CASEWORK_SHAPE).parse(args);
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const shopArgs = (k: Kit, over: Record<string, unknown> = {}) => parse({ action: "shop_drawings", run: FIX.run, label: LABEL, project_code: CODE,
  project_folder: k.project, sheets: ["I-4001"], dry_run: false, ...over });

/** Puts an old shop PDF in place and returns what it looks like before the run. */
function oldPdf(k: Kit, text = "OLD SHOP PDF") {
  fs.mkdirSync(k.folder, { recursive: true });
  const file = path.join(k.folder, SHOP);
  fs.writeFileSync(file, text);
  const t = new Date("2026-10-01T08:00:00Z");
  fs.utimesSync(file, t, t);
  return { file, bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs };
}
const untouched = (before: ReturnType<typeof oldPdf>) => {
  assert.ok(fs.existsSync(before.file), "the current PDF is still there");
  assert.ok(fs.readFileSync(before.file).equals(before.bytes), "its bytes are the same");
  assert.equal(fs.statSync(before.file).mtimeMs, before.mtimeMs, "its modified time is the same");
};
const folderFiles = (k: Kit) => fs.existsSync(k.folder) ? fs.readdirSync(k.folder).sort() : [];
const archived = (k: Kit) => { const d = path.join(k.folder, "_Archive"); return fs.existsSync(d) ? fs.readdirSync(d) : []; };

type Send = (command: string, payload: any, dry: boolean, ms: number) => Promise<unknown>;
/** Stands in for Revit: writes the PDF it was asked for (as Revit does: <file>.pdf in <folder>) and says it is done. */
const revitOk = (text = "NEW SHOP PDF", seen?: (p: any) => void): Send => async (_c, payload) => {
  seen?.(payload);
  if (payload.export) fs.writeFileSync(path.join(payload.export.folder, `${payload.export.file}.pdf`), text);
  return { dry_run: payload.dry_run, exported: payload.export ? { file: `${payload.export.file}.pdf`, result: "exported" } : null, rolled_back: false };
};

test("a run id is in every reply, in the right shape, and no two calls share one", async () => {
  const k = kit();
  try {
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const b = body(await runFmcCasework(parse({ action: "summary", run: FIX.run }), { config: k.config }));
      assert.match(b.run_id, /^CW-\d{8}T\d{6}-[0-9a-f]{6}$/);
      ids.add(b.run_id);
    }
    assert.equal(ids.size, 25, "25 calls in the same second still get 25 ids");
    assert.equal(newRunId(new Date(2026, 10, 28, 10, 45, 1)).slice(0, 18), "CW-20261128T104501");
    const refused = await runFmcCasework(parse({ action: "units" }), { config: k.config });
    assert.equal(refused.isError, true);
    assert.match(body(refused).run_id, /^CW-/, "a refusal carries it too");
    const room = await runFmcCasework(parse({ action: "room" }), { config: k.config });
    assert.match(body(room).run_id, /^CW-/, "even a call that stops before the standards");
  } finally { done(k); }
});

test("the run id goes into the file log rows of pack and shop_drawings, matching the reply", async () => {
  const k = kit();
  try {
    const pack = body(await runFmcCasework(parse({ action: "pack", run: FIX.run, label: LABEL, project_code: CODE, project_folder: k.project, dry_run: false }), { config: k.config }));
    assert.equal(pack.done, true);
    const shop = body(await runFmcCasework(shopArgs(k), { config: k.config, revit: revitOk() }));
    assert.notEqual(pack.run_id, shop.run_id);
    const rows = fs.readFileSync(k.log, "utf8").split(/\r?\n/).filter(Boolean);
    const rowOf = (id: string) => rows.filter((r) => r.includes(`run ${id}:`));
    assert.equal(rowOf(pack.run_id).length, 1);
    assert.match(rowOf(pack.run_id)[0], /casework_pack/);
    assert.equal(rowOf(shop.run_id).length, 1);
    assert.match(rowOf(shop.run_id)[0], /casework_shop/);
    assert.match(rowOf(shop.run_id)[0], /pdf exported/);
  } finally { done(k); }
});

test("the standards revision is returned: the file's own label, hashes, and whether the call changed the kit's values", async () => {
  const k = kit();
  try {
    const a = body(await runFmcCasework(parse({ action: "summary", run: FIX.run }), { config: k.config }));
    const r = a.standards_revision;
    assert.equal(r.label, "r7");
    assert.equal(r.kit_file_found, true);
    assert.match(r.kit_file, /FMC_Casework_Standards\.json$/);
    assert.match(r.kit_file_hash, /^[0-9a-f]{12}$/);
    assert.match(r.effective_hash, /^[0-9a-f]{12}$/);
    assert.match(r.kit_file_modified, /^\d{4}-\d\d-\d\dT/);
    assert.equal(r.call_overrides, false);
    assert.equal(r.from, a.standards_from);
    // the same standards again: the same revision
    const again = body(await runFmcCasework(parse({ action: "units", run: FIX.run }), { config: k.config })).standards_revision;
    assert.equal(again.effective_hash, r.effective_hash);
    // a call that changes a value: a different effective hash, the kit file's the same
    const over = body(await runFmcCasework(parse({ action: "summary", run: FIX.run, standards: { kerf: FIX.standards.kerf + 1 } }), { config: k.config })).standards_revision;
    assert.equal(over.call_overrides, true);
    assert.notEqual(over.effective_hash, r.effective_hash);
    assert.equal(over.kit_file_hash, r.kit_file_hash);
    // every action that used the standards says so, refusals after them too
    const pack = body(await runFmcCasework(parse({ action: "pack", run: FIX.run, label: LABEL, project_code: CODE, project_folder: k.project }), { config: k.config }));
    assert.equal(pack.standards_revision.effective_hash, r.effective_hash);
    const refusedPack = await runFmcCasework(parse({ action: "pack", run: FIX.run }), { config: k.config });
    assert.equal(refusedPack.isError, true);
    assert.equal(body(refusedPack).standards_revision.effective_hash, r.effective_hash);
    const shop = body(await runFmcCasework(shopArgs(k, { dry_run: true }), { config: k.config, revit: revitOk() }));
    assert.equal(shop.standards_revision.label, "r7");
  } finally { done(k); }
});

test("with no kit file the revision says so and hashes only the call's standards; a file with no label has label null", async () => {
  const none = kit(null);
  const unlabelled = kit(FIX.standards);
  try {
    const n = body(await runFmcCasework(parse({ action: "summary", run: FIX.run, standards: FIX.standards }), { config: none.config })).standards_revision;
    assert.equal(n.kit_file_found, false);
    assert.equal(n.kit_file_hash, null);
    assert.equal(n.kit_file_modified, null);
    assert.equal(n.label, null);
    assert.equal(n.from, "the call (the kit has none)");
    const u = body(await runFmcCasework(parse({ action: "summary", run: FIX.run }), { config: unlabelled.config })).standards_revision;
    assert.equal(u.label, null);
    assert.equal(u.kit_file_found, true);
    assert.equal(u.effective_hash, n.effective_hash, "the same values, wherever they came from, are the same standards");
    // nothing to report when the standards are missing: the refusal has a run id but no revision
    const missing = body(await runFmcCasework(parse({ action: "summary", run: FIX.run }), { config: none.config }));
    assert.ok(missing.refused);
    assert.equal(missing.standards_revision, undefined);
    assert.match(missing.run_id, /^CW-/);
  } finally { done(none); done(unlabelled); }
});

test("standardsRevision: key order doesn't change the hash; numbers and strings do", () => {
  const f = path.join(os.tmpdir(), "no-such-standards.json");
  const rev = (eff: unknown, kitJson: unknown = null) => standardsRevision({ kitFile: f, kitJson, effective: eff, from: "x", callOverrides: false });
  assert.equal(rev({ a: 1, b: { c: [1, 2], d: "x" } }).effective_hash, rev({ b: { d: "x", c: [1, 2] }, a: 1 }).effective_hash);
  assert.notEqual(rev({ a: 1 }).effective_hash, rev({ a: 2 }).effective_hash);
  assert.equal(rev({ a: 1 }, { rev: 12 }).label, "12");
  assert.equal(rev({ a: 1 }, { version: "2026.2" }).label, "2026.2");
  assert.equal(rev({ a: 1 }, { revision: { x: 1 } }).label, null);
});

test("a successful export archives the old PDF, and only after Revit has finished", async () => {
  const k = kit();
  try {
    const before = oldPdf(k);
    let atCall: { current: string; archive: string[]; pending: string[] } | null = null;
    const revit = revitOk("NEW SHOP PDF", (p) => {
      atCall = { current: fs.readFileSync(before.file, "utf8"), archive: archived(k), pending: folderFiles(k).filter((f) => f.includes("pending")) };
      assert.ok(p.export.file.includes(".pending-CW-"), "Revit is asked for a temporary file, not the current PDF's name");
      assert.notEqual(`${p.export.file}.pdf`, SHOP);
    });
    const r = await runFmcCasework(shopArgs(k), { config: k.config, revit });
    const b = body(r);
    assert.ok(!r.isError, JSON.stringify(b));
    assert.deepEqual(atCall, { current: "OLD SHOP PDF", archive: [], pending: [] }, "while Revit worked, the old PDF was still the current one and nothing was archived");
    assert.equal(fs.readFileSync(before.file, "utf8"), "NEW SHOP PDF", "the new export is now the current PDF");
    const arch = archived(k);
    assert.equal(arch.length, 1);
    assert.match(arch[0], new RegExp(`^\\d{8}-\\d{6}_${SHOP.replace(/[.]/g, "\\.")}$`));
    assert.equal(fs.readFileSync(path.join(k.folder, "_Archive", arch[0]), "utf8"), "OLD SHOP PDF", "the archived file is the old PDF, byte for byte");
    assert.deepEqual(folderFiles(k).filter((f) => f.includes("pending")), [], "no temporary file is left");
    assert.equal(b.pdf.export.state, "exported");
    assert.equal(b.pdf.export.archived, path.join(k.folder, "_Archive", arch[0]));
    assert.match(b.pdf.action, /only after a successful export/);
  } finally { done(k); }
});

test("a first export has nothing to archive and makes no _Archive folder", async () => {
  const k = kit();
  try {
    const b = body(await runFmcCasework(shopArgs(k), { config: k.config, revit: revitOk() }));
    assert.equal(b.pdf.action, "new");
    assert.equal(b.pdf.export.state, "exported");
    assert.equal(b.pdf.export.archived, undefined);
    assert.equal(fs.readFileSync(path.join(k.folder, SHOP), "utf8"), "NEW SHOP PDF");
    assert.deepEqual(archived(k), []);
    assert.ok(!fs.existsSync(path.join(k.folder, "_Archive")));
  } finally { done(k); }
});

/** The ways an export can fail: Revit says so, Revit throws, Revit rolls back, Revit says done but writes nothing. */
const FAILURES: Array<[string, Send, RegExp]> = [
  ["Revit reports the export failed (and left a half-written file)", async (_c, p) => {
    fs.writeFileSync(path.join(p.export.folder, `${p.export.file}.pdf`), "HALF");
    return { exported: { file: `${p.export.file}.pdf`, result: "failed: disk full" }, rolled_back: false };
  }, /disk full/],
  ["Revit says it didn't export", async () => ({ exported: { result: "Revit didn't export it" } }), /didn't export/],
  ["the connection to Revit throws", async (_c, p) => {
    fs.writeFileSync(path.join(p.export.folder, `${p.export.file}.pdf`), "HALF");
    throw new Error("Revit connection lost");
  }, /connection lost/],
  ["the changes were rolled back", async (_c, p) => ({ exported: { result: "exported" }, rolled_back: true, _p: p }), /rolled the changes back/],
  ["Revit says exported but no file is there", async () => ({ exported: { result: "exported" } }), /no PDF is there/],
  ["Revit reports no export at all", async () => ({ exported: null }), /no export/],
];

for (const [name, revit, why] of FAILURES) {
  test(`a failed export leaves the current PDF exactly as it was: ${name}`, async () => {
    const k = kit();
    try {
      const before = oldPdf(k);
      const r = await runFmcCasework(shopArgs(k), { config: k.config, revit });
      const b = body(r);
      assert.equal(r.isError, true);
      assert.match(b.error, why);
      assert.match(b.error, /left in place/);
      assert.match(b.run_id, /^CW-/);
      assert.equal(b.pdf.current_untouched, true);
      assert.equal(b.pdf.state, "failed");
      untouched(before);
      assert.deepEqual(archived(k), [], "nothing was archived");
      assert.ok(!fs.existsSync(path.join(k.folder, "_Archive")), "no _Archive folder was made");
      assert.deepEqual(folderFiles(k), [SHOP], "the folder holds the current PDF and nothing else (the temporary file is gone)");
      const row = fs.readFileSync(k.log, "utf8").split(/\r?\n/).filter((x) => x.includes(`run ${b.run_id}:`));
      assert.equal(row.length, 1, "the failure is logged under the run id");
    } finally { done(k); }
  });
}

test("a failed export with no earlier PDF leaves the folder without one", async () => {
  const k = kit();
  try {
    const r = await runFmcCasework(shopArgs(k), { config: k.config, revit: async () => ({ exported: { result: "failed: no" } }) });
    assert.equal(r.isError, true);
    assert.deepEqual(folderFiles(k), []);
  } finally { done(k); }
});

test("a second failure after a success keeps the first run's PDF; the archive holds only what the success moved", async () => {
  const k = kit();
  try {
    oldPdf(k, "ONE");
    await runFmcCasework(shopArgs(k), { config: k.config, revit: revitOk("TWO") });
    const two = { file: path.join(k.folder, SHOP), bytes: fs.readFileSync(path.join(k.folder, SHOP)) };
    const r = await runFmcCasework(shopArgs(k), { config: k.config, revit: async () => { throw new Error("boom"); } });
    assert.equal(r.isError, true);
    assert.ok(fs.readFileSync(two.file).equals(two.bytes));
    assert.equal(archived(k).length, 1);
    assert.equal(fs.readFileSync(path.join(k.folder, "_Archive", archived(k)[0]), "utf8"), "ONE");
  } finally { done(k); }
});

test("a dry run asks Revit for no export and touches nothing in the folder", async () => {
  const k = kit();
  try {
    const before = oldPdf(k);
    let payload: any;
    const b = body(await runFmcCasework(shopArgs(k, { dry_run: true }), { config: k.config, revit: revitOk("X", (p) => { payload = p; }) }));
    assert.equal(payload.export, null);
    assert.equal(b.dry_run, true);
    assert.match(b.pdf.action, /replace/);
    untouched(before);
    assert.deepEqual(folderFiles(k), [SHOP]);
  } finally { done(k); }
});

test("the temporary export must pass the folder guard like every other file", async () => {
  const k = kit();
  try {
    k.config.config.write_roots = [path.join(k.root, "elsewhere")];
    const r = await runFmcCasework(shopArgs(k), { config: k.config, revit: revitOk() });
    assert.equal(r.isError, true);
    assert.ok(body(r).refused);
    assert.ok(!fs.existsSync(k.folder), "nothing was made");
  } finally { done(k); }
});

test("exportReport reads what the add-in says", () => {
  assert.equal(exportReport({ exported: { result: "exported" } }).done, true);
  assert.equal(exportReport({ exported: { result: "exported" }, rolled_back: true }).done, false);
  assert.match(exportReport({ exported: { result: "failed: x" } }).why, /failed: x/);
  assert.equal(exportReport(null).done, false);
  assert.equal(exportReport("exported").done, false);
  assert.equal(exportReport({}).done, false);
});
