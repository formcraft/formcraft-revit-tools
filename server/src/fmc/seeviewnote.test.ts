import { test } from "node:test";
import assert from "node:assert/strict";

test("P-see_view-01: the reply says save_to's folder was not used and names both pictures", async () => {
  const { saveToNote } = await import("../tools/see_view.js");
  const note = saveToNote("C:\\Users\\USER\\agent-tools\\revit-tests\\out-files\\plan.png", "C:\\img\\plan.png", "C:\\img\\fmc_view_1.png") ?? "";
  assert.match(note, /folder \(C:\\Users\\USER\\agent-tools\\revit-tests\\out-files\) was not used/);
  assert.match(note, /also stays at C:\\img\\fmc_view_1\.png/);
  assert.equal(saveToNote("plan.png", "C:\\img\\plan.png", "C:\\img\\plan.png"), null);
  assert.equal(saveToNote("", "", ""), null);
});
