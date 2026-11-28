// B15: fmc_fam_dim, fmc_fam_visibility, fmc_fam_material, fmc_fam_category and their fmc_doc ops (offline; no Revit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { SpParam } from "./specs.js";
import { MaterialDb } from "./materials.js";
import { OP, opsProblems, splitProblems } from "./ops.js";
import { B15_OP_NAMES } from "./ops_b15.js";
import { FamB15Io, categoryOps, checkB15Ops, dimOps, famB15Run, materialOps, replacePlanB15, textureProblems, visibilityOps } from "./famb15.js";
import { FMC_FAM_DIM_SHAPE, runFmcFamDim } from "../tools/fmc_fam_dim.js";
import { FMC_FAM_VISIBILITY_SHAPE, runFmcFamVisibility } from "../tools/fmc_fam_visibility.js";
import { FMC_FAM_MATERIAL_SHAPE, runFmcFamMaterial } from "../tools/fmc_fam_material.js";
import { FMC_FAM_CATEGORY_SHAPE, runFmcFamCategory } from "../tools/fmc_fam_category.js";

const STAGING = "D:\\Kit\\04_Families\\_Staging";
const TPL = "C:\\ProgramData\\Autodesk\\RVT 2025\\Family Templates";
const MATS = "D:\\Kit\\07_Materials\\FMC_Materials.json";
const cfg: GuardConfig = {
  ...DEFAULT_CONFIG,
  template_roots: [TPL],
  family_template_dir: TPL + "\\English",
  library_roots: [STAGING],
  write_roots: [STAGING],
  family_staging_root: STAGING,
  materials_file: MATS,
};
const dictionary = new Map<string, SpParam>();
const db: MaterialDb = {
  version: "1", classes: [], problems: [],
  materials: [
    { name: "FMC_Wood_Oak", maps: [{ map: "albedo", file: "Textures\\oak.jpg", size_mm: 600 }] } as any,
    { name: "FMC_Steel_Brushed", maps: [{ map: "albedo", file: "Textures\\missing.jpg", size_mm: 600 }] } as any,
    { name: "FMC_Bad_Texture", maps: [{ map: "albedo", file: "C:\\Users\\someone\\Desktop\\x.jpg", size_mm: 600 }] } as any,
  ],
};
const TARGET = STAGING + "\\FMC_F_Chair.rfa";

function fakeIo(files: string[] = [], over: Partial<FamB15Io> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const set = new Set(files.map((f) => f.toLowerCase()));
  const io: FamB15Io = {
    config: cfg, dictionary, materials: db,
    doc: async (a) => {
      calls.push(a); events.push(`doc:${a.action}`);
      if (a.action === "open") return { body: { session: "S1" }, isError: false };
      if (a.action === "apply") return { body: { ops: [], created: 1, dry_run: a.dry_run }, isError: false };
      if (a.action === "save") { set.add(String(a.path).toLowerCase()); return { body: { saved: a.path }, isError: false }; }
      return { body: {}, isError: false };
    },
    exists: (p) => set.has(p.toLowerCase()),
    readdir: (d) => [...set].filter((f) => f.startsWith(d.toLowerCase() + "\\")).map((f) => files.find((x) => x.toLowerCase() === f)?.split("\\").pop() ?? f.split("\\").pop()!),
    rename: (a, b) => { events.push(`move:${a.split("\\").pop()}`); set.delete(a.toLowerCase()); set.add(b.toLowerCase()); },
    mkdir: (d) => { events.push(`mkdir:${d}`); },
    now: () => new Date(2026, 10, 28, 14, 30, 0),
    ...over,
  };
  return { io, calls, events };
}
const body = (r: { content: Array<{ text: string }>; isError: boolean }) => ({ ...JSON.parse(r.content[0].text), isError: r.isError });
const args = (over: Record<string, unknown>) => ({ session: "", template: "", dry_run: true, save_path: "", overwrite: false, ...over }) as any;

// the batch these ops refer back to: planes, a param of each type, a solid, a line set, a subcategory, a kit material
const base = [
  { op: "add_ref_plane", name: "Left", from: [-300, -500], to: [-300, 500] },
  { op: "add_ref_plane", name: "Hinge", from: [0, 0], to: [400, 400] },
  { op: "add_family_param", name: "Swing", type: "Angle" },
  { op: "add_family_param", name: "Radius", type: "Length" },
  { op: "add_family_param", name: "Show Detail", type: "YesNo" },
  { op: "extrusion", name: "Seat", points: [[0, 0], [400, 0], [400, 400], [0, 400]], start: 0, end: 450 },
  { op: "add_subcategory", name: "Frame", line_weight_projection: 2 },
  { op: "add_material", name: "FMC_Wood_Oak" },
];

// ---------- the new fmc_doc ops ----------

test("every B15 op is in fmc_doc's vocabulary and parses", () => {
  const ops = [
    { op: "dim_add_angular", name: "Swing angle", refs: ["Left", "Hinge"], label: "Swing" },
    { op: "dim_add_radial", name: "Seat radius", ref: "Seat", label: "Radius" },
    { op: "dim_add_radial", name: "Seat dia", ref: "Seat", diameter: true },
    { op: "dim_unlock", name: "Unlock W", refs: ["Left", "Hinge"] },
    { op: "vis_set", name: "Seat", detail_levels: ["coarse"], only_when_cut: false, param: "Show Detail" },
    { op: "vis_matrix", name: "Check" },
    { op: "material_set", name: "Seat", material: "FMC_Wood_Oak" },
    { op: "material_paint", name: "Seat/top", solid: "Seat", face: "top", material: "FMC_Wood_Oak" },
    { op: "material_purge", name: "Unused" },
    { op: "category_set", name: "Category", category: "Furniture", subcategory: "Frame", targets: ["Seat"] },
    { op: "category_flags", name: "family", cut_with_voids: true, ifc_export_as: "IfcFurniture" },
    { op: "category_sub_rename", name: "Frame", to: "Chair Frame" },
    { op: "category_sub_delete", name: "Old", reassign_to: "Frame" },
  ];
  assert.equal(new Set(ops.map((o) => o.op)).size, B15_OP_NAMES.length, "the test covers every B15 op");
  const r = checkB15Ops([...base, ...ops], { config: cfg, dictionary, materials: db });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ops.length, base.length + ops.length);
  assert.equal((r.ops.find((o) => o.op === "material_purge") as any).delete, false, "purge lists only by default");
});

test("the old ops still parse (the spread didn't break the union)", () => {
  assert.ok(OP.safeParse({ op: "set_category", name: "Furniture" }).success);
  assert.ok(!OP.safeParse({ op: "dim_add_angular", name: "x", refs: ["A"] }).success, "between needs two planes");
  assert.ok(!OP.safeParse({ op: "material_paint", name: "S/side", solid: "S", face: "side", material: "M" }).success, "face is an enum");
  assert.ok(!OP.safeParse({ op: "category_flags", name: "chair", cut_with_voids: true }).success, "name is family");
});

test("B15 op schemas have no tuple items (Claude API rule)", () => {
  const s = JSON.stringify(zodToJsonSchema(z.array(OP)));
  assert.ok(!/"items":\[/.test(s));
  for (const shape of [FMC_FAM_DIM_SHAPE, FMC_FAM_VISIBILITY_SHAPE, FMC_FAM_MATERIAL_SHAPE, FMC_FAM_CATEGORY_SHAPE])
    assert.ok(!/"items":\[/.test(JSON.stringify(zodToJsonSchema(z.object(shape as any)))));
});

test("checks: wrong parameter types, same plane twice, bad names are errors", () => {
  const bad = [
    ...base,
    { op: "dim_add_angular", name: "A1", refs: ["Left", "Left"], label: "Radius" },
    { op: "dim_add_radial", name: "R1", ref: "Seat", label: "Swing" },
    { op: "dim_unlock", name: "U1" },
    { op: "dim_unlock", name: "U2", refs: ["Left", "Hinge"], label: "Radius" },
    { op: "vis_set", name: "Seat" },
    { op: "vis_set", name: "Seat2", detail_levels: ["fine", "fine"], param: "Radius" },
    { op: "material_paint", name: "Seat/bottom", solid: "Seat", face: "top", material: "FMC_Wood_Oak" },
    { op: "category_flags", name: "family" },
    { op: "category_flags", name: "family", ifc_export_as: "Furniture" },
    { op: "category_sub_rename", name: "Frame", to: "frame" },
    { op: "category_sub_delete", name: "Frame", reassign_to: "Frame" },
    { op: "dim_add_angular", name: "A2", refs: ["Left", "Hinge"], side_a: 2 },
    { op: "material_set", name: "M1", param: "Radius", targets: ["Seat"], material: "FMC_Wood_Oak" },
    { op: "category_set", name: "C1" },
    { op: "category_set", name: "C2", category: "Furniture", targets: ["Seat"] },
    { op: "vis_set", name: "V3", element_ids: [101], targets: ["Seat"], views: ["plan_rcp"] },
  ];
  const { errors } = splitProblems(opsProblems(OP.array().parse(bad), dictionary, undefined, db));
  const has = (s: string) => assert.ok(errors.some((e) => e.includes(s)), `expected an error with "${s}" in ${JSON.stringify(errors, null, 1)}`);
  has("an angle needs two different planes");
  has(`"Radius" is Length, not Angle`);
  has(`"Swing" is Angle, not Length`);
  has("give one of id, refs [plane, plane] or label");
  has("set at least one of detail_levels, views, only_when_cut, param");
  has("a detail level is named twice");
  has(`"Radius" is Length, not YesNo`);
  has("give param or element_ids/targets, not both");
  has(`"Radius" is Length, not Material`);
  has("give category, subcategory or both");
  has("give subcategory");
  has("give element_ids or targets, not both");
  has(`name must be "Seat/top"`);
  has("set at least one of cut_with_voids");
  has("is an IFC class name such as IfcFurniture");
  has("the new name is the old one");
  has("reassign_to is the subcategory being deleted");
  has("side_a is 1 or -1");
});

test("checks: references not made in the batch are notes, not errors", () => {
  const ops = [
    { op: "dim_add_angular", name: "A", refs: ["P1", "P2"] },
    { op: "dim_add_radial", name: "R", ref: "Bowl" },
    { op: "material_set", name: "Bowl", material: "FMC_Stone" },
    { op: "category_sub_rename", name: "Legs", to: "Chair Legs" },
    { op: "vis_set", name: "V", element_ids: [345678], detail_levels: ["fine"] },
  ];
  const { errors, notes } = splitProblems(opsProblems(OP.array().parse(ops), dictionary));
  assert.deepEqual(errors, []);
  assert.ok(notes.length >= 5);
  assert.ok(notes.every((n) => n.includes("may exist in the file")));
});

// ---------- fmc_fam_dim ----------

test("fmc_fam_dim: diameter becomes radial with diameter, unlock gets a note, other ops are refused", () => {
  const p = dimOps([
    { op: "dim_add_diameter", name: "D", ref: "Seat" },
    { op: "dim_unlock", name: "U", label: "Width" },
    { op: "add_dimension", name: "Width", between: ["Left", "Right"], label: "Width" },
  ]);
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.ops[0], { op: "dim_add_radial", name: "D", ref: "Seat", diameter: true });
  assert.ok(p.notes[0].includes("what then floats"));
  assert.ok(dimOps([{ op: "extrusion", name: "X" }]).problems[0].includes("doesn't take op \"extrusion\""));
});

test("fmc_fam_dim: no session is a plan only; dry_run false without a session is refused", async () => {
  const { io, calls } = fakeIo();
  const items = [...base.slice(0, 3), { op: "dim_add_angular", name: "Swing angle", refs: ["Left", "Hinge"], label: "Swing" }];
  // base ops other than dimension ops are not dim tool ops: the tool refuses them
  const refused = body(await runFmcFamDim(args({ items }), io));
  assert.equal(refused.refused, true);
  const r = body(await runFmcFamDim(args({ items: [items[3]] }), io));
  assert.equal(r.isError, false);
  assert.equal(r.dry_run, true);
  assert.equal(r.planned_ops.length, 1);
  assert.ok(r.notes.some((n: string) => n.includes("may exist")));
  assert.equal(calls.length, 0, "nothing sent to Revit");
  const real = body(await runFmcFamDim(args({ items: [items[3]], dry_run: false }), io));
  assert.equal(real.refused, true);
});

test("fmc_fam_dim: with a session, a dry run applies rolled back and never saves", async () => {
  const { io, calls } = fakeIo();
  const r = body(await runFmcFamDim(args({ session: "S9", save_path: TARGET,
    items: [{ op: "dim_add_radial", name: "R", ref: "Seat" }] }), io));
  assert.equal(r.isError, false);
  assert.deepEqual(calls.map((c) => c.action), ["apply"]);
  assert.equal(calls[0].dry_run, true);
  assert.equal(calls[0].session, "S9");
  assert.equal(r.saved, undefined);
});

// ---------- fmc_fam_visibility ----------

test("fmc_fam_visibility: tiers expand, a matrix check is added, empty levels are proposed", () => {
  const p = visibilityOps([
    { op: "vis_set", name: "Seat", tier: "fine" },
    { op: "vis_set", name: "Legs", tier: "medium_fine" },
  ]);
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.ops[0], { op: "vis_set", name: "Seat", detail_levels: ["fine"] });
  assert.equal(p.ops.at(-1)!.op, "vis_matrix");
  assert.ok(p.notes.some((n) => n.includes("off at coarse")));
  assert.ok(!p.notes.some((n) => n.includes("off at fine")));
  assert.equal(visibilityOps([{ op: "set_visibility", name: "S", coarse: true }], false).ops.length, 1, "matrix: false adds none");
  assert.ok(visibilityOps([{ op: "vis_set", name: "S", tier: "sometimes" }]).problems[0].includes("isn't one of"));
  assert.ok(visibilityOps([{ op: "vis_set", name: "S", tier: "fine", detail_levels: ["coarse"] }]).problems[0].includes("not both"));
});

test("fmc_fam_visibility: runs through a template session (open, apply dry)", async () => {
  const { io, calls } = fakeIo();
  const r = body(await runFmcFamVisibility(args({ template: TPL + "\\English\\Metric Furniture.rft", matrix: true,
    items: [{ op: "vis_set", name: "Seat", only_when_cut: true }] }), io));
  assert.equal(r.isError, false, JSON.stringify(r));
  assert.deepEqual(calls.map((c) => c.action), ["open", "apply"]);
  assert.deepEqual((calls[1].ops as any[]).map((o) => o.op), ["vis_set", "vis_matrix"]);
});

test("fmc_fam_visibility: a template outside the template roots is refused before Revit", async () => {
  const { io, calls } = fakeIo();
  const r = body(await runFmcFamVisibility(args({ template: "C:\\Temp\\x.rft", items: [{ op: "vis_matrix", name: "V" }] }), io));
  assert.equal(r.refused, true);
  assert.equal(calls.length, 0);
});

// ---------- fmc_fam_material ----------

test("fmc_fam_material: material_param makes the parameter and ties the solid", () => {
  const p = materialOps([{ op: "material_param", name: "Seat Material", solid: "Seat" }, { op: "material_purge", name: "P", delete: true }]);
  assert.deepEqual(p.ops.slice(0, 2), [
    { op: "add_family_param", name: "Seat Material", type: "Material", instance: false, group: "Materials" },
    { op: "set_material_param", name: "Seat", param: "Seat Material" },
  ]);
  assert.ok(p.notes.some((n) => n.includes("delete is true")));
  assert.ok(materialOps([{ op: "material_param", name: "M" }]).problems[0].includes("needs name"));
});

test("fmc_fam_material: textures outside the kit refuse, missing ones warn", () => {
  const exists = (f: string) => f.toLowerCase().endsWith("oak.jpg");
  const ok = textureProblems([{ op: "add_material", name: "FMC_Wood_Oak" }], db, MATS, exists);
  assert.deepEqual(ok, { errors: [], notes: [] });
  const miss = textureProblems([{ op: "add_material", name: "FMC_Steel_Brushed" }], db, MATS, exists);
  assert.equal(miss.errors.length, 0);
  assert.ok(miss.notes[0].includes("isn't on disk"));
  const out = textureProblems([{ op: "add_material", name: "FMC_Bad_Texture" }], db, MATS, exists);
  assert.ok(out.errors[0].includes("outside the kit's materials folder"));
  assert.ok(textureProblems([{ op: "add_material", name: "FMC_Wood_Oak" }], null, MATS, exists).errors[0].includes("isn't readable"));
});

test("fmc_fam_material: a material not in the kit is refused; a kit one plans", async () => {
  const { io } = fakeIo([STAGING.replace("04_Families\\_Staging", "07_Materials\\Textures\\oak.jpg")]);
  const bad = body(await runFmcFamMaterial(args({ items: [{ op: "add_material", name: "Pink_Fluffy" }] }), io));
  assert.equal(bad.refused, true);
  assert.ok(bad.reasons.some((x: string) => x.includes("isn't in the kit's material library")));
  const good = body(await runFmcFamMaterial(args({ items: [{ op: "add_material", name: "FMC_Wood_Oak" },
    { op: "material_set", name: "Seat", material: "FMC_Wood_Oak" }] }), io));
  assert.equal(good.isError, false, JSON.stringify(good));
  assert.equal(good.planned_ops.length, 2);
});

// ---------- fmc_fam_category ----------

test("fmc_fam_category: category goes first, once; delete notes say what happens", () => {
  const p = categoryOps([{ op: "category_flags", name: "family", cut_with_voids: true }, { op: "category_sub_delete", name: "Old" }], "Furniture");
  assert.deepEqual(p.ops[0], { op: "category_set", name: "Category", category: "Furniture" });
  assert.ok(p.notes[0].includes("refused in Revit if any solid or line uses it"));
  assert.ok(categoryOps([{ op: "category_set", name: "C", category: "Casework" }], "Furniture").problems[0].includes("once"));
  assert.ok(categoryOps([{ op: "add_material", name: "x" }]).problems[0].includes("doesn't take op"));
});

test("fmc_fam_category: nothing to do is refused", async () => {
  const { io } = fakeIo();
  const r = body(await runFmcFamCategory(args({ items: [], category: "" }), io));
  assert.equal(r.refused, true);
});

test("fmc_fam_category: a panel Part Type on a non-electrical category is refused (existing rule still applies)", async () => {
  const { io } = fakeIo();
  const r = body(await runFmcFamCategory(args({ category: "Furniture", items: [{ op: "set_family_params", name: "family", part_type: "Panelboard" }] }), io));
  assert.equal(r.refused, true);
});

// ---------- saves ----------

test("save: real apply saves into staging; an existing file needs overwrite and is archived first", async () => {
  const items = [{ op: "category_sub_rename", name: "Frame", to: "Chair Frame" }];
  const exists = [TARGET, STAGING + "\\FMC_F_Chair.0001.rfa", STAGING + "\\FMC_F_Chair.build.json"];
  const a = fakeIo(exists);
  const no = body(await runFmcFamCategory(args({ session: "S1", dry_run: false, save_path: TARGET, items }), a.io));
  assert.equal(no.refused, true);
  assert.ok(no.reasons[0].includes("overwrite: true"));
  assert.equal(a.calls.length, 0);
  const b = fakeIo(exists);
  const yes = body(await runFmcFamCategory(args({ session: "S1", dry_run: false, save_path: TARGET, overwrite: true, items }), b.io));
  assert.equal(yes.isError, false, JSON.stringify(yes));
  const firstSave = b.events.indexOf("doc:save"), lastMove = b.events.map((e) => e.startsWith("move:")).lastIndexOf(true);
  assert.ok(lastMove >= 0 && lastMove < firstSave, "archived before the save: " + b.events.join(" "));
  assert.equal(b.calls.find((c) => c.action === "save")!.overwrite, false, "fmc_doc save never overwrites");
  assert.ok(yes.saved.archived.length >= 2);
});

test("save: outside the staging root is refused before Revit", async () => {
  const { io, calls } = fakeIo();
  const r = body(await runFmcFamDim(args({ session: "S1", dry_run: false, save_path: "D:\\Projects\\A-0001\\x.rfa",
    items: [{ op: "dim_unlock", name: "U", label: "Width" }] }), io));
  assert.equal(r.refused, true);
  assert.equal(calls.length, 0);
});

test("replacePlanB15 moves the .build.json with the file", () => {
  const moves = replacePlanB15(TARGET, ["FMC_F_Chair.rfa", "FMC_F_Chair.build.json"], new Date(2026, 10, 28, 14, 30, 0));
  assert.ok(moves.some(([f]) => f.endsWith("FMC_F_Chair.build.json")));
  assert.ok(moves.every(([, t]) => t.includes("_Archive")));
});

test("famB15Run refuses planner problems before anything else", async () => {
  const { io, calls } = fakeIo();
  const r = await famB15Run("t", { ops: [], problems: ["nope"], notes: [] }, args({ session: "S1", dry_run: false }), io);
  assert.equal(r.refused, true);
  assert.equal(calls.length, 0);
});

test("op names: the TS table (B15) and the add-in's (FmcDocFamB15.Op) are the same", async () => {
  const fs = await import("node:fs");
  const { B15 } = await import("./ops_b15.js");
  const cs = fs.readFileSync(new URL("../../../commandset/Services/Fmc/FmcDocFamB15.cs", import.meta.url), "utf8");
  const names = [...cs.matchAll(/public const string \w+ = "([a-z_]+)";/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, Object.values(B15).sort());
});
