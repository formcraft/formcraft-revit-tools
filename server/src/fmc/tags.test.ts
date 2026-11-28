import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { planTags, tagsZeroCauses, type TagSnapshot } from "./tags.js";
import { FMC_TAGS_SHAPE, runFmcTags, type FmcTagsArgs } from "../tools/fmc_tags.js";

function args(partial: Record<string, unknown>): FmcTagsArgs {
  return z.object(FMC_TAGS_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

const types = [
  { category: "Doors", id: "t1", name: "FMC_TAG_Door: Number" },
  { category: "Windows", id: "t2", name: "FMC_TAG_Window: Mark" },
  { category: "Rooms", id: "t3", name: "FMC_TAG_Room: Name" },
];

const snapshot: TagSnapshot = {
  title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  path: "D:\\Jobs\\_Staging\\F26901.rvt",
  sheets: [
    { id: "s1", number: "A101", name: "Level 1", issued: true, view_ids: ["v1", "v3"] },
    { id: "s2", number: "A102", name: "Level 2", issued: false, view_ids: ["v2"] },
  ],
  tag_types: types,
  views: [
    {
      id: "v1", name: "Level 1", is_floor_plan: true, sheet_ids: ["s1"],
      elements: [
        { id: "d1", category: "Doors", x: 1000, y: 2000, source: "host" },
        { id: "d2", category: "Doors", x: 1000, y: 2000, source: "link", link_id: "L1", link_name: "Arch" },
        { id: "w1", category: "Windows", x: 4000, y: 2000, source: "host" },
        { id: "r1", category: "Rooms", x: 2500, y: 2500, source: "link", link_id: "L1", placed: true },
        { id: "r0", category: "Rooms", x: 0, y: 0, source: "host", placed: false },
      ],
      tagged: [{ id: "w1", link_id: "" }],
      tags: [{ id: "tg", kind: "independent", min_x: 700, min_y: 1800, max_x: 1600, max_y: 2300 }],
      diagnosis: { doors_in_document: 4, doors_in_view: 1, doors_in_links: 3, doors_owner_view_match: 0, rooms_in_links: 2, rooms_in_view: 0, is_floor_plan: true },
    },
    {
      id: "v2", name: "Level 2", is_floor_plan: true, sheet_ids: ["s2"],
      elements: [{ id: "d9", category: "Doors", x: 0, y: 0, source: "host" }],
      diagnosis: { is_floor_plan: true, doors_in_view: 1, doors_owner_view_match: 0, doors_in_document: 1 },
    },
    {
      id: "v3", name: "Section A", is_floor_plan: false, sheet_ids: ["s1"],
      elements: [{ id: "d1", category: "Doors", x: 0, y: 0, source: "host" }],
      diagnosis: { is_floor_plan: false, doors_in_document: 4, doors_in_view: 0, doors_owner_view_match: 0 },
    },
  ],
};

test("a host-only script returns 0 when the doors are in a link, and rooms are not IndependentTags", () => {
  const causes = tagsZeroCauses({
    doors_in_document: 6,
    doors_in_view: 0,
    doors_in_links: 6,
    doors_owner_view_match: 0,
    rooms_in_links: 2,
    is_floor_plan: true,
  }, 0);
  assert.match(causes.join(" "), /linked document/);
  assert.match(causes.join(" "), /OwnerViewId/);
  assert.match(causes.join(" "), /NewRoomTag/);
  const notPlan = tagsZeroCauses({ is_floor_plan: false, doors_in_view: 0 }, 0);
  assert.match(notPlan.join(" "), /not a floor plan/);
  assert.deepEqual(tagsZeroCauses({ doors_in_links: 3, doors_in_view: 0 }, 2), []);
});

test("issued floor plans are tagged, links and rooms included, overlaps shift, sections are refused", () => {
  const plan = planTags(snapshot, { views: "all_sheets", categories: ["Doors", "Windows", "Rooms"] });
  assert.equal(plan.views.some((view) => view.view === "Level 2"), false);
  assert.ok(plan.skipped.some((row) => row.code === "FMC-TAGS-NOT-PLAN" && row.view === "Section A"));
  const level = plan.views.find((view) => view.view === "Level 1");
  const placed = level?.placed ?? [];
  assert.ok(placed.some((row) => row.element === "d2" && row.source === "link" && row.kind === "independent"));
  assert.ok(placed.some((row) => row.element === "r1" && row.kind === "room" && row.link_id === "L1"));
  assert.ok(level?.skipped.some((row) => row.element === "w1" && row.code === "FMC-TAGS-ALREADY"));
  assert.ok(level?.skipped.some((row) => row.element === "r0" && row.code === "FMC-TAGS-UNPLACED"));
  const door = placed.find((row) => row.element === "d1");
  assert.ok(door && (door.x !== 1000 || door.y !== 2000), "the host door moves off the existing tag box");
  const bare = planTags({ ...snapshot, tag_types: [] }, { views: "all_sheets", categories: ["Doors", "Windows", "Rooms"] });
  assert.equal(bare.placed, 0);
  assert.match(bare.why_zero.join(" "), /NewRoomTag/);
  assert.match(bare.why_zero.join(" "), /OwnerViewId/);
  const named = planTags(snapshot, { views: ["A102"], categories: ["Doors"] });
  assert.ok(named.skipped.some((row) => row.code === "FMC-TAGS-NOT-ISSUED"));
});

test("dry run does not apply, and a write needs a lease and references", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-tags-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_TAGS_DIR: path.join(dir, "tags") } as NodeJS.ProcessEnv;
  let applied = 0;
  const read = async () => snapshot;
  const dry = textOf(await runFmcTags(args({ document: snapshot.title }), { read, apply: async () => { applied += 1; return {}; }, env, guard }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.leaders, false);
  assert.equal(applied, 0);
  assert.ok(Array.isArray(dry.tags));
  const refused = textOf(await runFmcTags(args({ document: snapshot.title, dry_run: false }), { read, env, guard }));
  assert.equal(refused.code, "FMC-BATCH-LOCKED");
  const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] };
  const done = textOf(await runFmcTags(args({ document: snapshot.title, dry_run: false, batch_lease: "lease-1", references: refs }), {
    read,
    apply: async () => { applied += 1; return { ok: true, views: [{ view_id: "v1", tag_ids: ["900", "901"] }] }; },
    env,
    guard,
  }));
  assert.equal(applied, 1);
  assert.equal(done.dry_run, false);
  const level = (done.tags as Array<{ view_id: string; tag_ids: string[] }>).find((row) => row.view_id === "v1");
  assert.deepEqual(level?.tag_ids, ["900", "901"]);
});

test("the tag read is not a write and the apply is", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_tags"));
  assert.ok(WRITE_COMMANDS.has("fmc_tags_apply"));
  assert.ok(!WRITE_COMMANDS.has("fmc_tags"));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((row) => row.commandName));
  assert.ok(names.has("fmc_tags") && names.has("fmc_tags_apply"));
});
