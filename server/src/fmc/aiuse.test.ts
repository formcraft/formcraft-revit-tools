import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { AiModellerConfig, aiVerdict, batchKey, batchSize, parseConfig, parseRulebook, recordBatch, today } from "./aiuse.js";

// The proposed kit rulebook is the fixture, so the tests follow what the kit would hold.
const here = path.dirname(fileURLToPath(import.meta.url));
const proposal = fs.readFileSync(path.join(here, "..", "..", "..", "docs", "kit-proposals", "FMC_Rulebook_AIUse.json"), "utf8");
const book = parseRulebook(proposal).book!;

const cfg: GuardConfig = { ...DEFAULT_CONFIG, write_roots: ["D:\\Projects\\*\\01_WIP"] };
const wip = (title = "F26001-FMC-ZZ-ZZ-M3-A-0001", workshared = true, isLocal: boolean | undefined = true) => ({
  title, path: `D:\\Projects\\F26001\\01_WIP\\A\\${title}_jo.rvt`, isFamily: false, isWorkshared: workshared, isLocal,
});
const ai = (o: Partial<AiModellerConfig> = {}): AiModellerConfig => ({ on: true, stop: false, projects: {}, levels: {}, ...o });
const empty = { day: "", models: {} };
const ask = (command: string, o: object = {}) => ({ command, doc: wip(), elements: 3, approved: false, ...o });

test("the proposed kit rulebook reads cleanly", () => {
  assert.deepEqual(parseRulebook(proposal).problems, []);
  assert.equal(book.default_involvement, 20);
  assert.match(parseRulebook('{"schema":"x"}').problems.join(" "), /schema must be/);
});

test("Off unless the guard section and the kit rulebook both exist; Stop AI refuses everything", () => {
  assert.match(aiVerdict(ask("tag_rooms"), cfg, book, null, empty).reasons[0], /no valid ai_modeller section/);
  assert.match(aiVerdict(ask("tag_rooms"), cfg, null, ai(), empty).reasons[0], /no valid FMC_Rulebook_AIUse/);
  assert.match(aiVerdict(ask("tag_rooms"), cfg, book, ai({ stop: true, levels: { views: "Auto in WIP" } }), empty).reasons[0], /Stop AI is on/);
  assert.equal(parseConfig({ on: "yes" }), null);
});

test("never: structure, levels, grids, deleting, arbitrary code and links, at any level", () => {
  const all = ai({ involvement: 100, levels: { views: "Auto in WIP" } });
  for (const c of ["create_level", "create_grid", "create_structural_framing_system", "delete_element", "send_code_to_revit", "fmc_link_add", "create_line_based_element"])
    assert.match(aiVerdict(ask(c), cfg, book, all, empty).reasons[0], /AI never runs/, c);
});

test("only a person's local WIP copy: never a central model, never outside WIP", () => {
  const on = ai({ levels: { views: "Auto in WIP" } });
  assert.match(aiVerdict(ask("tag_rooms", { doc: wip(undefined, true, false) }), cfg, book, on, empty).reasons[0], /central model/);
  const { isLocal: _unknown, ...noLocal } = wip();
  assert.match(aiVerdict(ask("tag_rooms", { doc: noLocal }), cfg, book, on, empty).reasons[0], /central model/, "unknown counts as central");
  const shared = { ...wip(), path: "D:\\Projects\\F26001\\02_Shared\\A\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt" };
  assert.match(aiVerdict(ask("tag_rooms", { doc: shared }), cfg, book, on, empty).reasons[0], /isn't in a WIP folder/);
  assert.ok(aiVerdict(ask("tag_rooms", { doc: { ...noLocal, isWorkshared: false } }), cfg, book, on, empty).ok, "a non-workshared WIP file is the author's own");
});

test("the BIM Manager's switch, per project, and the involvement bands", () => {
  assert.match(aiVerdict(ask("tag_rooms"), cfg, book, ai({ on: false, levels: { views: "Auto in WIP" } }), empty).reasons[0], /off for F26001/);
  assert.ok(aiVerdict(ask("tag_rooms"), cfg, book, ai({ on: false, projects: { F26001: { on: true } }, levels: { views: "Auto in WIP" } }), empty).ok);
  assert.match(aiVerdict(ask("tag_rooms"), cfg, book, ai({ involvement: 0 }), empty).reasons[0], /involvement is 0%/);
  // fixtures unlock at Co-model (21-50), not at the default 20%
  assert.equal(book.groups.fixtures.name, "Fixtures and devices");
});

test("Suggest by default; Fix with approval waits for a person; Auto only where the rulebook allows it", () => {
  assert.match(aiVerdict(ask("tag_rooms"), cfg, book, ai(), empty).reasons[0], /at Suggest/);
  const fix = aiVerdict(ask("create_room"), cfg, book, ai({ levels: { create_from_brief: "Fix with approval" } }), empty);
  assert.equal(fix.needs_approval, true);
  assert.ok(aiVerdict(ask("create_room", { approved: true }), cfg, book, ai({ levels: { create_from_brief: "Fix with approval" } }), empty).ok);
  assert.match(aiVerdict(ask("create_room"), cfg, book, ai({ levels: { create_from_brief: "Auto in WIP" } }), empty).reasons[0], /may not run as Auto in WIP/);
  assert.ok(aiVerdict(ask("tag_rooms"), cfg, book, ai({ levels: { views: "Auto in WIP" } }), empty).ok);
});

test("structural models stay at 5%: data and views only", () => {
  const s = wip("F26001-FMC-ZZ-ZZ-M3-S-0001");
  const on = ai({ involvement: 100, levels: { views: "Auto in WIP", create_from_brief: "Fix with approval" } });
  assert.ok(aiVerdict(ask("tag_rooms", { doc: s }), cfg, book, on, empty).ok);
  assert.match(aiVerdict(ask("create_room", { doc: s, approved: true }), cfg, book, on, empty).reasons[0], /isn't unlocked at 5% for S models/);
});

test("limits: batch size, the day's total, and three failed batches switch AI off for the model", () => {
  const on = ai({ levels: { views: "Auto in WIP" } });
  assert.match(aiVerdict(ask("tag_rooms", { elements: 51 }), cfg, book, on, empty).reasons[0], /limit is 50/);
  const busy = { day: today(), models: { [wip().path.toLowerCase()]: { elements: 480, failed: 0, off: false } } };
  assert.match(aiVerdict(ask("tag_rooms", { elements: 30 }), cfg, book, on, busy).reasons[0], /today's limit of 500/);
  let st = empty as ReturnType<typeof recordBatch>;
  for (let i = 0; i < 3; i++) st = recordBatch(st, wip().path, 5, true, book);
  assert.match(aiVerdict(ask("tag_rooms"), cfg, book, on, st).reasons[0], /switched off/);
  assert.match(aiVerdict(ask("tag_rooms"), cfg, book, on, { ...st, day: "2000-01-01" }).reasons[0] ?? "ok", /ok/, "a new day starts clean");
});

test("an approval matches only the same batch: same command, model and parameters, in any key order", () => {
  const a = batchKey("create_room", { rooms: [1, 2], level: "L1" }, "D:\\P\\01_WIP\\M.rvt");
  assert.equal(batchKey("create_room", { level: "L1", rooms: [1, 2], document: "M" }, "d:\\p\\01_wip\\m.rvt"), a);
  assert.notEqual(batchKey("create_room", { rooms: [1, 2, 3], level: "L1" }, "D:\\P\\01_WIP\\M.rvt"), a);
  assert.equal(batchSize({ data: [{}, {}, {}], view: 4 }), 3);
  assert.equal(batchSize({}), 1);
});

test("the gate: queues a Fix-with-approval batch, runs it once approved, refuses structure when placing", async () => {
  const { aiGate } = await import("./aigate.js");
  const { setStatus, readQueue } = await import("./aiuse_io.js");
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-ai-"));
  const kit = path.join(appdata, "kit");
  fs.mkdirSync(kit);
  fs.writeFileSync(path.join(kit, "FMC_Rulebook_AIUse.json"), proposal);
  const env = { ...process.env, APPDATA: appdata };
  const config = { ...cfg, rulebooks_dir: kit, reports_dir: path.join(appdata, "reports"),
    ai_modeller: { on: true, levels: { create_from_brief: "Fix with approval" } } } as unknown as GuardConfig;
  const send = async () => ({ types: [{ id: 7, found: true, category: "OST_Doors" }, { id: 8, found: true, category: "OST_StructuralColumns" }] });

  const params = { data: [{ typeId: 7 }] };
  const first = await aiGate("create_point_based_element", params, wip(), config, send, env);
  assert.equal(first.ok, false);
  assert.match(first.reason, /waiting in the approval queue as ([0-9a-f]{8})/);
  const id = readQueue(env)[0].id;
  setStatus(id, "approved", "j.okello", env);
  const second = await aiGate("create_point_based_element", params, wip(), config, send, env);
  assert.equal(second.ok, true);
  assert.equal(await second.run!(async () => "placed"), "placed");
  assert.equal(readQueue(env)[0].status, "used");
  assert.ok(fs.readFileSync(path.join(appdata, "reports", "FMC_AI_Modeller_Log.csv"), "utf8").includes("j.okello"));

  const column = { data: [{ typeId: 8 }] };
  setStatus((await aiGate("create_point_based_element", column, wip(), config, send, env), readQueue(env).find((q) => q.status === "pending")!.id), "approved", "j.okello", env);
  const refused = await aiGate("create_point_based_element", column, wip(), config, send, env);
  assert.match(refused.reason, /type 8 isn't a door, window/);

  // No ai_modeller section at all: the gate adds nothing, the lock's refusal stands as it always did.
  assert.deepEqual(await aiGate("tag_rooms", {}, wip(), cfg, send, env), { ok: false, reason: "" });
});
