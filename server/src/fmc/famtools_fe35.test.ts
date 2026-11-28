// FE-03 to FE-05 (builder16): the additions to fmc_fam_2d, fmc_fam_light and fmc_fam_annotation, offline.
// The shared setup is the same as famtools.test.ts; it is repeated here so the two files merge without conflicts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { SpParam } from "./specs.js";
import { FamIo, SPOT_DEFAULT, annotationOps, checkOps, lightOps, repeatPlan, twoDOps } from "./famtools.js";
import { runFmcFamAnnotation } from "../tools/fmc_fam_annotation.js";
import { runFmcFam2d } from "../tools/fmc_fam_2d.js";
import { FMC_FAM_LIGHT_SHAPE, runFmcFamLight } from "../tools/fmc_fam_light.js";
import { z } from "zod";

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

// ---------- FE-04 fmc_fam_light ----------

const LIGHT = { ...COMMON, name: "Light source", shape: "point" as const, distribution: "hemispherical" as const, kelvin: 3000, ensure_category: true };

test("FE-04: a spot without angles gets the op's 60/90 defaults in the plan; a hemispherical light gets none", () => {
  const spot = lightOps({ distribution: "spot", lumens: 900 })[1];
  assert.deepEqual([spot.beam_deg, spot.field_deg], [SPOT_DEFAULT.beam_deg, SPOT_DEFAULT.field_deg]);
  assert.equal(lightOps({ distribution: "spot", lumens: 900, beam_deg: 30 })[1].field_deg, 90);
  const hemi = lightOps({ distribution: "hemispherical", lumens: 900 })[1];
  assert.equal(hemi.beam_deg, undefined);
});

test("FE-04: a spot beam wider than the default field is refused before Revit is asked", async () => {
  const { io, calls } = fakeIo();
  const r = body(await runFmcFamLight({ ...LIGHT, session: "S1", distribution: "spot", lumens: 900, beam_deg: 120 }, io));
  assert.equal(r.isError, true);
  assert.ok(r.reasons.some((x: string) => /field_deg must be at least beam_deg/.test(x)), r.reasons.join("\n"));
  assert.equal(calls.length, 0);
});

test("FE-04: kelvin outside Revit's 1800 to 20000 K is refused by the tool schema and by the op check", () => {
  const shape = z.object(FMC_FAM_LIGHT_SHAPE);
  assert.equal(shape.safeParse({ lumens: 800, kelvin: 1500 }).success, false);
  assert.equal(shape.safeParse({ lumens: 800, kelvin: 2700 }).success, true);
  assert.ok(checkOps([{ op: "light_source", name: "L", lumens: 800, kelvin: 1500 }], { config: cfg, dictionary }).errors.length > 0);
});

test("FE-04: no lumens at all is refused; lumens_by_type alone is enough", async () => {
  const { io } = fakeIo();
  const none = body(await runFmcFamLight({ ...LIGHT }, io));
  assert.equal(none.isError, true);
  assert.ok(none.reasons.some((x: string) => /lumens/.test(x)));
  const byType = body(await runFmcFamLight({ ...LIGHT, lumens_by_type: { "600": 1200 } }, io));
  assert.equal(byType.isError, false);
  assert.deepEqual(byType.planned_ops.map((o: { op: string }) => o.op), ["set_category", "light_source"]);
});

test("FE-04: a light source in a batch that sets another category is refused", () => {
  const r = checkOps([...lightOps({ lumens: 800, ensure_category: false }).map((o) => o), { op: "set_category", name: "Furniture" }].reverse(), { config: cfg, dictionary });
  assert.ok(r.errors.some((e) => /Lighting Fixtures/.test(e)), r.errors.join("\n"));
});

// ---------- FE-05 fmc_fam_annotation ----------

test("FE-05: a keynote tag is Keynote Tags with Key Value by default, and labels Revit's keynote parameters only", () => {
  const k = annotationOps({ kind: "keynote_tag" }, dictionary);
  assert.deepEqual(k.problems, []);
  assert.deepEqual(k.ops, [{ op: "set_category", name: "Keynote Tags" }]);
  assert.deepEqual(k.label_plan.map((l) => [l.param, l.added]), [["Key Value", false]]);
  assert.ok(!k.notes.some((n) => /Not in the kit's shared parameter dictionary/.test(n)));
  const both = annotationOps({ kind: "keynote_tag", label_params: ["Key Value", "Keynote Text"] }, dictionary);
  assert.equal(both.label_plan.length, 2);
  assert.ok(annotationOps({ kind: "keynote_tag", label_params: ["FMC_Mark"] }, dictionary).problems.length > 0);
  assert.ok(annotationOps({ kind: "keynote_tag", tag_category: "Door Tags" }, dictionary).problems.length > 0);
});

test("FE-05: repeating detail spacing becomes a repeat_plan for the project type; bad layouts are refused", () => {
  const ok = repeatPlan({ layout: "fixed_distance", spacing_mm: 600 }, "FMC_D_Blocking");
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.plan!.spacing_mm, 600);
  assert.equal(ok.plan!.parameters["Spacing (REPEATING_DETAIL_SPACING), mm"], 600);
  assert.equal(ok.plan!.inside, true);
  assert.match(ok.plan!.step, /never open or change a project/);
  assert.ok(repeatPlan({ layout: "fixed_distance" }, "F").problems.length > 0);
  assert.ok(repeatPlan({ layout: "fixed_number", number: 1 }, "F").problems.length > 0);
  assert.ok(repeatPlan({ layout: "fill_available", spacing_mm: 10 }, "F").problems.length > 0);
  assert.deepEqual(repeatPlan({ layout: "fixed_number", number: 5 }, "F").problems, []);
  assert.ok(annotationOps({ kind: "annotation", repeating_detail: { layout: "fill_available" } }, dictionary).problems.length > 0);
});

test("FE-05: fmc_fam_annotation returns repeat_plan with the plan and sends no project op", async () => {
  const { io, calls } = fakeIo();
  const args = { ...COMMON, kind: "detail_component" as const, family_name: "FMC_D_Blocking",
    repeating_detail: { layout: "maximum_spacing" as const, spacing_mm: 400 },
    draw: [{ op: "detail_lines", name: "Block", view: "plan", points: SQ, closed: true }] };
  const dry = body(await runFmcFamAnnotation(args, io));
  assert.equal(dry.isError, false);
  assert.equal(dry.repeat_plan.layout, "maximum_spacing");
  assert.deepEqual(dry.planned_ops.map((o: { op: string }) => o.op), ["set_category", "detail_lines"]);
  assert.equal(dry.planned_ops[0].name, "Detail Items");
  const run = body(await runFmcFamAnnotation({ ...args, session: "S2" }, io));
  assert.equal(run.repeat_plan.spacing_mm, 400);
  assert.deepEqual(calls.map((c) => c.action), ["apply"]);
});

test("FE-05: a keynote tag runs through fmc_fam_annotation with its label plan", async () => {
  const { io } = fakeIo();
  const r = body(await runFmcFamAnnotation({ ...COMMON, kind: "keynote_tag", label_params: ["Keynote Text"],
    draw: [{ op: "text_note", name: "Hint", text: "KN", at: [0, 0] }] }, io));
  assert.equal(r.isError, false);
  assert.deepEqual(r.planned_ops.map((o: { op: string }) => o.op), ["set_category", "text_note"]);
  assert.equal(r.label_plan[0].param, "Keynote Text");
  assert.equal(r.planned_ops[1].view, "annotation");
});
