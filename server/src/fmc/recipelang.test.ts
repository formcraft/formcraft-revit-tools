// N064: the recipe-language ops the current generator recipe uses (set_line_weight, envelope, visibility_tier).
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPS, opsProblems, splitProblems, expandSkeletons } from "./ops.js";
import { TIERS, expandLanguage, fam044Pens, languageProblems, tierFlags, withLineWeights } from "./recipelang.js";

const planes = [
  { op: "add_ref_plane", name: "Left", from: [-500, -1000], to: [-500, 1000] },
  { op: "add_ref_plane", name: "Right", from: [500, -1000], to: [500, 1000] },
  { op: "add_ref_plane", name: "Front", from: [-1000, -300], to: [1000, -300] },
  { op: "add_ref_plane", name: "Back", from: [-1000, 300], to: [1000, 300] },
];

test("the three ops parse (they were 'Invalid discriminator value' before N064)", () => {
  const ops = OPS.parse([...planes,
    { op: "add_subcategory", name: "Body" },
    { op: "set_line_weight", name: "Body", projection: 3, cut: 4 },
    { op: "envelope", name: "Coarse Envelope", rect: ["Left", "Right", "Front", "Back"], start: 0, end: 1200 },
    { op: "extrusion", name: "Box", rect: ["Left", "Right", "Front", "Back"], start: 0, end: 1000 },
    { op: "visibility_tier", name: "Body tier", tier: "body", solids: ["Box"] }]);
  assert.equal(ops.length, 9);
  assert.equal((ops[6] as any).tolerance_mm, 15);
});

test("envelope expands to its subcategory, box, assignment and Coarse-only visibility; visibility_tier to one set_visibility per solid", () => {
  const out = expandLanguage([{ op: "envelope", name: "Env", rect: ["Left", "Right", "Front", "Back"], start_plane: "Ref. Level", end: 900 },
    { op: "visibility_tier", name: "T", tier: "fine", solids: ["A", "B"] }] as any[]);
  assert.deepEqual(out.map((o: any) => o.op), ["add_subcategory", "extrusion", "set_subcategory", "set_visibility", "set_visibility", "set_visibility"]);
  assert.equal((out[0] as any).name, "Coarse Envelope");
  assert.equal((out[1] as any).start_plane, "Ref. Level");
  assert.deepEqual({ ...(out[3] as any), op: undefined, name: undefined }, { op: undefined, name: undefined, ...TIERS.envelope });
  assert.deepEqual((out[4] as any), { op: "set_visibility", name: "A", coarse: false, medium: false, fine: true });
  // an existing subcategory isn't added twice
  const again = expandLanguage([{ op: "add_subcategory", name: "Coarse Envelope" }, { op: "envelope", name: "Env", rect: ["L", "R", "F", "B"] }] as any[]);
  assert.equal(again.filter((o: any) => o.op === "add_subcategory").length, 1);
  // expandSkeletons runs it (so check and build see the same ops)
  assert.equal(expandSkeletons([{ op: "visibility_tier", name: "T", tier: "all", solids: ["A"] }] as any).length, 1);
});

test("tier flags: explicit levels win over the tier", () => {
  assert.deepEqual(tierFlags({ tier: "body", coarse: true }), { coarse: true, medium: true, fine: true });
  assert.deepEqual(tierFlags({ fine: true }), { fine: true });
});

test("set_line_weight: the later pens are what the subcategory ends with (FAM-044 judged on them)", () => {
  assert.deepEqual(fam044Pens("Coarse Envelope"), { role: "outline", projection: 3, cut: 4 });
  assert.deepEqual(fam044Pens("Body"), { role: "detail", projection: 2, cut: 4 });
  const w = withLineWeights([{ op: "add_subcategory", name: "Body", line_weight_projection: 1 }, { op: "set_line_weight", name: "Body", projection: 3, cut: 4 }] as any[]);
  assert.equal((w[0] as any).line_weight_projection, 3);
  assert.equal((w[0] as any).line_weight_cut, 4);
});

test("language rules: pens, pale colours, four planes, one envelope, tiers", () => {
  const p = languageProblems([
    { op: "set_line_weight", name: "Body" },
    { op: "set_line_weight", name: "Unit Outline", projection: 1 },
    { op: "set_line_weight", name: "Body", projection: 3, color: [250, 250, 250] },
    { op: "set_line_weight", name: "Body", projection: 1, keep_graphics: true },
    { op: "envelope", name: "E1", rect: ["L", "L", "F", "B"], start_plane: "X", end_plane: "X" },
    { op: "envelope", name: "E2", rect: ["L", "R", "F", "B"], start: 500, end: 100 },
    { op: "visibility_tier", name: "T1", solids: ["A"] },
    { op: "visibility_tier", name: "T2", coarse: false, medium: false, fine: false, solids: ["A", "A"] },
    { op: "visibility_tier", name: "T3", tier: "body", fine: true, solids: ["A"] },
  ]);
  const has = (re: RegExp) => assert.ok(p.some((x) => re.test(x)), `${re} in ${p.join("\n")}`);
  has(/op 1 .*give projection, cut or color/);
  has(/op 2 .*FAM-044 wants pen 3 for outlines/);
  has(/op 3 .*pale line colour/);
  assert.ok(!p.some((x) => /op 4 /.test(x)), "keep_graphics is a deliberate exception");
  has(/op 5 .*four different planes/); has(/op 5 .*one plane/);
  has(/op 6 .*end \(100\) must be above start \(500\)/); has(/op 6 .*one envelope per family/);
  has(/op 7 .*give a tier/); has(/op 8 .*every level off/); has(/op 8 .*named twice/);
  has(/^warning: op 9 .*explicit levels win/);
});

test("opsProblems: set_line_weight on a subcategory not made in the batch is a note (it may be in the file); a thin pen is an error; a good recipe is clean", () => {
  const ghost = splitProblems(opsProblems(OPS.parse([{ op: "set_line_weight", name: "Ghost", projection: 3 }]), null));
  assert.ok(ghost.notes.some((e) => /subcategory "Ghost"/.test(e)), ghost.notes.join("\n"));
  const thin = splitProblems(opsProblems(OPS.parse([{ op: "add_subcategory", name: "Unit Outline" }, { op: "set_line_weight", name: "Unit Outline", projection: 1 }]), null));
  assert.ok(thin.errors.some((e) => /FAM-044 wants pen 3/.test(e)), thin.errors.join("\n"));
  const ok = splitProblems(opsProblems(OPS.parse([...planes,
    { op: "envelope", name: "Coarse Envelope", rect: ["Left", "Right", "Front", "Back"], start: 0, end: 1200 },
    { op: "extrusion", name: "Box", rect: ["Left", "Right", "Front", "Back"], start: 0, end: 1000 },
    { op: "visibility_tier", name: "Body tier", tier: "body", solids: ["Box"] }]), null));
  assert.deepEqual(ok.errors, []);
});
