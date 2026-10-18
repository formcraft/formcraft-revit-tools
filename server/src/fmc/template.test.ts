import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLine, auditTemplate, fontFor, roleCopyLine, TemplateFacts, TemplateRef } from "./template.js";
import { parseSharedParameters } from "./specs.js";
import { DEFAULT_CONFIG } from "./policy.js";
import { loadAuditRef, registerLegends } from "../tools/fmc_template.js";

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

test("off-brand fonts and no view templates are Shoulds; no title block at all is a Must", () => {
  const lines = auditTemplate(facts({ text_types: [{ name: "Generic 2.5", font: "Times New Roman" }], title_blocks: 0, view_templates: 0 }), kit, brand);
  assert.equal(lines.find((l) => l.area.startsWith("Fonts vs"))!.status, "1 off-brand");
  assert.equal(lines.find((l) => l.area === "Title blocks vs the Family Register")!.severity, "Must");
  assert.equal(lines.find((l) => l.area === "View templates and filters")!.severity, "Should");
});

test("without the kit's parameter file the check says so instead of guessing", () => {
  assert.equal(auditTemplate(facts(), null, null)[0].status, "Not checked");
});

// ---------- F-044 (issue #145): both ways, and never a Pass for what isn't checked ----------

const REF: TemplateRef = {
  projectParameters: ["FMC_Asset_Tag", "FMC_Keynote_Code", "FMC_Building_Class"],
  titleBlocks: [{ family: "FMC_TitleBlock", priority: "P1" }, { family: "FMC_TB_Panel_ProjectData", priority: "P1" }, { family: "FMC_TB_Panel_Approvals", priority: "P2" }],
  materials: ["FMC_Concrete_C25", "FMC_Brick_Clay"],
  legends: ["LG_Z_Abbreviations", "LG_Z_Symbols", "LG_Z_GeneralNotes"],
  panelTemplates: ["FMC_DB_SPN", "FMC_DB_TPN", "FMC_MDB_Switchboard", "FMC_Data_Panel"],
  schedules: ["00_Codes_Used", "A04_Windows"],
  viewTemplates: ["VT_A_FloorPlan", "VT_Z_SitePlan_Coordinates"],
  exists: (p) => !p.includes("missing"),
};
// The pilot's audit: Revit's stock title blocks, stock schedules and view templates, no FMC_ material, broken textures
const pilot = facts({
  title_block_families: ["A1 metric", "A0 metric"], schedule_names: ["00_Codes_Used", "Door Schedule"], view_template_names: ["VT_A_FloorPlan", "Architectural Plan"],
  legend_names: ["LG_Z_GeneralNotes"], panel_schedule_templates: ["Branch Panel"],
  materials: [
    { name: "Concrete, Cast-in-Place gray", used: true, textures: ["C:\\Textures\\missing\\Concrete.jpg"] },
    { name: "Default", used: false, textures: [] }, { name: "Default Wall", used: false, textures: [] },
    { name: "Glass", used: true, textures: ["1\\Mats\\missing.png"] },
  ],
});
const area = (lines: AuditLine[], a: string) => lines.find((l) => l.area === a || l.area.startsWith(a))!;

test("F-044: kit parameters missing from the template are listed (the check runs both ways)", () => {
  const l = area(auditTemplate(pilot, kit, brand, REF), "Kit parameters in the template");
  assert.equal(l.severity, "Must");
  assert.equal(l.status, "2 missing");
  assert.match(l.detail, /1 of 3 present; missing FMC_Keynote_Code, FMC_Building_Class/);
  const all = facts({ shared_parameters: [{ name: "FMC_Asset_Tag", guid: "aaaaaaaa-0000-0000-0000-000000000001" }, { name: "x", guid: "AAAAAAAA-0000-0000-0000-000000000002" }, { name: "FMC_Building_Class", guid: "z" }] });
  assert.equal(area(auditTemplate(all, kit, brand, REF), "Kit parameters in the template").severity, "Pass", "by GUID where the kit has it, else by name");
});

test("F-044: Revit's stock title blocks don't pass: the kit's FMC_TB_* must be loaded", () => {
  const l = area(auditTemplate(pilot, kit, brand, REF), "Title blocks vs the Family Register");
  assert.equal(l.severity, "Must");
  assert.match(l.detail, /missing FMC_TitleBlock \(P1\), FMC_TB_Panel_ProjectData \(P1\), FMC_TB_Panel_Approvals \(P2\); loaded instead: A1 metric, A0 metric/);
  const loaded = facts({ title_block_families: ["FMC_TitleBlock", "FMC_TB_Panel_ProjectData", "FMC_TB_Panel_Approvals"] });
  assert.equal(area(auditTemplate(loaded, kit, brand, REF), "Title blocks vs the Family Register").severity, "Pass");
  const p2Only = facts({ title_block_families: ["FMC_TitleBlock", "FMC_TB_Panel_ProjectData"] });
  assert.equal(area(auditTemplate(p2Only, kit, brand, REF), "Title blocks vs the Family Register").severity, "Should");
  // an older add-in reports only a count: Not checked, never Pass
  const old = area(auditTemplate(facts(), kit, brand, REF), "Title blocks vs the Family Register");
  assert.equal(old.status, "Not checked");
  assert.match(old.detail, /2 title block types, but their families aren't named/);
});

test("F-044: legends, panel schedule templates, stock schedules and view templates against the kit", () => {
  const lines = auditTemplate(pilot, kit, brand, REF);
  assert.match(area(lines, "Legends vs the sheet register").detail, /missing LG_Z_Abbreviations, LG_Z_Symbols/);
  assert.equal(area(lines, "Legends vs the sheet register").severity, "Should");
  assert.equal(area(lines, "Panel schedule templates vs the kit").status, "4 missing");
  assert.match(area(lines, "Schedules not from the kit").detail, /Door Schedule: stock Autodesk or hand-made schedules/);
  assert.equal(area(lines, "Schedules not from the kit").severity, "Should");
  assert.match(area(lines, "View templates not from the kit").detail, /Architectural Plan/);
});

test("F-044: materials: none from the kit, broken textures, unused, duplicates and Revit's defaults", () => {
  const lines = auditTemplate(pilot, kit, brand, REF);
  assert.equal(area(lines, "Materials: the kit's FMC_ materials").status, "None from the kit");
  assert.equal(area(lines, "Materials: texture paths").status, "2 broken");
  assert.equal(area(lines, "Materials: unused").status, "2 unused");
  assert.match(area(lines, "Materials: duplicates and Revit defaults").detail, /Default, Default Wall/);
  const good = facts({ materials: [{ name: "FMC_Concrete_C25", used: true, textures: ["D:\\Kit\\07_Materials\\Textures\\c.jpg"] }] });
  const g = auditTemplate(good, kit, brand, REF);
  assert.equal(area(g, "Materials: the kit's FMC_ materials").severity, "Pass");
  assert.equal(area(g, "Materials: texture paths").severity, "Pass");
});

test("F-044: fonts without a brand pack, and every kit source that can't be read, say Not checked with why", () => {
  const lines = auditTemplate(pilot, kit, null, { brandNote: "The kit has no font pack (K:\\06_Templates\\FMC_BrandPacks.json is missing or empty): fonts can't be checked; a kit change request",
    problems: { titleBlocks: "Not readable: K:\\03_Master_Data\\FMC_Family_Register.csv" } });
  const fonts = area(lines, "Fonts vs the brand pack");
  assert.equal(fonts.status, "Not checked");
  assert.match(fonts.detail, /no font pack/);
  assert.match(area(lines, "Title blocks vs the Family Register").detail, /Not readable: .*FMC_Family_Register\.csv/);
  // with no kit reference at all, none of the new lines passes
  const checks = ["Kit parameters", "Title blocks vs", "Legends vs", "Panel schedule", "Schedules not", "View templates not", "Fonts vs", "Materials: the kit", "Materials: texture"];
  for (const c of checks) assert.equal(area(auditTemplate(pilot, kit, null), c).status, "Not checked", c);
  // an older add-in without the names: Not checked, not Pass
  for (const c of ["Legends vs", "Panel schedule", "Schedules not", "View templates not", "Materials"]) assert.equal(area(auditTemplate(facts(), kit, brand, REF), c).status, "Not checked", c);
});

test("F-044: a role template that is a byte copy of Base is Advice: role settings not applied (KCR 28)", () => {
  const files = [
    { name: "FMC_Base_Template_v2.2.rte", hash: "aaa" }, { name: "FMC_A_Template_v2.2.rte", hash: "aaa" },
    { name: "FMC_E_Template_v2.2.rte", hash: "aaa" }, { name: "FMC_S_Template_v2.2.rte", hash: "bbb" }, { name: "FMC_A_Template_v2.1.rte", hash: "aaa" },
  ];
  const role = roleCopyLine("FMC_A_Template_v2.2.rte", files)!;
  assert.equal(role.severity, "Advice");
  assert.match(role.detail, /byte-for-byte copy of FMC_Base_Template_v2\.2\.rte: role settings not applied — kit has no role value tables, KCR 28/);
  assert.equal(roleCopyLine("FMC_S_Template_v2.2.rte", files)!.severity, "Pass");
  const base = roleCopyLine("FMC_Base_Template_v2.2.rte", files)!;
  assert.equal(base.status, "2 identical to Base");
  assert.match(base.detail, /FMC_A_Template_v2\.2\.rte, FMC_E_Template_v2\.2\.rte/);
  assert.equal(roleCopyLine("FMC_A_Template_v2.2.rte", files.slice(1))!.status, "Not checked");
  assert.equal(roleCopyLine("Client_Template.rte", files), null, "not a kit template: no line");
});

test("F-044: the audit's kit reference is read from the kit folder (legends per role, title blocks from the register)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-kit-"));
  const md = path.join(dir, "03_Master_Data");
  fs.mkdirSync(md);
  fs.writeFileSync(path.join(md, "FMC_Master_Data.json"), JSON.stringify({ params: { FMC_Asset_Tag: {}, FMC_Building_Class: {} } }));
  fs.writeFileSync(path.join(md, "FMC_Family_Register.csv"), [
    "Role,Family,Category,Template / basis,Host,Connectors,KeyParameters,Types,Priority,Why",
    'Z,FMC_TitleBlock,Title Blocks,Metric Title Block,-,-,"Group 01, 02","A0, A1, A3",P1,One title block',
    "Z,FMC_TB_KeyPlan,Generic Annotations (nested in title block),Metric Generic Annotation,-,-,Zones,Standard,P1,Key plan",
    "A,FMC_A_Door_X,Doors,Metric Door,-,-,Width,900x2100,P1,Doors",
  ].join("\n"));
  fs.writeFileSync(path.join(md, "FMC_Sheet_Register.csv"), [
    "Role,Discipline,SheetNumber,SheetName,Series,Scale,Core,IssueSet,Placed",
    'Z,General,Z-0003,"Common Symbols, Abbreviations",0xxx,NTS,Core,PERMIT+TENDER,LG_Z_Symbols; LG_Z_Abbreviations',
    "E,Electrical,E-0001,Legend,0xxx,NTS,Core,TENDER,LG_E_Lighting; LG_E_Power",
  ].join("\n"));
  const tpl = path.join(dir, "FMC_E_Template_v2.2.rte");
  fs.writeFileSync(tpl, "same");
  fs.writeFileSync(path.join(dir, "FMC_Base_Template_v2.2.rte"), "same");
  const cfg = { ...DEFAULT_CONFIG, materials_file: path.join(dir, "none.json") };
  const { ref, brand: b } = loadAuditRef(dir, cfg, tpl, null);
  assert.deepEqual(ref.projectParameters, ["FMC_Asset_Tag", "FMC_Building_Class"]);
  assert.deepEqual(ref.titleBlocks, [{ family: "FMC_TitleBlock", priority: "P1" }]);
  assert.deepEqual(ref.legends!.sort(), ["LG_E_Lighting", "LG_E_Power", "LG_Z_Abbreviations", "LG_Z_Symbols"]);
  assert.deepEqual(registerLegends([["Role", "Placed"], ["E", "LG_E_Lighting; LG_Z_Symbols"]], ""), ["LG_Z_Symbols"], "Base: the General legends");
  assert.equal(ref.materials, undefined);
  assert.match(ref.problems!.materials!, /Not readable/);
  assert.match(ref.problems!.panelTemplates!, /FMC_Revit_Kit\.xlsx/);
  assert.equal(b, null);
  assert.match(ref.brandNote!, /no font pack/);
  assert.equal(ref.roleCopy!.status, "Identical to Base");
});
