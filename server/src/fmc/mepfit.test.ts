import { test } from "node:test";
import assert from "node:assert/strict";
import { planPlacement, splitPieces } from "./mepfit.js";
import { routePreview, type RouteOk } from "./route.js";

function route(): RouteOk {
  return {
    ok: true, read_only: true, dry_run: true, writes: 0, flow: "pressure",
    runs: [
      { id: "trunk", points_mm: [[0, 0, 0], [8000, 0, 0], [8000, 3000, 0]], length_mm: 11000, segments: [
        { from: [0, 0, 0], to: [8000, 0, 0], length_mm: 8000, vertical: false },
        { from: [8000, 0, 0], to: [8000, 3000, 0], length_mm: 3000, vertical: false },
      ] },
      { id: "branch1", joins: "trunk", points_mm: [[4000, 2000, 0], [4000, 0, 0]], length_mm: 2000, segments: [
        { from: [4000, 2000, 0], to: [4000, 0, 0], length_mm: 2000, vertical: false },
      ] },
    ],
    fittings: [
      { type: "open_end", at: [0, 0, 0], run: "trunk", role: "start" },
      { type: "joint", at: [6000, 0, 0], run: "trunk" },
      { type: "tee", at: [4000, 0, 0], run: "trunk", branch: "branch1" },
      { type: "corner", at: [8000, 0, 0], run: "trunk", angle_deg: 90 },
      { type: "open_end", at: [8000, 3000, 0], run: "trunk", role: "end" },
      { type: "open_end", at: [4000, 2000, 0], run: "branch1", role: "branch_start" },
    ],
    totals: { length_mm: 13000, bends: 1, fittings: { corner: 1, tee: 1, joint: 1, open_end: 3 } },
    search: { expanded: 1, backtracks: 0, goal_rejections: 0, pruned: { obstacle: 0, bounds: 0, elevation: 0, max_length: 0, fall: 0, bends: 0 } },
    warnings: [],
  };
}

test("pieces split at the tee and the joint, in order along the run", () => {
  const pieces = splitPieces(route());
  const trunk = pieces.filter((p) => p.run === "trunk").map((p) => [p.from[0], p.to[0], p.length_mm]);
  assert.deepEqual(trunk, [[0, 4000, 4000], [4000, 6000, 2000], [6000, 8000, 2000], [8000, 8000, 3000]]);
  assert.equal(pieces.filter((p) => p.run === "branch1").length, 1);
});

test("fittings: elbow at the corner, tee, union at the joint; open ends stay open unless caps", () => {
  const plan = planPlacement(route());
  assert.equal(plan.counts.elbow, 1);
  assert.equal(plan.counts.tee, 1);
  assert.equal(plan.counts.union, 1);
  assert.equal(plan.counts.cap, 0);
  assert.equal(plan.counts.open_ends, 3);
  assert.equal(plan.fittings.find((f) => f.op === "tee")?.branch, "branch1");
  const capped = planPlacement(route(), { caps: true });
  assert.equal(capped.counts.cap, 3);
});

test("a routing group with no rule is blocked up front with FMC-NO-FITTING-TYPE, and caps need a Caps rule", () => {
  const coverage = { id: 11, name: "PVC-U", kind: "pipe" as const, missing: ["Unions"], caps: false, ready: false, preferred_junction: "Tee" };
  const plan = planPlacement(route(), { coverage, caps: true });
  assert.equal(plan.counts.union, 0);
  assert.equal(plan.counts.cap, 0);
  assert.equal(plan.blocked.filter((b) => b.code === "FMC-NO-FITTING-TYPE").length, 4);
  assert.match(plan.blocked[0].reason, /PVC-U has no/);
});

test("an elbow angle the family cannot take is blocked with FMC-ANGLE", () => {
  const r = route();
  r.fittings[3].angle_deg = 60;
  const plan = planPlacement(r, { angles_deg: [90, 45] });
  assert.equal(plan.counts.elbow, 0);
  assert.equal(plan.blocked[0].code, "FMC-ANGLE");
});

test("a real routePreview result plans pieces that add up to the route length", () => {
  const r = routePreview({ start: [0, 0, 3000], goal: [5000, 3000, 3000], bounds: { min: [-500, -500, 2500], max: [6000, 4000, 3500] }, grid_mm: 500, size_mm: 100, flow: "pressure" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const plan = planPlacement(r);
  const total = plan.pieces.reduce((a, p) => a + p.length_mm, 0);
  assert.ok(Math.abs(total - r.totals.length_mm) <= plan.pieces.length, `${total} vs ${r.totals.length_mm}`);
  assert.equal(plan.counts.elbow, r.totals.fittings.corner);
});
