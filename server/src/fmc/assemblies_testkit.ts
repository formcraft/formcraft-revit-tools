import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRead } from "./assemblies_plan.js";

/** Shared by the F59 tests (not a test itself): the test designs and a model read without them. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../src/fmc/fixtures/assemblies_sample.json"), "utf8"));

export const EMPTY_MODEL: ModelRead = {
  patterns: [], curtain_types: [{ name: "Storefront", id: 101 }], railing_types: [{ name: "Handrail - Rectangular", id: 201, height: 900 }],
  mullion_types: ["50 x 150mm"], panel_types: ["Glazed", "Solid"], top_rail_types: ["Rectangular - 50x50mm"], legend_views: [],
};
