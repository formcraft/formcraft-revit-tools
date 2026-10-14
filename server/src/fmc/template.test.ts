import { test } from "node:test";
import assert from "node:assert/strict";
import { auditTemplate, fontFor, TemplateFacts } from "./template.js";
import { parseSharedParameters } from "./specs.js";

const kit = parseSharedParameters([
  "# This is a Revit shared parameter file.", "*GROUP\tID\tNAME", "GROUP\t1\tAsset", "*PARAM\tGUID\tNAME\tDATATYPE\tDATACATEGORY\tGROUP\tVISIBLE",
  "PARAM\taaaaaaaa-0000-0000-0000-000000000001\tFMC_Asset_Tag\tTEXT\t\t1\t1",
  "PARAM\taaaaaaaa-0000-0000-0000-000000000002\tFMC_Keynote_Code\tTEXT\t\t1\t1",
].join("\n"));

const facts = (o: Partial<TemplateFacts> = {}): TemplateFacts => ({
  title: "FMC_A_Template_v2.2", size_mb: 38, view_templates: 40, filters: 22, title_blocks: 2, schedules: 12,
  browser_organisations: 3, families: 60, unused_families: 12, warnings: 4,
  shared_parameters: [{ name: "FMC_Asset_Tag", guid: "AAAAAAAA-0000-0000-0000-000000000001" }],
  text_types: [{ name: "FMC_Arial_2.5", font: "Arial" }, { name: "FMC_Title_5", font: "Arial Bold" }],
  dimension_types: [{ name: "FMC_Linear_2.5", font: "Arial" }],
  ...o,
});

const brand = { name: "Formcraft (internal)", main_font: "Arial", title_font: "Arial Bold" };

test("title types take the title font, the rest the main font", () => {
  assert.equal(fontFor("FMC_Title_5", brand), "Arial Bold");
  assert.equal(fontFor("FMC_Arial_2.5", brand), "Arial");
});

test("a clean template passes the kit checks", () => {
  const lines = auditTemplate(facts(), kit, brand);
  assert.equal(lines.find((l) => l.area.startsWith("Shared parameters vs"))!.severity, "Pass");
  assert.equal(lines.find((l) => l.area.startsWith("Fonts vs"))!.severity, "Pass");
  assert.equal(lines.find((l) => l.area.startsWith("Size"))!.status, "38 MB · 12 unused");
});

test("same name with another GUID is a Must; parameters the kit doesn't have are a Should", () => {
  const lines = auditTemplate(facts({ shared_parameters: [
    { name: "FMC_Asset_Tag", guid: "bbbbbbbb-0000-0000-0000-000000000009" },
    { name: "Vendor_Code", guid: "cccccccc-0000-0000-0000-000000000003" },
  ] }), kit, null);
  const must = lines.find((l) => l.area.startsWith("Shared parameters vs"))!;
  assert.equal(must.severity, "Must");
  assert.equal(must.status, "1 differ");
  assert.equal(lines.find((l) => l.area === "Shared parameters not in the kit")!.status, "1 extra");
});

test("off-brand fonts, no title block and no view templates are Shoulds", () => {
  const lines = auditTemplate(facts({ text_types: [{ name: "Generic 2.5", font: "Times New Roman" }], title_blocks: 0, view_templates: 0 }), kit, brand);
  assert.equal(lines.find((l) => l.area.startsWith("Fonts vs"))!.status, "1 off-brand");
  assert.equal(lines.find((l) => l.area === "Title blocks and schedules")!.severity, "Should");
  assert.equal(lines.find((l) => l.area === "View templates and filters")!.severity, "Should");
});

test("without the kit's parameter file the check says so instead of guessing", () => {
  assert.equal(auditTemplate(facts(), null, null)[0].status, "Not checked");
});
