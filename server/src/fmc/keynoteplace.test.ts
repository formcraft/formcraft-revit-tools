import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { keepCentral, keynoteSeedPath, pickSeed, planKeynotes } from "./keynoteplace.js";
import { FMC_KEYNOTE_PLACE_SHAPE, runFmcKeynotePlace, type FmcKeynotePlaceArgs } from "../tools/fmc_keynote_place.js";

function args(partial: Record<string, unknown>): FmcKeynotePlaceArgs {
  return z.object(FMC_KEYNOTE_PLACE_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

const doc = {
  title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  path: "D:\\Jobs\\_Staging\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt",
  is_central: false,
  views: [
    { id: "1", name: "Level 1", is_plan: true },
    { id: "2", name: "Level 2", is_plan: true },
    { id: "3", name: "Section A", is_plan: false },
  ],
  tags: [
    { id: "9", view_id: "1", view: "Level 1", host: "20", key: "A.WAL_01", key_source: "Element", tag_type: "Keynote Tag : Element", linked: true },
    { id: "8", view_id: "3", view: "Section A", host: "21", key: "", key_source: "Material", tag_type: "Keynote Tag : Material", linked: false },
  ],
  hosts: [
    { id: "20", category: "Walls", view_id: "1" },
    { id: "30", category: "Walls", view_id: "2" },
    { id: "31", category: "Doors", view_id: "2" },
    { id: "40", category: "Walls", view_id: "3" },
  ],
};

test("a linked element tag in any view is the seed, and each plan is copied", () => {
  assert.equal(pickSeed(doc.tags, "element")?.id, "9");
  assert.equal(pickSeed(doc.tags, "material"), null);
  const plan = planKeynotes(doc, { by: "element", views: "all_plans", categories: ["Walls"], seedPath: "Z:\\kit\\seed.rvt", seedExists: false });
  assert.equal(plan.seed.route, "document");
  assert.equal(plan.seed.id, "9");
  const level1 = plan.views.find((view) => view.view === "Level 1");
  const level2 = plan.views.find((view) => view.view === "Level 2");
  assert.equal(level1?.placed.length, 0);
  assert.equal(level1?.skipped[0]?.code, "FMC-KEYNOTE-ALREADY");
  assert.deepEqual(level2?.placed.map((row) => row.host), ["30"]);
  assert.equal(plan.views.some((view) => view.view === "Section A"), false);
});

test("no linked tag uses the kit seed, and a missing file is a precise code on every view", () => {
  const file = keynoteSeedPath("Z:\\00_Standards");
  assert.equal(file, "Z:\\00_Standards\\02_Keynotes\\Seeds\\FMC_Keynote_Seed.rvt");
  const bare = { ...doc, tags: [] };
  const missing = planKeynotes(bare, { by: "user", views: ["Level 2", "Missing"], categories: [], seedPath: file, seedExists: false });
  assert.equal(missing.code, "FMC-KEYNOTE-SEED-MISSING");
  assert.ok(missing.views.every((view) => view.skipped.some((row) => row.code === "FMC-KEYNOTE-SEED-MISSING" || row.code === "FMC-KEYNOTE-VIEW")));
  const ready = planKeynotes(bare, { by: "element", views: "all_plans", categories: ["Doors"], seedPath: file, seedExists: true });
  assert.equal(ready.seed.route, "kit");
  assert.equal(ready.seed.exists, true);
  assert.deepEqual(ready.views.find((view) => view.view === "Level 2")?.placed.map((row) => row.host), ["31"]);
  assert.equal(ready.views.find((view) => view.view === "Level 1")?.skipped[0]?.code, "FMC-KEYNOTE-NO-HOST");
});

test("one tag per keynote value sits on the central element, off the wall, clear of existing tags", () => {
  const hosts = [
    { id: "1", category: "Walls", view_id: "1", key: "A.WAL_01", x: 0, y: 0, nx: 0, ny: 1, half_mm: 100 },
    { id: "2", category: "Walls", view_id: "1", key: "A.WAL_01", x: 1000, y: 0, nx: 0, ny: 1, half_mm: 100 },
    { id: "4", category: "Walls", view_id: "1", key: "A.WAL_01", x: 4000, y: 0, nx: 0, ny: 1, half_mm: 100 },
    { id: "3", category: "Walls", view_id: "1", key: "A.WAL_02", x: 1000, y: 5000, nx: 0, ny: 1, half_mm: 50 },
  ];
  const reduced = keepCentral(hosts, true);
  assert.deepEqual(reduced.kept.map((row) => row.id).sort(), ["2", "3"]);
  assert.deepEqual(reduced.dropped.map((row) => row.id).sort(), ["1", "4"]);
  const crowded = {
    ...doc,
    hosts,
    tags: [{
      id: "9", view_id: "1", view: "Level 1", host: "99", key: "A.WAL_09", key_source: "Element", tag_type: "Keynote Tag : Element", linked: true,
      min_x: 1800, min_y: 400, max_x: 2800, max_y: 1200,
    }],
  };
  const plan = planKeynotes(crowded, { by: "element", views: ["Level 1"], categories: ["Walls"], seedPath: "Z:\\kit\\seed.rvt", seedExists: true, one_per_key: true, leader: true, offset_mm: 600 });
  const level = plan.views.find((view) => view.view === "Level 1");
  assert.equal(plan.counts.one_per_key, 2);
  assert.ok(level?.skipped.some((row) => row.code === "FMC-KEYNOTE-ONE-PER-KEY" && row.host === "1"));
  const central = level?.placed.find((row) => row.host === "2");
  assert.equal(central?.leader, true);
  assert.equal(central?.head_mm?.[0], 1000);
  assert.equal(central?.head_mm?.[1], 700);
  assert.equal(plan.counts.collision_moved >= 0, true);
  assert.ok((plan.counts.placed + plan.counts.one_per_key + plan.counts.collision_blocked) >= 2);
});

test("dry run does not apply, and a write needs a lease and references", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-keynote-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG, protected_paths: ["D:\\Live"] };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_KEYNOTE_DIR: path.join(dir, "keynote") } as NodeJS.ProcessEnv;
  let applied = 0;
  const read = async () => ({ documents: [doc] });
  const dry = textOf(await runFmcKeynotePlace(args({ document: doc.title, by: "element", categories: ["Walls"] }), { read, apply: async () => { applied += 1; return {}; }, env, guard, kitRoot: "Z:\\00_Standards", seedExists: () => false }));
  assert.equal(dry.isError, false);
  assert.equal(dry.dry_run, true);
  assert.equal(applied, 0);
  assert.equal(dry.seed && (dry.seed as { route: string }).route, "document");
  const noLease = textOf(await runFmcKeynotePlace(args({ document: doc.title, by: "element", categories: ["Walls"], dry_run: false }), { read, env, guard, kitRoot: "Z:\\00_Standards", seedExists: () => false }));
  assert.equal(noLease.code, "FMC-BATCH-LOCKED");
  const noRefs = textOf(await runFmcKeynotePlace(args({ document: doc.title, by: "element", categories: ["Walls"], dry_run: false, batch_lease: "lease-1" }), { read, env, guard, kitRoot: "Z:\\00_Standards", seedExists: () => false }));
  assert.equal(noRefs.code, "FMC-KEYNOTE-REFERENCES");
  const hebert = textOf(await runFmcKeynotePlace(args({
    document: "HEBERT HOSTELS", by: "element", dry_run: false, batch_lease: "lease-1",
    references: { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] },
  }), {
    read: async () => ({ documents: [{ ...doc, title: "HEBERT HOSTELS", path: "D:\\Live\\HEBERT HOSTELS.rvt" }] }),
    apply: async () => { applied += 1; return {}; },
    env, guard, kitRoot: "Z:\\00_Standards", seedExists: () => false,
  }));
  assert.equal(hebert.code, "FMC-KEYNOTE-GUARD");
  assert.equal(applied, 0);
  const ok = textOf(await runFmcKeynotePlace(args({
    document: doc.title, by: "element", categories: ["Walls"], dry_run: false, batch_lease: "lease-1",
    references: { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] },
  }), { read, apply: async (body) => { applied += 1; return { ok: true, views: body.views }; }, env, guard, kitRoot: "Z:\\00_Standards", seedExists: () => false }));
  assert.equal(ok.isError, false);
  assert.equal(ok.dry_run, false);
  assert.equal(applied, 1);
  assert.equal((ok.applied as { ok: boolean }).ok, true);
});

test("the read is not a write command and the apply is", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_keynote_place"));
  assert.ok(WRITE_COMMANDS.has("fmc_keynote_place_apply"));
  assert.ok(!WRITE_COMMANDS.has("fmc_keynote_place"));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((row) => row.commandName));
  for (const name of ["fmc_keynote_place", "fmc_keynote_place_apply", "fmc_sheets_layout", "fmc_sheets_layout_apply", "fmc_viewstyle", "fmc_viewstyle_apply", "fmc_dims", "fmc_dims_apply"]) {
    assert.ok(names.has(name), name);
  }
});

test("research 53: NOTHING_TO_PLACE status with a summary line, seed check, and the real tag size", async () => {
  const { tagSize } = await import("./keynoteplace.js");
  const sized = { ...doc, tags: [{ ...doc.tags[0], min_x: 0, min_y: 0, max_x: 2000, max_y: 800 }, doc.tags[1]] };
  assert.deepEqual(tagSize(sized.tags, "element", sized.tags[0]), { width: 2000, height: 800, source: "seed" });
  assert.deepEqual(tagSize(doc.tags, "element", null), { width: 900, height: 450, source: "default" });
  const plan = planKeynotes(sized, { by: "element", views: "all_plans", categories: ["Walls"], seedPath: "Z:\\kit\\seed.rvt", seedExists: false });
  assert.equal(plan.tag_size.source, "seed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kp53-"));
  const env = { ...process.env, FMC_KEYNOTE_DIR: dir } as NodeJS.ProcessEnv;
  const bare = { ...doc, tags: [] };
  const none = textOf(await runFmcKeynotePlace(args({ document: doc.title, by: "user" }), { read: async () => ({ documents: [bare] }), env, guard: DEFAULT_CONFIG as GuardConfig, kitRoot: "Z:\\00_Standards", seedExists: () => false }));
  assert.equal(none.status, "NOTHING_TO_PLACE");
  assert.equal(none.summary, "0 of 2 views can be tagged, 0 tags planned: seed missing.");
  assert.equal(none.seed_check.ok, false);
  assert.equal(none.seed_check.linked_in_model, false);
  assert.match(none.seed_check.how_to, /Place one keynote tag/);
  const some = textOf(await runFmcKeynotePlace(args({ document: doc.title, by: "element", categories: ["Walls"] }), { read: async () => ({ documents: [doc] }), env, guard: DEFAULT_CONFIG as GuardConfig, kitRoot: "Z:\\00_Standards", seedExists: () => false }));
  assert.equal(some.status, "PLANNED");
  assert.equal(some.seed_check.ok, true);
  assert.equal(some.seed_check.how_to, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("P-fmc_keynote_place-02: a missing seed is NOTHING_TO_PLACE with ok false and the reason", async () => {
  const { placeStatus } = await import("./keynoteplace.js");
  const seedless = placeStatus("FMC-KEYNOTE-SEED-MISSING", { hosts: 21, placed: 0, skipped: 21 });
  assert.equal(seedless.status, "NOTHING_TO_PLACE");
  assert.equal(seedless.ok, false);
  assert.match(seedless.status_reason, /K-02/);
  assert.equal(placeStatus(undefined, { hosts: 3, placed: 2, skipped: 1 }).status, "PLANNED");
});
