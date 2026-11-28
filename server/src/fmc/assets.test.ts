import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { ASSETS_PROVISIONAL_NOTE, COLUMNS, SAMPLE_ASSETS_SPEC, assetsStatus, buildRegister, componentName, loadAssetsSpec, sheetCsv, typeName, type AssetsRead } from "./assets.js";
import { FMC_ASSETS_SHAPE, runFmcAssets, type FmcAssetsArgs } from "../tools/fmc_assets.js";

function args(partial: Record<string, unknown>): FmcAssetsArgs {
  return z.object(FMC_ASSETS_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

function fixture(extra: Partial<AssetsRead> = {}): AssetsRead {
  return {
    title: "SAMPLE-FMC-ZZ-ZZ-M3-M-0001", path: "C:\\Fixtures\\sample.rvt", is_family: false,
    facility: { project_name: "Sample Clinic", project_number: "F00001", building_name: "Block A", client_name: "Client", address: "Nairobi", status: "S4", site_name: "Nairobi", unique_id: "pi-1" },
    spaces: [
      { id: "11", unique_id: "r-11", kind: "room", number: "1.01", name: "Plant Room", level: "L1", area_m2: 24.456, placed: true, department: "Services" },
      { id: "12", unique_id: "r-12", kind: "room", number: "1.02", name: "Unplaced", level: "L1", area_m2: 0, placed: false },
      { id: "13", unique_id: "s-13", kind: "space", number: "S1.01", name: "Plant Space", level: "L1", area_m2: 24.4, placed: true },
    ],
    types: [
      { id: "500", unique_id: "t-500", category: "OST_MechanicalEquipment", family: "AHU", type: "AHU-01", manufacturer: "Acme", model: "X200", description: "Air handler", type_mark: "AHU", assembly_code: "D3040", omniclass: "23.75.10", values: { "Warranty Duration": "2 years", "Expected Life": "20" }, count: 2 },
      { id: "600", unique_id: "t-600", category: "OST_LightingFixtures", family: "Downlight", type: "DL-10W", manufacturer: "", model: "", count: 1 },
    ],
    components: [
      { id: "1001", unique_id: "c-1001", category: "OST_MechanicalEquipment", category_name: "Mechanical Equipment", type_id: "500", family: "AHU", type: "AHU-01", level: "L1", mark: "AHU-1", space: "1.01", values: { "Serial Number": "SN-1", "Installation Date": "2026-10-01" } },
      { id: "1002", unique_id: "c-1002", category: "OST_MechanicalEquipment", category_name: "Mechanical Equipment", type_id: "500", family: "AHU", type: "AHU-01", level: "L1", mark: "AHU-1", space: "1.01" },
      { id: "1003", unique_id: "c-1003", category: "OST_LightingFixtures", category_name: "Lighting Fixtures", type_id: "600", family: "Downlight", type: "DL-10W", level: "L1", mark: "", space: "" },
    ],
    systems: [{ id: "900", unique_id: "sys-900", name: "SA 1", classification: "Supply Air", system_type: "Supply Air", element_ids: ["1001", "1002", "77"] }],
    unknown_categories: [], truncated: false, ...extra,
  };
}

test("the register has the five COBie-style sheets with their column names", () => {
  const reg = buildRegister(fixture(), SAMPLE_ASSETS_SPEC);
  assert.deepEqual(Object.keys(reg.sheets), ["Facility", "Space", "Type", "Component", "System"]);
  assert.deepEqual(reg.counts, { Facility: 1, Space: 2, Type: 2, Component: 3, System: 1 });
  const f = reg.sheets.Facility[0];
  assert.equal(f.Name, "Block A");
  assert.equal(f.AreaUnits, "squaremeters");
  assert.equal(reg.sheets.Space[0].GrossArea, 24.46);
  assert.equal(reg.sheets.Space[1].Category, "MEP Space");
  const t = reg.sheets.Type[0];
  assert.equal(t.Name, "AHU: AHU-01");
  assert.equal(t.Manufacturer, "Acme");
  assert.equal(t.ModelNumber, "X200");
  assert.equal(t.WarrantyDurationParts, "2 years");
  assert.equal(t.Category, "23.75.10", "OmniClass is the COBie category when there is one");
  const c = reg.sheets.Component[0];
  assert.equal(c.TypeName, "AHU: AHU-01");
  assert.equal(c.SerialNumber, "SN-1");
  assert.equal(c.Space, "1.01");
  assert.equal(reg.sheets.Component[2].Name, "Downlight: DL-10W-1003", "no Mark: Type Name-id");
  assert.equal(reg.sheets.System[0].ComponentNames, "AHU-1", "members outside the register are left out and names are unique");
  for (const k of Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>) for (const row of reg.sheets[k]) for (const col of Object.keys(row)) assert.ok(COLUMNS[k].includes(col), `${k}.${col}`);
});

test("gaps: a component in no space, types without Manufacturer or ModelNumber, duplicate names, unplaced rooms", () => {
  const reg = buildRegister(fixture(), SAMPLE_ASSETS_SPEC);
  assert.deepEqual(reg.gap_counts, { "FMC-ASSETS-TYPE-VALUE": 2, "FMC-ASSETS-NO-SPACE": 1, "FMC-ASSETS-DUPLICATE-NAME": 1 });
  assert.ok(reg.gaps.some((g) => g.detail === "Downlight: DL-10W: Manufacturer"));
  assert.ok(reg.gaps.some((g) => g.code === "FMC-ASSETS-DUPLICATE-NAME" && /AHU-1 x2/.test(g.detail ?? "")));
  assert.ok(reg.warnings.some((w) => w.code === "FMC-ASSETS-SPACE-UNPLACED" && /1\.02/.test(w.detail ?? "")));
  assert.equal(typeName("", ""), "(no type)");
  assert.equal(componentName({ id: "5", mark: " M-5 " }), "M-5");
});

test("status: PROVISIONAL without a kit spec, GAPS with gaps or a cut read, READY only on a clean kit read; never PASS", () => {
  const clean = fixture({
    types: [{ id: "500", family: "AHU", type: "AHU-01", manufacturer: "Acme", model: "X200", count: 1 }],
    components: [{ id: "1001", type_id: "500", family: "AHU", type: "AHU-01", mark: "AHU-1", space: "1.01" }],
  });
  const reg = buildRegister(clean, SAMPLE_ASSETS_SPEC);
  assert.equal(reg.gaps.length, 0);
  assert.equal(assetsStatus(reg, true), "PROVISIONAL");
  assert.equal(assetsStatus(reg, false), "READY");
  assert.equal(assetsStatus(buildRegister({ ...clean, truncated: true }, SAMPLE_ASSETS_SPEC), false), "GAPS");
  assert.equal(assetsStatus(buildRegister(fixture(), SAMPLE_ASSETS_SPEC), false), "GAPS");
});

test("the spec: built-in sample is PROVISIONAL; a kit file is not unless it says so; bad JSON is refused", () => {
  const sample = loadAssetsSpec({ kitRoot: "", read: () => { throw new Error("missing"); } });
  assert.equal(sample.source, "sample");
  assert.equal(sample.provisional, true);
  const kit = loadAssetsSpec({ kitRoot: "K:\\Kit", read: (f) => { assert.match(f, /03_Master_Data\\FMC_Assets\.json$/); return JSON.stringify({ categories: ["OST_Doors"], required_type_fields: ["Manufacturer"] }); } });
  assert.equal(kit.source, "kit");
  assert.equal(kit.provisional, false);
  assert.deepEqual(kit.spec.categories, ["OST_Doors"]);
  assert.ok(kit.spec.component_parameters, "unset fields fall back to the sample");
  assert.equal(loadAssetsSpec({ kitRoot: "K:\\Kit", read: () => JSON.stringify({ status: "PROVISIONAL" }) }).provisional, true);
  assert.throws(() => loadAssetsSpec({ kitRoot: "K:\\Kit", read: () => "{not json" }), /FMC-ASSETS-SPEC/);
});

test("CSV output quotes commas and quotes and keeps the header", () => {
  const reg = buildRegister(fixture({ spaces: [{ id: "1", number: "1.01", name: "Ward, \"A\"", level: "L1", area_m2: 10, placed: true }] }), SAMPLE_ASSETS_SPEC);
  const csv = sheetCsv(reg, "Space");
  const lines = csv.split(/\r?\n/).filter(Boolean);
  assert.equal(lines[0], COLUMNS.Space.join(","));
  assert.match(lines[1], /"Ward, ""A"""/);
});

test("fmc_assets is read only: inline sheets, nothing written, PROVISIONAL note, row cap, sheet filter and csv", async () => {
  let sent: Record<string, unknown> = {};
  const res = textOf(await runFmcAssets(args({ document: "SAMPLE", sheets: ["type", "Component"], max_rows: 2 }), { read: async (b) => { sent = b; return fixture(); }, kitRoot: "" }));
  assert.equal(res.isError, false);
  assert.equal(res.read_only, true);
  assert.equal(res.written, false);
  assert.equal(res.model_changed, false);
  assert.equal(res.status, "PROVISIONAL");
  assert.equal(res.can_pass, false);
  assert.equal(res.provisional_note, ASSETS_PROVISIONAL_NOTE);
  assert.deepEqual(Object.keys(res.sheets), ["Type", "Component"]);
  assert.equal(res.sheets.Component.length, 2);
  assert.equal(res.counts.Component, 3);
  assert.equal(res.rows_cut.Component, true);
  assert.equal(res.rows_cut.Type, false);
  assert.deepEqual(sent.categories, SAMPLE_ASSETS_SPEC.categories);
  assert.ok((sent.component_parameters as string[]).includes("Serial Number"));
  assert.equal(sent.document, "SAMPLE");
  const csv = textOf(await runFmcAssets(args({ document: "SAMPLE", sheets: ["System"], format: "csv" }), { read: async () => fixture(), kitRoot: "" }));
  assert.equal(typeof csv.sheets.System, "string");
  assert.match(csv.sheets.System, /^Name,Category,ComponentNames/);
  const noValue = JSON.stringify(res);
  assert.doesNotMatch(noValue, /"status":"PASS"/);
});

test("refusals: no document, an unknown sheet, a family document, a refused read, a bad spec file", async () => {
  assert.equal(textOf(await runFmcAssets(args({}), { read: async () => fixture(), kitRoot: "" })).code, "FMC-DOC-REQUIRED");
  assert.equal(textOf(await runFmcAssets(args({ document: "X", sheets: ["Zone"] }), { read: async () => fixture(), kitRoot: "" })).code, "FMC-ASSETS-SHEET");
  assert.equal(textOf(await runFmcAssets(args({ document: "X" }), { read: async () => ({ ...fixture(), is_family: true }), kitRoot: "" })).code, "FMC-ASSETS-FAMILY");
  const refused = textOf(await runFmcAssets(args({ document: "X" }), { read: async () => ({ refused: true, code: "FMC-DOC-NOT-OPEN", message: "not open" }), kitRoot: "" }));
  assert.equal(refused.code, "FMC-DOC-NOT-OPEN");
  assert.equal(refused.isError, true);
  assert.equal(textOf(await runFmcAssets(args({ document: "X", spec: "C:\\nope\\FMC_Assets.json" }), { read: async () => fixture(), kitRoot: "", specText: "{bad" })).code, "FMC-ASSETS-SPEC");
});

test("the assets read is a read, and it is in command.json", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_assets_read"));
  assert.ok(!WRITE_COMMANDS.has("fmc_assets_read"));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.ok(manifest.commands.some((row) => row.commandName === "fmc_assets_read"));
});
