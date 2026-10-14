import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ScannedFamily, categoryTokens, checkFamily, nameOk, nextKeynoteCode, parseKeynotes, searchKeynotes, standardName, summarise,
} from "./library.js";
import { FamilySpec, parseSharedParameters } from "./specs.js";

const kit = parseSharedParameters([
  "*GROUP\tID\tNAME", "GROUP\t1\tAsset", "*PARAM\tGUID\tNAME\tDATATYPE\tDATACATEGORY\tGROUP\tVISIBLE",
  "PARAM\taaaaaaaa-0000-0000-0000-000000000001\tFMC_Asset_Tag\tTEXT\t\t1\t1",
  "PARAM\taaaaaaaa-0000-0000-0000-000000000002\tFMC_Mounting_Height_mm\tLENGTH\t\t1\t1",
].join("\n"));

const spec = (family: string, category: string, params: string[]): FamilySpec => ({
  family, role: family.split("_")[1], category, base_category: category, template: "", template_file: null, host: "", priority: "P1",
  types: [], connectors: null, packs: [], family_parameters: [], open_item: "",
  shared_parameters: params.map((name) => ({ name, binding: "Type", guid: null })),
});
const specs = [spec("FMC_E_ElecFixture_SocketDouble", "Electrical Fixtures", ["FMC_Asset_Tag", "FMC_Mounting_Height_mm"])];
const specMap = new Map(specs.map((s) => [s.family, s]));

const fam = (o: Partial<ScannedFamily> = {}): ScannedFamily => ({
  name: "FMC_E_ElecFixture_SocketDouble", category: "Electrical Fixtures",
  types: [{ name: "13A_Twin", keynote: "E.SOC_00" }],
  shared_guids: ["AAAAAAAA-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002"], ...o,
});

test("names: library FMC_[Role]_[Token]_[Desc] and project families (D4) pass", () => {
  assert.ok(nameOk("FMC_E_ElecFixture_SocketDouble"));
  assert.ok(nameOk("F26001_E_ElecFixture_Isolator"));
  assert.ok(!nameOk("Vendor_Socket_MK"));
  assert.ok(!nameOk("FMC_Q9_ElecFixture_X"));
});

test("a family that meets its spec is compliant with 100", () => {
  const v = checkFamily(fam(), specMap, kit);
  assert.equal(v.state, "Compliant");
  assert.equal(v.score, 100);
});

test("missing parameters and keynotes are fixable", () => {
  const v = checkFamily(fam({ shared_guids: [], types: [{ name: "13A_Twin", keynote: "" }] }), specMap, kit);
  assert.equal(v.state, "Fixable");
  assert.match(v.checks[1].detail, /Missing 2/);
  assert.equal(v.score, 50);
});

test("bad type names, CAD or a family with no spec need a person", () => {
  assert.equal(checkFamily(fam({ types: [{ name: "Type 1", keynote: "E" }] }), specMap, kit).state, "Needs a person");
  assert.equal(checkFamily(fam({ size_mb: 3.2, imported_cad: 1 }), specMap, kit).state, "Needs a person");
  assert.equal(checkFamily(fam({ name: "Vendor_Socket_MK" }), specMap, kit).state, "Needs a person");
});

test("the summary counts states and failures per check", () => {
  const s = summarise([checkFamily(fam(), specMap, kit), checkFamily(fam({ shared_guids: [] }), specMap, kit)]);
  assert.deepEqual([s.scanned, s.compliant, s.fixable, s.need_a_person], [2, 1, 1, 0]);
  assert.equal(s.by_check[1].fail, 1);
});

test("the standard name uses the kit's own token for the category", () => {
  assert.equal(categoryTokens(specs).get("Electrical Fixtures"), "ElecFixture");
  assert.equal(standardName("e", "ElecFixture", "socket mk"), "FMC_E_ElecFixture_SocketMk");
});

test("keynotes: parse, search and the next free code in a group", () => {
  const all = parseKeynotes("E.SOC\tSocket outlets\t\nE.SOC_00\t13 A twin switched socket outlet\tE.SOC\nE.SOC_03\t15 A industrial socket\tE.SOC\n");
  assert.equal(all.length, 3);
  assert.deepEqual(searchKeynotes(all, "twin").map((k) => k.code), ["E.SOC_00"]);
  assert.equal(nextKeynoteCode(all, "E.SOC"), "E.SOC_04");
  assert.equal(nextKeynoteCode(all, "E.LED"), "E.LED_00");
});
