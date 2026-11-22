import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectChecks,
  skippedNonFamily,
  summarizeTrace,
  traceFromSnapshot,
  withSkippedNonFamily,
  type ResolvedLimits,
  type TraceSnapshot,
} from "./trace.js";
import { countSystems, recommend } from "./trace_phase3.js";
import {
  citeLimit,
  dropOwnedEdits,
  planFixes,
  refuseTraceWrite,
  runCrossConnection,
  runDrainageFall,
  runMissing,
  runOverload,
  runPhaseBalance,
  runVoltageDrop,
} from "./trace_phase2.js";

const limits = { values: { near_miss_mm: 50, touch_mm: 10, size_mismatch_mm: 2, direction_deg: 15, connected_gap_mm: 15, voltage_tol_v: 15 }, status: "PROVISIONAL" as const, fields: [], kit_change: "" };

test("a sanitary fixture with an open waste and no trap is reported, and a valve clears the isolation check", () => {
  const open: TraceSnapshot = {
    flow: {
      elements: [
        { id: 1, name: "WC", kind: "fixture", category: "Plumbing Fixtures" },
        { id: 2, name: "Basin", kind: "fixture", category: "Plumbing Fixtures" },
        { id: 3, name: "Ball valve", kind: "accessory" },
      ],
      connectors: [
        { element_id: 1, index: 0, domain: "piping", origin: [0, 0, 0], direction: [0, 0, -1], flow: "out", shape: "round", size_mm: 110, height_mm: 0, connected: false, type: "end", open_end: true, system_id: 9, system_class: "Sanitary", refs: [] },
        { element_id: 2, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "in", shape: "round", size_mm: 15, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 8, system_class: "DomesticColdWater", refs: [[3, 0]] },
        { element_id: 3, index: 0, domain: "piping", origin: [0, 0, 0], direction: [-1, 0, 0], flow: "out", shape: "round", size_mm: 15, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 8, system_class: "DomesticColdWater", refs: [[2, 0]] },
      ],
      systems: [
        { id: 9, name: "Soil", domain: "piping", classification: "Sanitary", element_ids: [1] },
        { id: 8, name: "Cold", domain: "piping", classification: "DomesticColdWater", base_equipment_id: 3, element_ids: [2, 3] },
      ],
    },
  };
  const run = runMissing(open, limits, {});
  assert.ok(run.findings.some((item) => item.code === "FLOW-NO-WASTE" && item.id === 1));
  assert.equal(run.findings.some((item) => item.code === "FLOW-NO-ISOLATION" && item.id === 2), false);
  assert.ok((run.extra?.not_detectable ?? []).length > 3);
});

test("a flat drain is PROVISIONAL without a bank key and FAIL when the bank sets the fall", () => {
  const snapshot: TraceSnapshot = {
    flow: {
      elements: [{ id: 4, kind: "pipe", system_ids: [9], curve: [[0, 0, 0], [8000, 0, 0]] }],
      connectors: [{ element_id: 4, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 100, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 9, refs: [] }],
      systems: [{ id: 9, name: "Soil", domain: "piping", classification: "Sanitary", element_ids: [4] }],
    },
  };
  const provisional = runDrainageFall(snapshot, limits, {});
  assert.equal(provisional.findings[0].code, "STD-PROVISIONAL");
  assert.equal(provisional.extra?.systems?.[0].verdict, "incomplete data");
  assert.equal(provisional.findings.some((item) => item.code === "STD-FAIL"), false);
  const bank = runDrainageFall(snapshot, limits, { bank: { "trace.drain_fall_100": { value: 1 / 80, clause: "BS EN 12056 table" } } });
  assert.equal(bank.findings[0].code, "STD-FAIL");
  assert.match(bank.findings[0].detail, /BS EN 12056/);
  assert.equal(bank.extra?.systems?.[0].verdict, "not compliant");
  const rising: TraceSnapshot = { ...snapshot, flow: { ...snapshot.flow!, elements: [{ id: 4, kind: "pipe", system_ids: [9], curve: [[0, 0, 0], [8000, 0, -200]] }] } };
  const pass = runDrainageFall(rising, limits, { bank: { "trace.drain_fall_100": { value: 1 / 80, clause: "BS EN 12056 table" } } });
  assert.equal(pass.findings.length, 0);
  assert.equal(pass.pass, true);
  assert.equal(pass.extra?.systems?.[0].verdict, "compliant");
});

test("a supply connector joined to waste is not a pass when the rule is provisional", () => {
  const snapshot: TraceSnapshot = {
    flow: {
      elements: [{ id: 1, kind: "pipe" }, { id: 2, kind: "pipe" }],
      connectors: [
        { element_id: 1, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 22, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, system_class: "DomesticColdWater", refs: [[2, 0]] },
        { element_id: 2, index: 0, domain: "piping", origin: [0, 0, 0], direction: [-1, 0, 0], flow: "in", shape: "round", size_mm: 110, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 2, system_class: "Sanitary", refs: [[1, 0]] },
      ],
      systems: [
        { id: 1, name: "Cold", domain: "piping", classification: "DomesticColdWater", element_ids: [1] },
        { id: 2, name: "Soil", domain: "piping", classification: "Sanitary", element_ids: [2] },
      ],
    },
  };
  const open = runCrossConnection(snapshot, limits, {});
  assert.equal(open.findings[0].code, "STD-PROVISIONAL");
  const ruled = runCrossConnection(snapshot, limits, { bank: { "trace.cross_connection": { value: 0, clause: "no cross connection" } } });
  assert.equal(ruled.findings[0].code, "STD-FAIL");
});

test("voltage drop and phase are UNKNOWN without the stored values, and overload FAILs against a bank ratio", () => {
  const snapshot: TraceSnapshot = {
    electrical: {
      panels: [{ id: 10, name: "DB-1", has_supply: true, main_a: 0 }],
      circuits: [{ id: 4, panel_id: 10, panel_name: "DB-1", voltage: 230, rating_a: 10, apparent_va: 5000, element_ids: [1], phase: "" }],
      devices: [],
    },
  };
  assert.equal(runVoltageDrop(snapshot, limits, {}).findings[0].code, "STD-UNKNOWN");
  assert.equal(runPhaseBalance(snapshot, limits, {}).findings[0].code, "STD-UNKNOWN");
  const over = runOverload(snapshot, limits, { bank: { "trace.overload_ratio": { value: 1, clause: "rating" } } });
  assert.equal(over.findings[0].code, "STD-FAIL");
  const soft = runOverload(snapshot, limits, {});
  assert.equal(soft.findings[0].code, "STD-PROVISIONAL");
  const missing = runMissing(snapshot, limits, {});
  assert.ok(missing.findings.some((item) => item.code === "ELEC-NO-MAIN" && item.id === 10));
});

test("the fix plan connects an aligned pair, elbows a corner, resizes the smaller pipe, and caps only when asked", () => {
  const snapshot: TraceSnapshot = {
    flow: {
      elements: [
        { id: 1, kind: "pipe", system_ids: [1] },
        { id: 2, kind: "pipe" },
        { id: 3, kind: "pipe", system_ids: [1] },
        { id: 4, kind: "pipe", system_ids: [1] },
        { id: 5, kind: "pipe", system_ids: [1] },
        { id: 6, kind: "pipe" },
      ],
      connectors: [
        { element_id: 1, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 22, height_mm: 0, connected: false, type: "end", open_end: true, system_id: 1, refs: [] },
        { element_id: 2, index: 0, domain: "piping", origin: [20, 0, 0], direction: [-1, 0, 0], flow: "in", shape: "round", size_mm: 22, height_mm: 0, connected: false, type: "end", open_end: true, system_id: 0, refs: [] },
        { element_id: 3, index: 0, domain: "piping", origin: [0, 100, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 22, height_mm: 0, connected: false, type: "end", open_end: true, system_id: 1, refs: [] },
        { element_id: 4, index: 0, domain: "piping", origin: [20, 100, 0], direction: [0, 1, 0], flow: "in", shape: "round", size_mm: 22, height_mm: 0, connected: false, type: "end", open_end: true, system_id: 1, refs: [] },
        { element_id: 3, index: 1, domain: "piping", origin: [0, 0, 100], direction: [-1, 0, 0], flow: "in", shape: "round", size_mm: 15, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [[4, 1]] },
        { element_id: 4, index: 1, domain: "piping", origin: [0, 0, 100], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 28, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [[3, 1]] },
        { element_id: 5, index: 0, domain: "piping", origin: [8000, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 22, height_mm: 0, connected: false, type: "end", open_end: true, system_id: 1, refs: [] },
        { element_id: 6, index: 0, domain: "piping", origin: [4000, 0, 0], direction: [-1, 0, 0], flow: "in", shape: "round", size_mm: 22, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 0, refs: [[1, 0]] },
      ],
      systems: [{ id: 1, name: "Cold", domain: "piping", classification: "DomesticColdWater", element_ids: [1, 3, 4] }],
    },
  };
  const plan = planFixes(snapshot, limits, {});
  assert.ok(plan.edits.some((edit) => edit.op === "connect" && edit.a === 1 && edit.b === 2));
  assert.ok(plan.edits.some((edit) => edit.op === "elbow"));
  const resize = plan.edits.find((edit) => edit.op === "resize");
  assert.equal(resize?.element_id, 3);
  assert.equal(resize?.size_mm, 28);
  assert.match(plan.rule, /smaller pipe or duct is resized up/);
  assert.equal(plan.edits.some((edit) => edit.op === "cap"), false);
  assert.ok(plan.edits.some((edit) => edit.op === "assign_system" && edit.element_id === 6 && edit.system_id === 1));
  const capped = planFixes(snapshot, limits, { caps: true });
  assert.ok(capped.edits.some((edit) => edit.op === "cap" && edit.element_id === 5));
  const few = planFixes(snapshot, limits, { max: 1 });
  assert.equal(few.edits.length, 1);
  assert.equal(few.capped, true);
});

test("a circuit is joined only when its id is given, and owned elements drop out of the plan", () => {
  const snapshot: TraceSnapshot = {
    electrical: {
      panels: [{ id: 10, name: "DB-1", has_supply: true, main_a: 100 }],
      circuits: [{ id: 8, panel_id: 10, panel_name: "DB-1", voltage: 230, rating_a: 16, element_ids: [], phase: "L1" }],
      devices: [{ id: 5, category: "Electrical Fixtures", power_connector: true, circuit_ids: [], ground: "absent" }],
    },
  };
  assert.equal(planFixes(snapshot, limits, {}).edits.some((edit) => edit.op === "circuit"), false);
  const planned = planFixes(snapshot, limits, { circuit: "8" });
  assert.equal(planned.edits[0].op, "circuit");
  assert.equal(planned.edits[0].circuit_id, 8);
  assert.deepEqual(dropOwnedEdits(planned.edits, [{ id: "5" }]), []);
});

test("HEBERT HOSTELS, a central and a protected path are refused", () => {
  assert.match(refuseTraceWrite({ title: "HEBERT HOSTELS_USER", path: "C:\\Locals\\HEBERT HOSTELS_USER.rvt" }) ?? "", /HEBERT HOSTELS/);
  assert.match(refuseTraceWrite({ title: "P-0001_USER", is_central: true }) ?? "", /central/);
  assert.match(refuseTraceWrite({ title: "P-0001_USER", path: "D:\\Live\\Model.rvt" }, ["D:\\Live"]) ?? "", /protected/);
  assert.equal(refuseTraceWrite({ title: "F26901-FMC-ZZ-ZZ-M3-P-0001_USER", path: "C:\\WIP\\F26901-FMC-ZZ-ZZ-M3-P-0001_USER.rvt" }), null);
});

test("a cited limit says PROVISIONAL when the bank has no trace key", () => {
  const limit = citeLimit("trace.vent_distance", {});
  assert.equal(limit.source, "provisional");
  assert.equal(limit.value, 300);
  const banked = citeLimit("trace.vent_distance", { bank: { "trace.vent_distance": { value: 1500, clause: "clause 5" } } });
  assert.equal(banked.source, "standards");
  assert.equal(banked.clause, "clause 5");
});

test("the apply command is the only trace write, and it does not save or switch views", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const apply = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcTraceApply.cs"), "utf8");
  const read = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcTrace.cs"), "utf8");
  assert.equal(/new\s+Transaction/.test(read), false);
  assert.equal((apply.match(/new Transaction/g) ?? []).length, 1);
  assert.match(apply, /RollBack/);
  assert.equal(/SynchronizeWithCentral|CheckoutElements|RequestViewChange|OpenAndActivateDocument|\.Save\(/.test(apply), false);
});

const TRENCHES = [1822136, 1822137, 1822138, 1822139];

function directShapeSnapshot(): TraceSnapshot {
  return {
    model: "F26901-FMC-ZZ-ZZ-M3-P-0001_USER",
    flow: {
      elements: [{ id: 1, name: "WC", kind: "fixture", category: "Plumbing Fixtures" }],
      connectors: [
        { element_id: 1, index: 0, domain: "piping", origin: [0, 0, 0], direction: [0, 0, -1], flow: "out", shape: "round", size_mm: 110, height_mm: 0, connected: false, type: "end", open_end: true, system_id: 9, system_class: "Sanitary", refs: [] },
      ],
      systems: [{ id: 9, name: "Soil", domain: "piping", classification: "Sanitary", element_ids: [1] }],
    },
    electrical: { panels: [], circuits: [], devices: [] },
    skipped_non_family: {
      count: TRENCHES.length,
      ids: TRENCHES,
      capped: false,
      items: TRENCHES.map((id) => ({ id, class: "DirectShape", category: "Plumbing Fixtures" })),
    },
  };
}

test("a DirectShape in a fixture category is reported for missing, standards, recommend, fix and counts", () => {
  const snapshot = directShapeSnapshot();
  const resolved = { status: limits.status, values: limits.values, fields: [], kit_change: limits.kit_change } as ResolvedLimits;
  const skip = skippedNonFamily(snapshot);
  assert.equal(skip.count, 4);
  assert.deepEqual(skip.ids, TRENCHES);
  assert.equal(skip.items[0]?.class, "DirectShape");
  assert.equal(skip.items[0]?.category, "Plumbing Fixtures");

  const missing = summarizeTrace(traceFromSnapshot(snapshot, selectChecks("missing"), resolved, {}), {
    limits: resolved, skipped: [], unknown: [], sampleLimit: 20, highlight: "off", report: "memory", snapshot,
  });
  assert.equal(missing.skipped_non_family?.count, 4);
  assert.deepEqual(missing.skipped_non_family?.ids, TRENCHES);
  assert.equal(missing.checks.some((check) => check.ids.some((row) => TRENCHES.includes(row.id))), false);
  assert.ok(missing.checks.some((check) => check.ids.some((row) => row.id === 1 && row.code === "FLOW-NO-WASTE")));

  const standards = summarizeTrace(traceFromSnapshot(snapshot, selectChecks("standards"), resolved, {}), {
    limits: resolved, skipped: [], unknown: [], sampleLimit: 20, highlight: "off", report: "memory", snapshot,
  });
  assert.equal(standards.skipped_non_family?.count, 4);
  assert.equal(standards.checks.some((check) => check.ids.some((row) => TRENCHES.includes(row.id))), false);

  const counts = withSkippedNonFamily({ counts: countSystems(snapshot) }, snapshot);
  assert.equal(counts.skipped_non_family.count, 4);
  assert.deepEqual(counts.skipped_non_family.ids, TRENCHES);
  assert.equal(counts.counts.document.elements, 1);
  assert.equal(counts.counts.plumbing.fixtures.WC, 1);

  const recommended = withSkippedNonFamily({ recommendations: recommend(snapshot, {}, limits) }, snapshot);
  assert.equal(recommended.skipped_non_family.count, 4);
  assert.equal(recommended.recommendations.some((item) => TRENCHES.includes(item.element_id)), false);

  const plan = withSkippedNonFamily(planFixes(snapshot, limits, {}), snapshot);
  assert.equal(plan.skipped_non_family.count, 4);
  assert.equal(plan.edits.some((edit) => edit.ids.some((id) => TRENCHES.includes(id))), false);

  const many = Array.from({ length: 60 }, (_, index) => 1822136 + index);
  const capped = skippedNonFamily({
    skipped_non_family: { count: 60, ids: many, items: many.map((id) => ({ id, class: "DirectShape", category: "Plumbing Fixtures" })) },
  });
  assert.equal(capped.count, 60);
  assert.equal(capped.ids.length, 50);
  assert.equal(capped.capped, true);
  assert.equal(capped.items.length, 50);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  for (const file of ["FmcTrace.cs", "FmcTraceApply.cs", "FmcJoins.cs"]) {
    const text = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", file), "utf8");
    assert.equal(text.includes("Cast<FamilyInstance>"), false, file);
    assert.equal(text.includes("Cast<MEPCurve>"), false, file);
    assert.equal(text.includes("Cast<Pipe>"), false, file);
    assert.match(text, /skipped_non_family/);
  }
});
