import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FMC_FAM_HOSTING_SHAPE, runFmcFamHosting } from "../tools/fmc_fam_hosting.js";
import { planHosting } from "./famhost_plan.js";
import { RUN_ID, Kit, callTool, done, fakeRevit, kit } from "./famedit_testkit.js";

const BASE = { family: "FMC_Shelf", category: "Furniture", path: "C:\\stage\\FMC_Shelf.rfa", instance_parameters: ["Mark"], solids: 2, voids: 1 };
const READS: Record<string, any> = {
  unhosted: { ...BASE, placement: "OneLevelBased", hosting: "none", work_plane_based: false, work_plane_based_settable: true, always_vertical: false },
  wall: { ...BASE, placement: "OneLevelBasedHosted", hosting: "wall", work_plane_based: false, work_plane_based_settable: false },
  face: { ...BASE, placement: "WorkPlaneBased", hosting: "face", work_plane_based: true, work_plane_based_settable: false },
  wpb: { ...BASE, placement: "WorkPlaneBased", hosting: "none", work_plane_based: true, work_plane_based_settable: true, always_vertical: false },
  mass: { ...BASE, category: "Mass", placement: "OneLevelBased", hosting: "none", is_conceptual_mass: true, is_adaptive: false,
    reference_points: [{ id: 5, adaptive: false }, { id: 6, adaptive: false }] },
  adaptive: { ...BASE, category: "Generic Models", placement: "Adaptive", hosting: "none", is_adaptive: true, adaptive_points: 2,
    reference_points: [{ id: 5, adaptive: true }, { id: 6, adaptive: true }, { id: 7, adaptive: false }] },
};

async function call(k: Kit, read: string, args: Record<string, unknown>, templates: string[] = []) {
  const rv = fakeRevit({ fmc_fam_hosting_read: READS[read] });
  const have = new Set(templates.map((t) => path.win32.join(k.config.config.family_template_dir, t)));
  const r = await callTool(FMC_FAM_HOSTING_SHAPE, runFmcFamHosting, { document: "FMC_Shelf.rfa", ...args }, { config: k.config, revit: rv.send, exists: (f) => have.has(f) });
  return { ...r, rv };
}

test("read: one read-path call, with a run id", async () => {
  const k = kit();
  try {
    const r = await call(k, "wall", { action: "read" });
    assert.match(r.body.run_id, RUN_ID);
    assert.equal(r.body.hosting.hosting, "wall");
    assert.deepEqual(r.rv.calls.map((c) => [c.command, c.dry]), [["fmc_fam_hosting_read", true]]);
  } finally { done(k); }
});

test("convert to face_based: not in place; the dry run gives the rebuild path and the template check, and sends no change", async () => {
  const k = kit();
  try {
    const r = await call(k, "wall", { action: "convert", to: "face_based" }, ["Metric Generic Model face based.rft"]);
    assert.equal(r.isError, false);
    assert.equal(r.body.in_place, false);
    assert.match(r.body.plan.why, /can't change in place|can't be changed in place|API can't change it in place/);
    assert.equal(r.body.plan.rebuild.template_found, true);
    assert.equal(r.body.plan.rebuild.new_name, "FMC_Shelf_FaceBased.rfa");
    assert.equal(r.body.plan.rebuild.steps[0].args.template.endsWith("Metric Generic Model face based.rft"), true);
    assert.ok(r.body.plan.rebuild.steps.some((s: any) => s.tool === "fmc_fam_nested"), "the instance parameter is carried by an associate step");
    assert.ok(r.body.plan.rebuild.limits.some((l: string) => /voids/.test(l)));
    assert.equal(r.rv.applies().length, 0);
  } finally { done(k); }
});

test("convert to face_based for real is refused, never faked; a missing template and an unsaved source are blocked in the plan", async () => {
  const k = kit();
  try {
    const real = await call(k, "wall", { action: "convert", to: "face_based", dry_run: false, confirm: true });
    assert.equal(real.isError, true);
    assert.match(real.body.reasons[0], /rebuild|in place/);
    assert.equal(real.rv.applies().length, 0);
    assert.match(real.body.plan.rebuild.blocked.join(" "), /template .* isn't on this PC/);
    const unsaved = await call(k, "unhosted", { action: "rebuild_plan", to: "face_based" });
    assert.equal(unsaved.isError, false);
    assert.equal(unsaved.rv.applies().length, 0);
    const k2 = READS.unhosted.path; READS.unhosted.path = "";
    try {
      const r = await call(k, "unhosted", { action: "rebuild_plan", to: "face_based" });
      assert.match(r.body.rebuild.blocked.join(" "), /no file: save it to staging/);
    } finally { READS.unhosted.path = k2; }
  } finally { done(k); }
});

test("already face-based or already work plane-based: nothing to do", async () => {
  const k = kit();
  try {
    assert.equal((await call(k, "face", { action: "convert", to: "face_based" })).body.nothing_to_do, true);
    const w = await call(k, "wpb", { action: "convert", to: "work_plane_based" });
    assert.equal(w.body.nothing_to_do, true);
    assert.equal(w.rv.applies().length, 0);
  } finally { done(k); }
});

test("work_plane_based on an unhosted family: in place, one transaction; dry run read path, real run write path with confirm", async () => {
  const k = kit();
  try {
    const dry = await call(k, "unhosted", { action: "convert", to: "work_plane_based", always_vertical: true });
    assert.equal(dry.body.in_place, true);
    const sent = dry.rv.applies()[0];
    assert.deepEqual([sent.command, sent.dry, sent.payload.action, sent.payload.always_vertical, sent.payload.dry_run], ["fmc_fam_hosting_apply", true, "work_plane_based", true, true]);
    assert.equal(sent.payload.run_id, dry.body.run_id);
    const no = await call(k, "unhosted", { action: "convert", to: "work_plane_based", dry_run: false });
    assert.match(no.body.reasons[0], /confirm=true/);
    assert.equal(no.rv.applies().length, 0);
    const yes = await call(k, "unhosted", { action: "convert", to: "work_plane_based", dry_run: false, confirm: true });
    assert.equal(yes.isError, false);
    assert.equal(yes.rv.applies()[0].dry, false);
    assert.match(fs.readFileSync(k.log, "utf8"), /fam_hosting_convert,false,FMC_Shelf.rfa,done/);
  } finally { done(k); }
});

test("work_plane_based on a wall-hosted family is a rebuild; only Always Vertical differing makes it a change", async () => {
  const k = kit();
  try {
    const wall = await call(k, "wall", { action: "convert", to: "work_plane_based" });
    assert.equal(wall.body.in_place, false);
    assert.match(wall.body.plan.why, /wall-hosted/);
    const av = await call(k, "wpb", { action: "convert", to: "work_plane_based", always_vertical: true });
    assert.equal(av.body.in_place, true);
  } finally { done(k); }
});

test("adaptive: points made adaptive in a conceptual mass; unknown point refused; an ordinary family gets the rebuild path", async () => {
  const k = kit();
  try {
    const mass = await call(k, "mass", { action: "convert", to: "adaptive" });
    assert.deepEqual(mass.rv.applies()[0].payload, { action: "make_adaptive", points: [5, 6], dry_run: true, document: "FMC_Shelf.rfa", run_id: mass.body.run_id });
    const some = await call(k, "mass", { action: "convert", to: "adaptive", points: [6] });
    assert.deepEqual(some.rv.applies()[0].payload.points, [6]);
    const bad = await call(k, "mass", { action: "convert", to: "adaptive", points: [99] });
    assert.equal(bad.rv.applies().length, 0);
    assert.match(bad.body.plan.why, /No reference point 99/);
    const rebuild = await call(k, "unhosted", { action: "convert", to: "adaptive" }, ["Metric Generic Model Adaptive.rft"]);
    assert.equal(rebuild.body.in_place, false);
    assert.ok(rebuild.body.plan.rebuild.limits[0].includes("adaptive points"));
    assert.equal(rebuild.body.plan.rebuild.template_found, true);
  } finally { done(k); }
});

test("adaptive family: already adaptive is nothing to do; points can still add a free reference point", async () => {
  const k = kit();
  try {
    assert.equal((await call(k, "adaptive", { action: "convert", to: "adaptive" })).body.nothing_to_do, true);
    const more = await call(k, "adaptive", { action: "convert", to: "adaptive", points: [7] });
    assert.deepEqual(more.rv.applies()[0].payload.points, [7]);
  } finally { done(k); }
});

test("convert and rebuild_plan need to; a project file is refused", async () => {
  const k = kit();
  try {
    assert.match((await call(k, "wall", { action: "convert" })).body.reasons.join(" "), /needs to:/);
    assert.match((await call(k, "wall", { action: "rebuild_plan" })).body.reasons.join(" "), /needs to:/);
    assert.match((await call(k, "wall", { action: "convert", to: "adaptive", document: "X.rvt" })).body.reasons.join(" "), /project file/);
  } finally { done(k); }
});

test("planHosting has no filesystem side effects and a hosted family never offers an in-place face conversion", () => {
  for (const key of ["unhosted", "wall", "wpb"]) {
    const p = planHosting("face_based", READS[key], { templateDir: "", exists: () => false });
    assert.equal(p.in_place, false);
    assert.equal(p.apply, undefined);
    assert.equal(p.rebuild?.template_found, null);
  }
});
