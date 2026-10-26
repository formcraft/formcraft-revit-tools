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
