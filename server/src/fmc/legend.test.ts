import { test } from "node:test";
import assert from "node:assert/strict";
import { chainTestsRoot, roleTemplate } from "../tools/fmc_legend.js";

test("F-064 #6: the chain test uses the role's template from 06_Templates\\_Staging and saves in _ChainTests", () => {
  const have = new Set(["K:\\06_Templates\\_Staging\\FMC_E_Template_v2.2.rte", "K:\\06_Templates\\FMC_A_Template_v2.2.rte"]);
  const roots = ["C:\\ProgramData\\Autodesk\\RVT 2025\\Templates", "K:\\06_Templates"];
  assert.equal(roleTemplate(roots, "E", (f) => have.has(f)), "K:\\06_Templates\\_Staging\\FMC_E_Template_v2.2.rte");
  assert.equal(roleTemplate(roots, "A", (f) => have.has(f)), "K:\\06_Templates\\FMC_A_Template_v2.2.rte");
  assert.equal(roleTemplate(roots, "M", (f) => have.has(f)), null);
  assert.equal(chainTestsRoot(["K:\\04_Families\\_Staging", "K:\\04_Families\\_ChainTests"], "K:\\04_Families\\_Staging"), "K:\\04_Families\\_ChainTests");
  assert.equal(chainTestsRoot([], "K:\\04_Families\\_Staging\\"), "K:\\04_Families\\_ChainTests");
});

test("research 54: list_chains lists chain-test projects on disk, current and archived, read-only", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { listChains, runFmcLegend, FMC_LEGEND_SHAPE } = await import("../tools/fmc_legend.js");
  const { DEFAULT_CONFIG } = await import("./policy.js");
  const { z } = await import("zod");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chains54-"));
  const staging = path.join(base, "04_Families", "_Staging");
  const root = path.join(base, "04_Families", "_ChainTests");
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(path.join(root, "_Archive"), { recursive: true });
  fs.writeFileSync(path.join(root, "FMC_ChainTest_A.rvt"), "x");
  fs.writeFileSync(path.join(root, "FMC_ChainTest_A.json"), "{}");
  fs.writeFileSync(path.join(root, "FMC_ChainTest_E.rvt"), "xx");
  fs.writeFileSync(path.join(root, "FMC_ChainTest_E.0001.rvt"), "backup");
  fs.writeFileSync(path.join(root, "_Archive", "FMC_ChainTest_A_20261101.rvt"), "old");
  fs.writeFileSync(path.join(root, "notes.txt"), "n");
  const all = listChains(root);
  assert.equal(all.length, 3);
  assert.deepEqual(listChains(root, "a").map((row) => [row.archived, !!row.result]).sort(), [[false, true], [true, false]]);
  const guard = { ...DEFAULT_CONFIG, family_staging_root: staging, library_roots: [] };
  const out = JSON.parse((await runFmcLegend(z.object(FMC_LEGEND_SHAPE).parse({ action: "list_chains", role: "E" }), { guard })).content[0].text);
  assert.equal(out.read_only, true);
  assert.equal(out.chains.length, 1);
  assert.equal(out.summary, "1 current and 0 archived chain-test project for role E.");
  fs.rmSync(base, { recursive: true, force: true });
});
