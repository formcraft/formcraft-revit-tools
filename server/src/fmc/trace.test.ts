import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { documentRequired } from "./fairqueue.js";
import {
  PROVISIONAL_LIMITS,
  catalogue,
  directionsOppose,
  resolveTraceLimits,
  runContinuity,
  runLeak,
  selectChecks,
  summarizeTrace,
  traceFromSnapshot,
  traceReportDir,
  writeTraceReport,
  type ResolvedLimits,
  type TraceConnector,
  type TraceElement,
  type TraceSnapshot,
} from "./trace.js";
import { parseTraceArgs, runFmcTrace } from "../tools/fmc_trace.js";
import { copyTraceFile, pageFindings, flattenFindings } from "./tracereport.js";

const limits = (): ResolvedLimits => {
  const resolved = resolveTraceLimits({});
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.limits;
};

function element(partial: Partial<TraceElement> & { id: number }): TraceElement {
  return { domain: "piping", kind: "pipe", system_ids: [], bbox: null, ...partial };
}

function connector(partial: Partial<TraceConnector> & { element_id: number; index: number }): TraceConnector {
  return {
    domain: "piping",
    origin: [0, 0, 0],
    direction: [1, 0, 0],
    flow: "out",
    shape: "round",
    size_mm: 50,
    height_mm: 0,
    connected: false,
    type: "end",
    open_end: true,
    system_id: 0,
    refs: [],
    ...partial,
  };
}

test("provisional limits stay provisional, a call wins, and a standards value fills one key", () => {
  const plain = resolveTraceLimits({});
  assert.equal(plain.ok, true);
  if (!plain.ok) return;
  assert.equal(plain.limits.status, "PROVISIONAL");
  assert.equal(plain.limits.values.near_miss_mm, PROVISIONAL_LIMITS.near_miss_mm);
  assert.match(plain.limits.kit_change, /PROVISIONAL/);

  const called = resolveTraceLimits({ near_miss_mm: 25 });
  assert.equal(called.ok, true);
  if (!called.ok) return;
  assert.equal(called.limits.values.near_miss_mm, 25);
  assert.equal(called.limits.fields.find((field) => field.key === "trace.near_miss_mm")?.source, "call");
  assert.equal(called.limits.status, "PROVISIONAL");

  const drafted = (value: number) => ({ value, status: "draft", clause: "clause 2" });
  const bank = resolveTraceLimits({}, {
    "trace.near_miss_mm": drafted(40),
    "trace.touch_mm": drafted(12),
    "trace.size_mismatch_mm": drafted(12),
    "trace.direction_deg": drafted(12),
    "trace.connected_gap_mm": drafted(12),
    "trace.voltage_tol_v": drafted(12),
  });
  assert.equal(bank.ok, true);
  if (!bank.ok) return;
  assert.equal(bank.limits.status, "standards");
  assert.equal(bank.limits.values.direction_deg, 12);
  assert.equal(bank.limits.fields.find((field) => field.key === "trace.direction_deg")?.source, "standards");
  assert.equal(bank.limits.kit_change, "");

  const bad = resolveTraceLimits({ touch_mm: -1 });
  assert.equal(bad.ok, false);
});

test("limits read bank aliases, and a null alias stays unknown on the provisional default", () => {
  const drafted = { status: "draft" as const, clause: "joints" };
  const aliased = resolveTraceLimits({}, {
    "trace.near_miss_tolerance": { value: 80, ...drafted },
    "trace.voltage_drop_max": { value: 3, ...drafted },
    "trace.connection_tolerance": { value: { touch_mm: 8, size_mismatch_mm: null, direction_deg: 20, connected_gap_mm: 12, voltage_tol_v: 25 }, ...drafted },
  });
  assert.equal(aliased.ok, true);
  if (!aliased.ok) return;
  const near = aliased.limits.fields.find((field) => field.key === "trace.near_miss_mm");
  assert.equal(near?.value, 80);
  assert.equal(near?.source, "standards");
  assert.equal(near?.alias_used, "trace.near_miss_tolerance");
  const drop = aliased.limits.fields.find((field) => field.key === "trace.voltage_drop_pct");
  assert.equal(drop?.value, 3);
  assert.equal(drop?.alias_used, "trace.voltage_drop_max");
  const touch = aliased.limits.fields.find((field) => field.key === "trace.touch_mm");
  const gap = aliased.limits.fields.find((field) => field.key === "trace.connected_gap_mm");
  const size = aliased.limits.fields.find((field) => field.key === "trace.size_mismatch_mm");
  assert.equal(touch?.value, 8);
  assert.equal(touch?.alias_used, "trace.connection_tolerance");
  assert.equal(gap?.value, 12);
  assert.equal(size?.source, "unknown");
  assert.equal(size?.value, PROVISIONAL_LIMITS.size_mismatch_mm);
  assert.equal(size?.status, "PROVISIONAL");
  assert.match(size?.clause ?? "", /PROVISIONAL/);
  assert.equal(aliased.limits.values.voltage_tol_v, 25);

  const scalar = resolveTraceLimits({}, { "trace.connection_tolerance": { value: 9, ...drafted } });
  assert.equal(scalar.ok, true);
  if (!scalar.ok) return;
  assert.equal(scalar.limits.values.touch_mm, 9);
  assert.equal(scalar.limits.values.connected_gap_mm, 9);
  assert.equal(scalar.limits.values.direction_deg, PROVISIONAL_LIMITS.direction_deg);
  assert.equal(scalar.limits.fields.find((field) => field.key === "trace.direction_deg")?.alias_used, undefined);

  const nulled = resolveTraceLimits({}, { "trace.near_miss_tolerance": { value: null, status: "approved", clause: "not set" } });
  assert.equal(nulled.ok, true);
  if (!nulled.ok) return;
  const missing = nulled.limits.fields.find((field) => field.key === "trace.near_miss_mm");
  assert.equal(missing?.source, "unknown");
  assert.equal(missing?.value, PROVISIONAL_LIMITS.near_miss_mm);
  assert.equal(missing?.alias_used, "trace.near_miss_tolerance");
  assert.match(missing?.clause ?? "", /PROVISIONAL/);

  const provisional = resolveTraceLimits({}, { "trace.near_miss_tolerance": { value: 40, status: "provisional", clause: "drafted" } });
  assert.equal(provisional.ok, true);
  if (!provisional.ok) return;
  assert.equal(provisional.limits.fields.find((field) => field.key === "trace.near_miss_mm")?.source, "provisional");

  const canonical = resolveTraceLimits({}, {
    "trace.near_miss_mm": { value: 30, ...drafted },
    "trace.near_miss_tolerance": { value: 80, ...drafted },
  });
  assert.equal(canonical.ok, true);
  if (!canonical.ok) return;
  const kept = canonical.limits.fields.find((field) => field.key === "trace.near_miss_mm");
  assert.equal(kept?.value, 30);
  assert.equal(kept?.alias_used, undefined);

  const called = resolveTraceLimits({ near_miss_mm: 25 }, { "trace.near_miss_tolerance": { value: 80, ...drafted } });
  assert.equal(called.ok, true);
  if (!called.ok) return;
  assert.equal(called.limits.values.near_miss_mm, 25);
  assert.equal(called.limits.fields.find((field) => field.key === "trace.near_miss_mm")?.source, "call");
});

test("leak and continuity use the bank tolerance, including a connection_tolerance voltage", () => {
  const apart: TraceSnapshot = {
    flow: {
      elements: [element({ id: 1 }), element({ id: 2 })],
      connectors: [
        connector({ element_id: 1, index: 0, origin: [0, 0, 0], direction: [1, 0, 0] }),
        connector({ element_id: 2, index: 0, origin: [60, 0, 0], direction: [-1, 0, 0] }),
      ],
      systems: [],
    },
  };
  const wide = resolveTraceLimits({}, { "trace.near_miss_tolerance": { value: 80, status: "draft", clause: "joints" } });
  assert.equal(wide.ok, true);
  if (!wide.ok) return;
  assert.equal(runLeak(apart, wide.limits, {}).findings.some((finding) => finding.code === "FLOW-NEAR-MISS"), true);
  assert.equal(runLeak(apart, limits(), {}).findings.some((finding) => finding.code === "FLOW-NEAR-MISS"), false);

  const board: TraceSnapshot = {
    electrical: {
      panels: [{ id: 1, name: "DB", distribution: "DS_415", voltage: 415, has_supply: true }],
      circuits: [{ id: 4, panel_id: 1, panel_name: "DB", number: "1", voltage: 230, poles: 1, element_ids: [8], distribution: "DS_240" }],
      devices: [{ id: 8, category: "ElectricalFixtures", voltage: 250, poles: 1, power_connector: true, circuit_ids: [4] }],
    },
  };
  assert.equal(runContinuity(board, limits(), {}).findings.some((finding) => finding.code === "ELEC-VOLTAGE-MISMATCH"), true);
  const loose = resolveTraceLimits({}, {
    "trace.connection_tolerance": { value: { voltage_tol_v: 25 }, status: "draft", clause: "joints" },
  });
  assert.equal(loose.ok, true);
  if (!loose.ok) return;
  assert.equal(loose.limits.fields.find((field) => field.key === "trace.voltage_tol_v")?.alias_used, "trace.connection_tolerance");
  assert.equal(runContinuity(board, loose.limits, {}).findings.some((finding) => finding.code === "ELEC-VOLTAGE-MISMATCH"), false);
});

test("conduit and tray open ends are the same leak codes, and they are not FLOW-NO-SYSTEM", () => {
  const ends = Array.from({ length: 4 }, (_, index) => ({
    element_id: index + 1,
    index: 0,
    domain: index < 3 ? "conduit" : "tray",
    origin: [index * 1000, 0, 0] as number[],
    direction: [1, 0, 0] as number[],
    flow: "",
    shape: "round",
    size_mm: 20,
    height_mm: 0,
    connected: false,
    type: "end",
    open_end: true,
    system_id: 0,
    refs: [] as number[][],
  }));
  const snapshot: TraceSnapshot = {
    flow: {
      elements: ends.map((end) => ({ id: end.element_id, kind: end.domain, domain: end.domain, system_ids: [] as number[] })),
      connectors: ends,
      systems: [],
    },
  };
  const conduit = runLeak(snapshot, limits(), { domain: "conduit" });
  assert.equal(conduit.counts["FLOW-OPEN-END"], 3);
  assert.equal(conduit.findings.some((finding) => finding.code === "FLOW-NO-SYSTEM"), false);
  const both = runLeak(snapshot, limits(), { domain: "electrical_containment" });
  assert.equal(both.counts["FLOW-OPEN-END"], 4);
  assert.equal(runLeak(snapshot, limits(), { domain: "tray" }).counts["FLOW-OPEN-END"], 1);
});

test("connector axes face each other within the provisional angle", () => {
  assert.equal(directionsOppose([1, 0, 0], [-1, 0, 0], 15), true);
  assert.equal(directionsOppose([1, 0, 0], [1, 0, 0], 15), false);
  assert.equal(directionsOppose([0, 0, 0], [1, 0, 0], 15), null);
});

test("leak test: open end, untouched parallel pipe, size mismatch, near-miss, no system, island", () => {
  const snapshot: TraceSnapshot = {
    model: "P-0001_USER",
    resolved_document: { title: "P-0001_USER", path: "C:\\WIP\\P-0001_USER.rvt" },
    active_unchanged: true,
    flow: {
      elements: [
        element({ id: 1, kind: "equipment", system_ids: [10], bbox: [0, 0, 0, 100, 100, 100] }),
        element({ id: 2, kind: "pipe", system_ids: [10], bbox: [100, 40, 40, 400, 60, 60] }),
        element({ id: 3, kind: "fitting", system_ids: [10], bbox: [400, 20, 20, 500, 80, 80] }),
        element({ id: 4, kind: "pipe", system_ids: [10], bbox: [0, 500, 0, 300, 560, 40] }),
        element({ id: 5, kind: "pipe", system_ids: [], bbox: [0, 0, 500, 200, 40, 540] }),
        element({ id: 6, kind: "pipe", system_ids: [10], bbox: [900, 0, 0, 1100, 40, 40] }),
        element({ id: 7, kind: "fitting", system_ids: [10], bbox: [180, 0, 0, 280, 80, 80] }),
      ],
      connectors: [
        connector({ element_id: 1, index: 0, origin: [100, 50, 50], direction: [1, 0, 0], flow: "out", connected: true, open_end: false, refs: [[2, 0]] }),
        connector({ element_id: 2, index: 0, origin: [100, 50, 50], direction: [-1, 0, 0], flow: "in", connected: true, open_end: false, refs: [[1, 0]] }),
        connector({ element_id: 2, index: 1, origin: [400, 50, 50], direction: [1, 0, 0], flow: "out", size_mm: 50, connected: true, open_end: false, refs: [[3, 0]] }),
        connector({ element_id: 3, index: 0, origin: [400, 50, 50], direction: [-1, 0, 0], flow: "in", size_mm: 80, connected: true, open_end: false, refs: [[2, 1]] }),
        connector({ element_id: 3, index: 1, origin: [500, 50, 50], direction: [1, 0, 0], flow: "out", open_end: true }),
        connector({ element_id: 4, index: 0, origin: [0, 530, 20], direction: [-1, 0, 0], open_end: true }),
        connector({ element_id: 5, index: 0, origin: [0, 20, 520], direction: [-1, 0, 0], open_end: true }),
        connector({ element_id: 6, index: 0, origin: [900, 20, 20], direction: [-1, 0, 0], open_end: true }),
        connector({ element_id: 2, index: 2, origin: [200, 50, 50], direction: [0, 1, 0], type: "curve", open_end: false, connected: false }),
        connector({ element_id: 2, index: 3, origin: [200, 50, 50], direction: [1, 0, 0], flow: "out", open_end: true }),
        connector({ element_id: 7, index: 0, origin: [230, 50, 50], direction: [-1, 0, 0], flow: "in", open_end: true }),
      ],
      systems: [{ id: 10, name: "Sanitary", domain: "piping", classification: "Sanitary", base_equipment_id: 1, element_ids: [1, 2, 3, 4, 6, 7] }],
    },
  };
  const run = runLeak(snapshot, limits(), { domain: "both" });
  const codes = run.findings.map((finding) => `${finding.code}:${finding.id}`);
  assert.ok(codes.includes("FLOW-OPEN-END:3"), codes.join(","));
  assert.ok(codes.includes("FLOW-OPEN-END:4"));
  assert.equal(run.findings.some((finding) => finding.code === "FLOW-OPEN-END" && finding.connector === 2), false);
  assert.ok(codes.includes("FLOW-SIZE-MISMATCH:3"));
  assert.ok(codes.includes("FLOW-NEAR-MISS:2") || codes.includes("FLOW-NEAR-MISS:7"));
  assert.equal(run.findings.some((finding) => finding.code === "FLOW-NOT-CONNECTED" && finding.id === 4 && finding.other_id === 2), false);
  assert.ok(codes.includes("FLOW-NO-SYSTEM:5"));
  assert.ok(codes.includes("FLOW-ISLAND:4"));
  assert.ok(codes.includes("FLOW-ISLAND:6"));
  assert.equal(run.findings.some((finding) => finding.code === "FLOW-ISLAND" && finding.id === 2), false);
  assert.equal(run.pass, false);
  assert.ok(run.counts["FLOW-OPEN-END"] >= 2);
});

test("a pipe end buried in a fitting with no connector pair is FLOW-NOT-CONNECTED", () => {
  const snapshot: TraceSnapshot = {
    flow: {
      elements: [
        element({ id: 1, bbox: [0, 0, 0, 200, 40, 40] }),
        element({ id: 2, kind: "fitting", bbox: [190, 0, 0, 300, 80, 80] }),
      ],
      connectors: [
        connector({ element_id: 1, index: 0, origin: [200, 20, 20], open_end: true }),
        connector({ element_id: 2, index: 0, origin: [400, 20, 20], open_end: true }),
      ],
      systems: [{ id: 1, name: "Domestic", domain: "piping", base_equipment_id: 0, element_ids: [1, 2] }],
    },
  };
  const run = runLeak(snapshot, limits(), {});
  assert.ok(run.findings.some((finding) => finding.code === "FLOW-NOT-CONNECTED" && finding.id === 1 && finding.other_id === 2));
  assert.equal(run.findings.some((finding) => finding.code === "FLOW-NEAR-MISS"), false);
});

test("connected connectors that face apart, or sit apart, are a near-miss; a matched joint is not", () => {
  const bad: TraceSnapshot = {
    flow: {
      elements: [element({ id: 1, kind: "fitting" }), element({ id: 2 })],
      connectors: [
        connector({ element_id: 1, index: 0, origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", connected: true, open_end: false, refs: [[2, 0]] }),
        connector({ element_id: 2, index: 0, origin: [40, 0, 0], direction: [1, 0, 0], flow: "out", connected: true, open_end: false, refs: [[1, 0]] }),
      ],
      systems: [{ id: 3, name: "Supply", domain: "piping", base_equipment_id: 1, element_ids: [1, 2] }],
    },
  };
  const run = runLeak(bad, limits(), { source: "1" });
  const near = run.findings.filter((finding) => finding.code === "FLOW-NEAR-MISS");
  assert.equal(near.length, 1);
  assert.match(near[0].detail, /apart/);
  assert.match(near[0].detail, /face/);
  assert.match(near[0].detail, /flow/);
  assert.equal(run.findings.some((finding) => finding.code === "FLOW-ISLAND"), false);

  const good: TraceSnapshot = {
    flow: {
      elements: [element({ id: 1, system_ids: [3] }), element({ id: 2, system_ids: [3] })],
      connectors: [
        connector({ element_id: 1, index: 0, origin: [0, 0, 0], direction: [1, 0, 0], flow: "out", connected: true, open_end: false, refs: [[2, 0]] }),
        connector({ element_id: 2, index: 0, origin: [2, 0, 0], direction: [-1, 0, 0], flow: "in", connected: true, open_end: false, refs: [[1, 0]] }),
      ],
      systems: [{ id: 3, name: "Supply", domain: "piping", base_equipment_id: 1, element_ids: [1, 2] }],
    },
  };
  const clean = runLeak(good, limits(), { system: "Supply" });
  assert.equal(clean.pass, true, JSON.stringify(clean.findings));
});

test("a named system that is not in the model does not pass, and ducts stay out of a piping walk", () => {
  const snapshot: TraceSnapshot = {
    flow: {
      elements: [element({ id: 1, domain: "hvac", kind: "duct" })],
      connectors: [connector({ element_id: 1, index: 0, domain: "hvac", open_end: true })],
      systems: [{ id: 8, name: "Supply air", domain: "hvac", element_ids: [1] }],
    },
  };
  const missing = runLeak(snapshot, limits(), { system: "Sanitary" });
  assert.equal(missing.pass, false);
  assert.match(missing.warnings.join(" "), /Sanitary/);
  assert.equal(missing.findings.length, 0);
  const ducts = runLeak(snapshot, limits(), { domain: "duct" });
  assert.ok(ducts.findings.some((finding) => finding.code === "FLOW-OPEN-END" && finding.id === 1));
  const pipes = runLeak(snapshot, limits(), { domain: "piping" });
  assert.equal(pipes.findings.some((finding) => finding.code === "FLOW-OPEN-END"), false);
});

test("electrical continuity reports each phase-1 code and accepts a matched device", () => {
  const snapshot: TraceSnapshot = {
    model: "E-0001_USER",
    electrical: {
      panels: [
        { id: 1, name: "MDB", distribution: "DS_415", voltage: 415, has_supply: false },
        { id: 2, name: "DB-1", distribution: "DS_415", voltage: 415, has_supply: true, supply_from_id: 1 },
      ],
      circuits: [
        { id: 9, panel_id: 0, number: "x", voltage: 230, poles: 1, element_ids: [5], distribution: "" },
        { id: 7, panel_id: 2, panel_name: "DB-1", number: "1", voltage: 230, poles: 1, element_ids: [], distribution: "DS_415" },
        { id: 8, panel_id: 2, panel_name: "DB-1", number: "2", voltage: 230, poles: 1, element_ids: [6], distribution: "DS_415" },
        { id: 4, panel_id: 2, panel_name: "DB-1", number: "3", voltage: 230, poles: 1, element_ids: [8], distribution: "DS_240" },
      ],
      devices: [
        { id: 5, category: "ElectricalFixtures", voltage: 230, poles: 1, power_connector: true, circuit_ids: [] },
        { id: 6, category: "ElectricalFixtures", voltage: 400, poles: 1, power_connector: true, circuit_ids: [8] },
        { id: 8, category: "LightingFixtures", voltage: 230, poles: 1, distribution: "DS_415", power_connector: true, circuit_ids: [4] },
        { id: 11, category: "LightingFixtures", voltage: 240, poles: 1, distribution: "DS_415", power_connector: true, circuit_ids: [8] },
      ],
    },
  };
  const run = runContinuity(snapshot, limits(), {});
  const codes = new Set(run.findings.map((finding) => finding.code));
  assert.ok(codes.has("ELEC-NO-CIRCUIT"));
  assert.ok(codes.has("ELEC-NO-PANEL"));
  assert.ok(codes.has("ELEC-NO-SUPPLY"));
  assert.ok(codes.has("ELEC-VOLTAGE-MISMATCH"));
  assert.ok(codes.has("ELEC-EMPTY-CIRCUIT"));
  assert.equal(run.findings.some((finding) => finding.code === "ELEC-VOLTAGE-MISMATCH" && finding.id === 11), false);
  assert.ok(run.findings.some((finding) => finding.code === "ELEC-VOLTAGE-MISMATCH" && finding.id === 6));
  assert.ok(run.findings.some((finding) => finding.code === "ELEC-VOLTAGE-MISMATCH" && finding.id === 8));
  const one = runContinuity(snapshot, limits(), { panel: "DB-1" });
  assert.equal(one.findings.some((finding) => finding.code === "ELEC-NO-SUPPLY" && finding.id === 1), false);
  assert.ok(one.findings.some((finding) => finding.code === "ELEC-NO-PANEL"));
  assert.ok(one.findings.some((finding) => finding.code === "ELEC-NO-CIRCUIT"));
});

test("the reply is counts and a capped id list; the JSON file keeps every finding", () => {
  const elements = [element({ id: 1, kind: "equipment", system_ids: [1], bbox: [0, 0, 0, 10, 10, 10] })];
  const connectors = [connector({ element_id: 1, index: 0, origin: [10, 5, 5], connected: true, open_end: false, refs: [] })];
  for (let i = 0; i < 6; i++) {
    const id = 10 + i;
    elements.push(element({ id, bbox: [100 + i * 100, 0, 0, 180 + i * 100, 20, 20] }));
    connectors.push(connector({ element_id: id, index: 0, origin: [100 + i * 100, 10, 10], open_end: true }));
  }
  const snapshot: TraceSnapshot = {
    model: "P-0001_USER",
    active_unchanged: true,
    flow: { elements, connectors, systems: [{ id: 1, name: "Sanitary", domain: "piping", base_equipment_id: 1, element_ids: [1] }] },
  };
  const selection = selectChecks("leak");
  const resolved = limits();
  const runs = traceFromSnapshot(snapshot, selection, resolved, { domain: "both" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-trace-"));
  const report = writeTraceReport(snapshot, runs, resolved, { domain: "both" }, { ...process.env, LOCALAPPDATA: dir });
  const summary = summarizeTrace(runs, { limits: resolved, skipped: [], unknown: [], sampleLimit: 2, highlight: "ids", report, snapshot });
  assert.equal(summary.checks[0].ids.length, 2);
  assert.ok(summary.checks[0].counts["FLOW-OPEN-END"] >= 6);
  assert.equal(JSON.stringify(summary).includes("origin"), false);
  const full = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.ok(full.checks[0].findings.length >= 6);
  assert.ok(report.includes("trace-"));
  assert.equal(summary.read_only, true);
  assert.equal(summary.limits_status, "PROVISIONAL");
  // F98: nothing found against PROVISIONAL limits is PROVISIONAL, never pass true.
  const empty = summarizeTrace([], { limits: resolved, skipped: [], unknown: [], sampleLimit: 2, highlight: "ids", report, snapshot });
  assert.equal(empty.pass, false);
  assert.equal(empty.status, "PROVISIONAL");
  assert.equal(summary.status, "FAIL");
});

test("phase 2 standards checks run, and tray fill stays listed and not run", () => {
  const list = catalogue();
  const ids = list.checks.map((check) => check.id);
  assert.deepEqual(ids.slice(0, 3), ["leak", "continuity", "missing"]);
  assert.deepEqual(ids.slice(3, 7), ["drainage_fall", "venting", "cross_connection", "dead_legs"]);
  const picked = selectChecks("run", ["leak", "drainage_fall", "tray_fill", "nope"]);
  assert.deepEqual(picked.run.map((check) => check.id), ["leak", "drainage_fall"]);
  assert.equal(picked.skipped[0].id, "tray_fill");
  assert.deepEqual(picked.unknown, ["nope"]);
  assert.equal(list.checks.find((check) => check.id === "drainage_fall")?.implemented, true);
});

test("report pages a saved findings file and refuses a copy onto D:", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-trace-page-"));
  const home = path.join(dir, "Formcraft");
  const file = path.join(home, "trace", "trace-P-0001-page.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ checks: [{ id: "leak", findings: [
    { code: "FLOW-OPEN-END", id: 1 }, { code: "FLOW-NO-SYSTEM", id: 2 }, { code: "FLOW-OPEN-END", id: 3 },
  ] }] }));
  const page = pageFindings(flattenFindings(JSON.parse(fs.readFileSync(file, "utf8"))), { offset: 1, limit: 1, codes: ["FLOW-OPEN-END"] });
  assert.equal(page.total, 2);
  assert.equal(page.findings[0].id, 3);
  const copied = copyTraceFile(file, path.join(home, "handoff"), { ...process.env, LOCALAPPDATA: dir });
  assert.equal(fs.existsSync(copied), true);
  assert.throws(() => copyTraceFile(file, "D:\\Jobs\\out", { ...process.env, LOCALAPPDATA: dir }), /D:/);
  const reply = await runFmcTrace(parseTraceArgs({ action: "report", path: file, offset: 0, limit: 1, codes: ["FLOW-NO-SYSTEM"] }));
  const body = JSON.parse(reply.content[0].text);
  assert.equal(body.read_only, true);
  assert.equal(body.findings[0].id, 2);
});

test("checks and limits do not need Revit, and the description names the codes", async () => {
  const checks = await runFmcTrace(parseTraceArgs({ action: "checks" }));
  const body = JSON.parse(checks.content[0].text);
  assert.equal(body.read_only, true);
  assert.ok(body.codes.includes("FLOW-OPEN-END"));
  assert.ok(body.codes.includes("ELEC-EMPTY-CIRCUIT"));
  const shown = await runFmcTrace(parseTraceArgs({ action: "limits", near_miss_mm: 30 }));
  const limitsBody = JSON.parse(shown.content[0].text);
  assert.equal(limitsBody.limits.values.near_miss_mm, 30);
  assert.equal(limitsBody.limits.status, "PROVISIONAL");
  const { FMC_TRACE_DESCRIPTION } = await import("../tools/fmc_trace.js");
  assert.match(FMC_TRACE_DESCRIPTION, /read-only/);
  assert.match(FMC_TRACE_DESCRIPTION, /FLOW-NEAR-MISS/);
  assert.match(FMC_TRACE_DESCRIPTION, /FMC-DOC-REQUIRED/);
  assert.match(FMC_TRACE_DESCRIPTION, /P-0001_USER/);
  assert.match(FMC_TRACE_DESCRIPTION, /E-0001_USER/);
});

test("fmc_trace names its document and does not open a closed file", () => {
  const open = ["P-0001_USER", "E-0001_USER"];
  assert.match(documentRequired("fmc_trace", open, undefined) ?? "", /FMC-DOC-REQUIRED/);
  assert.match(documentRequired("fmc_trace", open, "missing") ?? "", /FMC-DOC-NOT-FOUND/);
  assert.match(documentRequired("fmc_trace", open, "C:\\WIP\\P-0001_USER.rvt") ?? "", /FMC-DOC-NOT-FOUND/);
  assert.equal(documentRequired("fmc_trace", open, "P-0001_USER"), undefined);
  assert.match(documentRequired("fmc_trace", ["P-0001_USER", "P-0001_USER"], "P-0001_USER") ?? "", /FMC-DOC-AMBIGUOUS/);
});

test("the report directory stays under Formcraft and off D:", () => {
  assert.equal(traceReportDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" }), "C:\\Users\\me\\AppData\\Local\\Formcraft\\trace");
  assert.equal(traceReportDir({ LOCALAPPDATA: "D:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" }), "C:\\Users\\me\\Formcraft\\trace");
});

test("the add-in command opens no transaction and does not switch documents", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const source = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcTrace.cs"), "utf8");
  assert.equal(/new\s+Transaction/.test(source), false);
  assert.equal(/TransactionGroup/.test(source), false);
  assert.equal(/Checkout/.test(source), false);
  assert.equal(/SynchronizeWithCentral/.test(source), false);
  assert.equal(/RequestViewChange/.test(source), false);
  assert.equal(/OpenAndActivateDocument/.test(source), false);
  assert.match(source, /mayOpen:\s*false/);
  assert.match(source, /IsolateElementsTemporary/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName?: string }> };
  assert.ok(manifest.commands.some((row) => row.commandName === "fmc_trace"));
});
