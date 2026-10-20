import { test } from "node:test";
import assert from "node:assert/strict";
import { rhinoProofProblems, PartsManifest } from "./rhinoproof.js";
import type { RhinoRulebook } from "./rhino.js";

const BOOK = { version: "0.1", proof: { rhino_first: true } } as RhinoRulebook;
const F = "D:\\Kit\\04_Families\\_Staging\\_Rhino\\FMC_I_Furniture_Sofa\\Arm_L.3dm";
const op = { op: "import_part", name: "Arm_L", file: F };
const good: PartsManifest = { check: { ok: true, rulebook_version: "0.1" }, parts: [{ name: "Arm_L", file: F, sha256: "abc" }] };
const io = (m: PartsManifest | null, sha: string | null = "ABC") => ({ manifest: () => m, sha256: () => sha });

test("owner 20 Oct: a Rhino part goes to Revit only with its passing check, under the kit's rulebook, unchanged", () => {
  assert.deepEqual(rhinoProofProblems([op], {}, BOOK, io(good)), []);
  assert.match(rhinoProofProblems([op], {}, BOOK, io(null))[0], /no parts\.json/);
  assert.match(rhinoProofProblems([op], {}, BOOK, io({ ...good, check: undefined }))[0], /doesn't record a passing Rhino check/);
  assert.match(rhinoProofProblems([op], {}, BOOK, io({ ...good, check: { ok: true, rulebook_version: "0.0" } }))[0], /rulebook 0\.0, the kit's is 0\.1/);
  assert.match(rhinoProofProblems([op], {}, BOOK, io(good, "def"))[0], /changed after its check/);
  assert.match(rhinoProofProblems([op], {}, BOOK, io(good, null))[0], /missing on disk/);
  assert.match(rhinoProofProblems([op], {}, null, io(good))[0], /no Rhino rulebook/);
});

test("owner 20 Oct: a complex shape (rhino_required) must come from Rhino; plain recipes are untouched", () => {
  assert.match(rhinoProofProblems([{ op: "extrusion", name: "Body" }], { rhino_required: true }, BOOK, io(null))[0], /RHN-011/);
  assert.deepEqual(rhinoProofProblems([{ op: "extrusion", name: "Body" }], {}, null, io(null)), []);
});
