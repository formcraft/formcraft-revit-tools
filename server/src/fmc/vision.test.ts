import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readInbox } from "../tools/fmc_ai.js";
import { touchedIds } from "../tools/see_view.js";

test("after-picture (owner 26 Oct): the ids a batch made or named, not the ones it deleted", () => {
  const ops = [{ op: "attach", ids: [11, 12], target: 40 }, { op: "create_roof" }, { op: "move", ids: ["$2"] }];
  const answer = { ops: [{ created_ids: [] }, { created_ids: [99] }, {}] };
  assert.deepEqual(touchedIds(ops, answer).sort((a, b) => a - b), [11, 12, 40, 99]);
});

test("Send to AI inbox: unread items come with their picture once, then they're read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-inbox-"));
  fs.writeFileSync(path.join(dir, "a1.json"), JSON.stringify({ id: "a1", at: "2026-10-26T10:00:00Z", note: "this wall is doubled", ids: [5, 6], view: "GF Plan", read: false }));
  fs.writeFileSync(path.join(dir, "a1.png"), Buffer.from([137, 80, 78, 71]));
  const first = readInbox(dir);
  assert.equal(first.content[1].type, "image");
  const facts = JSON.parse((first.content[0] as { text: string }).text);
  assert.equal(facts.unread, 1);
  assert.equal(facts.shown[0].note, "this wall is doubled");
  const again = JSON.parse((readInbox(dir).content[0] as { text: string }).text);
  assert.equal(again.unread, 0);
});

test("Ogala report: queued calls are counted apart from failures; dry runs need no approval", async () => {
  const { summariseUsage } = await import("./usage.js");
  const at = "2026-10-26T12:00:00Z";
  const s = summariseUsage([{ at, tool: "modify_model", action: "", ms: 100, ok: false, build: "b1", queued: true },
    { at, tool: "modify_model", action: "", ms: 100, ok: false, build: "b1" }, { at, tool: "modify_model", action: "", ms: 100, ok: true, build: "b1" }]) as any;
  const b = s.by_build[0];
  assert.equal(b.failures, 1);
  assert.equal(b.queued, 1);

  const { aiGate } = await import("./aigate.js");
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dry-"));
  const env = { ...process.env, APPDATA: appdata };
  const config = { live_model_lock: true, write_roots: [], library_roots: [], reports_dir: path.join(appdata, "r"), rulebooks_dir: path.join(appdata, "k"),
    ai_modeller: { on: true, mode: "testing", access: "full", projects: { "THE OGALA RESIDENCE": { general: true } } } } as any;
  const doc = { title: "OGL_A_MainHouse", path: path.win32.join("D:", "P", "THE OGALA RESIDENCE", "01_WIP", "OGL_A_MainHouse.rvt"), isFamily: false, isWorkshared: false } as any;
  const g = await aiGate("fmc_model_edit", { ops: [{ op: "delete", ids: [1] }], dry_run: true }, doc, config, async () => ({}), env);
  assert.equal(g.ok, true, g.user ?? g.reason);
});

test("coded session rules (owner 26 Oct): failures with reasons; auto-save only after the interval, never workshared", async () => {
  const { failures } = await import("./usage.js");
  const at = "2026-10-26T12:00:00Z";
  const f = failures([{ at, tool: "modify_model", action: "", ms: 1, ok: false, build: "b", error: "Value cannot be null." },
    { at, tool: "modify_model", action: "", ms: 1, ok: false, build: "b", error: "Value cannot be null." },
    { at, tool: "modify_model", action: "", ms: 1, ok: false, build: "b", queued: true }]);
  assert.equal(f.failures, 2);
  assert.deepEqual([f.list[0].error, f.list[0].times], ["Value cannot be null.", 2]);

  const { autoSave } = await import("./aigate.js");
  const sent: string[] = [];
  const send = async (c: string) => { sent.push(c); return {}; };
  const doc = { title: "M", path: "D:\\P\\01_WIP\\M.rvt", isFamily: false, isWorkshared: false, isActive: true } as any;
  const later = Date.now() + 11 * 60_000;
  assert.equal(await autoSave(doc, { mode: "testing" }, send, {}, Date.now()), false, "not yet");
  const r: any = {};
  assert.equal(await autoSave(doc, { mode: "testing" }, send, r, later), true);
  assert.ok(r.auto_saved);
  assert.equal(await autoSave({ ...doc, path: "D:\\P\\01_WIP\\W.rvt", isWorkshared: true }, { mode: "testing" }, send, {}, later), false, "never workshared");
  assert.equal(await autoSave({ ...doc, path: "D:\\P\\01_WIP\\S.rvt" }, { mode: "strict" }, send, {}, later), false, "off outside testing unless set");
  assert.deepEqual(sent, ["fmc_revit_file"]);
});

test("FAM-044 (owner 26 Oct): family lines are black or dark on the rule's pens; pale colours and pen 1 parts are refused", async () => {
  const { fixSubcategory, graphicsProblems, lightness } = await import("./familygraphics.js");
  const white = { op: "add_subcategory" as const, name: "White", color: [242, 242, 238], line_weight_projection: 1 };
  assert.equal(graphicsProblems(white, "op 1").length, 2, "pale colour and pen 1");
  assert.deepEqual(fixSubcategory(white), { ...white, color: [0, 0, 0], line_weight_projection: 2, line_weight_cut: 4 });
  assert.deepEqual(fixSubcategory({ op: "add_subcategory", name: "Coarse Envelope", color: [120, 130, 140] }).line_weight_projection, 3);
  const zone = fixSubcategory({ op: "add_subcategory", name: "Clearance Operation", color: [255, 214, 90] });
  assert.ok(lightness(zone.color!) <= 0.45 && zone.line_weight_projection === 1, "a clearance stays thin, its colour darkened");
  assert.deepEqual(graphicsProblems({ ...white, keep_graphics: true }, "op 1"), [], "a deliberate exception");
});
