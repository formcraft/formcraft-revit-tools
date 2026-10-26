import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanNodes, flatten, outlineProblems, smoothOps, smoothOutline, type P2 } from "./curves.js";
import { OPS, opsProblems, splitProblems } from "./ops.js";

// A traced oval: 80 points, the way a photo outline arrives
const oval: P2[] = Array.from({ length: 80 }, (_, i) => [Math.round(300 * Math.cos((2 * Math.PI * i) / 80) * 100) / 100, Math.round(180 * Math.sin((2 * Math.PI * i) / 80) * 100) / 100]);

test("curves (owner 26 Oct): a traced curve becomes a few smooth splines, corners stay corners", () => {
  const nodes = smoothOutline(oval);
  assert.ok(nodes.length < 10, `${nodes.length} nodes`);
  assert.ok(nodes.some((n) => !Array.isArray(n) && n.spline), "splines");
  assert.deepEqual(outlineProblems(nodes), []);
  // a D shape: a straight back, a traced curve: the two corners are kept
  const d: P2[] = [[0, -200], [0, 200], ...Array.from({ length: 40 }, (_, i) => [200 * Math.sin(Math.PI * (i + 1) / 41), 200 * Math.cos(Math.PI * (i + 1) / 41)] as P2)];
  const dn = smoothOutline(d);
  assert.ok(dn.filter(Array.isArray).length >= 1 && dn.some((n) => !Array.isArray(n)), JSON.stringify(dn).slice(0, 200));
  assert.deepEqual(outlineProblems(dn), []);
});

test("curves: near-duplicate points are merged; crossings and in-line arcs are refused with where", () => {
  assert.equal(cleanNodes([[0, 0], [0.3, 0], [100, 0], [100, 100]]).merged, 1);
  assert.match(outlineProblems([[0, 0], [10, 10], [10, 0], [0, 10]]).join(), /crosses or touches itself near/);
  assert.match(outlineProblems([[0, 0], { to: [20, 0], through: [10, 0] }, [20, 20]]).join(), /in line/);
  assert.match(outlineProblems([[-5, 0], [5, 0], [5, 5]], "revolution").join(), /cross its axis/);
  assert.ok(flatten([[0, 0], { to: [100, 0], through: [50, 20] }, [100, 100]]).length > 10);
});

test("curves: recipes may mix lines, arcs and splines, and a traced outline is smoothed before it is checked or built", () => {
  const ops = OPS.parse([
    { op: "extrusion", name: "Body", points: oval, start: 0, end: 50 },
    { op: "extrusion", name: "Knob", points: [[0, 0], { to: [40, 0], through: [20, -10] }, { to: [40, 40], spline: [[50, 20]] }, [0, 40]], start: 0, end: 10 },
    { op: "extrusion", name: "Kept", points: oval, smooth: false, start: 0, end: 5 },
  ]);
  const out = smoothOps(ops) as any[];
  assert.ok(out[0].points.length < 10);
  assert.equal(out[2].points.length, 80, "smooth false keeps every point");
  assert.deepEqual(splitProblems(opsProblems(ops, null)).errors, []);
});
