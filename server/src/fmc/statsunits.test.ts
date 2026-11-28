import { test } from "node:test";
import assert from "node:assert/strict";
import { levelsInMm } from "../tools/analyze_model_statistics.js";

// Tool research 1-25 (analyze_model_statistics, approved 28 Nov): level elevations in millimetres, not feet.

test("model statistics: an old add-in's feet are converted to elevationMm; every level is kept", () => {
  const out = levelsInMm({ projectName: "P", levels: [{ levelName: "L0", elevation: 0, elementCount: 3 }, { levelName: "L1", elevation: 10, elementCount: 1 }, { levelName: "B1", elevation: -1.5, elementCount: 0 }] }) as any;
  assert.deepEqual(out.levels.map((l: any) => l.elevationMm), [0, 3048, -457.2]);
  assert.equal(out.levels.length, 3);
  assert.equal(out.levels.every((l: any) => l.elevation === undefined && l.elevation_converted_from_feet === true), true);
  assert.equal(out.lengthUnit, "mm");
});

test("model statistics: a new add-in's elevationMm is left as sent, also inside a wrapped reply", () => {
  const out = levelsInMm({ result: { levels: [{ levelName: "L1", elevationMm: 3000, projectElevationMm: 3000 }] } }) as any;
  assert.equal(out.result.levels[0].elevationMm, 3000);
  assert.equal(out.result.levels[0].elevation_converted_from_feet, undefined);
  assert.equal(levelsInMm(null), null);
  assert.equal(levelsInMm("text"), "text");
});
