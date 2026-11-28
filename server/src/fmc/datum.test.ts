import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { duplicates, gridLabels, mergeResults, originOf, planDimensions, planGrids, planLevels, planPoints, toInternal, uniqueName, type DatumSnapshot } from "./datum.js";
import { isBlankTagText } from "./tags.js";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { runCreateGrid } from "../tools/create_grid.js";
import { runCreateLevel } from "../tools/create_level.js";
import { runCreateDimensions } from "../tools/create_dimensions.js";
import { runCreatePointBasedElement } from "../tools/create_point_based_element.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.resolve(here, "../../src/fmc/fixtures/placement_cases.json"), "utf8"));

function body(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

const snap: DatumSnapshot = {
  title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  base_point: { x: 10000, y: -5000, z: 1500 },
  grids: [{ id: "g1", name: "A" }, { id: "g2", name: "1" }],
  levels: [{ id: "l1", name: "Level 1", elevation_mm: 1500 }, { id: "l2", name: "Level 2", elevation_mm: 4500 }],
  views: [
    { id: "100", name: "Level 1", view_type: "FloorPlan", can_dimension: true },
    { id: "200", name: "{3D}", view_type: "ThreeD", can_dimension: false },
  ],
  instances: [{ id: "i1", type_id: "77", x: 11000, y: -4000, z: 1500 }],
};

const grid = {
  xCount: 3, xSpacing: 6000, xStartLabel: "B", xNamingStyle: "alphabetic",
  yCount: 2, ySpacing: 5000, yStartLabel: "2", yNamingStyle: "numeric",
  xExtentMin: 0, xExtentMax: 20000, yExtentMin: 0, yExtentMax: 15000,
  elevation: 0, xStartPosition: 0, yStartPosition: 0,
};

test("parity with the C# core: grid labels, duplicate names, unique names, blank tag text", () => {
  for (const c of cases.labels) assert.deepEqual(gridLabels(c.count, c.start, c.style), c.want, `labels ${c.start}/${c.style}`);
  for (const c of cases.duplicates) assert.deepEqual(duplicates(c.requested, c.existing), c.want, `duplicates ${c.requested}`);
  for (const c of cases.unique) assert.equal(uniqueName(c.base, new Set(c.existing)), c.want);
  for (const c of cases.blank) assert.equal(isBlankTagText(c.text), c.want, `blank ${JSON.stringify(c.text)}`);
});

test("project base point: coordinates move by the base point; internal_origin leaves them", () => {
  assert.deepEqual(originOf(snap, "project_base_point"), { x: 10000, y: -5000, z: 1500 });
  assert.deepEqual(originOf(snap, "internal_origin"), { x: 0, y: 0, z: 0 });
  assert.equal(originOf({}, "project_base_point"), null);
  assert.deepEqual(toInternal({ x: 1, y: 2, z: 3 }, { x: 10, y: 20, z: 30 }), { x: 11, y: 22, z: 33 });
});

test("grids: names, internal positions, duplicates are errors, rename is explicit, a cap", () => {
  const origin = originOf(snap, "project_base_point")!;
  const plan = planGrids(grid, snap, origin, "error");
  assert.equal(plan.items.length, 5);
  assert.equal(plan.errors, 0);
  assert.deepEqual(plan.items.map((row) => row.name), ["B", "C", "D", "2", "3"]);
  assert.equal(plan.items[1].position_internal_mm, 16000);
  assert.equal(plan.params.xStartPosition, 10000);
  assert.equal(plan.params.yExtentMax, 10000);
  assert.equal(plan.params.elevation, 1500);
  assert.equal(plan.params.onDuplicate, "error");
  const clash = planGrids({ ...grid, xStartLabel: "A", yStartLabel: "1" }, snap, origin, "error");
  assert.equal(clash.errors, 2);
  assert.ok(clash.items.filter((row) => row.status === "error").every((row) => row.code === "FMC-GRID-DUPLICATE"));
  const renamed = planGrids({ ...grid, xStartLabel: "A" }, snap, origin, "rename");
  assert.equal(renamed.errors, 0);
  assert.equal(renamed.items[0].status, "would_rename");
  assert.equal(renamed.items[0].name, "A1");
  const many = planGrids({ ...grid, xCount: 150, yCount: 60 }, snap, origin, "error");
  assert.ok(many.items.every((row) => row.code === "FMC-GRID-TOO-MANY"));
});

test("levels: duplicate names and equal heights are errors; reuse is explicit; elevations from the base point", () => {
  const origin = originOf(snap, "project_base_point")!;
  const plan = planLevels([{ name: "Level 3", elevation: 6000 }, { name: "level 1", elevation: 9000 }, { name: "Roof", elevation: 3000 }, { name: "Level 3", elevation: 12000 }], snap, origin, "error");
  assert.equal(plan.items[0].status, "would_create");
  assert.equal(plan.items[0].elevation_internal_mm, 7500);
  assert.equal(plan.items[1].code, "FMC-LEVEL-DUPLICATE");
  assert.equal(plan.items[2].code, "FMC-LEVEL-SAME-ELEVATION");
  assert.equal(plan.items[3].code, "FMC-LEVEL-DUPLICATE");
  assert.equal(plan.errors, 3);
  const reuse = planLevels([{ name: "Level 2", elevation: 3000 }], snap, origin, "reuse");
  assert.equal(reuse.items[0].status, "would_reuse");
  assert.equal(reuse.onDuplicate, "reuse");
  const twice = planLevels([{ name: "A", elevation: 100 }, { name: "B", elevation: 100.5 }], snap, origin, "error");
  assert.equal(twice.items[1].code, "FMC-LEVEL-SAME-ELEVATION");
});

test("dimensions: view required and dimensionable, no zero length, two refs or none, no repeats", () => {
  const origin = originOf(snap, "project_base_point")!;
  const p = (x: number, y: number) => ({ x, y, z: 0 });
  const plan = planDimensions([
    { startPoint: p(0, 0), endPoint: p(5000, 0), viewId: 100, elementIds: [1, 2] },
    { startPoint: p(0, 0), endPoint: p(5000, 0), viewId: -1 },
    { startPoint: p(0, 0), endPoint: p(5000, 0), viewId: 200 },
    { startPoint: p(0, 0), endPoint: p(0, 0), viewId: 100 },
    { startPoint: p(0, 0), endPoint: p(5000, 0), viewId: 100, elementIds: [1] },
    { startPoint: p(0, 0), endPoint: p(5000, 0), viewId: 100, elementIds: [2, 1] },
    { startPoint: p(0, 0), endPoint: p(5000, 0), viewId: 999 },
  ], snap, origin);
  assert.deepEqual(plan.items.map((row) => row.code ?? row.status), [
    "would_create", "FMC-DIM-VIEW-REQUIRED", "FMC-DIM-VIEW-TYPE", "FMC-DIM-ZERO", "FMC-DIM-REFS", "FMC-DIM-DUPLICATE", "FMC-DIM-VIEW",
  ]);
  assert.deepEqual(plan.dimensions[0].startPoint, { x: 10000, y: -5000, z: 1500 });
});

test("placement: a standing instance or a repeat is FMC-PLACE-DUPLICATE; points and base level move by the base point", () => {
  const origin = originOf(snap, "project_base_point")!;
  const plan = planPoints([
    { typeId: 77, locationPoint: { x: 1000, y: 1000, z: 0 }, baseLevel: 0 },
    { typeId: 77, locationPoint: { x: 3000, y: 1000, z: 0 }, baseLevel: 0 },
    { typeId: 77, locationPoint: { x: 3005, y: 1000, z: 0 }, baseLevel: 0 },
    { typeId: 78, locationPoint: { x: 1000, y: 1000, z: 0 }, baseLevel: 0 },
  ], snap, origin);
  assert.deepEqual(plan.items.map((row) => row.code ?? row.status), ["FMC-PLACE-DUPLICATE", "would_create", "FMC-PLACE-DUPLICATE", "would_create"]);
  assert.deepEqual(plan.data[0].locationPoint, { x: 13000, y: -4000, z: 1500 });
  assert.equal(plan.data[0].baseLevel, 1500);
});

test("results: one row per input; refused rows keep their code; unreported rows are unknown", () => {
  const plan = [
    { index: 0, status: "would_create" as const },
    { index: 1, status: "error" as const, code: "FMC-DIM-ZERO" },
    { index: 2, status: "would_create" as const },
  ];
  const merged = mergeResults(plan, [0, 2], { Success: true, Items: [{ index: 0, status: "created", id: 55 }] });
  assert.equal(merged[0].status, "created");
  assert.equal(merged[0].id, 55);
  assert.equal(merged[1].code, "FMC-DIM-ZERO");
  assert.equal(merged[2].status, "unknown");
});

test("tools: dry run is the default and writes nothing; an error refuses the write; a write reports per item", async () => {
  let writes = 0;
  const io = (answer: unknown) => ({ read: async () => snap, write: async (command: string, sent: Record<string, unknown>) => { writes++; return typeof answer === "function" ? (answer as (c: string, b: Record<string, unknown>) => unknown)(command, sent) : answer; } });
  const dry = body(await runCreateGrid({ ...grid }, io({})));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.items.length, 5);
  assert.equal(writes, 0);
  const blocked = body(await runCreateGrid({ ...grid, xStartLabel: "A", dry_run: false }, io({})));
  assert.equal(blocked.code, "FMC-DATUM-BLOCKED");
  assert.equal(blocked.isError, true);
  assert.equal(writes, 0);
  let sentBody: Record<string, any> = {};
  const done = body(await runCreateGrid({ ...grid, dry_run: false, document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER" }, io((_c: string, b: Record<string, unknown>) => {
    sentBody = b;
    return { Success: true, Items: [0, 1, 2, 3, 4].map((i) => ({ index: i, status: "created", id: 900 + i })) };
  })));
  assert.equal(writes, 1);
  assert.equal(sentBody.document, "F26901-FMC-ZZ-ZZ-M3-A-0002_USER");
  assert.equal(sentBody.xStartPosition, 10000);
  assert.equal(done.ok, true);
  assert.equal(done.summary.created, 5);
  const internal = body(await runCreateLevel({ data: [{ name: "Level 3", elevation: 6000 }], dry_run: false, relative_to: "internal_origin" }, io((_c: string, b: Record<string, any>) => {
    sentBody = b;
    return { Success: true, Items: [{ index: 0, status: "created", id: 5 }] };
  })));
  assert.equal(sentBody.data[0].elevation, 6000);
  assert.equal(sentBody.onDuplicate, "error");
  assert.equal(internal.ok, true);
  const dims = body(await runCreateDimensions({ dimensions: [{ startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 1000, y: 0, z: 0 }, viewId: 100 }], dry_run: false }, io({ Success: true, Response: [1] })));
  assert.equal(dims.ok, false, "an add-in answer with no items is not taken as success");
  assert.equal(dims.items[0].status, "unknown");
  const before = writes;
  const place = body(await runCreatePointBasedElement({ data: [{ typeId: 78, locationPoint: { x: 0, y: 0, z: 0 }, baseLevel: 0 }] }, io({ Success: true, Items: [{ index: 0, status: "created", id: 42 }] })));
  assert.equal(writes, before + 1, "placement keeps its old default: it writes unless dry_run is true");
  assert.equal(place.items[0].id, 42);
  const failedRead = body(await runCreateGrid({ ...grid }, { read: async () => { throw new Error("Unknown command fmc_datum_read"); } }));
  assert.equal(failedRead.code, "FMC-DATUM-READ");
});

test("the datum read is a read, and the add-in knows it", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_datum_read"));
  assert.ok(!WRITE_COMMANDS.has("fmc_datum_read"));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.ok(manifest.commands.some((row) => row.commandName === "fmc_datum_read"));
});
