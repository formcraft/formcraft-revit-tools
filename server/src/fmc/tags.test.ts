import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { auditTags, freePoint, isBlankTagText, kitTypeForScale, loadTagScaleRules, planTags, tagSize, tagsZeroCauses, type TagScaleRules, type TagSnapshot } from "./tags.js";
import { FMC_TAGS_SHAPE, appliedItems, runFmcTags, type FmcTagsArgs } from "../tools/fmc_tags.js";

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
  const dry = textOf(await runFmcTags(args({ document: snapshot.title }), { read, apply: async () => { applied += 1; return {}; }, env, guard, kitRoot: "" }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.leaders, false);
  assert.equal(applied, 0);
  assert.ok(Array.isArray(dry.tags));
  const refused = textOf(await runFmcTags(args({ document: snapshot.title, dry_run: false }), { read, env, guard, kitRoot: "" }));
  assert.equal(refused.code, "FMC-BATCH-LOCKED");
  const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] };
  const done = textOf(await runFmcTags(args({ document: snapshot.title, dry_run: false, batch_lease: "lease-1", references: refs }), {
    read,
    apply: async () => { applied += 1; return { ok: true, views: [{ view_id: "v1", tag_ids: ["900", "901"] }] }; },
    env,
    guard,
    kitRoot: "",
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

const rules: TagScaleRules = {
  schema: "fmc-tag-scale/0.1",
  status: "PROVISIONAL",
  rules: [
    { category: "Rooms", max_scale: 100, tag_type: "FMC_TAG_Room: Name" },
    { category: "Rooms", min_scale: 101, tag_type: "FMC_TAG_Room: Number only" },
    { category: "Doors", tag_type: "FMC_TAG_Door: Number" },
  ],
  paper_box_mm: { Doors: [10, 5] },
};

function scaled(scale: number): TagSnapshot {
  return {
    ...snapshot,
    views: [{ ...snapshot.views![0], scale, tags: [], tagged: [] }],
  };
}

test("bulk: scope reaches unissued and unplaced-on-sheet plans in one call, and max_views caps it", () => {
  const issued = planTags(snapshot, { views: "all_sheets", categories: ["Doors"] });
  assert.ok(!issued.views.some((view) => view.view === "Level 2"));
  const anySheet = planTags(snapshot, { views: "all_sheets", categories: ["Doors"], scope: "any_sheet" });
  assert.ok(anySheet.views.some((view) => view.view === "Level 2"));
  const named = planTags(snapshot, { views: ["A101", "A102", "Level 2"], categories: ["Doors"], scope: "any_sheet" });
  assert.deepEqual(named.views.map((view) => view.view).sort(), ["Level 1", "Level 2"]);
  const capped = planTags(snapshot, { views: "all_sheets", categories: ["Doors"], scope: "any_plan", max_views: 1 });
  assert.equal(capped.views.length, 1);
  assert.ok(capped.skipped.some((row) => row.code === "FMC-TAGS-TOO-MANY-VIEWS"));
});

test("kit tag type by view scale, and a kit type that is not loaded is an error, not a fallback", () => {
  assert.equal(kitTypeForScale(rules, "Rooms", 50), "FMC_TAG_Room: Name");
  assert.equal(kitTypeForScale(rules, "Rooms", 200), "FMC_TAG_Room: Number only");
  assert.equal(kitTypeForScale(rules, "Windows", 100), null);
  const at50 = planTags(scaled(50), { views: "all_sheets", categories: ["Doors", "Rooms", "Windows"], scale_rules: rules });
  const level = at50.views[0];
  const room = level.placed.find((row) => row.element === "r1");
  assert.equal(room?.tag_type, "FMC_TAG_Room: Name");
  assert.equal(room?.type_source, "kit_scale");
  const door = level.placed.find((row) => row.element === "d1");
  assert.equal(door?.type_source, "kit_scale");
  const win = level.placed.find((row) => row.element === "w1");
  assert.equal(win?.type_source, "first");
  const at200 = planTags(scaled(200), { views: "all_sheets", categories: ["Rooms"], scale_rules: rules });
  assert.ok(at200.views[0].skipped.some((row) => row.element === "r1" && row.code === "FMC-TAGS-KIT-TYPE-MISSING"));
  const forced = planTags(scaled(200), { views: "all_sheets", categories: ["Rooms"], scale_rules: rules, tag_types: { Rooms: "FMC_TAG_Room: Name" } });
  assert.equal(forced.views[0].placed[0]?.type_source, "argument");
  assert.deepEqual(tagSize(50, "Doors", rules), [500, 250]);
  assert.deepEqual(tagSize(100, "Rooms", rules), [900, 450]);
});

test("overlap: shifts grow with the scale, keep off obstacles and other elements, stay in the crop", () => {
  const box = { min_x: 700, min_y: 1800, max_x: 1600, max_y: 2300 };
  const at100 = freePoint(1000, 2000, [box], { scale: 100 });
  assert.ok(!("blocked" in at100) && at100.moved);
  const at200 = freePoint(1000, 2000, [box], { scale: 200, size: [1800, 900] });
  assert.ok(!("blocked" in at200));
  if (!("blocked" in at100) && !("blocked" in at200)) {
    assert.ok(Math.abs(at200.offset[0]) + Math.abs(at200.offset[1]) > Math.abs(at100.offset[0]) + Math.abs(at100.offset[1]));
  }
  const crop = { min_x: 0, min_y: 0, max_x: 1100, max_y: 1100 };
  const out = freePoint(5000, 5000, [], { scale: 100, crop });
  assert.deepEqual(out, { blocked: "crop" });
  const view = {
    id: "v9", name: "L9", is_floor_plan: true, sheet_ids: ["s9"], scale: 100,
    obstacles: [{ id: "n1", kind: "text", min_x: 500, min_y: 500, max_x: 1500, max_y: 1500 }],
    elements: [
      { id: "d5", category: "Doors", x: 1000, y: 1000, source: "host" as const },
      { id: "d6", category: "Doors", x: 3000, y: 1000, source: "host" as const, min_x: 2400, min_y: 600, max_x: 3600, max_y: 1400 },
      { id: "d7", category: "Doors", x: 3000, y: 1000, source: "host" as const },
      { id: "d5", category: "Doors", x: 1000, y: 1000, source: "host" as const },
    ],
  };
  const plan = planTags({ sheets: [{ id: "s9", number: "A109", issued: true, view_ids: ["v9"] }], views: [view], tag_types: types }, { views: "all_sheets", categories: ["Doors"] });
  const rows = plan.views[0];
  const d5 = rows.placed.find((row) => row.element === "d5");
  assert.ok(d5 && d5.moved, "d5 moves off the text note");
  const d7 = rows.placed.find((row) => row.element === "d7");
  assert.ok(d7 && d7.moved, "d7 moves off door d6's own box");
  assert.ok(rows.skipped.some((row) => row.element === "d5" && row.code === "FMC-TAGS-DUPLICATE"));
  assert.equal(rows.items.length, 4, "every element in scope has one row");
  assert.equal(plan.items, 4);
});

test("audit: missing tags and blank tags, read only", () => {
  assert.equal(isBlankTagText(""), true);
  assert.equal(isBlankTagText("  "), true);
  assert.equal(isBlankTagText("?"), true);
  assert.equal(isBlankTagText("D-01"), false);
  assert.equal(isBlankTagText(undefined), false);
  const snap: TagSnapshot = {
    ...snapshot,
    views: [{
      ...snapshot.views![0],
      tags: [
        { id: "t10", kind: "independent", category: "Doors", element: "d9", text: "", min_x: 0, min_y: 0, max_x: 1, max_y: 1 },
        { id: "t11", kind: "room", text: "101 Office", min_x: 0, min_y: 0, max_x: 1, max_y: 1 },
        { id: "t12", kind: "independent", category: "Windows", element: "w1", text: "?", min_x: 0, min_y: 0, max_x: 1, max_y: 1 },
      ],
    }],
  };
  const audit = auditTags(snap, { views: "all_sheets", categories: ["Doors", "Windows", "Rooms"] });
  const level = audit.views[0];
  assert.deepEqual(level.missing.map((row) => row.element).sort(), ["d1", "d2", "r1"]);
  assert.deepEqual(level.unplaced_rooms, ["r0"]);
  assert.deepEqual(level.blank.map((row) => row.tag_id).sort(), ["t10", "t12"]);
  assert.equal(audit.missing, 3);
  assert.equal(audit.blank, 2);
  const doorsOnly = auditTags(snap, { views: "all_sheets", categories: ["Doors"] });
  assert.deepEqual(doorsOnly.views[0].blank.map((row) => row.tag_id), ["t10"]);
});

test("mode plan is a preview: no write, no report, even with dry_run false; mode audit never writes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-tags-plan-"));
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_TAGS_DIR: path.join(dir, "tags") } as NodeJS.ProcessEnv;
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  let applied = 0;
  const apply = async () => { applied += 1; return {}; };
  const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] };
  const plan = textOf(await runFmcTags(args({ document: snapshot.title, mode: "plan", dry_run: false, batch_lease: "lease-1", references: refs }), { read: async () => snapshot, apply, env, guard, kitRoot: "" }));
  assert.equal(plan.plan_only, true);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.report, "");
  assert.equal(applied, 0);
  assert.equal(fs.existsSync(path.join(dir, "tags")), false);
  assert.ok(plan.items > 0);
  let readBody: Record<string, unknown> = {};
  const audit = textOf(await runFmcTags(args({ document: snapshot.title, mode: "audit", dry_run: false, batch_lease: "lease-1", references: refs }), {
    read: async (body) => { readBody = body; return snapshot; }, apply, env, guard, kitRoot: "",
  }));
  assert.equal(readBody.audit, true);
  assert.equal(audit.read_only, true);
  assert.equal(applied, 0);
  assert.equal(typeof audit.missing, "number");
});

test("scale rules load from the named file or the kit; a broken named file is an error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-tagscale-"));
  fs.mkdirSync(path.join(dir, "03_Master_Data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "03_Master_Data", "FMC_TagScale.json"), JSON.stringify({ ...rules, status: "" }));
  const kit = loadTagScaleRules({ kitRoot: dir, env: {} });
  assert.equal(kit.source, "kit");
  assert.equal(kit.provisional, false);
  assert.equal(loadTagScaleRules({ kitRoot: "", env: {} }).source, "none");
  assert.throws(() => loadTagScaleRules({ file: path.join(dir, "nope.json"), env: {} }), /FMC-TAGS-SCALE-RULES/);
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_TAGS_DIR: path.join(dir, "tags") } as NodeJS.ProcessEnv;
  const res = textOf(await runFmcTags(args({ document: snapshot.title, categories: ["Rooms"] }), { read: async () => scaled(200), env, guard: { ...DEFAULT_CONFIG }, kitRoot: dir }));
  assert.equal(res.scale_rules.source, "kit");
  assert.ok(res.views[0].skipped.some((row: { code: string }) => row.code === "FMC-TAGS-KIT-TYPE-MISSING"));
});

test("after a write every planned tag has a row: placed, failed or unknown, and no tag id is guessed", () => {
  const views = [{ view: "Level 1", view_id: "v1", placed: [
    { element: "d1", link_id: "", category: "Doors" },
    { element: "d2", link_id: "L1", category: "Doors" },
    { element: "w9", link_id: "", category: "Windows" },
  ] }, { view: "Level 3", view_id: "v3", placed: [{ element: "d3", link_id: "", category: "Doors" }] }];
  const out = appliedItems(views, { views: [{ view_id: "v1", tag_ids: ["900"], items: [
    { element: "d1", link_id: "", status: "placed", tag_id: "900" },
    { element: "d2", link_id: "L1", status: "failed", code: "FMC-TAGS-ALREADY", reason: "already" },
  ] }] });
  assert.equal(out.placed, 1);
  assert.equal(out.failed, 1);
  assert.equal(out.unknown, 2);
  assert.equal(out.items.length, 4);
  assert.deepEqual(out.tags.find((row) => row.view_id === "v3")?.tag_ids, []);
  const old = appliedItems(views.slice(0, 1), { views: [{ view_id: "v1" }] });
  assert.deepEqual(old.tags[0].tag_ids, [], "an older add-in answer is not turned into element ids");
});
