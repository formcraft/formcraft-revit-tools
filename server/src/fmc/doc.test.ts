import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, GuardConfig } from "./policy.js";
import { buildReport, openProblems, saveProblems } from "./doc.js";

const cfg: GuardConfig = {
  ...DEFAULT_CONFIG,
  template_roots: ["C:\\ProgramData\\Autodesk\\RVT 2025\\Family Templates"],
  library_roots: ["D:\\Kit\\04_Families\\_Staging", "D:\\Kit\\04_Families\\_ChainTests"],
  write_roots: ["D:\\Kit\\04_Families\\_Staging", "D:\\Kit\\04_Families\\_ChainTests"],
};
const RFT = "C:\\ProgramData\\Autodesk\\RVT 2025\\Family Templates\\English\\Metric Generic Model.rft";

test("open: family templates from the template roots, or family files from staging only", () => {
  assert.deepEqual(openProblems({ template: RFT }, cfg), []);
  assert.deepEqual(openProblems({ file: "D:\\Kit\\04_Families\\_Staging\\P\\FMC_P_EQ_WaterHeater.rfa" }, cfg), []);
  assert.match(openProblems({ template: "C:\\Temp\\x.rft" }, cfg)[0], /template folder/);
  assert.match(openProblems({ template: "C:\\ProgramData\\Autodesk\\RVT 2025\\Templates\\Metric.rte" }, cfg)[0], /project templates come in B5/);
  assert.match(openProblems({ file: "Z:\\Projects\\F26001\\01_WIP\\A\\model.rvt" }, cfg)[0], /only family files/);
  assert.match(openProblems({ file: "Z:\\Live\\FMC_A_Door.rfa" }, cfg)[0], /staging files only/);
  assert.match(openProblems({}, cfg)[0], /needs a family template/);
});

test("save: an .rfa inside the write roots", () => {
  assert.deepEqual(saveProblems("D:\\Kit\\04_Families\\_ChainTests\\FMC_P_EQ_WaterHeater.rfa", cfg), []);
  assert.match(saveProblems("D:\\Kit\\04_Families\\_ChainTests\\x.rvt", cfg)[0], /saved as \.rfa/);
  assert.ok(saveProblems("C:\\Temp\\FMC_P_EQ_WaterHeater.rfa", cfg).some((r) => /Not inside an allowed write folder/.test(r)));
});

test("the build report: same ops give the same hash", () => {
  const s = { id: "a1", source: RFT, opened: "", ops: [{ op: "add_ref_plane", name: "Left", result: "create" }] };
  const a = buildReport(s, "D:\\x\\FMC_P_EQ_WaterHeater.rfa", { category: "Generic Models", parameters: [1, 2], solids: 1 }, { kit: "2.2", revision: "r4" }, "abc1234", new Date());
  const b = buildReport({ ...s }, "D:\\y\\FMC_P_EQ_WaterHeater.rfa", {}, {}, "def", new Date());
  assert.equal(a.ops_hash, b.ops_hash);
  assert.equal(a.kit, "2.2 r4");
  assert.equal(a.result.parameters, 2);
  assert.equal(a.source, "Metric Generic Model.rft");
});
