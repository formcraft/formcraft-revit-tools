import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { familyDocumentOf, buildReport, hoursSince, idleLimit, markStale, openProblems, saveProblems } from "./doc.js";

const cfg: GuardConfig = {
  ...DEFAULT_CONFIG,
  template_roots: ["C:\\ProgramData\\Autodesk\\RVT 2025\\Family Templates"],
  library_roots: ["D:\\Kit\\04_Families\\_Staging", "D:\\Kit\\04_Families\\_ChainTests"],
  write_roots: ["D:\\Kit\\04_Families\\_Staging", "D:\\Kit\\04_Families\\_ChainTests"],
};
const RFT = "C:\\ProgramData\\Autodesk\\RVT 2025\\Family Templates\\English\\Metric Generic Model.rft";

test("open: family templates from the template roots, or family files from staging only", () => {
  assert.deepEqual(openProblems({ template: RFT }, cfg), []);
  assert.deepEqual(openProblems({ file: "D:\\Kit\\04_Families\\_Staging\\P\\FMC_P_EQ_WaterHeater.rfa" }, cfg), []);
  assert.match(openProblems({ template: "C:\\Temp\\x.rft" }, cfg)[0], /template folder/);
  assert.match(openProblems({ template: "C:\\ProgramData\\Autodesk\\RVT 2025\\Templates\\Metric.rte" }, cfg)[0], /project templates come in B5/);
  assert.match(openProblems({ file: "Z:\\Projects\\F26001\\01_WIP\\A\\model.rvt" }, cfg)[0], /only family files/);
  assert.match(openProblems({ file: "Z:\\Live\\FMC_A_Door.rfa" }, cfg)[0], /staging files only/);
  assert.match(openProblems({}, cfg)[0], /needs a family template/);
});

test("save: an .rfa inside the write roots", () => {
  assert.deepEqual(saveProblems("D:\\Kit\\04_Families\\_ChainTests\\FMC_P_EQ_WaterHeater.rfa", cfg), []);
  assert.match(saveProblems("D:\\Kit\\04_Families\\_ChainTests\\x.rvt", cfg)[0], /saved as \.rfa/);
  assert.ok(saveProblems("C:\\Temp\\FMC_P_EQ_WaterHeater.rfa", cfg).some((r) => /Not inside an allowed write folder/.test(r)));
});

test("the build report: same ops give the same hash", () => {
  const s = { id: "a1", source: RFT, opened: "", ops: [{ op: "add_ref_plane", name: "Left", result: "create" }] };
  const a = buildReport(s, "D:\\x\\FMC_P_EQ_WaterHeater.rfa", { category: "Generic Models", parameters: [1, 2], solids: 1 }, { kit: "2.2", revision: "r4" }, "abc1234", new Date());
  const b = buildReport({ ...s }, "D:\\y\\FMC_P_EQ_WaterHeater.rfa", {}, {}, "def", new Date());
  assert.equal(a.ops_hash, b.ops_hash);
  assert.equal(a.kit, "2.2 r4");
  assert.equal(a.result.parameters, 2);
  assert.equal(a.source, "Metric Generic Model.rft");
});

test("F-046: sessions idle longer than the guard's limit (default 12 h) are marked stale", () => {
  assert.equal(DEFAULT_CONFIG.session_idle_hours, 12);
  assert.equal(idleLimit(DEFAULT_CONFIG), 12);
  assert.equal(idleLimit({ session_idle_hours: 4 }), 4);
  assert.equal(idleLimit({ session_idle_hours: -1 }), 12, "a bad value falls back to 12");
  assert.equal(idleLimit({ session_idle_hours: "x" as unknown as number }), 12);

  const now = new Date("2026-10-15T12:00:00Z");
  const marked = markStale([
    { id: "a", opened: "2026-10-14T11:31:00Z", used: "2026-10-14T11:40:00Z" }, // the audit's oldest: a day idle
    { id: "b", opened: "2026-10-15T11:00:00Z" },                               // older ledger entry: opened only
    { id: "c", idle_minutes: 12 * 60 + 6 },                                    // the add-in's own count wins
    { id: "d" },                                                               // nothing known: never stale
  ], now, 12);
  assert.deepEqual(marked.map((s) => [s.id, s.idle_hours, s.stale]), [["a", 24.3, true], ["b", 1, false], ["c", 12.1, true], ["d", null, false]]);
  assert.equal(marked[0].stale_after_hours, 12);
  assert.equal(hoursSince("not a time", now), null);
});

test("familyDocumentOf prefers the saved path and falls back to the title", () => {
  assert.equal(familyDocumentOf({ title: "Family1", path: "C:\\Staging\\P\\Tank.rfa" }), "C:\\Staging\\P\\Tank.rfa");
  assert.equal(familyDocumentOf({ title: "FMC_P_PlumbingEq_Tank_Poly_Elevated", path: "" }), "FMC_P_PlumbingEq_Tank_Poly_Elevated");
  assert.equal(familyDocumentOf({ title: "  ", path: "  " }), "");
  assert.equal(familyDocumentOf(undefined), "");
});

test("familyDocumentOf uses the opened .rfa path when the add-in has not yet returned a path", () => {
  const file = "C:\\Staging\\P\\Existing.rfa";
  assert.equal(familyDocumentOf({ title: "Existing", path: "" }, file), file);
  assert.equal(familyDocumentOf({ title: "Existing", path: "C:\\Staging\\P\\Saved.rfa" }, file), "C:\\Staging\\P\\Saved.rfa");
  assert.equal(familyDocumentOf(undefined, file), file);
  assert.equal(familyDocumentOf({ title: "Existing" }, "  "), "Existing");
});

// ---------- research tool 36: list checks the ledger against Revit ----------
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { pruneLedger, reconcileLedger, writeLedger, readLedger } from "./doc.js";
import { runFmcDoc, FMC_DOC_SHAPE } from "../tools/fmc_doc.js";
import { z } from "zod";

const ledgerOf = () => ({
  "65033519": { id: "65033519", source: "Metric Profile.rft", opened: "2026-11-26T08:00:00Z", ops: [] },
  "a2": { id: "a2", source: "Metric Profile.rft", opened: "2026-11-26T08:05:00Z", ops: [] },
  "live": { id: "live", source: "Generic.rft", opened: new Date().toISOString(), ops: [] },
});

test("reconcileLedger marks entries Revit no longer holds, and Revit-only sessions", () => {
  const r = reconcileLedger(ledgerOf(), [{ session: "live" }, { session: "other" }, {}]);
  assert.equal(r.revit_checked, true);
  assert.deepEqual(r.sessions.map((s) => [s.id, s.in_revit]), [["65033519", false], ["a2", false], ["live", true]]);
  assert.deepEqual(r.not_in_revit, ["65033519", "a2"]);
  assert.deepEqual(r.revit_only, ["other"]);
});

test("reconcileLedger with no Revit answer calls nothing dead", () => {
  const r = reconcileLedger(ledgerOf(), null);
  assert.equal(r.revit_checked, false);
  assert.deepEqual(r.not_in_revit, []);
  assert.ok(r.sessions.every((s) => s.in_revit === null));
  assert.deepEqual(Object.keys(pruneLedger(ledgerOf(), ["a2"])), ["65033519", "live"]);
});

const docArgs = (extra: Record<string, unknown>) => z.object(FMC_DOC_SHAPE).parse({ action: "list", ...extra });
const tmpCfg = () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "fmc-doc-ledger-"));
  writeLedger(dir, ledgerOf());
  return { dir, cfg: { ...cfg, reports_dir: dir } };
};
const bodyOf = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

test("fmc_doc list (live bug): ledger sessions Revit doesn't hold come back in_revit false", async () => {
  const { dir, cfg: c } = tmpCfg();
  const body = bodyOf(await runFmcDoc(docArgs({}), { config: c, background: async () => ({ ok: true, sessions: [{ session: "live" }], other_background: [] }) }));
  assert.equal(body.revit_checked, true);
  assert.deepEqual(body.not_in_revit, ["65033519", "a2"]);
  assert.deepEqual(body.sessions.map((s: { id: string; in_revit: boolean }) => [s.id, s.in_revit]), [["65033519", false], ["a2", false], ["live", true]]);
  assert.match(body.next, /2 ledger entries Revit no longer holds/);
  assert.deepEqual(body.pruned, []);
  assert.equal(Object.keys(readLedger(dir)).length, 3, "list without prune never writes the ledger");
});

test("fmc_doc list prune drops only the dead entries, and only after Revit answered", async () => {
  const { dir, cfg: c } = tmpCfg();
  const failed = bodyOf(await runFmcDoc(docArgs({ prune: true }), { config: c, background: async () => { throw new Error("no answer"); } }));
  assert.equal(failed.revit_checked, false);
  assert.match(failed.note, /Revit didn't answer/);
  assert.equal(Object.keys(readLedger(dir)).length, 3, "no prune without Revit's answer");
  const body = bodyOf(await runFmcDoc(docArgs({ prune: true }), { config: c, background: async () => ({ sessions: [{ session: "live" }] }) }));
  assert.deepEqual(body.pruned, ["65033519", "a2"]);
  assert.deepEqual(body.sessions.map((s: { id: string }) => s.id), ["live"]);
  assert.deepEqual(Object.keys(readLedger(dir)), ["live"]);
});

test("fmc_doc list check_revit false reads the ledger only", async () => {
  const { cfg: c } = tmpCfg();
  let asked = false;
  const body = bodyOf(await runFmcDoc(docArgs({ check_revit: false }), { config: c, background: async () => { asked = true; return {}; } }));
  assert.equal(asked, false);
  assert.equal(body.revit_checked, false);
  assert.equal(body.sessions.length, 3);
});
