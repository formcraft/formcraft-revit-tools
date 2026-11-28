import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ScannedFamily, categoryTokens, checkFamily, decodeKeynoteFile, keynoteTableWarnings, nameOk, nextKeynoteCode, parseKeynotes, searchKeynotes, standardName, summarise,
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

test("F-039: a spec that names no kit parameter never passes as '0 present'", () => {
  const empty = new Map([["FMC_E_ElecFixture_SocketDouble", spec("FMC_E_ElecFixture_SocketDouble", "Electrical Fixtures", ["Not_In_Kit"])]]);
  const c = checkFamily(fam(), empty, kit).checks.find((x) => x.check === "Required FMC parameters present (by GUID)")!;
  assert.equal(c.state, "fail");
  assert.match(c.detail, /^0 required: .*Not_In_Kit.*kit change request; the file carries 2 shared parameters/);
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

test("a keynote table with LF line endings warns, and a short load warns when the file has many lines", () => {
  const lf = "A\tArchitectural\t\nB\tBlockwork\t\nC\tConcrete\t\nD\tDoors\t\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(keynoteTableWarnings(crlf).length, 0);
  assert.equal(keynoteTableWarnings(crlf, 4).length, 0);
  assert.match(keynoteTableWarnings(lf).join("\n"), /LF line endings/);
  assert.match(keynoteTableWarnings(lf, 1).join("\n"), /loaded 1 keynote entry from a file with 4 lines/);
  assert.equal(keynoteTableWarnings("A\tArchitectural\t\n").length, 0);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(crlf, "utf16le")]);
  assert.equal(keynoteTableWarnings(decodeKeynoteFile(utf16)).length, 0);
  assert.equal(parseKeynotes(decodeKeynoteFile(utf16)).length, 4);
});

test("research 55: vendor class, not-set-up library, scan scope line, keynote_request dry run", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { z } = await import("zod");
  const lib = await import("./library.js");
  const tool = await import("../tools/fmc_library.js");
  assert.equal(lib.familyOrigin("FMC_E_Socket_Double"), "fmc");
  assert.equal(lib.familyOrigin("A1 metric"), "vendor");
  const fam = (name: string) => lib.checkFamily({ name, category: "Furniture", types: [{ name: "600_Std", keynote: "A.1" }], shared_guids: [] }, new Map(), new Map());
  const verdicts = [fam("FMC_A_Furn_Desk"), fam("Baluster - Square"), fam("Area Tag")];
  assert.equal(verdicts[1].origin, "vendor");
  const summary = lib.summarise(verdicts);
  assert.equal(summary.fmc, 1);
  assert.equal(summary.vendor, 2);
  const scoped = tool.scopeScan(verdicts, "fmc_only");
  assert.equal(scoped.kept.length, 1);
  assert.match(scoped.line, /^3 families; 1 are FMC families, 0 of them compliant; 2 are stock or vendor families/);
  const none = tool.libraryNotSetUp({ folder: "Z:\\k\\05_Scripts\\library", index: "Z:\\k\\05_Scripts\\library\\index.json", entries: [], problems: ["Can't read ...: ENOENT"] }, () => false);
  assert.equal(none?.status, "NOT_SET_UP");
  assert.equal(none?.code, "FMC-LIBRARY-NOT-SET-UP");
  assert.doesNotMatch(none?.message ?? "", /ENOENT/);
  assert.equal(tool.libraryNotSetUp({ folder: "f", index: "f\\index.json", entries: [], problems: [] }, () => true), null);
  const sample = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "data", "library", "index.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(sample, "utf8")).scripts, []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib55-"));
  const guardFile = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(guardFile, JSON.stringify({ reports_dir: dir, keynote_file: path.join(dir, "none.txt") }));
  const before = process.env.FMC_GUARD_CONFIG;
  process.env.FMC_GUARD_CONFIG = guardFile;
  try {
    const out = JSON.parse((await tool.runFmcLibrary(z.object(tool.FMC_LIBRARY_SHAPE).parse({ action: "keynote_request", group: "E.SOC", text: "Socket, double" }))).content[0].text);
    assert.equal(out.dry_run, true);
    assert.equal(out.same_text_requested, 0);
    assert.equal(fs.existsSync(path.join(dir, "FMC_Keynote_Requests.csv")), false);
  } finally {
    if (before === undefined) delete process.env.FMC_GUARD_CONFIG; else process.env.FMC_GUARD_CONFIG = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
