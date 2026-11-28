import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { checkFactors, computeCarbon, factorsPathFor, kitDensities, loadFactors, type CarbonRead } from "./carbon.js";
import { FMC_CARBON_SHAPE, runFmcCarbon, type FmcCarbonArgs } from "../tools/fmc_carbon.js";

const args = (partial: Record<string, unknown>): FmcCarbonArgs => z.object(FMC_CARBON_SHAPE).parse(partial);
const textOf = (r: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> =>
  ({ ...(JSON.parse(r.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: r.isError === true });

// TEST VALUES ONLY: round numbers to check the arithmetic. They are not carbon factors and are not shipped.
const READ: CarbonRead = {
  title: "A", revit_version: "2025",
  materials: [
    { name: "FMC_Concrete_C25", class: "Concrete", volume_m3: 10 },
    { name: "FMC_Steel_S275", class: "Metal", volume_m3: 2 },
    { name: "FMC_Timber_Cypress", class: "Wood", volume_m3: 4 },
    { name: "FMC_Paint", class: "Paint", volume_m3: 0 },
  ],
  assemblies: [
    { category: "Walls", type: "Block 200", material: "FMC_Concrete_C25", volume_m3: 10 },
    { category: "Structural Framing", type: "UB", material: "FMC_Steel_S275", volume_m3: 2 },
    { category: "Doors", type: "D1", material: "FMC_Timber_Cypress", volume_m3: 4 },
  ],
};

test("with no factor file there are no totals and the owner note says where factors come from", async () => {
  const r = textOf(await runFmcCarbon(args({ document: "A" }), { read: async () => READ, materialsFile: "", materialsJson: null }));
  assert.equal(r.status, "NO_FACTORS");
  assert.equal(r.totals.kgco2e, null);
  assert.equal(r.can_pass, false);
  assert.equal(r.read_only, true);
  assert.ok(r.notes.some((n: string) => /Family Kit Loader/.test(n)));
  assert.equal(r.unfactored.length, 3);
});

test("factors need one positive number and a source; per-kg needs a density from the factor or the kit", () => {
  const checked = checkFactors({ factors: [
    { material: "a", kgco2e_per_m3: 1, source: "s" },
    { material: "b", kgco2e_per_m3: 1, kgco2e_per_kg: 1, source: "s" },
    { material: "c", kgco2e_per_m3: 1 },
    { material: "d", kgco2e_per_kg: -1, source: "s" },
  ] });
  assert.equal(checked.factors.length, 1);
  assert.equal(checked.problems.length, 3);
  const densities = kitDensities({ materials: [{ name: "FMC_Steel_S275", physical: { density_kg_m3: 100 } }, { name: "x", physical: { density_kg_m3: "n/a" } }] });
  assert.equal(densities.get("fmc_steel_s275"), 100);
  assert.equal(densities.size, 1);
  const loaded = { path: "f", found: true, status: "approved", problems: [], factors: [
    { material: "Concrete", match: "class" as const, kgco2e_per_m3: 10, source: "test", status: "approved" },
    { material: "FMC_Steel_S275", kgco2e_per_kg: 2, source: "test", status: "approved" },
  ] };
  const result = computeCarbon(READ, loaded, densities);
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.totals.kgco2e, 10 * 10 + 2 * 100 * 2);
  assert.equal(result.unfactored[0]?.material, "FMC_Timber_Cypress");
  assert.equal(result.assemblies[0]?.category, "Structural Framing");
  const noDensity = computeCarbon(READ, loaded, new Map());
  assert.ok(noDensity.unfactored.some((u) => u.material === "FMC_Steel_S275" && /density/.test(String(u.reason))));
  const all = computeCarbon({ ...READ, materials: READ.materials.slice(0, 2) }, loaded, densities);
  assert.equal(all.status, "COMPLETE");
  assert.equal(computeCarbon({ ...READ, materials: READ.materials.slice(0, 2) }, { ...loaded, status: "draft" }, densities).status, "PROVISIONAL");
});

test("the factor file sits beside the kit materials file, and a bad file is reported", () => {
  assert.equal(factorsPathFor("Z:\\00_Standards\\07_Materials\\FMC_Materials.json"), "Z:\\00_Standards\\07_Materials\\FMC_CarbonFactors.json");
  assert.equal(factorsPathFor("Z:\\x\\FMC_Materials.json", "C:\\f.json"), "C:\\f.json");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-carbon-"));
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.equal(loadFactors(bad).status, "invalid");
  assert.equal(loadFactors(path.join(dir, "missing.json")).found, false);
});

test("the carbon read is a read and there is no carbon write", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_carbon"));
  assert.ok(![...WRITE_COMMANDS].some((c) => c.startsWith("fmc_carbon")));
});
