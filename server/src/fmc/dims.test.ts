import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { isExterior, planDims } from "./dims.js";
import { FMC_DIMS_SHAPE, runFmcDims, type FmcDimsArgs } from "../tools/fmc_dims.js";

function args(partial: Record<string, unknown>): FmcDimsArgs {
  return z.object(FMC_DIMS_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

const grids = [
  { id: "g1", name: "1", x0: 0, y0: 0, x1: 0, y1: 10000 },
  { id: "g2", name: "2", x0: 6000, y0: 0, x1: 6000, y1: 10000 },
  { id: "gA", name: "A", x0: 0, y0: 0, x1: 8000, y1: 0 },
  { id: "gB", name: "B", x0: 0, y0: 4000, x1: 8000, y1: 4000 },
];
const walls = [
  { id: "w1", name: "North", function: "exterior", x0: 0, y0: 0, x1: 8000, y1: 0 },
  { id: "w2", name: "Partition", function: "interior", x0: 2000, y0: 0, x1: 2000, y1: 4000 },
];
const openings = [{ id: "d1", host_id: "w1", x: 3000, y: 0, width_mm: 900 }];

test("grid chains are ordered, exterior walls carry openings, and interior walls are skipped", () => {
  assert.equal(isExterior("Exterior"), true);
  assert.equal(isExterior("interior"), false);
  const plan = planDims({ grids, walls, openings, targets: ["grids", "walls", "openings"], chain: true, offset_mm: 600 });
  const vertical = plan.strings.find((row) => row.kind === "grids" && row.references.some((ref) => ref.id === "g1"));
  assert.deepEqual(vertical?.references.map((ref) => ref.id), ["g1", "g2"]);
  assert.equal(vertical?.line.y0, 10600);
  assert.equal(vertical?.line.y1, 10600);
  assert.ok((vertical?.line.x1 ?? 0) > (vertical?.line.x0 ?? 0));
  const wall = plan.strings.find((row) => row.kind === "walls");
  assert.deepEqual(wall?.references.map((ref) => ref.role), ["wall_start", "opening", "wall_end"]);
  assert.equal(wall?.line.y0, 600);
  assert.equal(wall?.line.x1, 8000);
  assert.ok(plan.skipped.some((row) => row.id === "w2" && row.code === "FMC-DIMS-NOT-EXTERIOR"));
  const pairs = planDims({ grids: grids.slice(0, 2), walls: [], openings: [], targets: ["grids"], chain: false, offset_mm: 600 });
  assert.equal(pairs.strings.length, 1);
  assert.equal(pairs.strings[0]?.references.length, 2);
  const one = planDims({ grids: [grids[0]], walls: [], openings: [], targets: ["grids"], chain: true, offset_mm: 600 });
  assert.equal(one.skipped[0]?.code, "FMC-DIMS-NEED-PAIR");
  const jambs = planDims({ grids: [], walls: [walls[0]], openings, targets: ["openings"], chain: true, offset_mm: 400 });
  assert.equal(jambs.strings[0]?.kind, "openings");
  assert.deepEqual(jambs.strings[0]?.references.map((ref) => ref.id), ["d1"]);
});

test("interior partitions chain across the run, and rooms get two clear dimensions", () => {
  const partitions = [
    { id: "p1", function: "interior", x0: 0, y0: 0, x1: 0, y1: 4000 },
    { id: "p2", function: "interior", x0: 3000, y0: 0, x1: 3000, y1: 4000 },
  ];
  const interior = planDims({ walls: partitions, openings: [], targets: ["interior"], chain: true, offset_mm: 600 });
  assert.equal(interior.skipped.some((row) => row.code === "FMC-DIMS-NOT-EXTERIOR"), false);
  const chain = interior.strings.find((row) => row.kind === "interior");
  assert.deepEqual(chain?.references.map((ref) => ref.id), ["p1", "p2"]);
  assert.equal(chain?.references[0]?.role, "wall_side");
  const withWalls = planDims({ walls, openings: [], targets: ["walls", "interior"], chain: true, offset_mm: 600 });
  assert.equal(withWalls.skipped.some((row) => row.id === "w2" && row.code === "FMC-DIMS-NOT-EXTERIOR"), false);
  const rooms = planDims({
    walls: [], openings: [], targets: ["rooms"], chain: true, offset_mm: 600,
    rooms: [{
      id: "r1", name: "Bedroom", x: 1500, y: 2000,
      bounds: [
        { wall_id: "wl", side: "left", x: 0, y: 2000, nx: 1, ny: 0 },
        { wall_id: "wr", side: "right", x: 3000, y: 2000, nx: -1, ny: 0 },
        { wall_id: "wb", side: "bottom", x: 1500, y: 0, nx: 0, ny: 1 },
        { wall_id: "wt", side: "top", x: 1500, y: 4000, nx: 0, ny: -1 },
      ],
    }],
  });
  assert.equal(rooms.strings.length, 2);
  assert.ok(rooms.strings.every((row) => row.kind === "rooms"));
  assert.deepEqual(rooms.strings[0]?.references.map((ref) => ref.role), ["room_side", "room_side"]);
  assert.equal(rooms.skipped.some((row) => row.code === "FMC-DIMS-NOT-EXTERIOR"), false);
});

test("a dry run returns the references and does not apply", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dims-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_DIMS_DIR: path.join(dir, "dims") } as NodeJS.ProcessEnv;
  const read = async () => ({ title: "A", path: "D:\\Jobs\\_Staging\\A.rvt", view: "Level 1", grids, walls, openings });
  let applied = 0;
  const dry = textOf(await runFmcDims(args({ document: "A", view: "Level 1", targets: "grids" }), { read, apply: async () => { applied += 1; return {}; }, env, guard }));
  assert.equal(dry.dry_run, true);
  assert.equal(applied, 0);
  assert.ok(Array.isArray(dry.references));
  assert.equal((dry.strings as unknown[]).length, 2);
  const refused = textOf(await runFmcDims(args({ document: "A", view: "Level 1", dry_run: false }), { read, env, guard }));
  assert.equal(refused.code, "FMC-BATCH-LOCKED");
  const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] };
  const done = textOf(await runFmcDims(args({ document: "A", view: "Level 1", targets: ["walls"], dry_run: false, batch_lease: "lease-1", references: refs }), {
    read, apply: async (body) => { applied += 1; return { strings: (body.strings as unknown[]).length }; }, env, guard,
  }));
  assert.equal(applied, 1);
  assert.equal(done.dry_run, false);
});

test("the dimension read is not a write and the apply is", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_dims"));
  assert.ok(WRITE_COMMANDS.has("fmc_dims_apply"));
});

// ---------- research tool 35: the dry run shows the guard result; protected names from one place ----------
test("a dry run says would_refuse for a protected name or a central, and null when an apply could go ahead", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dims-guard-"));
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_DIMS_DIR: path.join(dir, "dims") } as NodeJS.ProcessEnv;
  const guard = { ...DEFAULT_CONFIG, never_write_titles: ["Ogala Live"] } as GuardConfig;
  const readAs = (title: string, extra: Record<string, unknown> = {}) => async () => ({ title, path: `D:\\Jobs\\_Staging\\${title}.rvt`, view: "Level 1", grids, walls, openings, ...extra });
  const ok = textOf(await runFmcDims(args({ document: "A", view: "Level 1", targets: "grids" }), { read: readAs("A"), env, guard }));
  assert.equal(ok.would_refuse, null);
  const hebert = textOf(await runFmcDims(args({ document: "H", view: "Level 1", targets: "grids" }), { read: readAs("HEBERT HOSTELS_USER"), env, guard }));
  assert.equal(hebert.dry_run, true);
  assert.equal(hebert.isError, false, "a dry run is still a plan");
  assert.match(String(hebert.would_refuse), /HEBERT HOSTELS is not written by fmc_dims/);
  assert.match(String(hebert.next), /would be refused/);
  const extra = textOf(await runFmcDims(args({ document: "O", view: "Level 1", targets: "grids" }), { read: readAs("Ogala Live_USER"), env, guard }));
  assert.match(String(extra.would_refuse), /Ogala Live is not written/);
  const central = textOf(await runFmcDims(args({ document: "C", view: "Level 1", targets: "grids" }), { read: readAs("C", { is_central: true }), env, guard }));
  assert.match(String(central.would_refuse), /A central model is not written/);
  const real = textOf(await runFmcDims(args({ document: "H", view: "Level 1", targets: "grids", dry_run: false, batch_lease: "l" }), { read: readAs("HEBERT HOSTELS_USER"), env, guard, apply: async () => { throw new Error("must not apply"); } }));
  assert.equal(real.code, "FMC-DIMS-GUARD");
});

test("research tool 35: ids keeps only the named grids, walls or rooms, and an opening follows its wall", async () => {
  const { filterDimInput } = await import("./dims.js");
  const rooms = [{ id: "r1", name: "Kitchen", x: 0, y: 0, bounds: [] }, { id: "r2", name: "Bed 1", x: 0, y: 0, bounds: [] }];
  const all = filterDimInput({ grids, walls, openings, rooms }, undefined);
  assert.equal(all.grids.length, 4);
  const one = filterDimInput({ grids, walls, openings, rooms }, ["w1", "kitchen", "nope"]);
  assert.deepEqual(one.walls.map((w) => w.id), ["w1"]);
  assert.deepEqual(one.openings.map((o) => o.id), ["d1"]);
  assert.deepEqual(one.rooms.map((r) => r.id), ["r1"]);
  assert.equal(one.grids.length, 0);
  assert.deepEqual(one.unmatched, ["nope"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dims-ids-"));
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_DIMS_DIR: path.join(dir, "dims") } as NodeJS.ProcessEnv;
  const read = async () => ({ title: "A", path: "D:\\Jobs\\_Staging\\A.rvt", view: "Level 1", grids, walls, openings });
  const dry = textOf(await runFmcDims(args({ document: "A", view: "Level 1", targets: "grids", ids: ["1", "2"] }), { read, env, guard: { ...DEFAULT_CONFIG } }));
  assert.equal((dry.strings as unknown[]).length, 1, "only grids 1 and 2: one chain");
  assert.deepEqual(dry.unmatched_ids, []);
});
