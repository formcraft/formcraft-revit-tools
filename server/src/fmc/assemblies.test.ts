import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSpec, AssembliesSpec } from "./assemblies_spec.js";
import { patText, patName } from "./assemblies_pat.js";
import { ModelRead, applyPayload, legendPlan, planOps } from "./assemblies_plan.js";
import { EMPTY_MODEL, SAMPLE } from "./assemblies_testkit.js";

/** F59 engine: the designs checked, the .pat text, the plan against a model read, the legend calls. */

const spec = () => checkSpec(SAMPLE).spec as AssembliesSpec;

test("the sample designs pass; nothing is defaulted, so missing values are problems", () => {
  assert.deepEqual(checkSpec(SAMPLE).problems, []);
  const bad = checkSpec({
    patterns: [{ name: "Hatch", target: "paper", grids: [] }, { name: "FMC_A", target: "model", grids: [{ angle: 0, spacing: 0 }] }, { name: "fmc_a", target: "model", grids: [{ angle: 0, spacing: 1 }] }],
    curtain_walls: [{ name: "FMC_CW", vertical: { layout: "fixed_distance" }, horizontal: { layout: "none", spacing: 10 } }],
    railings: [{ name: "FMC_RL", base: "x" }],
  });
  assert.equal(bad.spec, null);
  for (const re of [/Hatch: the name starts FMC_/, /target is drafting or model/, /1 to 6 grids/, /spacing in mm, more than 0/, /fmc_a is in the designs twice/,
    /FMC_CW: base/, /vertical.spacing \(mm\) is needed for fixed_distance/, /horizontal.spacing means nothing with none/, /FMC_RL: height \(mm\) is needed/])
    assert.ok(bad.problems.some((p) => re.test(p)), `${re}`);
  assert.match(checkSpec({}).problems[0], /no patterns, curtain walls or railings/);
});

test(".pat text: one file per target, mm, sorted, CRLF, the same bytes every time", () => {
  const s = spec();
  const d = patText(s.patterns, "drafting");
  assert.equal(d, patText(s.patterns, "drafting"));
  assert.ok(d.startsWith(";%UNITS=MM\r\n"));
  const body = d.split("\r\n");
  assert.ok(body.indexOf("*FMC_FP_Cross_2") < body.indexOf("*FMC_FP_Hatch45_3, Diagonal 3 mm"), "sorted by name");
  assert.ok(body.includes(";%TYPE=DRAFTING"));
  assert.ok(body.includes("45,0,0,0,3"));
  assert.ok(!d.includes("FMC_MP_Tile_600"), "model patterns go in the model file");
  const m = patText(s.patterns, "model");
  assert.ok(m.includes(";%TYPE=MODEL") && m.includes("90,0,0,150,300"));
  assert.equal(patName("drafting"), "FMC_Patterns_Drafting.pat");
});

test("plan against a model without them: every design is a create, with the add-in's payload in mm", () => {
  const p = planOps(spec(), EMPTY_MODEL);
  assert.deepEqual(p.counts, { create: 5, update: 0, unchanged: 0, blocked: 0 });
  const cw = p.ops.find((o) => o.kind === "curtain_wall")!;
  assert.deepEqual(cw.payload, { name: "FMC_CW_Glazed_1500", base: "Storefront", update: false, vertical: { layout: "fixed_distance", layout_code: 1, spacing: 1500 },
    horizontal: { layout: "maximum_spacing", layout_code: 3, spacing: 3000 }, mullion_interior: "50 x 150mm", mullion_border: "50 x 150mm", panel: "Glazed" });
  const pay = applyPayload(p.ops, true);
  assert.equal(pay.dry_run, true);
  assert.deepEqual([pay.patterns.length, pay.curtain_walls.length, pay.railings.length], [3, 1, 1]);
});

test("plan against a model that has them: unchanged when equal (angles a and a+180 are the same lines), update with the changes listed", () => {
  const s = spec();
  const model: ModelRead = { ...EMPTY_MODEL,
    patterns: [
      { name: "FMC_FP_Hatch45_3", target: "drafting", id: 1, grids: [{ angle: 225, spacing: 3, shift: 0, origin: [0, 0] }] },
      { name: "FMC_FP_Cross_2", target: "drafting", id: 2, grids: [{ angle: 0, spacing: 2.5 }, { angle: 90, spacing: 2 }] },
      { name: "FMC_MP_Tile_600", target: "drafting", id: 3, grids: [{ angle: 0, spacing: 600 }] },
    ],
    curtain_types: [...EMPTY_MODEL.curtain_types, { name: "FMC_CW_Glazed_1500", id: 102, vertical: { layout: "fixed_distance", spacing: 1500 },
      horizontal: { layout: "maximum_spacing", spacing: 3000 }, mullion: { interior: "50 x 150mm", border: "50 x 150mm" }, panel: "Solid" }],
    railing_types: [...EMPTY_MODEL.railing_types, { name: "FMC_RL_Steel_1100", id: 202, height: 1100, top_rail: "Rectangular - 50x50mm" }],
  };
  const p = planOps(s, model);
  const by = Object.fromEntries(p.ops.map((o) => [o.name, o]));
  assert.equal(by.FMC_FP_Hatch45_3.action, "unchanged");
  assert.equal(by.FMC_FP_Cross_2.action, "update");
  assert.deepEqual(by.FMC_FP_Cross_2.changes, ["grid 1 spacing 2.5 → 2"]);
  assert.equal(by.FMC_FP_Cross_2.payload!.id, 2);
  assert.equal(by.FMC_MP_Tile_600.action, "create", "a drafting pattern of the same name isn't the model pattern");
  assert.deepEqual(by.FMC_CW_Glazed_1500.changes, ["panel Solid → Glazed"]);
  assert.equal(by.FMC_RL_Steel_1100.action, "unchanged");
  assert.equal(applyPayload(p.ops, false).railings.length, 0, "unchanged items aren't sent");
});

test("a base, mullion, panel or top rail type the model lacks blocks the item and is a kit request; nothing is substituted", () => {
  const model: ModelRead = { ...EMPTY_MODEL, curtain_types: [], mullion_types: [], panel_types: ["Solid"], top_rail_types: [] };
  const p = planOps(spec(), model);
  const cw = p.ops.find((o) => o.kind === "curtain_wall")!;
  assert.equal(cw.action, "blocked");
  assert.deepEqual(cw.why, ["the model has no curtain wall type Storefront to start from", "the model has no mullion type 50 x 150mm", "the model has no mullion type 50 x 150mm", "the model has no curtain panel type Glazed"]);
  assert.equal(cw.payload, undefined);
  assert.equal(p.ops.find((o) => o.kind === "railing")!.action, "blocked");
  assert.deepEqual(p.kit_requests.map((k) => k.item), ["mullion type 50 x 150mm", "curtain panel type Glazed", "top rail type Rectangular - 50x50mm"]);
  assert.equal(applyPayload(p.ops, true).curtain_walls.length, 0);
});

test("legend: create_view first when the view is missing, then place the curtain wall types as walls; railings and patterns listed", () => {
  const s = spec();
  const l = legendPlan(s, { ...EMPTY_MODEL, curtain_types: [{ name: "FMC_CW_Glazed_1500", id: 102 }] });
  assert.ok(!("problem" in l));
  if ("problem" in l) return;
  assert.equal(l.view_exists, false);
  assert.deepEqual(l.first, { tool: "fmc_legend", args: { action: "create_view", name: "FMC_Legend_Assemblies", dry_run: true } });
  assert.deepEqual(l.place.args.types, [{ id: 102, category: "wall" }]);
  assert.equal(l.place.args.columns, 2);
  assert.equal(l.place.args.dry_run, true);
  assert.equal(l.not_placed.length, 4);
  const there = legendPlan(s, { ...EMPTY_MODEL, legend_views: ["fmc_legend_assemblies"] });
  assert.ok(!("problem" in there) && there.view_exists && !("first" in there) && there.not_in_model_yet[0] === "FMC_CW_Glazed_1500");
  assert.ok("problem" in legendPlan({ ...s, legend: undefined }, EMPTY_MODEL));
});
