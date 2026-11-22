import { test } from "node:test";
import assert from "node:assert/strict";
import type { TraceSnapshot } from "./trace.js";
import { citeCell, citeLimit, deadLegLimitMm, fallLimit, phaseLimits, pipeCapacity, traceEntriesFromStandards, voltageDropMv } from "./trace_bank.js";
import { runDrainageFall, runVenting } from "./trace_phase2.js";

const limits = { values: { near_miss_mm: 50, touch_mm: 10, size_mismatch_mm: 2, direction_deg: 15, connected_gap_mm: 15, voltage_tol_v: 15 } };

test("a provisional bank entry is cited as PROVISIONAL and a draft with a clause can pass", () => {
  const provisional = citeLimit("trace.drain_min_mm", { "trace.drain_min_mm": { value: 100, status: "provisional", clause: "clause 4" } });
  assert.equal(provisional.source, "provisional");
  assert.equal(provisional.value, 100);
  assert.match(provisional.clause, /clause 4/);
  const draft = citeLimit("trace.drain_min_mm", { "trace.drain_min_mm": { value: 100, status: "draft", clause: "clause 4" } });
  assert.equal(draft.source, "standards");
  const approved = citeLimit("trace.vent_distance", { "trace.vent_distance": { value: 300, status: "approved", clause: "trap outlet" } });
  assert.equal(approved.source, "standards");
  assert.equal(approved.value, 300);
});

test("a null value uses the provisional default, and a null with no default is unknown", () => {
  const nulled = citeLimit("trace.drain_min_mm", { "trace.drain_min_mm": { value: null, status: "draft", clause: "not set" } });
  assert.equal(nulled.value, 100);
  assert.equal(nulled.source, "provisional");
  assert.match(nulled.clause, /null/);
  const empty = citeLimit("trace.not_a_key", { "trace.not_a_key": { value: null, status: "draft", clause: "empty" } });
  assert.equal(empty.value, null);
  assert.equal(empty.source, "unknown");
  assert.doesNotThrow(() => traceEntriesFromStandards({ "trace.drain_min_mm": { value: null }, "levels.floor_to_floor": { value: 3000 }, "trace.bad": "nope" }));
});

test("drain fall over 225 mm is 1:100 and 300 mm is 1:150", () => {
  const bank = { "trace.drain_fall_over": { value: { "225": "1:100", "300": "1:150" }, status: "draft" as const, clause: "table 6" } };
  const at225 = fallLimit(200, bank);
  const at300 = fallLimit(300, bank);
  assert.equal(at225.source, "standards");
  assert.ok(Math.abs((at225.value ?? 0) - 0.01) < 1e-9);
  assert.ok(Math.abs((at300.value ?? 0) - 1 / 150) < 1e-9);
  assert.match(at300.clause, /table 6/);
  const missing = fallLimit(300, { "trace.drain_fall_over": { value: { "225": "1:100", "300": null }, status: "draft", clause: "table 6" } });
  assert.equal(missing.source, "provisional");
  assert.ok(Math.abs((missing.value ?? 0) - 1 / 150) < 1e-9);
});

test("a hot-water dead leg uses the length table, and a null pipe capacity stays provisional", () => {
  assert.equal(deadLegLimitMm(12, undefined).value, 20000);
  assert.equal(deadLegLimitMm(22, undefined).value, 12000);
  assert.equal(deadLegLimitMm(28, undefined).value, 8000);
  assert.equal(deadLegLimitMm(40, undefined).value, 3000);
  const capped = pipeCapacity(32, { "trace.pipe_capacity_fu": { value: { "32": null, "40": 12 }, status: "draft", clause: "sizes" } });
  assert.equal(capped.value, 6);
  assert.equal(capped.source, "provisional");
  const known = pipeCapacity(40, { "trace.pipe_capacity_fu": { value: { "32": null, "40": 12 }, status: "draft", clause: "sizes" } });
  assert.equal(known.value, 12);
  assert.equal(known.source, "standards");
});

test("voltage drop is read per cable size and phase imbalance keeps the short-term allowance", () => {
  const mv = voltageDropMv(2.5, { "trace.voltage_drop_mV_per_A_m": { value: { "1.5": 29, "2.5": null, "4": 11 }, status: "draft", clause: "cables" } });
  assert.equal(mv.value, 18);
  assert.equal(mv.source, "provisional");
  const set = voltageDropMv(1.5, { "trace.voltage_drop_mV_per_A_m": { value: { "1.5": 29, "2.5": null }, status: "approved", clause: "cables" } });
  assert.equal(set.value, 29);
  assert.equal(set.source, "standards");
  const phase = phaseLimits({ "trace.phase_imbalance_max": { value: { max_pct: 5, short_term_pct: 10 }, status: "draft", clause: "balance" } });
  assert.equal(phase.standing.value, 5);
  assert.equal(phase.standing.source, "standards");
  assert.equal(phase.shortTerm.value, 10);
  const pressure = citeLimit("trace.residual_pressure_min", { "trace.residual_pressure_min": { value: 0.2, unit: "kg/cm2", kPa: 19.6, status: "draft", clause: "0.20 kg/cm²" } });
  assert.equal(pressure.value, 19.6);
  assert.equal(citeCell("trace.supply_loading_units", "wc_flush_valve").value, 4.32);
  assert.equal(citeCell("trace.supply_loading_units", "bath").value, 1.96);
});

test("a vent within 300 mm of the trap outlet can pass, and a provisional fall cannot", () => {
  const near: TraceSnapshot = {
    flow: {
      elements: [
        { id: 1, name: "Bottle trap", kind: "fitting", system_ids: [1] },
        { id: 2, kind: "pipe", system_ids: [1], curve: [[0, 0, 0], [200, 0, 0]] },
        { id: 3, name: "Vent cowl", kind: "fitting", system_ids: [1] },
      ],
      connectors: [
        { element_id: 1, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 40, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [[2, 0]] },
        { element_id: 2, index: 0, domain: "piping", origin: [0, 0, 0], direction: [-1, 0, 0], flow: "in", shape: "round", size_mm: 40, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [[1, 0]] },
        { element_id: 2, index: 1, domain: "piping", origin: [200, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 40, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [[3, 0]] },
        { element_id: 3, index: 0, domain: "piping", origin: [200, 0, 0], direction: [-1, 0, 0], flow: "in", shape: "round", size_mm: 40, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 1, refs: [[2, 1]] },
      ],
      systems: [{ id: 1, name: "Soil", domain: "piping", classification: "Sanitary", element_ids: [1, 2, 3] }],
    },
  };
  const passed = runVenting(near, limits, { bank: { "trace.vent_distance": { value: 300, status: "draft", clause: "within 300 mm of the trap outlet" } } });
  assert.equal(passed.findings.some((item) => item.code === "STD-FAIL" || item.code === "STD-PROVISIONAL"), false);
  assert.equal(passed.pass, true);
  const far = structuredClone(near);
  far.flow!.elements![1].curve = [[0, 0, 0], [800, 0, 0]];
  const missed = runVenting(far, limits, { bank: { "trace.vent_distance": { value: 300, status: "draft", clause: "within 300 mm of the trap outlet" } } });
  assert.equal(missed.findings[0]?.code, "STD-FAIL");
  const flat: TraceSnapshot = {
    flow: {
      elements: [{ id: 4, kind: "pipe", system_ids: [9], curve: [[0, 0, 0], [8000, 0, -200]] }],
      connectors: [{ element_id: 4, index: 0, domain: "piping", origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", shape: "round", size_mm: 100, height_mm: 0, connected: true, type: "end", open_end: false, system_id: 9, refs: [] }],
      systems: [{ id: 9, name: "Soil", domain: "piping", classification: "Sanitary", element_ids: [4] }],
    },
  };
  const held = runDrainageFall(flat, limits, { bank: { "trace.drain_fall_100": { value: "1:80", status: "provisional", clause: "not signed" } } });
  assert.equal(held.findings[0].code, "STD-PROVISIONAL");
  assert.equal(held.pass, false);
});
