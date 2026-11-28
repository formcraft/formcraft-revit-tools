import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLUIDS, cableSize, checkSegment, criticalPath, frictionFactor, mepLimits, section, sizeRound, summary, vd, voltageDropRow,
  type MepSegment,
} from "./mepsize.js";
import { circuitsFromFacts, runFmcMepSize, type FmcMepSizeArgs } from "../tools/fmc_mep_size.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, LOCALAPPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "mepsize-")) };
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const args = (a: Partial<FmcMepSizeArgs>): FmcMepSizeArgs => ({
  action: "duct", segments: [], standard_sizes_mm: [], circuits: [], cables: [], from_model: false, limits: {}, sample_limit: 40, ...a,
} as FmcMepSizeArgs);

test("a missing bank key is TBC, never a number from code, and the call's limit is tagged engineer", () => {
  const none = mepLimits("duct", {});
  assert.equal(none.velocity_max_ms.value, null);
  assert.equal(none.velocity_max_ms.source, "TBC");
  assert.ok(none.tbc.includes("mep.duct_velocity_max_ms"));
  assert.equal(none.provisional, true);
  const given = mepLimits("duct", {}, { velocity_max_ms: 5 });
  assert.equal(given.velocity_max_ms.value, 5);
  assert.equal(given.velocity_max_ms.source, "engineer");
  const banked = mepLimits("duct", { "mep.duct_velocity_max_ms": { value: 6, status: "approved", clause: "CIBSE B3 table" } as never });
  assert.equal(banked.velocity_max_ms.value, 6);
  assert.match(banked.velocity_max_ms.source, /^(standards|provisional):mep\.duct_velocity_max_ms$/);
});

test("section: round and rectangular hydraulic diameter", () => {
  const r = section({ size_mm: 400 })!;
  assert.ok(Math.abs(r.area_m2 - 0.125664) < 1e-5);
  assert.equal(r.dh_m, 0.4);
  const q = section({ shape: "rect", w_mm: 600, h_mm: 300 })!;
  assert.ok(Math.abs(q.area_m2 - 0.18) < 1e-9);
  assert.ok(Math.abs(q.dh_m - 0.4) < 1e-9);
  assert.equal(section({ shape: "rect", w_mm: 600 }), null);
});

test("friction factor: laminar 64/Re and Swamee-Jain within 2 % of Colebrook", () => {
  assert.equal(frictionFactor(1000, 0.00015, 0.1), 0.064);
  // Colebrook solved by iteration for Re 1e5, e/D 0.0015 (0.15 mm in 100 mm) is 0.02374.
  const f = frictionFactor(1e5, 0.00015, 0.1);
  assert.ok(Math.abs(f - 0.02374) / 0.02374 < 0.02, `f=${f}`);
});

test("duct sizing: 500 L/s at 5 m/s needs 357 mm, so 400 mm from the list", () => {
  const seg: MepSegment = { id: "D1", kind: "duct", flow_l_s: 500 };
  const limits = mepLimits("duct", {}, { velocity_max_ms: 5 });
  const row = sizeRound(seg, limits, FLUIDS.air, [250, 315, 355, 400, 450]);
  assert.equal(row.values.min_diameter.value, 357);
  assert.equal(row.values.proposed_size.value, 400);
  assert.equal(row.verdict, "TBC", "friction is TBC without a friction limit and roughness");
  const full = sizeRound(seg, mepLimits("duct", {}, { velocity_max_ms: 5, friction_max_pa_m: 1, roughness_mm: 0.15 }), FLUIDS.air, [355, 400, 450]);
  assert.equal(full.verdict, "pass");
  assert.equal(full.values.proposed_size.value, 400);
  const none = sizeRound(seg, limits, FLUIDS.air, []);
  assert.equal(none.verdict, "TBC");
  assert.match(none.note ?? "", /standard size list/);
  const tooSmall = sizeRound(seg, limits, FLUIDS.air, [200, 250]);
  assert.equal(tooSmall.verdict, "fail");
  assert.equal(sizeRound(seg, mepLimits("duct", {}), FLUIDS.air, [400]).verdict, "TBC");
});

test("pressure: friction and fitting loss on a water pipe", () => {
  // 1 L/s in 32 mm ID: v = 1.243 m/s, dynamic 771 Pa; K 1.5 gives 1157 Pa of fitting loss.
  const limits = mepLimits("pipe", {}, { velocity_max_ms: 1.5, friction_max_pa_m: 800, roughness_mm: 0.0015 });
  const row = checkSegment({ id: "P1", kind: "pipe", flow_l_s: 1, size_mm: 32, length_m: 10, k: [0.9, 0.6] }, limits, FLUIDS.water);
  assert.equal(row.values.velocity.value, 1.24);
  assert.ok(Math.abs(Number(row.values.fitting_loss.value) - 1157) < 3, String(row.values.fitting_loss.value));
  assert.ok(Number(row.values.friction.value) > 400 && Number(row.values.friction.value) < 700, String(row.values.friction.value));
  assert.equal(row.verdict, "pass");
  assert.ok(row.loss_pa! > 1157);
  const fast = checkSegment({ id: "P2", kind: "pipe", flow_l_s: 2, size_mm: 32, length_m: 1 }, limits, FLUIDS.water);
  assert.equal(fast.verdict, "fail");
  assert.match(fast.note ?? "", /velocity/);
  const noRough = checkSegment({ id: "P3", kind: "pipe", flow_l_s: 1, size_mm: 32, length_m: 1 }, mepLimits("pipe", {}, { velocity_max_ms: 2 }), FLUIDS.water);
  assert.equal(noRough.loss_pa, null);
  assert.equal(noRough.verdict, "TBC");
});

test("critical path: the leaf with the largest summed loss; a TBC branch is listed, a broken parent reported", () => {
  const segs: MepSegment[] = [
    { id: "root", kind: "duct", flow_l_s: 1 }, { id: "a", kind: "duct", flow_l_s: 1, upstream: "root" },
    { id: "a1", kind: "duct", flow_l_s: 1, upstream: "a" }, { id: "b", kind: "duct", flow_l_s: 1, upstream: "root" },
    { id: "c", kind: "duct", flow_l_s: 1, upstream: "root" }, { id: "x", kind: "duct", flow_l_s: 1, upstream: "missing" },
  ];
  const losses = new Map<string, number | null>([["root", 50], ["a", 20], ["a1", 15], ["b", 60], ["c", null], ["x", 1]]);
  const cp = criticalPath(segs, losses);
  assert.deepEqual(cp.path, ["root", "b"]);
  assert.equal(cp.loss_pa, 110);
  assert.deepEqual(cp.tbc, ["root > c"]);
  assert.equal(cp.problems.length, 1);
});

test("voltage drop: kit formula, smallest passing cable, the modelled size checked, and TBC without a table", () => {
  assert.deepEqual(vd(18, 10, 30, 230), { v: 5.4, pct: 2.35 });
  assert.equal(cableSize("2#2.5mm², 1#2.5mm²"), 2.5);
  const cables = [
    { size_mm2: 1.5, mv_a_m: 29, rating_a: 18 }, { size_mm2: 2.5, mv_a_m: 18, rating_a: 24 }, { size_mm2: 4, mv_a_m: 11, rating_a: 32 },
  ];
  const limits = mepLimits("pipe", {}, { vd_pct: 4 });
  const ok = voltageDropRow({ id: "DB1/1", voltage_v: 230, current_a: 16, length_m: 20, wire_size: "2.5" }, cables, limits);
  assert.equal(ok.values.proposed_size.value, 2.5);
  assert.equal(ok.verdict, "pass");
  const long = voltageDropRow({ id: "DB1/2", voltage_v: 230, current_a: 16, length_m: 40, wire_size: "2.5" }, cables, limits);
  assert.equal(long.values.proposed_size.value, 4);
  assert.equal(long.verdict, "fail", "the modelled 2.5 mm² is too small");
  const none = voltageDropRow({ id: "DB1/3", voltage_v: 230, current_a: 10, length_m: 10 }, [], limits);
  assert.equal(none.verdict, "TBC");
  const spec = voltageDropRow({ id: "DB1/4", voltage_v: 230, current_a: 10, length_m: 10, cable_spec: "XLPE/SWA" }, [{ spec: "PVC", size_mm2: 2.5, mv_a_m: 18 }], limits);
  assert.equal(spec.verdict, "TBC");
  assert.match(spec.note ?? "", /matches/);
  // trace.voltage_drop_pct has a tool default (trace_bank.ts): it is used, but tagged provisional, never as standards.
  const fallback = voltageDropRow({ id: "DB1/5", voltage_v: 230, current_a: 10, length_m: 10 }, cables, mepLimits("pipe", {}));
  assert.match(String(fallback.values.limit.source), /^provisional:/);
  assert.equal(summary([ok, long, none]).result, "fail");
  assert.equal(summary([]).result, "no input");
});

test("tool: duct, critical_path and voltage_drop from the model, all read-only drafts", async () => {
  const duct = parse(await runFmcMepSize(args({ action: "duct", segments: [{ id: "D1", kind: "duct", flow_l_s: 500 }], standard_sizes_mm: [355, 400], limits: { velocity_max_ms: 5 } }), { bank: {}, env }));
  assert.equal(duct.read_only, true);
  assert.match(duct.draft, /DRAFT/);
  assert.equal(duct.rows[0].values.proposed_size.value, 400);
  const cp = parse(await runFmcMepSize(args({ action: "critical_path", limits: { velocity_max_ms: 8, friction_max_pa_m: 2, roughness_mm: 0.15 }, segments: [
    { id: "r", kind: "duct", flow_l_s: 600, size_mm: 450, length_m: 10 },
    { id: "a", kind: "duct", flow_l_s: 300, size_mm: 315, length_m: 12, k: [0.3], upstream: "r" },
    { id: "b", kind: "duct", flow_l_s: 300, size_mm: 355, length_m: 5, upstream: "r" },
  ] }), { bank: {}, env }));
  assert.deepEqual(cp.critical_path.path, ["r", "a"]);
  let sent: unknown;
  const vdr = parse(await runFmcMepSize(args({ action: "voltage_drop", from_model: true, limits: { vd_pct: 5 }, cables: [{ size_mm2: 2.5, mv_a_m: 18 }] }), {
    bank: {}, env, read: async (body) => { sent = body; return { mep: { circuits: [{ id: 77, board: "DB1", number: "3", voltage_v: 230, current_a: 10, length_m: 15, wire_size: "2#2.5mm²", classes: ["Lighting"] }] } }; },
  }));
  assert.deepEqual(sent, {});
  assert.equal(vdr.rows[0].id, "DB1/3");
  assert.equal(vdr.rows[0].values.current.source, "model:77");
  assert.equal(vdr.summary.pass, 1);
  const empty = parse(await runFmcMepSize(args({ action: "pressure" }), { bank: {}, env }));
  assert.equal(empty.summary.result, "no input");
  assert.equal(circuitsFromFacts({ circuits: [{ board: "", number: "1" }] })[0].id, "(no board)/1");
});

test("source scan: fmc_mep_size never uses sendRaw and sends only the read fmc_mep_facts", () => {
  const src = fs.readFileSync(path.join(here, "..", "..", "src", "tools", "fmc_mep_size.ts"), "utf8");
  assert.ok(!/sendRaw/.test(src), "no sendRaw");
  const sent = [...src.matchAll(/sendCommand\("([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sent, ["fmc_mep_facts"]);
  assert.ok(!/Transaction|_apply/.test(src), "read-only: no apply command");
});
