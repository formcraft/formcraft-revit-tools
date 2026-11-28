import { test } from "node:test";
import assert from "node:assert/strict";
import { activePlanView, gridLabels, planGrid, planLevels, type GridArgs } from "./basicwrites.js";
import { runCreateGrid } from "../tools/create_grid.js";
import { runCreateLevel } from "../tools/create_level.js";
import { runCreateDimensions } from "../tools/create_dimensions.js";

const bodyOf = (r: { content: Array<{ text: string }>; isError?: boolean }) => ({ ...JSON.parse(r.content[0].text), isError: r.isError });
const grid: GridArgs = {
  xCount: 3, xSpacing: 6000, xStartLabel: "A", xNamingStyle: "alphabetic",
  yCount: 2, ySpacing: 5000, yStartLabel: "1", yNamingStyle: "numeric",
  xExtentMin: -1000, xExtentMax: 13000, yExtentMin: -1000, yExtentMax: 6000,
  elevation: 0, xStartPosition: 0, yStartPosition: 0,
};
const recorder = (replies: Record<string, unknown>) => {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const send = async (command: string, params: Record<string, unknown>) => {
    calls.push({ command, params });
    const reply = replies[command];
    if (reply instanceof Error) throw reply;
    return reply ?? { Success: true };
  };
  return { calls, send };
};

test("grid labels follow the add-in: A.., 1.., prefixed and zero-padded", () => {
  assert.deepEqual(gridLabels(3, "A", "alphabetic"), ["A", "B", "C"]);
  assert.deepEqual(gridLabels(3, "1", "numeric"), ["1", "2", "3"]);
  assert.deepEqual(gridLabels(2, "G-01", "numeric"), ["G-01", "G-02"]);
  assert.deepEqual(gridLabels(2, "Z", "alphabetic"), ["Z", "AA"]);
});

test("create_grid dry run lists final labels and positions, flags duplicates, and creates nothing", async () => {
  const io = recorder({ ai_element_filter: { Success: true, Response: [{ name: "B" }, { Name: "7" }] } });
  const body = bodyOf(await runCreateGrid({ ...grid }, io));
  assert.equal(body.dry_run, true);
  assert.deepEqual(body.grids.map((g: { name: string; position_mm: number }) => [g.name, g.position_mm]), [["A", 0], ["B", 6000], ["C", 12000], ["1", 0], ["2", 5000]]);
  assert.deepEqual(body.grids[0].from_mm, { x: 0, y: -1000 });
  assert.deepEqual(body.grids[3].to_mm, { x: 13000, y: 0 });
  assert.deepEqual(body.duplicates, ["B"]);
  assert.match(body.next, /refuses/);
  assert.deepEqual(io.calls.map((c) => c.command), ["ai_element_filter"]);
});

test("a real create_grid refuses a duplicate instead of renaming it (A to A1), and refuses when names cannot be read", async () => {
  const dup = recorder({ ai_element_filter: { Response: [{ name: "a" }] } });
  const refused = bodyOf(await runCreateGrid({ ...grid, dry_run: false }, dup));
  assert.equal(refused.isError, true);
  assert.equal(refused.code, "FMC-GRID-DUPLICATE");
  assert.equal(dup.calls.some((c) => c.command === "create_grid"), false);
  const repeat = planGrid({ ...grid, yCount: 1, yStartLabel: "A", yNamingStyle: "alphabetic" }, []);
  assert.deepEqual(repeat.duplicates, ["A"]);
  const unread = recorder({ ai_element_filter: new Error("bridge down") });
  const r = bodyOf(await runCreateGrid({ ...grid, dry_run: false }, unread));
  assert.equal(r.code, "FMC-GRID-READ");
  assert.equal(unread.calls.some((c) => c.command === "create_grid"), false);
  const clean = recorder({ ai_element_filter: { Response: [{ name: "Q" }] } });
  bodyOf(await runCreateGrid({ ...grid, dry_run: false }, clean));
  const sent = clean.calls.find((c) => c.command === "create_grid");
  assert.ok(sent);
  assert.equal(sent!.params.onDuplicate, "refuse");
  assert.equal("dry_run" in sent!.params, false);
});

test("create_level dry run lists levels, views and conflicts; only a real run calls create_level", async () => {
  const io = recorder({ ai_element_filter: { Response: [{ name: "Level 1", elevation: 0 }, { name: "Roof", elevation: 9000 }] } });
  const body = bodyOf(await runCreateLevel({ data: [{ name: "Level 2", elevation: 3000 }, { name: "roof", elevation: 9500, createCeilingPlan: false }, { name: "Top", elevation: 9000.2 }] }, io));
  assert.equal(body.dry_run, true);
  assert.deepEqual(body.levels[0].views, ["floor plan", "ceiling plan"]);
  assert.deepEqual(body.levels[1].views, ["floor plan"]);
  assert.equal(body.conflicts.length, 2);
  assert.equal(io.calls.some((c) => c.command === "create_level"), false);
  assert.deepEqual(planLevels([{ name: "X", elevation: 1 }], []).conflicts, []);
  const real = recorder({});
  await runCreateLevel({ data: [{ name: "Level 2", elevation: 3000 }], dry_run: false }, real);
  assert.deepEqual(real.calls.map((c) => c.command), ["create_level"]);
});

test("create_dimensions: viewId -1 is refused unless the active view is a plan view, never silently defaulted", async () => {
  const dim = { startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 1000, y: 0, z: 0 }, viewId: -1 };
  const section = recorder({ get_current_view_info: { Response: { id: 55, name: "Section 1", viewType: "Section" } } });
  const refused = bodyOf(await runCreateDimensions({ dimensions: [dim], dry_run: false }, section));
  assert.equal(refused.isError, true);
  assert.equal(refused.code, "FMC-DIM-VIEW");
  assert.equal(section.calls.some((c) => c.command === "create_dimensions"), false);
  const unread = recorder({ get_current_view_info: new Error("no reply") });
  assert.equal(bodyOf(await runCreateDimensions({ dimensions: [dim] }, unread)).code, "FMC-DIM-VIEW");
  const plan = recorder({ get_current_view_info: { Response: { id: 77, name: "Level 1", viewType: "FloorPlan" } } });
  const dry = bodyOf(await runCreateDimensions({ dimensions: [dim, { ...dim, viewId: 90 }] }, plan));
  assert.equal(dry.dry_run, true);
  assert.deepEqual(dry.dimensions.map((d: { viewId: number }) => d.viewId), [77, 90]);
  assert.equal(dry.active_view.name, "Level 1");
  assert.equal(plan.calls.some((c) => c.command === "create_dimensions"), false);
  await runCreateDimensions({ dimensions: [dim], dry_run: false }, plan);
  const sent = plan.calls.find((c) => c.command === "create_dimensions");
  assert.equal((sent!.params.dimensions as Array<{ viewId: number }>)[0].viewId, 77);
  // a named view needs no active-view read
  const named = recorder({});
  await runCreateDimensions({ dimensions: [{ ...dim, viewId: 90 }], dry_run: false }, named);
  assert.deepEqual(named.calls.map((c) => c.command), ["create_dimensions"]);
  assert.equal(activePlanView({ id: 3, name: "C", viewType: "CeilingPlan" }).problem, null);
});