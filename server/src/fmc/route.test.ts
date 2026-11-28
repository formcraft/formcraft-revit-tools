import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSlope, routePreview, segmentHitsBox, type RouteBox, type RouteOk, type RouteRequest, type Vec3 } from "./route.js";

function ok(req: RouteRequest): RouteOk {
  const r = routePreview(req);
  if (!r.ok) assert.fail(`expected a route, got ${r.code}: ${r.reason}`);
  return r;
}

function horizontalSlopes(r: RouteOk): number[] {
  return r.runs.flatMap((run) => run.segments.filter((s) => !s.vertical).map((s) => s.slope as number));
}

function clearOf(r: RouteOk, boxes: RouteBox[], by: number) {
  for (const run of r.runs) for (const s of run.segments) for (const b of boxes) {
    const inflated = { min: b.min.map((v) => v - by) as Vec3, max: b.max.map((v) => v + by) as Vec3 };
    assert.equal(segmentHitsBox(s.from, s.to, inflated), false, `${run.id} ${JSON.stringify(s)} hits ${b.id}`);
  }
}

function zNeverRises(r: RouteOk) {
  for (const run of r.runs) for (let i = 1; i < run.points_mm.length; i++) {
    assert.ok(run.points_mm[i][2] <= run.points_mm[i - 1][2] + 1e-6, `${run.id} rises at ${i}`);
  }
}

test("slopes parse from a fraction, a ratio or a percentage", () => {
  assert.equal(parseSlope(0.025), 0.025);
  assert.equal(parseSlope("1:40"), 0.025);
  assert.equal(parseSlope("2.5%"), 0.025);
  assert.ok(Number.isNaN(parseSlope("steep") as number));
});

test("a required slope is met on every horizontal piece, and the reply is a preview that writes nothing", () => {
  const r = ok({
    start: [0, 0, 1000], goal: [4000, 0, 900], bounds: { min: [-500, -500, 0], max: [4500, 500, 2000] },
    flow: "gravity", slope: { min: "1:40" }, allow_vertical: false,
  });
  assert.equal(r.read_only, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.writes, 0);
  assert.deepEqual(r.runs[0].points_mm, [[0, 0, 1000], [4000, 0, 900]]);
  for (const s of horizontalSlopes(r)) assert.ok(Math.abs(s - 0.025) < 1e-6, `slope ${s}`);
  assert.equal(r.runs[0].segments[0].slope_ratio, "1:40");
  assert.equal(r.totals.bends, 0);
});

test("a slope range regrades the run evenly to land on the end", () => {
  const r = ok({
    start: [0, 0, 1000], goal: [4000, 0, 860], bounds: { min: [-500, -500, 0], max: [4500, 500, 2000] },
    flow: "gravity", slope: { min: "1:40", max: "1:20" }, allow_vertical: false,
  });
  assert.equal(r.runs[0].regraded, true);
  for (const s of horizontalSlopes(r)) assert.ok(Math.abs(s - 0.035) < 1e-6, `slope ${s}`);
});

test("max length forces the shorter detour even when it has more bends", () => {
  const wall: RouteBox = { id: "wall", min: [400, -150, -100], max: [1600, 2000, 100] };
  const nib: RouteBox = { id: "nib", min: [-500, -1000, -100], max: [250, -150, 100] };
  const base: RouteRequest = {
    start: [0, 0, 0], goal: [2000, 0, 0], bounds: { min: [-1000, -1000, 0], max: [3000, 3000, 0] },
    obstacles: [wall, nib], allow_vertical: false, bend_penalty_mm: 5000,
  };
  const free = ok(base);
  assert.equal(free.runs[0].length_mm, 6000, "few bends win without a length budget: over the top of the wall (touching its face is clear)");
  assert.equal(free.totals.bends, 2);
  const tight = ok({ ...base, max_length_mm: 3000 });
  assert.equal(tight.runs[0].length_mm, 2400);
  assert.equal(tight.totals.bends, 3);
  assert.ok(tight.search.pruned.max_length > 0);
  clearOf(tight, [wall, nib], 0);
  const none = routePreview({ ...base, max_length_mm: 2000 });
  assert.equal(none.ok, false);
  if (!none.ok) {
    assert.equal(none.code, "FMC-ROUTE-NONE");
    assert.equal(none.blocking, "max_length");
    assert.match(none.reason, /shortest is 2400 mm/);
  }
});

test("a dead-end pocket is backed out of instead of failing", () => {
  // A U around the start, open away from the goal.
  const pocket: RouteBox[] = [
    { id: "east", min: [200, -400, -100], max: [400, 400, 100] },
    { id: "north", min: [-600, 200, -100], max: [400, 400, 100] },
    { id: "south", min: [-600, -400, -100], max: [400, -200, 100] },
  ];
  const r = ok({
    start: [0, 0, 0], goal: [2000, 0, 0], bounds: { min: [-1500, -1500, 0], max: [2500, 1500, 0] },
    obstacles: pocket, allow_vertical: false, size_mm: 50,
  });
  assert.ok(r.search.backtracks > 0, "the search backed up");
  const [a, b] = r.runs[0].points_mm;
  assert.ok(b[0] < a[0], "it leaves the pocket westward");
  clearOf(r, pocket, 25);
});

test("arriving too high at a fixed slope rejects the goal and detours to lose height", () => {
  const r = ok({
    start: [0, 0, 1000], goal: [2000, 0, 900], bounds: { min: [-200, -200, 0], max: [2200, 1000, 2000] },
    flow: "gravity", slope: { min: "1:40" }, allow_vertical: false,
  });
  assert.ok(r.search.goal_rejections > 0);
  const horizontal = r.runs[0].segments.reduce((a, s) => a + (s.vertical ? 0 : Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1])), 0);
  assert.equal(Math.round(horizontal), 4000);
  for (const s of horizontalSlopes(r)) assert.ok(Math.abs(s - 0.025) < 1e-6);
  zNeverRises(r);
});

test("no route: the reason names the constraint that rules every route out", () => {
  const bounds = { min: [-1000, -1000, 0] as Vec3, max: [3000, 1000, 0] as Vec3 };
  const ring: RouteBox[] = [
    { id: "w", min: [1600, -400, -100], max: [1700, 400, 100] },
    { id: "e", min: [2300, -400, -100], max: [2400, 400, 100] },
    { id: "n", min: [1600, 300, -100], max: [2400, 400, 100] },
    { id: "s", min: [1600, -400, -100], max: [2400, -300, 100] },
  ];
  const enclosed = routePreview({ start: [0, 0, 0], goal: [2000, 0, 0], bounds, obstacles: ring, allow_vertical: false });
  assert.equal(enclosed.ok, false);
  if (!enclosed.ok) { assert.equal(enclosed.code, "FMC-ROUTE-NONE"); assert.equal(enclosed.blocking, "enclosed"); assert.equal(enclosed.writes, 0); }

  const inside = routePreview({ start: [0, 0, 0], goal: [2000, 0, 0], bounds, obstacles: [{ min: [1900, -100, -100], max: [2100, 100, 100] }] });
  assert.equal(!inside.ok && inside.blocking, "goal_blocked");

  const flat = routePreview({ start: [0, 0, 1000], goal: [4000, 0, 990], bounds: { min: [0, -500, 0], max: [4000, 500, 2000] }, flow: "gravity", slope: { min: "1:40" } });
  assert.equal(flat.ok, false);
  if (!flat.ok) { assert.equal(flat.blocking, "fall"); assert.match(flat.reason, /needs 100 mm of fall/); }

  const bad = routePreview({ start: [0, 0, 0], goal: [100, 0, 0], bounds, flow: "gravity" });
  assert.equal(!bad.ok && bad.code, "FMC-ROUTE-INPUT");
});

test("gravity drainage keeps the minimum slope, drops under a beam, never rises, and a branch joins at a tee", () => {
  const beam: RouteBox = { id: "beam", kind: "structural framing", min: [1400, -2000, 950], max: [1600, 2000, 1300] };
  const r = ok({
    start: [0, 0, 1000], goal: [3000, 0, 800], branches: [[1000, 1500, 1200]],
    bounds: { min: [-500, -500, 600], max: [3500, 2000, 1400] },
    obstacles: [beam], flow: "gravity", slope: { min: "1:40", max: "1:20" }, size_mm: 100, clearance_mm: 0, z_min_mm: 700,
  });
  for (const s of horizontalSlopes(r)) assert.ok(s >= 0.025 - 1e-6 && s <= 0.05 + 1e-6, `slope ${s}`);
  zNeverRises(r);
  clearOf(r, [beam], 50);
  assert.ok(r.runs[0].segments.some((s) => s.vertical), "the trunk drops to pass under the beam");
  const trunkEnd = r.runs[0].points_mm[r.runs[0].points_mm.length - 1];
  assert.deepEqual(trunkEnd, [3000, 0, 800]);
  assert.equal(r.runs[1].joins, "trunk");
  assert.equal(r.totals.fittings.tee, 1);
  const tee = r.fittings.find((f) => f.type === "tee");
  assert.equal(tee?.branch, "branch_1");
  assert.equal(tee?.note, undefined, "the tee is on a straight piece of the trunk");
  // The branch arrives at the trunk from above or level with it.
  const branchEnd = r.runs[1].points_mm[r.runs[1].points_mm.length - 1];
  assert.deepEqual(branchEnd, tee?.at);
});

test("the fitting points name corners, tees, joints and open ends for the connector tool", () => {
  const r = ok({
    start: [0, 0, 0], goal: [3000, 3000, 0], branches: [[1500, -1000, 0]],
    bounds: { min: [-500, -1500, 0], max: [3500, 3500, 0] },
    obstacles: [{ id: "block", min: [100, 100, -100], max: [2900, 3500, 100] }],
    allow_vertical: false, stock_length_mm: 1000,
  });
  // The block leaves one way: east along y 0, a corner at (3000, 0), then north. The branch tees in at (1500, 0).
  assert.equal(r.totals.fittings.corner, 1);
  const corner = r.fittings.find((f) => f.type === "corner");
  assert.equal(corner?.angle_deg, 90);
  assert.deepEqual(corner?.at, [3000, 0, 0]);
  const ends = r.fittings.filter((f) => f.type === "open_end").map((f) => f.role).sort();
  assert.deepEqual(ends, ["branch_start", "end", "start"]);
  assert.deepEqual(r.fittings.find((f) => f.type === "tee")?.at, [1500, 0, 0]);
  // Stock length 1000: x 1000 (before the tee), x 2500 (after it), then y 1000 and 2000 after the corner.
  const joints = r.fittings.filter((f) => f.type === "joint").map((f) => f.at);
  assert.deepEqual(joints, [[1000, 0, 0], [2500, 0, 0], [3000, 1000, 0], [3000, 2000, 0]]);
  for (const f of r.fittings) assert.ok(["corner", "tee", "joint", "open_end"].includes(f.type));
});

test("fmc_trace route is a preview with no Revit call: the plan, or a plain reason", async () => {
  const { parseTraceArgs, runFmcTrace } = await import("../tools/fmc_trace.js");
  const good = await runFmcTrace(parseTraceArgs({
    action: "route",
    route: { start: [0, 0, 1000], goal: [4000, 0, 900], bounds: { min: [0, -500, 0], max: [4000, 500, 2000] }, flow: "gravity", slope: { min: "1:40" } },
  }));
  assert.equal(good.isError, false);
  const body = JSON.parse(good.content[0].text);
  assert.equal(body.action, "route");
  assert.equal(body.ok, true);
  assert.equal(body.writes, 0);
  assert.equal(body.read_only, true);
  assert.ok(body.fittings.some((f: { type: string }) => f.type === "open_end"));

  const none = JSON.parse((await runFmcTrace(parseTraceArgs({
    action: "route",
    route: { start: [0, 0, 1000], goal: [4000, 0, 990], bounds: { min: [0, -500, 0], max: [4000, 500, 2000] }, flow: "gravity", slope: { min: "1:40" } },
  }))).content[0].text);
  assert.equal(none.code, "FMC-ROUTE-NONE");
  assert.equal(none.blocking, "fall");

  const missing = await runFmcTrace(parseTraceArgs({ action: "route" }));
  assert.equal(missing.isError, true);
});
