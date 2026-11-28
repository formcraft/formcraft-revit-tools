import { test } from "node:test";
import assert from "node:assert/strict";
import { conduitLimits, fittingCovered, nearestSize, nullBankEntry, pairEnds, sizeComment, type ConduitEnd } from "./conduitplan.js";
import { conduitCounts, createdIds, junctionLoaded, runFmcConduit } from "../tools/fmc_conduit.js";
import { DEFAULT_CONFIG } from "./policy.js";

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

test("conduit: a null bank entry is named, not called missing (P-fmc_conduit-02)", () => {
  const drafted = { status: "draft", clause: "K-19" };
  const nulls = conduitLimits({
    "trace.near_miss_tolerance": { value: null, ...drafted },
    "trace.connection_tolerance": { value: null, ...drafted },
  } as never);
  for (const field of nulls.fields) {
    assert.equal(field.provisional, true, field.key);
    assert.doesNotMatch(field.clause, /Not in the standards bank/, field.key);
    assert.match(field.clause, /value is null/, field.key);
  }
  assert.match(nulls.fields[0].clause, /trace\.near_miss_tolerance/);
  assert.match(nulls.fields[3].clause, /trace\.connection_tolerance/);
  assert.equal(nullBankEntry("trace.direction_deg", { "trace.connection_tolerance": { value: { direction_deg: null, touch_mm: 8 } } } as never), "trace.connection_tolerance.direction_deg");
  assert.equal(nullBankEntry("trace.touch_mm", { "trace.connection_tolerance": { value: { touch_mm: 8 } } } as never), null);
  const missing = conduitLimits({});
  assert.match(missing.fields[1].clause, /Not in the standards bank/, "a key that is truly absent still says so");
  assert.doesNotMatch(missing.fields[1].clause, /value is null/);
  const named = conduitLimits({ "trace.connection_tolerance": { value: { touch_mm: 8, size_mismatch_mm: 3, direction_deg: 20 }, status: "approved", clause: "STD 1" } } as never);
  assert.equal(named.touch_mm, 8);
  assert.equal(named.fields[1].alias_used, "trace.connection_tolerance");
});

test("conduit: scan counts show nothing read, fix lists created ids and warns about a missing junction family (P-fmc_conduit-01)", async () => {
  assert.deepEqual(conduitCounts({ counts: { conduits: 0, trays: 0, conduit_fittings: 0, tray_fittings: 0, end_connectors_read: 0, connected_ends: 0, free_ends: 0 } }).nothing_read, true);
  assert.equal(conduitCounts({ counts: { conduits: 3, end_connectors_read: 6, connected_ends: 6, free_ends: 0 } }).nothing_read, false);
  const derived = conduitCounts({ ends: [end(1, [0, 0, 0], [1, 0, 0]), end(1, [5, 0, 0], [-1, 0, 0])] });
  assert.equal(derived.source, "ends only");
  assert.equal(derived.counts.free_ends, 2);
  assert.deepEqual(createdIds([{ created_id: 77 }, { op: "extend" }, { created_id: 0 }]), [77]);
  assert.equal(junctionLoaded("FMC_E_ElecFixture_JunctionBox 75x75_Galv", ["FMC_E_ElecFixture_JunctionBox 75x75_Galv"]), true);
  assert.equal(junctionLoaded("FMC_E_ElecFixture_JunctionBox", ["FMC_E_ElecFixture_JunctionBox 75x75_Galv"]), true);
  assert.equal(junctionLoaded("X", []), false);
  assert.equal(junctionLoaded("X", undefined), null);

  const args = {
    action: "scan" as const, document: "E-0001", dry_run: true, batch_lease: "",
    domain: "conduit" as const, junction: false, junction_family: "FMC_E_ElecFixture_JunctionBox 75x75_Galv", resize_fallback: false, comment_material: "PVC",
    type_name: "", standard_name: "", sizes: [], elbow: "", union: "", tee: "", cross: "", transition: "", sample_limit: 20,
  };
  const io = { bank: {}, guard: { ...DEFAULT_CONFIG, protected_paths: [] } };
  const empty = JSON.parse((await runFmcConduit(args, { ...io, read: async () => ({ model: "E-0001", ends: [], counts: { conduits: 0, trays: 0, conduit_fittings: 0, tray_fittings: 0, end_connectors_read: 0, connected_ends: 0, free_ends: 0 } }) })).content[0].text);
  assert.equal(empty.nothing_read, true);
  assert.match(empty.message, /No conduit was read/);
  assert.equal(empty.counts.conduits, 0);

  const snap = async () => ({ model: "E-0001", ends: [end(1, [0, 0, 0], [1, 0, 0]), end(2, [5, 0, 0], [-1, 0, 0])], fitting_types_loaded: ["FMC_E_Elbow Standard"] });
  const dry = JSON.parse((await runFmcConduit({ ...args, action: "fix", junction: true }, { ...io, read: snap })).content[0].text);
  assert.equal(dry.dry_run, true);
  assert.match(dry.junction_warning, /FMC-NO-FITTING-TYPE/);
  const real = JSON.parse((await runFmcConduit({ ...args, action: "fix", dry_run: false, batch_lease: "lease-1" }, {
    ...io, read: snap, apply: async () => ({ applied: true, done: [{ op: "union", ok: true, a: 1, b: 2, created_id: 901 }], failed: [] }),
  })).content[0].text);
  assert.deepEqual(real.created_ids, [901]);
  assert.equal(real.junction_warning, undefined);
});
