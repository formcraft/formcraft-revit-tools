import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { FMC_FAMILY_SHAPE, stagingRows } from "../tools/fmc_family.js";

test("research tool 40: staging says which families are built, with date, size and build report", () => {
  const plans = [
    { family: "FMC_A_BurglarBars", role: "A", save_path: "D:\\Kit\\04_Families\\_Staging\\A\\FMC_A_BurglarBars.rfa" },
    { family: "FMC_TAG_A_Room", role: "A", save_path: "D:\\Kit\\04_Families\\_Staging\\A\\FMC_TAG_A_Room.rfa" },
    { family: "FMC_P_None", role: "P", save_path: "" },
  ];
  const when = new Date("2026-11-27T08:00:00Z");
  const stat = (file: string) => (file.endsWith("FMC_TAG_A_Room.rfa") || file.endsWith("FMC_A_BurglarBars.rfa") ? { mtime: when, size: 393216 } : null);
  const json = (file: string) => (file.endsWith("FMC_TAG_A_Room.build.json") ? { saved_at: "2026-11-27T08:00:00Z", kit: "2.2 r4", plugin: "cf71214", ops_hash: "abc", ops: [1, 2] } : null);
  const rows = stagingRows(plans, stat, json);
  assert.equal(rows.built, 2);
  assert.equal(rows.missing, 1);
  assert.deepEqual(rows.families.map((f) => [f.family, f.built]), [["FMC_A_BurglarBars", true], ["FMC_TAG_A_Room", true], ["FMC_P_None", false]]);
  assert.equal(rows.families[0].modified_at, "2026-11-27T08:00:00.000Z");
  assert.equal(rows.families[0].bytes, 393216);
  assert.equal(rows.families[0].build_report, undefined);
  assert.deepEqual(rows.families[1].build_report, { saved_at: "2026-11-27T08:00:00Z", kit: "2.2 r4", plugin: "cf71214", ops_hash: "abc" });
});

test("staging is an fmc_family action and needs no selection", () => {
  const parsed = z.object(FMC_FAMILY_SHAPE).parse({ action: "staging" });
  assert.equal(parsed.action, "staging");
  assert.equal(parsed.dry_run, true);
});
