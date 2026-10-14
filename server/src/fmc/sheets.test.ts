import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { ModelSheet, compare, completeness, numberOk, parseRegister, planned } from "./sheets.js";
import { readXlsx } from "./xlsx.js";
import { csvRow } from "../tools/fmc_sheets.js";

const rows = [
  ["FMC Sheet Register", "", "", ""],
  ["Number", "Name", "Role", "Issue sets"],
  ["Z-0001", "Cover and index", "Z", "PERMIT; TENDER"],
  ["A-1001", "Ground floor plan", "A", "PERMIT"],
  ["A-1002", "First floor plan", "A", "PERMIT, TENDER"],
  ["S-1001", "Foundation plan", "S", ""],
  ["A-1001", "Duplicate", "A", "PERMIT"],
];

test("the register reads by header, skips a title row and reports duplicates", () => {
  const r = parseRegister(rows);
  assert.equal(r.sheets.length, 4);
  assert.deepEqual(r.sheets[0].sets, ["PERMIT", "TENDER"]);
  assert.match(r.problems[0], /A-1001 is in the register twice/);
});

test("planned: the issue set and roles pick the sheets; no sets means every set", () => {
  const reg = parseRegister(rows).sheets;
  assert.deepEqual(planned(reg, "tender", ["A", "S"]).map((s) => s.number), ["A-1002", "S-1001"]);
  assert.deepEqual(planned(reg, "PERMIT", []).map((s) => s.number), ["Z-0001", "A-1001", "A-1002", "S-1001"]);
});

test("compare: missing, extra and names that differ", () => {
  const plan = planned(parseRegister(rows).sheets, "PERMIT", ["A", "S"]);
  const model: ModelSheet[] = [
    { id: 1, number: "A-1001", name: "Ground floor plan", views: 2, fields: { "Drawn By": "AB", "Checked By": "" } },
    { id: 2, number: "A-9001", name: "Old option B", views: 1, fields: {} },
    { id: 3, number: "S-1001", name: "Foundations", views: 0, fields: { "Drawn By": "" } },
  ];
  assert.deepEqual(compare(plan, model, ["A", "S"]).map((d) => `${d.number} ${d.difference}`), ["A-1002 Missing", "A-9001 Extra", "S-1001 Name differs"]);
  assert.deepEqual(completeness(plan, model).map((c) => `${c.number} ${c.status} ${c.percent}`), ["A-1001 In work 75", "A-1002 Due 0", "S-1001 Due 0"]);
});

test("sheet numbers follow [Role]-[Series][Number]", () => {
  assert.ok(numberOk("A-1001"));
  assert.ok(numberOk("FP-2003"));
  assert.ok(!numberOk("A1001"));
});

test("csv fields keep quoted commas", () => {
  assert.deepEqual(csvRow('A-1001,"Plan, ground",A'), ["A-1001", "Plan, ground", "A"]);
});

/** A minimal .xlsx (stored and deflated entries) is read like Excel's. */
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = zlib.deflateRawSync(Buffer.from(content));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20);
    c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    parts.push(local, n, data); central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

test("xlsx: shared strings, inline strings, numbers and gaps", () => {
  const buf = zip({
    "xl/sharedStrings.xml": "<sst><si><t>Number</t></si><si><t>Name</t></si><si><t>A-1001</t></si><si><r><t>Plan &amp; </t></r><r><t>key</t></r></si></sst>",
    "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></row>" +
      "<row r=\"2\"><c r=\"A2\" t=\"s\"><v>2</v></c><c r=\"C2\" t=\"s\"><v>3</v></c><c r=\"D2\"><v>12</v></c></row>" +
      "<row r=\"3\"><c r=\"A3\" t=\"inlineStr\"><is><t>S-1001</t></is></c></row></sheetData></worksheet>",
  });
  assert.deepEqual(readXlsx(buf), [["Number", "Name"], ["A-1001", "", "Plan & key", "12"], ["S-1001"]]);
});
