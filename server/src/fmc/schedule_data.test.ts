import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { readXlsxSheets } from "./xlsx.js";
import { applyList, diffEdits, editsFromCsv, fieldEditable, projectRootOf, tableOf, toCsv, type SchedRead } from "./schedule_data.js";
import { FMC_SCHEDULE_DATA_SHAPE, runFmcScheduleData, type FmcScheduleDataArgs } from "../tools/fmc_schedule_data.js";

const root = new URL("../../../", import.meta.url);
const args = (p: Record<string, unknown>): FmcScheduleDataArgs => z.object(FMC_SCHEDULE_DATA_SHAPE).parse(p);
const out = (r: { content: Array<{ text: string }>; isError?: boolean }) => ({ ...JSON.parse(r.content[0].text), isError: r.isError === true });

const doors: SchedRead = {
  schedule: "A10_Door_Schedule", schedule_id: "900", is_key: false,
  fields: [
    { name: "Mark", kind: "parameter", builtin: "ALL_MODEL_MARK" },
    { name: "Comments", kind: "parameter", builtin: "ALL_MODEL_INSTANCE_COMMENTS" },
    { name: "Type Mark", kind: "parameter", builtin: "ALL_MODEL_TYPE_MARK", type_param: true },
    { name: "Width", kind: "parameter", builtin: "DOOR_WIDTH", type_param: true },
    { name: "Area x2", kind: "calculated" },
    { name: "Level", kind: "parameter", builtin: "FAMILY_LEVEL_PARAM", read_only: true },
    { name: "Count", kind: "count" },
  ],
  rows: [
    { id: "101", type_id: "7", values: { Mark: "D01", Comments: "", "Type Mark": "T1", Width: "900", "Area x2": "3.6", Level: "L1", Count: "1" } },
    { id: "102", type_id: "7", values: { Mark: "D02", Comments: "fire", "Type Mark": "T1", Width: "900", "Area x2": "3.6", Level: "L1", Count: "1" } },
    { id: "103", type_id: "8", values: { Mark: "D03", Comments: "", "Type Mark": "T2", Width: "1000", "Area x2": "4", Level: "L2", Count: "1" }, checkout: "owned_by_other", owner: "jane" },
  ],
};

const keySched: SchedRead = {
  schedule: "Room Style Key", schedule_id: "950", is_key: true,
  fields: [{ name: "Key Name", kind: "parameter" }, { name: "Floor Finish", kind: "parameter" }, { name: "Cost", kind: "formula" }],
  rows: [{ id: "500", values: { "Key Name": "Wet", "Floor Finish": "Tile", Cost: "10" } }],
};

test("schedule_data: what can be written", () => {
  assert.equal(fieldEditable(doors.fields[0], false).ok, true);
  assert.equal(fieldEditable(doors.fields[1], false).ok, true);
  assert.match(fieldEditable(doors.fields[3], false).reason!, /only marks, comments and key-schedule values/);
  assert.match(fieldEditable(doors.fields[4], false).reason!, /calculated field/);
  assert.match(fieldEditable(doors.fields[5], false).reason!, /read-only/);
  assert.match(fieldEditable(doors.fields[6], false).reason!, /count field/);
  assert.equal(fieldEditable(keySched.fields[1], true).ok, true, "a key schedule's own values are written");
  assert.match(fieldEditable(keySched.fields[2], true).reason!, /formula field/, "formula fields are refused even in a key schedule");
});

test("schedule_data: the cell diff keeps only changes, refuses calculated, read-only, other fields and owned elements", () => {
  const d = diffEdits(doors, [
    { id: "101", values: { Mark: "D01", Comments: "checked", Width: "950", "Area x2": "9" } },
    { id: "102", values: { Mark: "D02A", Level: "L3" } },
    { id: "103", values: { Mark: "D03A" } },
    { id: "999", values: { Mark: "X" } },
    { id: "101b", values: { Bogus: "1" } },
  ]);
  assert.deepEqual(d.changes, [
    { id: "101", field: "Comments", from: "", to: "checked" },
    { id: "102", field: "Mark", from: "D02", to: "D02A" },
  ]);
  assert.deepEqual(d.refused.map((r) => `${r.id}:${r.field}`), ["101:Width", "101:Area x2", "102:Level", "103:Mark"]);
  assert.match(d.refused[3].reason, /owned by jane/);
  assert.deepEqual(d.unknown_ids, ["999", "101b"]);
});

test("schedule_data: a type mark set two ways on one type is a problem; set once it is applied once", () => {
  const two = diffEdits(doors, [{ id: "101", values: { "Type Mark": "TA" } }, { id: "102", values: { "Type Mark": "TB" } }]);
  assert.match(two.problems.join(), /type 7 is given 2 different values/);
  const one = diffEdits(doors, [{ id: "101", values: { "Type Mark": "TA" } }, { id: "102", values: { "Type Mark": "TA" } }]);
  assert.deepEqual(one.problems, []);
  assert.equal(one.changes.length, 2);
  assert.equal(applyList(one.changes).length, 1);
});

test("schedule_data: export then edit then read back round-trips through CSV", () => {
  const table = tableOf(doors);
  assert.deepEqual(table[0].slice(0, 3), ["ElementId", "Mark", "Comments"]);
  const csv = toCsv(table).replace('"fire"', '"fire, 60 min"').replace("fire", '"fire, 60 min"');
  const text = toCsv([table[0], ["101", "D01", 'say "hi", ok', "T1", "900", "3.6", "L1", "1"]]);
  const back = editsFromCsv(text);
  assert.deepEqual(back.problems, []);
  assert.equal(back.rows[0].values.Comments, 'say "hi", ok');
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(editsFromCsv("Mark\nD1\n").problems.join(), /No ElementId column/);
});

test("schedule_data: the project folder comes from the document path", () => {
  assert.equal(projectRootOf("C:\\Jobs\\F26901\\01_WIP\\A\\x.rvt"), "C:\\Jobs\\F26901");
  assert.equal(projectRootOf("C:\\Temp\\x.rvt"), "");
  assert.equal(projectRootOf(""), "");
});

test("schedule_data: the commands are registered, the apply is a write, the read is not", () => {
  const names = (JSON.parse(fs.readFileSync(new URL("command.json", root), "utf8")) as { commands: Array<{ commandName: string }> }).commands.map((c) => c.commandName);
  assert.ok(names.includes("fmc_schedule_data_read") && names.includes("fmc_schedule_data_apply"));
  assert.ok(WRITE_COMMANDS.has("fmc_schedule_data_apply"));
  assert.ok(!WRITE_COMMANDS.has("fmc_schedule_data_read") && !READ_VIA_SEND_COMMAND.has("fmc_schedule_data_apply"));
  const cs = fs.readFileSync(new URL("commandset/Services/Fmc/FmcScheduleData.cs", root), "utf8");
  for (const b of ["ALL_MODEL_MARK", "ALL_MODEL_TYPE_MARK", "ALL_MODEL_INSTANCE_COMMENTS", "ALL_MODEL_TYPE_COMMENTS"]) assert.ok(cs.includes(b), b);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-sched-"));
const job = path.win32.join(tmp, "F26901");
const docPath = path.win32.join(job, "01_WIP", "F26901-FMC-ZZ-ZZ-M3-A-0001.rvt");
const guard = { ...DEFAULT_CONFIG, write_roots: [tmp] };
const reader = (s: SchedRead) => async () => ({ ...s, title: "F26901-FMC-ZZ-ZZ-M3-A-0001", path: docPath });

test("schedule_data tool: document and schedule are required", async () => {
  assert.equal(out(await runFmcScheduleData(args({ action: "read" }))).code, "FMC-DOC-REQUIRED");
  assert.equal(out(await runFmcScheduleData(args({ action: "read", document: "A" }))).code, "FMC-SCHEDULE-REQUIRED");
});

test("schedule_data tool: read marks which fields are writable", async () => {
  const r = out(await runFmcScheduleData(args({ action: "read", document: "A", schedule: "A10" }), { read: reader(doors), guard }));
  assert.equal(r.read_only, true);
  assert.deepEqual(r.fields.filter((f: { writable: boolean }) => f.writable).map((f: { name: string }) => f.name), ["Mark", "Comments", "Type Mark"]);
});

test("schedule_data tool: export is a dry run by default, then writes an xlsx in 01_WIP\\_Schedules", async () => {
  const dry = out(await runFmcScheduleData(args({ action: "export", document: "A", schedule: "A10" }), { read: reader(doors), guard }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.plan.file, path.win32.join(job, "01_WIP", "_Schedules", "A10_Door_Schedule.xlsx"));
  assert.equal(fs.existsSync(dry.plan.file), false);
  const done = out(await runFmcScheduleData(args({ action: "export", document: "A", schedule: "A10", dry_run: false }), { read: reader(doors), guard }));
  assert.equal(done.dry_run, false);
  const sheet = [...readXlsxSheets(fs.readFileSync(done.written.file)).values()][0];
  assert.equal(sheet[0][0], "ElementId");
  assert.equal(sheet.length, 4);
  const outside = out(await runFmcScheduleData(args({ action: "export", document: "A", schedule: "A10", out_folder: tmp }), { read: reader(doors), guard }));
  assert.equal(outside.code, "FMC-SCHEDULE-OUTSIDE");
});

test("schedule_data tool: apply refuses refused cells, needs a lease, and sends only the diff", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const io = { read: reader(doors), guard, apply: async (b: Record<string, unknown>) => { sent.push(b); return { written: (b.changes as unknown[]).length }; } };
  const edits = [{ id: "101", values: { Mark: "D01X", Width: "1" } }];
  const dry = out(await runFmcScheduleData(args({ action: "apply", document: "A", schedule: "A10", edits }), io));
  assert.equal(dry.code, "FMC-SCHEDULE-REFUSED-CELLS");
  const dry2 = out(await runFmcScheduleData(args({ action: "apply", document: "A", schedule: "A10", edits, skip_refused: true }), io));
  assert.equal(dry2.dry_run, true);
  assert.equal(sent.length, 0);
  const noLease = out(await runFmcScheduleData(args({ action: "apply", document: "A", schedule: "A10", edits, skip_refused: true, dry_run: false }), io));
  assert.equal(noLease.code, "FMC-BATCH-LOCKED");
  const done = out(await runFmcScheduleData(args({ action: "apply", document: "A", schedule: "A10", edits, skip_refused: true, dry_run: false, batch_lease: "L1" }), io));
  assert.equal(done.dry_run, false);
  assert.deepEqual(sent[0].changes, [{ id: "101", field: "Mark", from: "D01", to: "D01X" }]);
  assert.equal(sent[0].schedule_id, "900");
});

test("schedule_data tool: diff reads an edited csv file", async () => {
  const f = path.join(tmp, "edited.csv");
  fs.writeFileSync(f, toCsv([["ElementId", "Floor Finish", "Cost"], ["500", "Screed", "99"]]));
  const r = out(await runFmcScheduleData(args({ action: "diff", document: "A", schedule: "Key", file: f }), { read: reader(keySched), guard }));
  assert.equal(r.read_only, true);
  assert.deepEqual(r.changes, [{ id: "500", field: "Floor Finish", from: "Tile", to: "Screed" }]);
  assert.deepEqual(r.refused.map((x: { field: string }) => x.field), ["Cost"]);
});
