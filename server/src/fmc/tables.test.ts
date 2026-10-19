import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KIT_TABLES, blocking, cellValue, changeRequestMarkdown, compareTable, diffSummary, matchColumns, parameterTokens, parseCsv,
  parseKitTable, readAbout, aboutSheet, resolveTable, sameValue, sheetTable, tableSheet, writeKitTable,
} from "./tables.js";
import { readXlsxSheets, sheetNameProblem, writeXlsx } from "./xlsx.js";
import { readZip, writeZip } from "./zip.js";

const REGISTER = [
  "Role,Family,Category,KeyParameters,Priority",
  'Z,FMC_TitleBlock,Title Blocks,"FMC_TB_Brand_Main, FMC_SP_*",P1',
  'A,FMC_A_Door_Flush,Doors,"FMC_Fire_Resistance_Min",P2',
  "A,FMC_A_Window_Casement,Windows,,P2",
].join("\r\n") + "\r\n";

const MASTER = JSON.stringify({
  stamp: "test",
  params: {
    FMC_Project_Code: { guid: "g1", group: "FMC_01", binding: "Project Information", categories: ["OST_ProjectInformation"] },
    FMC_Fire_Resistance_Min: { guid: "g2", group: "FMC_05", binding: "Type", categories: ["OST_Doors"] },
  },
  deprecated_params: { FMC_Project_Name: "Built-in Project Name" },
  codes: {
    "B.200_00": { description: "200 mm block", unit: "m2", rate: 48000, waste: null },
    "B.150_00": { description: "150 mm block", unit: "m2", rate: null, waste: null },
  },
}, null, 1) + "\n";

const KIT_PARAMS = new Set(["FMC_Project_Code", "FMC_Fire_Resistance_Min", "FMC_TB_Brand_Main", "FMC_Project_Name"]);
const def = (id: string) => KIT_TABLES.find((d) => d.id === id)!;

test("CSV: quoted commas, doubled quotes and line breaks stay in one field; each record keeps its raw text", () => {
  const r = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\nlast,1');
  assert.deepEqual(r.map((x) => x.cells), [["a", "b"], ["x, y", 'say "hi"\nthere'], ["last", "1"]]);
  assert.equal(r[1].raw, '"x, y","say ""hi""\nthere"');
});

test("tables resolve by id or by file, and a file needs its key", () => {
  assert.equal(resolveTable("family_register").def?.file, "FMC_Family_Register.csv");
  assert.deepEqual(resolveTable("family_research").def?.key, ["Family", "Change"]);
  assert.equal(resolveTable("FMC_Master_Data.json#codes").def?.id, "codes");
  assert.match(resolveTable("FMC_Other.csv").problem!, /key column/);
  assert.deepEqual(resolveTable("FMC_Other.csv", "A+B").def?.key, ["A", "B"]);
  assert.match(resolveTable("FMC_Other.json", "A").problem!, /section/);
  assert.match(resolveTable("nope").problem!, /Unknown table/);
});

test("a kit table: CSV columns as text, JSON maps with the key as a column and typed fields", () => {
  const reg = parseKitTable(def("family_register"), REGISTER);
  assert.deepEqual(reg.columns, ["Role", "Family", "Category", "KeyParameters", "Priority"]);
  assert.equal(reg.rows.length, 3);
  assert.equal(reg.rows[0].row.KeyParameters, "FMC_TB_Brand_Main, FMC_SP_*");
  const codes = parseKitTable(def("codes"), MASTER);
  assert.deepEqual(codes.columns, ["Code", "description", "unit", "rate", "waste"]);
  assert.equal(codes.types.rate, "number");
  assert.equal(codes.types.waste, "any");
  assert.ok(codes.nullable.has("waste"));
  const dep = parseKitTable(def("deprecated_parameters"), MASTER);
  assert.deepEqual(dep.columns, ["Parameter", "Replaced_By"]);
  const params = parseKitTable(def("parameters"), MASTER);
  assert.equal(params.types.categories, "json");
});

test("the sheet's header is its first row with text; empty rows are skipped and rows count from 1", () => {
  const s = sheetTable([[], ["", ""], ["Family", "Role"], ["A", "Z"], ["", ""], ["B", "A"]]);
  assert.equal(s.headerRow, 3);
  assert.deepEqual(s.body.map((b) => b.row), [4, 6]);
});

test("columns match by name, case and spacing aside, or by the person's own map", () => {
  assert.deepEqual(matchColumns(["KeyParameters", "Family", "Template"], ["Key parameters", "family", "Template / basis"]), ["KeyParameters", "Family", null]);
  assert.deepEqual(matchColumns(["KeyParameters", "Family", "Template"], ["Template / basis"], { "Template / basis": "Template" }), ["Template"]);
});

test("values: empty is empty, numbers by value, Excel's line breaks, lists by content", () => {
  assert.ok(sameValue("", null));
  assert.ok(sameValue(undefined, ""));
  assert.ok(sameValue("1.10", "1.1"));
  assert.ok(sameValue(1.1, "1.1000000000000001"));
  assert.ok(sameValue("a\r\nb", "a\nb"));
  assert.ok(sameValue(["x"], ["x"]));
  assert.ok(!sameValue("P1", "P2"));
  assert.ok(!sameValue(0, ""));
});

test("cells take the column's type; one that doesn't fit is a problem", () => {
  assert.deepEqual(cellValue("48000", "number", false, 1, false), { value: 48000 });
  assert.match(cellValue("lots", "number", false, 1, false).problem!, /number/);
  assert.deepEqual(cellValue("yes", "boolean", false, false, false), { value: true });
  assert.deepEqual(cellValue('["OST_Doors"]', "json", false, [], false), { value: ["OST_Doors"] });
  assert.match(cellValue("OST_Doors", "json", false, [], false).problem!, /JSON/);
  assert.deepEqual(cellValue("", "number", false, 5, true), { value: null });
  assert.deepEqual(cellValue("12", "any", false, null, true), { value: 12 });
  assert.match(cellValue("abc", "number", true, "1", false).problem!, /number/);
});

test("parameter names in a cell skip wildcards and stems", () => {
  assert.deepEqual(parameterTokens("FMC_TB_Brand_Main / _Studio, FMC_SP_*, FMC_TB_"), ["FMC_TB_Brand_Main"]);
  assert.deepEqual(parameterTokens([{ name: "FMC_GFA_m2" }]), ["FMC_GFA_m2"]);
});

test("compare: added, removed and changed rows by key, cell by cell; untouched columns stay", () => {
  const kit = parseKitTable(def("family_register"), REGISTER);
  const sheet = [
    ["Role", "Family", "Category", "Key parameters", "Priority", "Comment"],
    ["Z", "FMC_TitleBlock", "Title Blocks", "FMC_TB_Brand_Main, FMC_SP_*", "P1", "ok"],
    ["A", "FMC_A_Door_Flush", "Doors", "FMC_Fire_Resistance_Min", "P1", ""],
    ["A", "FMC_A_Door_Sliding", "Doors", "", "P3", ""],
  ];
  const { diff, proposed, touched } = compareTable(kit, sheet, { kitParameters: KIT_PARAMS });
  assert.deepEqual(diff.added, [{ key: "FMC_A_Door_Sliding", row: 4 }]);
  assert.deepEqual(diff.removed, [{ key: "FMC_A_Window_Casement" }]);
  assert.deepEqual(diff.changed, [{ key: "FMC_A_Door_Flush", row: 3, cells: [{ column: "Priority", kit: "P2", workbook: "P1" }] }]);
  assert.equal(diff.unchanged, 1);
  assert.deepEqual(diff.workbook_only_columns, ["Comment"]);
  assert.deepEqual(diff.problems, []);
  assert.equal(diffSummary(diff), "1 added, 1 removed, 1 changed");
  assert.deepEqual(proposed.map((r) => r.key), ["FMC_TitleBlock", "FMC_A_Door_Flush", "FMC_A_Door_Sliding"]);
  // the proposed CSV: untouched records keep their exact text, the edited one is rewritten, the kit's line endings kept
  const out = writeKitTable(kit, proposed, REGISTER, touched);
  assert.equal(out, [
    "Role,Family,Category,KeyParameters,Priority",
    'Z,FMC_TitleBlock,Title Blocks,"FMC_TB_Brand_Main, FMC_SP_*",P1',
    "A,FMC_A_Door_Flush,Doors,FMC_Fire_Resistance_Min,P1",
    "A,FMC_A_Door_Sliding,Doors,,P3",
  ].join("\r\n") + "\r\n");
});

test("a CSV that mixes CRLF and LF keeps each untouched record's own line ending", () => {
  const mixed = "Family,Change,Evidence\r\nA,new,X\nB,ext,Y\r\nC,new,Z\n";
  const kit = parseKitTable(def("family_research"), mixed);
  const same = compareTable(kit, tableSheet(kit).map((r) => r.map((c) => String(c ?? ""))));
  assert.equal(writeKitTable(kit, same.proposed, mixed, same.touched), mixed);
  const edit = compareTable(kit, [["Family", "Change", "Evidence"], ["A", "new", "X"], ["B", "ext", "Y2"], ["C", "new", "Z"], ["D", "new", "W"]]);
  assert.equal(writeKitTable(kit, edit.proposed, mixed, edit.touched), "Family,Change,Evidence\r\nA,new,X\nB,ext,Y2\r\nC,new,Z\nD,new,W\r\n");
});

test("xlsx: character references (&#8211;) read as the character", () => {
  const buf = writeXlsx([{ name: "S", rows: [["x"]] }]);
  const parts = readZip(buf);
  parts.set("xl/sharedStrings.xml", Buffer.from(parts.get("xl/sharedStrings.xml")!.toString().replace(">x<", ">water &#8211; red &#x2014; &amp;#8211;<")));
  const back = readXlsxSheets(writeZip([...parts].map(([name, data]) => ({ name, data }))));
  assert.equal(back.get("S")![0][0], "water – red — &#8211;");
});

test("keep_removed keeps rows a filtered sheet doesn't have", () => {
  const kit = parseKitTable(def("family_register"), REGISTER);
  const { diff, proposed } = compareTable(kit, [["Family", "Priority"], ["FMC_A_Door_Flush", "P1"]], { keepRemoved: true });
  assert.equal(diff.removed.length, 0);
  assert.equal(proposed.length, 3);
  assert.equal(proposed[1].row.Category, "Doors"); // a column the sheet doesn't have stays
});

test("problems: duplicate and empty keys, a parameter that isn't a kit parameter, a missing key column", () => {
  const kit = parseKitTable(def("family_register"), REGISTER);
  const { diff } = compareTable(kit, [
    ["Family", "KeyParameters"],
    ["FMC_TitleBlock", "FMC_TB_Brand_Main, FMC_SP_*"],
    ["FMC_TitleBlock", "x"],
    ["", "y"],
    ["FMC_A_Door_Flush", "FMC_Fire_Resistance_Min, FMC_Made_Up"],
  ], { kitParameters: KIT_PARAMS, keepRemoved: true });
  assert.deepEqual(diff.problems.map((p) => p.kind), ["duplicate key", "empty key", "not a kit parameter"]);
  assert.match(diff.problems[0].detail, /rows 2 and 3/);
  assert.match(diff.problems[2].detail, /FMC_Made_Up isn't a kit parameter/);
  assert.equal(blocking(diff).length, 3);
  const none = compareTable(kit, [["Role", "Priority"], ["Z", "P1"]]);
  assert.equal(none.diff.problems[0].kind, "missing key column");
  assert.match(none.diff.notes.join(" "), /weren't checked/);
});

test("a bad type blocks a JSON table; in a CSV it is a warning", () => {
  const codes = parseKitTable(def("codes"), MASTER);
  const { diff } = compareTable(codes, [["Code", "Description", "Rate"], ["B.200_00", "200 mm block", "lots"], ["B.150_00", "150 mm block", "42000"]]);
  assert.equal(diff.problems.length, 1);
  assert.equal(diff.problems[0].kind, "bad type");
  assert.equal(diff.problems[0].blocking, true);
  assert.deepEqual(diff.changed, [{ key: "B.150_00", row: 3, cells: [{ column: "rate", kit: null, workbook: 42000 }] }]);
  const csv = parseKitTable(resolveTable("FMC_X.csv", "Name").def!, "Name,Size\r\na,10\r\nb,20\r\n");
  const w = compareTable(csv, [["Name", "Size"], ["a", "10"], ["b", "big"]]).diff;
  assert.equal(w.problems[0].blocking, false);
  assert.equal(w.changed.length, 1);
});

test("a new parameter row must be in the shared parameter file", () => {
  const params = parseKitTable(def("parameters"), MASTER);
  const sheet = [...tableSheet(params).map((r) => r.map((c) => c === null ? "" : String(c))), ["FMC_New_One", "g9", "FMC_05", "Type", '["OST_Doors"]']];
  const p = compareTable(params, sheet, { kitParameters: KIT_PARAMS, dictionary: new Set(["FMC_Project_Code"]) }).diff;
  assert.equal(p.added.length, 1);
  assert.match(p.problems.map((x) => x.detail).join(" "), /FMC_New_One isn't in the shared parameter file/);
  const ok = compareTable(params, sheet, { kitParameters: KIT_PARAMS, dictionary: new Set(["FMC_New_One"]) }).diff;
  assert.deepEqual(ok.problems, []);
});

test("JSON: the proposed file changes only the section, keeps the other sections, field order and indentation", () => {
  const codes = parseKitTable(def("codes"), MASTER);
  const sheet = tableSheet(codes).map((r) => r.map((c) => c === null ? "" : String(c)));
  sheet[1][3] = "50000";                                   // B.200_00 rate
  sheet.push(["C.300_00", "300 mm slab", "m3", "", ""]);   // a new code
  const { diff, proposed, touched } = compareTable(codes, sheet);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.added.length, 1);
  const out = writeKitTable(codes, proposed, MASTER, touched);
  const data = JSON.parse(out);
  assert.equal(data.codes["B.200_00"].rate, 50000);
  assert.deepEqual(Object.keys(data.codes["B.200_00"]), ["description", "unit", "rate", "waste"]);
  assert.deepEqual(data.codes["C.300_00"], { description: "300 mm slab", unit: "m3", rate: null, waste: null });
  assert.deepEqual(data.params, JSON.parse(MASTER).params);
  assert.equal(data.stamp, "test");
  assert.ok(out.startsWith('{\n "stamp"'));
  // nothing edited: the file comes back byte for byte
  const same = compareTable(codes, tableSheet(codes).map((r) => r.map((c) => c === null ? "" : String(c))));
  assert.equal(writeKitTable(codes, same.proposed, MASTER, same.touched), MASTER);
});

test("a plain-value map writes plain values back", () => {
  const dep = parseKitTable(def("deprecated_parameters"), MASTER);
  const { proposed, touched } = compareTable(dep, [["Parameter", "Replaced_By"], ["FMC_Project_Name", "Project Name (built-in)"]]);
  assert.deepEqual(JSON.parse(writeKitTable(dep, proposed, MASTER, touched)).deprecated_params, { FMC_Project_Name: "Project Name (built-in)" });
});

test("xlsx: what writeXlsx writes, readXlsxSheets reads back (text, numbers, booleans, XML characters, line breaks)", () => {
  const rows = [["Code", "Rate", "Note", "Ok"], ["B.200_00", 48000, 'a < b & "c"\nnext', true], ["B.150_00", 1.1, null, false]];
  const buf = writeXlsx([{ name: "codes", rows, header: true }, { name: "About", rows: [["table", "codes"]] }], new Date(2026, 9, 19));
  const parts = readZip(buf);
  assert.ok(parts.has("[Content_Types].xml") && parts.has("xl/sharedStrings.xml") && parts.has("xl/styles.xml"));
  assert.match(parts.get("xl/worksheets/sheet1.xml")!.toString(), /state="frozen".*autoFilter ref="A1:D3"/s);
  const back = readXlsxSheets(buf);
  assert.deepEqual([...back.keys()], ["codes", "About"]);
  assert.deepEqual(back.get("codes"), [["Code", "Rate", "Note", "Ok"], ["B.200_00", "48000", 'a < b & "c"\nnext', "1"], ["B.150_00", "1.1", "", "0"]]);
  assert.throws(() => writeXlsx([{ name: "a/b", rows: [] }]), /character/);
  assert.match(sheetNameProblem("x".repeat(32)), /31/);
});

test("xlsx: an empty <row/> doesn't swallow the next row, and row numbers can be kept", () => {
  const buf = writeXlsx([{ name: "S", rows: [["h"], [], ["x"]] }]);
  assert.deepEqual(readXlsxSheets(buf).get("S"), [["h"], [], ["x"]]);
  // Excel leaves empty rows out: with rowNumbers they come back as [], so rows[i] is row i + 1
  const parts = readZip(buf);
  const sheet = parts.get("xl/worksheets/sheet1.xml")!.toString();
  assert.match(sheet, /<row r="2"><\/row>/);
  parts.set("xl/worksheets/sheet1.xml", Buffer.from(sheet.replace(/<row r="2"><\/row>/, "").replace(/<row r="3">/, '<row r="4"/><row r="5">').replace(/r="A3"/, 'r="A5"')));
  const rezipped = writeZip([...parts].map(([name, data]) => ({ name, data })));
  assert.deepEqual(readXlsxSheets(rezipped).get("S"), [["h"], [], ["x"]]);
  assert.deepEqual(readXlsxSheets(rezipped, { rowNumbers: true }).get("S"), [["h"], [], [], [], ["x"]]);
});

test("export, edit in Excel, import: the round trip through an .xlsx, with the About sheet naming the table", () => {
  const kit = parseKitTable(def("family_register"), REGISTER);
  const buf = writeXlsx([{ name: "family_register", rows: tableSheet(kit), header: true },
    { name: "About", rows: aboutSheet(kit.def, "K:\\03_Master_Data\\FMC_Family_Register.csv", kit.rows.length, new Date()) }]);
  const sheets = readXlsxSheets(buf, { rowNumbers: true });
  assert.deepEqual(readAbout(sheets), { table: "family_register", key: "Family" });
  const rows = sheets.get("family_register")!;
  const untouched = compareTable(kit, rows);
  assert.equal(diffSummary(untouched.diff), "0 added, 0 removed, 0 changed");
  assert.equal(writeKitTable(kit, untouched.proposed, REGISTER, untouched.touched), REGISTER);
  rows[3][4] = "P1";
  assert.equal(compareTable(kit, rows).diff.changed[0].key, "FMC_A_Window_Casement");
});

test("the kit change request lists every change for the person who publishes", () => {
  const kit = parseKitTable(def("family_register"), REGISTER);
  const { diff } = compareTable(kit, [["Family", "Priority"], ["FMC_TitleBlock", "P1"], ["FMC_A_Door_Flush", "P1|P2"], ["FMC_New", "P3"]]);
  const md = changeRequestMarkdown({ id: "KCR-1", title: "Family register", kitFile: "K:\\a.csv", proposedFile: "S:\\a_proposed.csv",
    workbook: "S:\\a.xlsx", sheet: "family_register", by: "tester", at: new Date("2026-10-19T10:00:00Z"), reason: "new door" }, diff);
  assert.match(md, /^# Kit change request KCR-1: Family register/);
  assert.match(md, /1 added, 1 removed, 1 changed/);
  assert.match(md, /\| FMC_A_Door_Flush \| Priority \| P2 \| P1\\\|P2 \|/);
  assert.match(md, /## Removed\r\n\r\n- FMC_A_Window_Casement/);
  assert.match(md, /a person, not a tool/);
});

test("fmc_tables: export and import write only to staging, never the kit; the import records a kit change request", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-tables-"));
  const kit = path.join(dir, "Kit");
  const master = path.join(kit, "03_Master_Data");
  fs.mkdirSync(master, { recursive: true });
  fs.mkdirSync(path.join(kit, "01_Shared_Parameters"), { recursive: true });
  fs.writeFileSync(path.join(master, "FMC_Family_Register.csv"), REGISTER);
  fs.writeFileSync(path.join(master, "FMC_Master_Data.json"), MASTER);
  fs.writeFileSync(path.join(kit, "01_Shared_Parameters", "FMC_SharedParameters.txt"),
    "*META\tVERSION\tMINVERSION\nMETA\t2\t1\n*GROUP\tID\tNAME\nGROUP\t1\tG\n*PARAM\tGUID\tNAME\tDATATYPE\tDATACATEGORY\tGROUP\tVISIBLE\nPARAM\tg\tFMC_TB_Brand_Main\tTEXT\t\t1\t1\n");
  const staging = path.join(kit, "_Staging", "Tables");
  const guard = path.join(dir, "fmc_guard.json");
  // a careless guard that would allow the kit's own folder: the tool still refuses 03_Master_Data
  fs.writeFileSync(guard, JSON.stringify({ write_roots: [staging, master], reports_dir: path.join(dir, "reports"),
    specs_path: path.join(master, "FMC_Family_Specs.json"), shared_parameter_file: path.join(kit, "01_Shared_Parameters", "FMC_SharedParameters.txt") }));
  const old = process.env.FMC_GUARD_CONFIG;
  process.env.FMC_GUARD_CONFIG = guard;
  try {
    const { runFmcTables, FMC_TABLES_SHAPE } = await import("../tools/fmc_tables.js");
    const { z } = await import("zod");
    const call = async (a: object) => { const r = await runFmcTables(z.object(FMC_TABLES_SHAPE).parse(a)); return { body: JSON.parse(r.content[0].text), isError: r.isError }; };

    const list = await call({ action: "tables" });
    assert.ok(list.body.tables.find((t: any) => t.table === "family_register").readable);

    const dry = await call({ action: "export", table: "family_register" });
    assert.equal(dry.body.dry_run, true);
    assert.ok(!fs.existsSync(staging));
    const into = await call({ action: "export", table: "family_register", out_folder: master, dry_run: false });
    assert.equal(into.isError, true);
    assert.match(into.body.reasons.join(" "), /Never into the kit's 03_Master_Data/);
    const ex = await call({ action: "export", table: "family_register", dry_run: false });
    assert.equal(ex.body.done, true);
    const wbFile = ex.body.written as string;
    assert.ok(wbFile.startsWith(staging));

    // a person edits the workbook in Excel
    const sheets = readXlsxSheets(fs.readFileSync(wbFile));
    const rows = sheets.get("family_register")!;
    rows[2][4] = "P1";
    rows.push(["A", "FMC_A_Door_New", "Doors", "FMC_Not_In_Kit", "P3"]);
    const edited = path.join(staging, "FMC_Table_family_register.xlsx");
    fs.writeFileSync(edited, writeXlsx([{ name: "family_register", rows, header: true }, { name: "About", rows: sheets.get("About")! }]));

    const cmp = await call({ action: "compare", workbook: edited, table: "family_register" });
    assert.equal(cmp.body.summary, "1 added, 0 removed, 1 changed; 1 problem (1 to fix)");

    const imp = await call({ action: "import", workbook: edited });  // the table comes from the About sheet
    assert.equal(imp.body.dry_run, true);
    assert.ok(imp.body.blocked_by[0].includes("FMC_Not_In_Kit"));
    const refused = await call({ action: "import", workbook: edited, dry_run: false });
    assert.equal(refused.isError, true);

    rows[rows.length - 1][3] = "FMC_TB_Brand_Main";
    fs.writeFileSync(edited, writeXlsx([{ name: "family_register", rows, header: true }, { name: "About", rows: sheets.get("About")! }]));
    const pending = await call({ action: "pending" });
    assert.equal(pending.body.workbooks, 1);
    assert.equal(pending.body.results[0].ready, true);

    const done = await call({ action: "import", workbook: edited, dry_run: false, reason: "new door" });
    assert.equal(done.body.done, true, JSON.stringify(done.body));
    assert.ok(done.body.proposed.startsWith(staging));
    assert.match(fs.readFileSync(done.body.proposed, "utf8"), /FMC_A_Door_New/);
    assert.match(fs.readFileSync(done.body.request_file, "utf8"), /Kit change request KCR-/);
    assert.match(fs.readFileSync(path.join(dir, "reports", "FMC_Kit_Change_Requests.csv"), "utf8"), /family_register.*new door,requested/);
    // the kit's own file is untouched
    assert.equal(fs.readFileSync(path.join(master, "FMC_Family_Register.csv"), "utf8"), REGISTER);
    assert.match(fs.readFileSync(path.join(dir, "reports", "FMC_MCP_FileLog.csv"), "utf8"), /tables_import/);
  } finally {
    if (old === undefined) delete process.env.FMC_GUARD_CONFIG; else process.env.FMC_GUARD_CONFIG = old;
  }
});
