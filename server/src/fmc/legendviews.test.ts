import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { LEGEND_VIEW, directionFor, gridSlot, labelPlan, paperMmToFeet, paramOrder } from "./legendmath.js";
import { FMC_LEGEND_SHAPE, runFmcLegend, type FmcLegendArgs } from "../tools/fmc_legend.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function args(partial: Record<string, unknown>): FmcLegendArgs {
  return z.object(FMC_LEGEND_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, unknown> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

function io() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-legend-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG, protected_paths: ["D:\\Live"], save_exclude: ["HEBERT HOSTELS"], sync_exclude: [], protected_roots: [] };
  const env = { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, FMC_LEGEND_DIR: path.join(dir, "legend") } as NodeJS.ProcessEnv;
  return { dir, env, guard, reportDir: path.join(dir, "legend") };
}

const seeded = {
  documents: [{
    title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
    path: "D:\\Jobs\\_Staging\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt",
    is_central: false,
    views: [{ id: "5", name: "Symbols", scale: 50, component_count: 1 }],
    components: [{ id: "8", view_id: "5", type_id: "1", direction: -7, length_mm: 1000 }],
  }],
};

test("legend layout, view direction and parameter order", () => {
  const a = gridSlot(0, 2, 10, 20, 15, 0);
  const b = gridSlot(1, 2, 10, 20, 15, 0);
  const c = gridSlot(2, 2, 10, 20, 15, 0);
  assert.deepEqual({ col: a.col, row: a.row, x: a.x_mm, y: a.y_mm }, { col: 0, row: 0, x: 15, y: 0 });
  assert.deepEqual({ col: b.col, row: b.row, x: b.x_mm, y: b.y_mm }, { col: 1, row: 0, x: 25, y: 0 });
  assert.deepEqual({ col: c.col, row: c.row, x: c.x_mm, y: c.y_mm }, { col: 0, row: 1, x: 15, y: -20 });
  assert.equal(paperMmToFeet(304.8, 1), 1);
  assert.equal(paperMmToFeet(10, 25), 250 / 304.8);
  assert.deepEqual(directionFor("door"), { name: "elevation_front", value: LEGEND_VIEW.elevation_front });
  assert.equal(directionFor("window")?.value, -7);
  assert.equal(directionFor("wall")?.value, -5);
  assert.equal(directionFor("floor")?.value, -5);
  assert.equal(directionFor("ceiling")?.value, -4);
  assert.deepEqual(paramOrder("door"), ["LEGEND_COMPONENT", "LEGEND_COMPONENT_VIEW"]);
  assert.deepEqual(paramOrder("wall"), ["LEGEND_COMPONENT", "LEGEND_COMPONENT_VIEW", "LEGEND_COMPONENT_LENGTH"]);
  assert.equal(paramOrder("floor").includes("LEGEND_COMPONENT_LENGTH"), false);
  assert.equal(labelPlan("none").free_text, false);
  assert.equal(labelPlan("keynote").attempt, "keynote_tag");
  assert.equal(labelPlan("type_mark").needs_type_marks, true);
  assert.equal(labelPlan("type_mark").free_text, false);
});

test("seed reports a missing component, and place plans a grid without text notes", async () => {
  const box = io();
  const empty = textOf(await runFmcLegend(args({ action: "seed", document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER" }), {
    ...box,
    read: async () => ({ documents: [{ title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", path: "D:\\Jobs\\_Staging\\A.rvt", views: [], components: [] }] }),
  }));
  assert.equal(empty.isError, true);
  assert.equal(empty.code, "FMC-LEGEND-NO-SEED");
  assert.equal(empty.fix, "place one legend component by hand once");
  assert.equal(empty.free_text, false);

  const place = textOf(await runFmcLegend(args({
    action: "place",
    document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
    view: "Symbols",
    types: [{ id: "21", category: "door" }, { id: "22", category: "wall" }],
    columns: 1,
    spacing_x_mm: 80,
    spacing_y_mm: 40,
    origin_x_mm: 15,
    origin_y_mm: 0,
    label: "type_mark",
    dry_run: true,
  }), { ...box, read: async () => seeded }));
  assert.equal(place.isError, false);
  assert.equal(place.dry_run, true);
  assert.equal(place.free_text, false);
  const items = place.items as Array<{ type_id: string; params: string[]; direction: number; y_mm: number; length_mm: number | null }>;
  assert.deepEqual(items[0].params, ["LEGEND_COMPONENT", "LEGEND_COMPONENT_VIEW"]);
  assert.equal(items[0].direction, -7);
  assert.equal(items[0].y_mm, 0);
  assert.deepEqual(items[1].params, ["LEGEND_COMPONENT", "LEGEND_COMPONENT_VIEW", "LEGEND_COMPONENT_LENGTH"]);
  assert.equal(items[1].direction, -5);
  assert.equal(items[1].y_mm, -40);
  const label = place.label as { free_text: boolean; attempt: string };
  assert.equal(label.free_text, false);
  assert.equal(label.attempt, "type_mark_tag");

  const locked = textOf(await runFmcLegend(args({
    action: "place",
    document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
    types: [{ id: "21", category: "door" }],
    dry_run: false,
  }), { ...box, read: async () => seeded }));
  assert.equal(locked.code, "FMC-BATCH-LOCKED");

  const chain = textOf(await runFmcLegend(args({ action: "chain", role: "" })));
  assert.equal(chain.isError, true);
  assert.match(JSON.stringify(chain.reasons), /role/);

  const apply = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcLegendApply.cs"), "utf8");
  assert.equal(apply.includes("TextNote"), false);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_legend_views"));
  assert.ok(WRITE_COMMANDS.has("fmc_legend_apply"));
});

test("fmc_legend chain: the real chain is a write that needs the batch lease and goes through sendCommand", async () => {
  assert.ok(WRITE_COMMANDS.has("fmc_legend_chain"));
  const box = io();
  const staging = path.join(box.dir, "staging");
  fs.mkdirSync(path.join(staging, "A"), { recursive: true });
  fs.writeFileSync(path.join(staging, "A", "FMC_Door.rfa"), "");
  const template = path.join(box.dir, "FMC_A_Template_v2.2.rte");
  fs.writeFileSync(template, "");
  const guard: GuardConfig = { ...box.guard, family_staging_root: staging, library_roots: [path.join(box.dir, "_ChainTests")], template_roots: [], write_roots: [box.dir] };
  const sent: Array<{ body: Record<string, unknown>; timeout: number }> = [];
  const chain = async (body: Record<string, unknown>, timeout: number) => { sent.push({ body, timeout }); return { placed_all: 1 }; };

  const dry = textOf(await runFmcLegend(args({ action: "chain", role: "A", template }), { ...box, guard, chain }));
  assert.equal(dry.dry_run, true, JSON.stringify(dry));
  assert.equal(sent.length, 0);

  const noLease = textOf(await runFmcLegend(args({ action: "chain", role: "A", template, dry_run: false }), { ...box, guard, chain }));
  assert.equal(noLease.code, "FMC-BATCH-LOCKED", JSON.stringify(noLease));
  assert.equal(noLease.isError, true);
  assert.equal(sent.length, 0);

  const real = textOf(await runFmcLegend(args({ action: "chain", role: "A", template, dry_run: false, batch_lease: "L1" }), { ...box, guard, chain }));
  assert.equal(real.isError, false, JSON.stringify(real));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].timeout, 12 * 60 * 60 * 1000);

  const src = fs.readFileSync(path.join(root, "server", "src", "tools", "fmc_legend.ts"), "utf8");
  assert.match(src, /sendCommand\("fmc_legend_chain"/);
  assert.doesNotMatch(src, /sendRaw\("fmc_legend_chain"/);
});
