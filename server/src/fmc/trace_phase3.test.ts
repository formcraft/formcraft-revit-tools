import { test } from "node:test";
import assert from "node:assert/strict";
import type { TraceSnapshot } from "./trace.js";
import { countSystems, editsForRecommendations, recommend, summariseCounts, summariseRecommendations } from "./trace_phase3.js";

const limits = { values: { near_miss_mm: 50, touch_mm: 10, size_mismatch_mm: 2, direction_deg: 15, connected_gap_mm: 15, voltage_tol_v: 15 } };

function pipe(id: number, size: number, from: number[], to: number[], system = 1): TraceSnapshot["flow"] {
  return {
    elements: [{ id, kind: "pipe", system_ids: [system], curve: [from, to] }],
    connectors: [
      { element_id: id, index: 0, domain: "piping", origin: from, direction: [1, 0, 0], flow: "out", shape: "round", size_mm: size, height_mm: 0, connected: true, type: "end", open_end: false, system_id: system, refs: [] },
      { element_id: id, index: 1, domain: "piping", origin: to, direction: [-1, 0, 0], flow: "in", shape: "round", size_mm: size, height_mm: 0, connected: true, type: "end", open_end: false, system_id: system, refs: [] },
    ],
    systems: [],
  };
}

test("counts bill fixtures, fixture units, fittings, pipe length, ducts, circuits and orphans", () => {
  const snapshot: TraceSnapshot = {
    flow: {
      elements: [
        { id: 1, name: "WC", kind: "fixture", system_ids: [1] },
        { id: 2, name: "Basin", kind: "fixture", system_ids: [1] },
        { id: 3, name: "Ball valve", kind: "accessory", system_ids: [1] },
        { id: 4, kind: "pipe", system_ids: [1], curve: [[0, 0, 0], [10000, 0, 0]] },
        { id: 5, kind: "fitting", system_ids: [1] },
        { id: 6, kind: "fitting", system_ids: [1] },
        { id: 7, name: "End cap", kind: "fitting", system_ids: [1] },
        { id: 8, kind: "terminal", system_ids: [2], domain: "hvac" },
        { id: 9, name: "Volume damper", kind: "accessory", system_ids: [2], domain: "hvac" },
        { id: 10, kind: "duct", system_ids: [2], domain: "hvac", curve: [[0, 0, 0], [5000, 0, 0]] },
        { id: 11, kind: "pipe" },
      ],
      connectors: [
        { element_id: 4, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 32, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [] },
        { element_id: 5, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 32, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [] },
        { element_id: 5, index: 1, domain: "piping", origin: [1, 0, 0], direction: [0, 1, 0], flow: "in", shape: "round", size_mm: 32, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [] },
        { element_id: 6, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 32, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [] },
        { element_id: 6, index: 1, domain: "piping", origin: [1, 0, 0], direction: [-1, 0, 0], flow: "in", shape: "round", size_mm: 32, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [] },
        { element_id: 6, index: 2, domain: "piping", origin: [0, 1, 0], direction: [0, 1, 0], flow: "out", shape: "round", size_mm: 32, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [] },
        { element_id: 10, index: 0, domain: "hvac", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "rect", size_mm: 300, height_mm: 200, connected: true, type: "end", open_end: false, system_id: 2, refs: [] },
      ],
      systems: [
        { id: 1, name: "Cold", domain: "piping", classification: "DomesticColdWater", element_ids: [1, 2, 3, 4, 5, 6, 7] },
        { id: 2, name: "Supply air", domain: "hvac", classification: "SupplyAir", element_ids: [8, 9, 10] },
      ],
    },
    electrical: {
      panels: [{ id: 20, name: "DB-1", has_supply: true, ways: 12 }],
      circuits: [
        { id: 12, number: "12", panel_id: 20, panel_name: "DB-1", voltage: 230, apparent_va: 1800, length_m: 25, phase: "L1", element_ids: [] },
        { id: 4, number: "4", panel_id: 20, panel_name: "DB-1", voltage: 230, apparent_va: 400, length_m: 10, phase: "L2", element_ids: [] },
      ],
      devices: [
        { id: 30, name: "Socket", category: "Electrical Fixtures", power_connector: true, circuit_ids: [12] },
        { id: 31, name: "Downlight", category: "Lighting Fixtures", power_connector: true, circuit_ids: [12] },
        { id: 32, name: "Socket", category: "Electrical Fixtures", power_connector: true, circuit_ids: [] },
      ],
    },
  };
  const counts = countSystems(snapshot);
  assert.equal(counts.document.systems, 2);
  assert.equal(counts.document.orphans, 1);
  assert.deepEqual(counts.orphans, [11]);
  assert.equal(counts.plumbing.fixtures["WC"], 1);
  assert.equal(counts.plumbing.fixture_units, 7);
  assert.equal(counts.plumbing.valves, 1);
  assert.equal(counts.plumbing.fittings.elbow, 1);
  assert.equal(counts.plumbing.fittings.tee, 1);
  assert.equal(counts.plumbing.fittings.cap, 1);
  assert.equal(counts.plumbing.pipe_m_by_size["32"], 10);
  assert.equal(counts.ducts.terminals, 1);
  assert.equal(counts.ducts.dampers, 1);
  assert.equal(counts.ducts.duct_m_by_size["300"], 5);
  const panel = counts.electrical.panels[0];
  assert.equal(panel.circuits, 2);
  assert.equal(panel.spare_ways, 10);
  assert.equal(panel.load_va, 2200);
  assert.equal(panel.phases.L1, 1800);
  assert.equal(counts.electrical.cable_m, 35);
  assert.equal(counts.document.uncircuited, 1);
  const summary = summariseCounts(counts, 1);
  assert.equal((summary.systems as unknown[]).length, 1);
  assert.equal(summary.systems_total, 2);
});

test("recommendations name the pipe, the circuit, the phase, the bend and the fall, and only some can be edited", () => {
  const snapshot: TraceSnapshot = {
    flow: {
      elements: [
        { id: 1, name: "Flush valve WC", kind: "fixture", system_ids: [1] },
        { id: 2, name: "Bath", kind: "fixture", system_ids: [1] },
        { id: 3, name: "Sink", kind: "fixture", system_ids: [1] },
        { id: 4, kind: "pipe", system_ids: [1], curve: [[0, 0, 0], [8000, 0, -66.7]] },
        { id: 8, name: "Basin", kind: "fixture", system_ids: [2] },
        { id: 9, kind: "fitting", system_ids: [3] },
        { id: 12, kind: "pipe", system_ids: [3], curve: [[0, 0, 0], [8000, 0, -66.7]] },
      ],
      connectors: [
        { element_id: 4, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 32, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, system_class: "DomesticColdWater", refs: [] },
        { element_id: 8, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "in", shape: "round", size_mm: 15, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 2, system_class: "DomesticColdWater", refs: [[10, 0]] },
        { element_id: 10, index: 0, domain: "piping", origin: [100, 0, 0], direction: [-1, 0, 0], flow: "out", shape: "round", size_mm: 15, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 2, system_class: "DomesticColdWater", refs: [[8, 0]] },
        { element_id: 9, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 110, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 3, system_class: "Sanitary", refs: [] },
        { element_id: 9, index: 1, domain: "piping", origin: [1, 0, 0], direction: [0, 1, 0], flow: "in", shape: "round", size_mm: 110, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 3, system_class: "Sanitary", refs: [] },
        { element_id: 12, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 100, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 3, refs: [] },
      ],
      systems: [
        { id: 1, name: "Cold", domain: "piping", classification: "DomesticColdWater", element_ids: [1, 2, 3, 4] },
        { id: 2, name: "Cold branch", domain: "piping", classification: "DomesticColdWater", element_ids: [8, 10] },
        { id: 3, name: "Soil", domain: "piping", classification: "Sanitary", element_ids: [9, 12] },
      ],
    },
    electrical: {
      panels: [{ id: 20, name: "DB-1", has_supply: true, ways: 0 }],
      circuits: [
        { id: 12, number: "12", panel_id: 20, panel_name: "DB-1", voltage: 230, apparent_va: 1800, phase: "L1", element_ids: [], rating_a: 16 },
        { id: 4, number: "4", panel_id: 20, panel_name: "DB-1", voltage: 230, apparent_va: 900, phase: "L1", element_ids: [] },
        { id: 7, number: "7", panel_id: 20, panel_name: "DB-1", voltage: 230, apparent_va: 100, phase: "L3", element_ids: [] },
      ],
      devices: [
        ...Array.from({ length: 14 }, (_, index) => ({ id: 100 + index, name: "Socket", category: "Electrical Fixtures", power_connector: true, circuit_ids: [12] })),
        { id: 200, name: "Downlight", category: "Lighting Fixtures", power_connector: true, circuit_ids: [12] },
      ],
    },
  };
  // element 10 is referenced but not in the element list. Add it so the valve walk has a neighbour that is not a valve.
  snapshot.flow!.elements!.push({ id: 10, kind: "pipe", system_ids: [2] });
  const items = recommend(snapshot, {}, limits);
  const upsize = items.find((item) => item.code === "REC-UPSIZE-PIPE");
  assert.ok(upsize, items.map((item) => item.code).join(","));
  assert.equal(upsize?.element_id, 4);
  assert.equal(upsize?.target, "40 mm");
  assert.match(upsize?.edit?.detail ?? "", /loading units exceeds the 6 capacity/);
  assert.equal(upsize?.provisional, true);
  assert.equal(upsize?.advisory, false);
  const sockets = items.find((item) => item.code === "REC-SPLIT-SOCKETS");
  assert.match(sockets?.current ?? "", /circuit 12 has 14 sockets/);
  assert.match(sockets?.target ?? "", /max 10 per circuit/);
  assert.equal(sockets?.key, "trace.max_points_per_circuit");
  const load = items.find((item) => item.code === "REC-SPLIT-LOAD");
  assert.match(load?.current ?? "", /1\.8 kW/);
  const phase = items.find((item) => item.code === "REC-REBALANCE");
  assert.match(phase?.current ?? "", /phase L1 is/);
  assert.match(phase?.target ?? "", /move circuits/);
  assert.match(phase?.target ?? "", /L3/);
  assert.ok(items.some((item) => item.code === "REC-ADD-VALVE" && item.id === "REC-ADD-VALVE:8"));
  assert.ok(items.some((item) => item.code === "REC-ADD-CLEANOUT" && item.element_id === 9));
  const fall = items.find((item) => item.code === "REC-REGRADE");
  assert.equal(fall?.element_id, 12);
  assert.match(fall?.current ?? "", /1:/);
  assert.equal(fall?.advisory, true);
  const banked = recommend(snapshot, { bank: { "trace.pipe_capacity_fu": { value: { "32": 6, "40": 12 }, status: "draft", clause: "table 3" } } }, limits);
  const signed = banked.find((item) => item.id === "REC-UPSIZE-PIPE:4");
  assert.equal(signed?.provisional, false);
  assert.equal(signed?.clause, "table 3");
  const chosen = editsForRecommendations(items, ["REC-UPSIZE-PIPE:4", "REC-ADD-CLEANOUT:9", "REC-NOPE"]);
  assert.equal(chosen.edits.length, 1);
  assert.equal(chosen.edits[0].op, "resize");
  assert.equal(chosen.edits[0].size_mm, 40);
  assert.equal(chosen.advisory[0].code, "REC-ADD-CLEANOUT");
  assert.deepEqual(chosen.unknown, ["REC-NOPE"]);
  const shown = summariseRecommendations(items, 2);
  assert.equal((shown.recommendations as unknown[]).length, 2);
  assert.ok((shown.recommendations_total as number) > 2);
});
