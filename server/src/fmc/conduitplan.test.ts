import { test } from "node:test";
import assert from "node:assert/strict";
import { conduitLimits, fittingCovered, nearestSize, pairEnds, sizeComment, type ConduitEnd } from "./conduitplan.js";
import { runFmcConduit } from "../tools/fmc_conduit.js";

function end(id: number, at: number[], direction: number[], size = 20): ConduitEnd {
  return { element_id: id, index: 0, size_mm: size, origin: at, direction, kind: "curve" };
}

test("free ends pair as extend, union, elbow or transition, and offset is only reported", () => {
  assert.equal(conduitLimits({}).provisional, true);
  const limits = conduitLimits({}, { near_mm: 50, touch_mm: 10, size_mm: 2, direction_deg: 15 });
  assert.equal(limits.provisional, false);
  assert.equal(limits.near_mm, 50);
  const ends = [
    end(1, [0, 0, 0], [1, 0, 0]),
    end(2, [8, 0, 0], [-1, 0, 0]),
    end(3, [0, 100, 0], [1, 0, 0]),
    end(4, [40, 100, 0], [-1, 0, 0]),
    end(5, [0, 200, 0], [1, 0, 0]),
    end(6, [30, 200, 0], [0, 1, 0]),
    end(7, [0, 300, 0], [1, 0, 0], 20),
    end(8, [30, 300, 0], [-1, 0, 0], 25),
    end(9, [0, 400, 0], [1, 0, 0]),
    end(10, [20, 400, 40], [0, 0, 1]),
    // Parallel and not co-linear. One elbow cannot join these, so they stay a report.
    end(11, [0, 500, 0], [1, 0, 0]),
    end(12, [30, 500, 40], [-1, 0, 0]),
  ];
  const paired = pairEnds(ends, limits);
  const op = (id: number) => paired.pairs.find((pair) => pair.a.element_id === id || pair.b.element_id === id)?.op;
  assert.equal(op(1), "extend");
  assert.equal(op(3), "union");
  assert.equal(op(5), "elbow");
  assert.equal(op(7), "transition");
  assert.equal(op(9), "report");
  assert.equal(op(11), "report");
  assert.equal(paired.pairs.find((pair) => pair.a.element_id === 11)?.alignment, "offset");
  assert.equal(paired.pairs.find((pair) => pair.a.element_id === 1)?.confidence, 0.9);
});

test("a size is covered only when the table and the fittings both have it, and the fallback comment is explicit", () => {
  const covered = fittingCovered(20, [16, 20, 27], { elbow: true, union: true, transition: true });
  assert.equal(covered.in_table, true);
  assert.equal(covered.fittings_set, true);
  const missing = fittingCovered(25, [16, 21, 27], { elbow: true, union: false, transition: true });
  assert.equal(missing.in_table, false);
  assert.equal(missing.fittings_set, false);
  assert.deepEqual(nearestSize(20, [16, 21, 27]), { size_mm: 21, delta_mm: 1 });
  assert.equal(sizeComment(20), "nominal 20 mm PVC");
});

test("a direct shape is skipped and a fix without a lease does not apply", async () => {
  const limits = conduitLimits({});
  const skipped = pairEnds([{ element_id: 4, index: 0, size_mm: 20, origin: [0, 0, 0], direction: [1, 0, 0], is_direct_shape: true }], limits);
  assert.equal(skipped.skipped[0].code, "FMC-DIRECTSHAPE");
  let applied = false;
  const result = await runFmcConduit({
    action: "fix", document: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", dry_run: false, batch_lease: "",
    domain: "conduit", junction: false, junction_family: "", resize_fallback: false, comment_material: "PVC",
    type_name: "", standard_name: "", sizes: [], elbow: "", union: "", tee: "", cross: "", transition: "", sample_limit: 20,
  }, {
    bank: {},
    read: async () => ({ model: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", ends: [end(1, [0, 0, 0], [1, 0, 0]), end(2, [5, 0, 0], [-1, 0, 0])] }),
    apply: async () => { applied = true; return { applied: true }; },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /FMC-BATCH-LOCKED/);
  assert.equal(applied, false);
});

test("496 free ends are paired without holding more than the end list", () => {
  const ends: ConduitEnd[] = [];
  for (let i = 0; i < 496; i += 2) {
    ends.push(end(i + 1, [i * 10, 0, 0], [1, 0, 0]));
    ends.push(end(i + 2, [i * 10 + 6, 0, 0], [-1, 0, 0]));
  }
  const paired = pairEnds(ends, conduitLimits({}, { near_mm: 20, touch_mm: 10, size_mm: 2, direction_deg: 15 }));
  assert.equal(paired.free.length, 496);
  assert.equal(paired.pairs.length, 248);
  assert.ok(paired.pairs.every((pair) => pair.op === "extend"));
});
