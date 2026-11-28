import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPayload, kitParams, parseCis, planBrief } from "./brief.js";

const params = kitParams({ params: {
  FMC_Project_Code: { binding: "Project Information", categories: ["OST_ProjectInformation"] },
  FMC_Plot_No: { binding: "Project Information", categories: ["OST_ProjectInformation"] },
  FMC_District: { binding: "Project Information", categories: ["OST_ProjectInformation"] },
  FMC_Target_Area: { binding: "Instance", categories: ["OST_Rooms"] },
  FMC_Finish_Set: { binding: "Instance", categories: ["OST_Rooms"] },
  FMC_Fire_Rating: { binding: "Type", categories: ["OST_Doors"] },
} });
const cis = (o: object) => JSON.stringify({ schema: "fmc-cis/0.1", project: "F26001", revision: "R4", approved: "2026-10-13",
  levels: [{ name: "00 Ground", elevation_mm: 0 }, { name: "01 First", elevation_mm: 3300 }],
  project_info: { FMC_Project_Code: "F26001", FMC_Plot_No: "112", FMC_District: "" },
  rooms: [{ number: "G01", name: "Genkan", params: { FMC_Target_Area: 9, FMC_Finish_Set: "FS-01" } }],
  materials: ["FMC_Concrete_Cast"], families: ["FMC_A_Door_Single", "FMC_A_Window_Casement"], ...o });
const kitFamilies = ["K\\04_Families\\A\\FMC_A_Door_Single.rfa", "K\\04_Families\\_Staging\\A\\FMC_A_Window_Casement.rfa"];

test("a good CIS plans levels, kit-checked values, rooms and approved families; blanks stay blank", () => {
  const { cis: c, problems } = parseCis(cis({}));
  assert.deepEqual(problems, []);
  const plan = planBrief(c!, params, kitFamilies);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.project_info.map((p) => p.name), ["FMC_Project_Code", "FMC_Plot_No"]);
  assert.deepEqual(plan.blanks, ["FMC_District"]);
  assert.deepEqual(plan.families.map((f) => f.name), ["FMC_A_Door_Single"]);
  assert.match(plan.skipped.join(" "), /FMC_A_Window_Casement: not approved/);
  assert.match(plan.skipped.join(" "), /no materials library/);
  const payload = applyPayload(plan, true);
  assert.deepEqual(payload.project_info, { FMC_Project_Code: "F26001", FMC_Plot_No: "112" });
  assert.deepEqual(payload.rooms[0].params, { FMC_Target_Area: "9", FMC_Finish_Set: "FS-01" });
});

test("parameters the kit doesn't have, or binds elsewhere, stop the run", () => {
  const { cis: c } = parseCis(cis({ project_info: { FMC_Client_Mood: "happy", FMC_Fire_Rating: "60" },
    rooms: [{ number: "G01", name: "Genkan", params: { FMC_Project_Code: "x" } }] }));
  const plan = planBrief(c!, params, []);
  assert.equal(plan.problems.length, 3);
  assert.match(plan.problems[0], /FMC_Client_Mood isn't a kit parameter/);
  assert.match(plan.problems[1], /Type parameter in the kit/);
  assert.match(plan.problems[2], /isn't bound to Rooms/);
});

test("a CIS that can't be read is refused, never guessed", () => {
  assert.match(parseCis("{half").problems[0], /Not JSON/);
  const bad = parseCis(cis({ schema: "other", levels: [{ name: "L1", elevation_mm: "x" }, { name: "l1", elevation_mm: 0 }],
    rooms: [{ number: "G01", name: "A" }, { number: "G01", name: "B" }, { name: "C" }] })).problems;
  assert.ok(bad.some((p) => /schema must be/.test(p)));
  assert.ok(bad.some((p) => /elevation_mm is not a number/.test(p)));
  assert.ok(bad.some((p) => /Level names repeat: l1/.test(p)));
  assert.ok(bad.some((p) => /Room numbers repeat: G01/.test(p)));
  assert.ok(bad.some((p) => /rooms\[2\]: number and name/.test(p)));
});

import { BRIEF_NOT_APPROVED, briefApproval } from "./brief.js";
import { runFmcBrief } from "../tools/fmc_brief.js";
import { fileURLToPath } from "node:url";
import fsx from "node:fs";
import osx from "node:os";
import pathx from "node:path";

test("a CIS is approved when approved is true or the approval date; anything else is not", () => {
  for (const ok of [true, "true", "TRUE", "2026-10-13", "2026-10-13T08:00:00Z"]) assert.equal(briefApproval(ok).approved, true, String(ok));
  for (const bad of [false, "false", "no", "pending", "draft", "", undefined, null, "13/10/2026", "2026-13-45", 0, "yes please"]) {
    const v = briefApproval(bad);
    assert.equal(v.approved, false, String(bad));
    assert.equal(v.code, BRIEF_NOT_APPROVED);
    assert.equal(v.code, "FMC-BRIEF-NOT-APPROVED");
  }
});

test("fmc_brief apply with dry_run false is refused for an unapproved CIS before Revit is asked; nothing is created", async () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "fmc-brief-"));
  const was = process.cwd();
  process.chdir(dir);
  try {
    const kit = pathx.win32.join(pathx.basename(dir), "kit");
    const master = pathx.win32.join(kit, "03_Master_Data", "FMC_Master_Data.json");
    if (process.platform === "win32") fsx.mkdirSync(pathx.dirname(master), { recursive: true });
    fsx.writeFileSync(master, JSON.stringify({ params: { FMC_Project_Name: { binding: "instance", categories: ["OST_ProjectInformation"] } } }));
    const file = pathx.join(dir, "cis.json");
    const body = (approved: unknown) => JSON.stringify({ schema: "fmc-cis/0.1", project: "F26001", revision: "R4", ...(approved === undefined ? {} : { approved }),
      levels: [{ name: "L1", elevation_mm: 0 }], project_info: {}, rooms: [], materials: [], families: [] });
    for (const approved of [undefined, false, "false", "draft", ""]) {
      fsx.writeFileSync(file, body(approved));
      const res = await runFmcBrief({ action: "apply", cis_file: file, kit_folder: kit, dry_run: false });
      const text = (res.content[0] as { text: string }).text;
      assert.equal(res.isError, true, String(approved));
      assert.match(text, /FMC-BRIEF-NOT-APPROVED/, String(approved));
      assert.doesNotMatch(text, /"result"/, "Revit was not asked");
    }
  } finally { process.chdir(was); fsx.rmSync(dir, { recursive: true, force: true }); }
});

test("fmc_brief source: the approval check sits between the plan and the Revit apply, and only dry_run false needs it", () => {
  const src = fsx.readFileSync(pathx.resolve(pathx.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools", "fmc_brief.ts"), "utf8");
  const check = src.indexOf("if (!dry && !approval.approved)");
  assert.ok(check > 0);
  assert.ok(check < src.indexOf('sendCommand("fmc_brief_apply"'), "refused before fmc_brief_apply is sent");
  assert.ok(check > src.indexOf("if (plan.problems.length)"));
});
