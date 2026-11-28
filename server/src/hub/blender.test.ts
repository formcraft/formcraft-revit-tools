import { test } from "node:test";
import assert from "node:assert/strict";
import { RENDER_SCRIPT, resultOf, withValues } from "./blender.js";
import { renderFolder } from "../tools/fmc_blender.js";

test("Blender (owner 27 Oct): values travel as base64 JSON, so a value can never become code", () => {
  const code = withValues("print(P)", { view: `x"); import os; os.remove("y` });
  assert.ok(!code.includes("import os;"), code);
  const b64 = /b64decode\("([A-Za-z0-9+/=]+)"\)/.exec(code)![1];
  assert.equal(JSON.parse(Buffer.from(b64, "base64").toString()).view, `x"); import os; os.remove("y`);
});

test("Blender: the answer's last FMC_RESULT line is the result; a failed script says why", () => {
  assert.deepEqual(resultOf({ status: "ok", stdout: "noise\nFMC_RESULT {\"png\":\"a.png\"}\n" }), { png: "a.png" });
  assert.throws(() => resultOf({ status: "error", message: "boom" }), /boom/);
  assert.throws(() => resultOf({ status: "ok", stdout: "nothing" }), /no result/);
});

test("Blender: renders go to the project's 01_WIP/_Exchange/Renders; Revit colours are made linear; OBJ first", () => {
  const f = renderFolder("D:/P/Ogala", "C:/R", "{3D}", new Date("2026-10-27T07:03:59Z"));
  assert.equal(f, String.raw`D:\P\Ogala\01_WIP\_Exchange\Renders\20261027-070359__3D_`);
  assert.match(RENDER_SCRIPT, /\(v \+ 0\.055\) \/ 1\.055\) \*\* 2\.4/);
  assert.match(RENDER_SCRIPT, /obj_import\(filepath=P\["obj"\], forward_axis="Y", up_axis="Z"\)/);
});
