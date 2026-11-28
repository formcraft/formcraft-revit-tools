// FE-03 to FE-05 (builder16): the additions to fmc_fam_2d, fmc_fam_light and fmc_fam_annotation, offline.
// The shared setup is the same as famtools.test.ts; it is repeated here so the two files merge without conflicts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { SpParam } from "./specs.js";
import { FamIo, checkOps, twoDOps } from "./famtools.js";
import { runFmcFam2d } from "../tools/fmc_fam_2d.js";

const STAGING = "D:\\Kit\\04_Families\\_Staging";
const cfg: GuardConfig = { ...DEFAULT_CONFIG, library_roots: [STAGING], write_roots: [STAGING], family_staging_root: STAGING };
const dictionary = new Map<string, SpParam>([
  ["FMC_Mark", { name: "FMC_Mark", guid: "11111111-1111-1111-1111-111111111111", datatype: "TEXT", group: "Identity" }],
]);
const SQ = [[0, 0], [100, 0], [100, 100], [0, 100]];
const COMMON = { session: "", template: "", dry_run: true, save_path: "", overwrite: false };

function fakeIo(): { io: FamIo; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const io: FamIo = {
    config: cfg, dictionary,
    doc: async (a) => {
      calls.push(a);
      if (a.action === "open") return { body: { session: "S1" }, isError: false };
      if (a.action === "apply") return { body: { ops: [], dry_run: a.dry_run }, isError: false };
      return { body: {}, isError: false };
    },
    exists: () => false, readdir: () => [], rename: () => undefined, mkdir: () => undefined,
  };
  return { io, calls };
}
const body = (r: { content: Array<{ text: string }>; isError: boolean }) => ({ ...JSON.parse(r.content[0].text), isError: r.isError });

// ---------- FE-03 fmc_fam_2d ----------

test("FE-03: model_lines and model_text pass the fmc_doc checks with defaults filled in", () => {
  const r = checkOps([
    { op: "add_subcategory", name: "Plan Outline", line_weight_projection: 3 },
    { op: "model_lines", name: "Outline", points: SQ, closed: true, subcategory: "Plan Outline", fine: false, plan_rcp: true },
    { op: "model_text", name: "Badge", text: "FMC", point: [10, 20], coarse: false },
  ], { config: cfg, dictionary });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ops[1].op, "model_lines");
  assert.equal((r.ops[1] as { plane: string }).plane, "plan");
  assert.equal((r.ops[1] as { fine?: boolean }).fine, false);
  const t = r.ops[2] as { plane: string; depth_mm: number; align: string; coarse?: boolean };
  assert.deepEqual([t.plane, t.depth_mm, t.align, t.coarse], ["front", 10, "left", false]);
});

test("FE-03: model ops refuse all detail levels off, control characters and a one-point line", () => {
  const off = checkOps([{ op: "model_lines", name: "L", points: [[0, 0], [10, 0]], coarse: false, medium: false, fine: false }], { config: cfg, dictionary });
  assert.ok(off.errors.some((e) => /can't all be off/.test(e)), off.errors.join("\n"));
  const ctl = checkOps([{ op: "model_text", name: "T", text: "A\u0007B" }], { config: cfg, dictionary });
  assert.ok(ctl.errors.some((e) => /control characters/.test(e)), ctl.errors.join("\n"));
  const one = checkOps([{ op: "model_lines", name: "L", points: [[0, 0]] }], { config: cfg, dictionary });
  assert.ok(one.errors.length > 0);
  const big = checkOps([{ op: "model_text", name: "T", text: "x".repeat(201) }], { config: cfg, dictionary });
  assert.ok(big.errors.length > 0);
});

test("FE-03: a subcategory a model op names must be made earlier or exist in the file", () => {
  const r = checkOps([{ op: "model_lines", name: "L", points: [[0, 0], [10, 0]], subcategory: "Nope" }], { config: cfg, dictionary });
  assert.ok([...r.errors, ...r.notes].some((e) => /subcategory "Nope"/.test(e)));
});

test("FE-03: visibility flags on view-only ops are refused, not dropped", () => {
  assert.match(twoDOps([{ op: "filled_region", name: "F", points: SQ, coarse: false }]).problems[0], /own view/);
  assert.match(twoDOps([{ op: "detail_lines", name: "D", points: SQ, plan_rcp: false }]).problems[0], /plan_rcp/);
  assert.match(twoDOps([{ op: "symbolic_lines", name: "S", subcategory: "X", points: SQ, front_back: false }]).problems[0], /coarse, medium and fine/);
  assert.deepEqual(twoDOps([{ op: "symbolic_lines", name: "S", subcategory: "X", points: SQ, fine: false }]).problems, []);
  assert.deepEqual(twoDOps([{ op: "model_lines", name: "M", points: SQ, left_right: false }]).problems, []);
});

test("FE-03: fmc_fam_2d plans subcategory, model lines, a region and model text in order and runs them as one fmc_doc batch", async () => {
  const items = [
    { op: "add_subcategory", name: "Plan Outline", line_weight_projection: 3 },
    { op: "model_lines", name: "Outline", plane: "plan", points: SQ, closed: true, subcategory: "Plan Outline" },
    { op: "masking_region", name: "Mask", points: SQ },
    { op: "model_text", name: "Badge", text: "FMC", plane: "front", point: [0, 50] },
  ];
  const { io, calls } = fakeIo();
  const dry = body(await runFmcFam2d({ ...COMMON, items }, io));
  assert.equal(dry.isError, false);
  assert.deepEqual(dry.planned_ops.map((o: { op: string }) => o.op), ["add_subcategory", "model_lines", "masking_region", "model_text"]);
  assert.equal(calls.length, 0, "no session: nothing is sent to Revit");
  const run = body(await runFmcFam2d({ ...COMMON, session: "S9", items }, io));
  assert.equal(run.isError, false);
  assert.deepEqual(calls.map((c) => [c.action, c.session, c.dry_run]), [["apply", "S9", true]]);
  assert.equal((calls[0].ops as unknown[]).length, 4);
});

test("FE-03: a pale or pen-1 outline subcategory is reported under FAM-044", () => {
  const r = checkOps([{ op: "add_subcategory", name: "Plan Outline", color: [230, 230, 230], line_weight_projection: 1 }], { config: cfg, dictionary });
  assert.ok([...r.errors, ...r.notes].some((e) => /FAM-044/.test(e)));
});
