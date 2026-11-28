import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { auditParams, parseCsv, planBind, planCopy, planFill, readKitShared, type Binding, type ValueRow } from "./params.js";
import { FMC_PARAMS_SHAPE, runFmcParams, type FmcParamsArgs } from "../tools/fmc_params.js";

const KIT = [
  "# This is a Revit shared parameter file.",
  "*META\tVERSION\tMINVERSION", "META\t2\t1",
  "*GROUP\tID\tNAME", "GROUP\t1\tIdentity Data",
  "*PARAM\tGUID\tNAME\tDATATYPE\tDATACATEGORY\tGROUP\tVISIBLE\tDESCRIPTION\tUSERMODIFIABLE",
  "PARAM\taaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\tStatus\tTEXT\t\t1\t1\t\t1",
  "PARAM\tbbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee\tClear Height\tLENGTH\t\t1\t1\t\t1",
  "PARAM\tcccccccc-bbbb-cccc-dddd-eeeeeeeeeeee\tFire Rating\tTEXT\t\t1\t1\t\t1",
].join("\r\n");

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "fmc-params-t-")); }
function kitFile(utf16: boolean): string {
  const f = path.join(tmp(), "FMC_SharedParameters.txt");
  fs.writeFileSync(f, utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(KIT, "utf16le")]) : KIT);
  return f;
}

const bound: Binding[] = [
  { name: "Status", guid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", shared: true, datatype: "TEXT", binding: "instance", categories: ["OST_Walls"] },
  { name: "Clear Height", guid: "99999999-bbbb-cccc-dddd-eeeeeeeeeeee", shared: true, datatype: "LENGTH", binding: "instance", categories: ["OST_Rooms"] },
  { name: "Legacy", guid: "11111111-bbbb-cccc-dddd-eeeeeeeeeeee", shared: true, datatype: "TEXT", binding: "type", categories: [] },
  { name: "Fire Rating", guid: "", shared: false, datatype: "TEXT", binding: "instance", categories: ["OST_Doors"] },
];

test("the kit file is read as UTF-8 or UTF-16", () => {
  for (const utf16 of [false, true]) {
    const kit = readKitShared(kitFile(utf16))!;
    assert.equal(kit.size, 3, `utf16=${utf16}`);
    assert.equal(kit.get("Clear Height")!.datatype, "LENGTH");
  }
  assert.equal(readKitShared(path.join(tmp(), "nope.txt")), null);
});

test("audit names GUID mismatch, not in kit, a clash with a kit name, and what is not bound", () => {
  const a = auditParams(readKitShared(kitFile(false))!, bound);
  const codes = Object.fromEntries(a.findings.map((f) => [f.name, f.code]));
  assert.equal(a.ok, 1);
  assert.equal(codes["Clear Height"], "FMC-PARAM-GUID-MISMATCH");
  assert.equal(codes["Legacy"], "FMC-PARAM-NOT-IN-KIT");
  assert.equal(codes["Fire Rating"], "FMC-PARAM-NAME-CLASH");
  assert.deepEqual(a.not_bound, ["Clear Height", "Fire Rating"]);
  const narrow = auditParams(readKitShared(kitFile(false))!, bound, ["status"]);
  assert.equal(narrow.findings.length, 0);
  assert.equal(narrow.ok, 1);
});

test("bind plans from the kit GUID, adds categories, and refuses a GUID clash or a kit gap", () => {
  const kit = readKitShared(kitFile(false));
  const base = { kit, kitFile: "k", binding: "instance" as const, group: "data", bound };
  const add = planBind({ ...base, names: ["Status"], categories: ["OST_Walls", "OST_Doors"] });
  assert.equal(add.ok, true);
  assert.equal(add.steps.length, 1);
  assert.deepEqual((add.steps[0] as { added_categories: string[] }).added_categories, ["OST_Doors"]);
  assert.deepEqual((add.steps[0] as { categories: string[] }).categories, ["OST_Walls", "OST_Doors"]);
  const done = planBind({ ...base, names: ["Status"], categories: ["OST_Walls"] });
  assert.equal(done.steps.length, 0);
  assert.equal(done.preview[0].status, "already_bound");
  assert.equal(planBind({ ...base, names: ["Clear Height"], categories: ["OST_Walls"] }).code, "FMC-PARAM-GUID-MISMATCH");
  assert.equal(planBind({ ...base, names: ["Fire Rating"], categories: ["OST_Walls"] }).code, "FMC-PARAM-GUID-MISMATCH");
  assert.equal(planBind({ ...base, names: ["Nope"], categories: ["OST_Walls"] }).code, "FMC-PARAM-NOT-IN-KIT");
  assert.equal(planBind({ ...base, names: ["Status"], categories: ["OST_Walls"], binding: "type" }).code, "FMC-PARAM-BINDING-KIND");
  assert.equal(planBind({ ...base, kit: null, names: ["Status"], categories: ["OST_Walls"] }).code, "FMC-PARAM-FILE");
  assert.equal(planBind({ ...base, names: [], categories: ["OST_Walls"] }).code, "FMC-PARAM-NAME");
  assert.equal(planBind({ ...base, names: ["Status"], categories: [] }).code, "FMC-PARAM-CATEGORY");
  const fresh = planBind({ ...base, bound: [], names: ["Fire Rating"], categories: ["OST_Walls"] });
  assert.equal((fresh.steps[0] as { existing: boolean }).existing, false);
});

const rows: ValueRow[] = [
  { id: "1", editable: true, params: [
    { key: "name:Mark", name: "Mark", storage: "String", value: "W1" }, { key: "name:Comments", name: "Comments", storage: "String", value: "" },
    { key: "name:Count", name: "Count", storage: "Integer", value: 3 }, { key: "name:Height", name: "Height", storage: "Double", value: 3, display: "914 mm" },
    { key: "name:RO", name: "RO", storage: "String", value: "x", readonly: true } ] },
  { id: "2", editable: true, params: [
    { key: "name:Mark", name: "Mark", storage: "String", value: "" }, { key: "name:Comments", name: "Comments", storage: "String", value: "keep" },
    { key: "name:Count", name: "Count", storage: "Integer", value: 4 }, { key: "name:Height", name: "Height", storage: "Double", value: 2, display: "609.6 mm" } ] },
  { id: "3", editable: false, owner: "Ann", params: [] },
];

test("copy: same storage or into text; empty source and read-only are handled", () => {
  const toText = planCopy(rows, "Mark", "Comments");
  assert.equal(toText.steps.length, 1);
  assert.equal(toText.preview.find((p) => p.id === "2")!.status, "no_change");
  assert.equal(toText.preview.find((p) => p.id === "3")!.status, "refused");
  const num = planCopy(rows, "Count", "Comments");
  assert.equal((num.steps[0] as { to: string }).to, "3");
  assert.equal(planCopy(rows, "Comments", "Count").preview.find((p) => p.id === "1")!.status, "no_change");
  assert.equal(planCopy(rows, "Count", "Height").preview.find((p) => p.id === "1")!.status, "refused");
  assert.equal(planCopy(rows, "Mark", "RO").preview.find((p) => p.id === "1")!.status, "refused");
  assert.equal(planCopy(rows, "Mark", "Mark").code, "FMC-PARAM-NAME");
  assert.equal(planCopy([], "a", "b").code, "FMC-PARAM-NO-ELEMENTS");
  assert.equal(planCopy(rows, "Mark", "Comments").plan_hash, toText.plan_hash);
});

test("CSV: quotes, doubled quotes, CRLF, BOM", () => {
  const t = parseCsv('\uFEFFId,Mark,Comments\r\n1,"W,1","say ""hi"""\r\n\r\n2,W2,\r\n');
  assert.deepEqual(t, [["Id", "Mark", "Comments"], ["1", "W,1", 'say "hi"'], ["2", "W2", ""]]);
});

test("fill_csv: typed per storage, blanks left alone, unknown ids and read-only refused", () => {
  const csv = parseCsv("Id,Mark,Count,Height,RO\n1,W9,3,914,zzz\n2,W2,five,2400,\n9,X,1,1,\n1,dup,1,1,\n");
  const plan = planFill(rows, csv);
  assert.equal(plan.ok, true);
  const st = (line: number, name?: string) => plan.preview.find((p) => p.line === line && (name ? p.name === name : true))!;
  assert.equal(st(2, "Mark").status, "will_change");
  assert.equal(st(2, "Count").status, "no_change");
  assert.equal(st(2, "Height").status, "no_change");
  assert.equal(st(2, "RO").status, "refused");
  assert.equal(st(3, "Count").status, "refused");
  const h = plan.steps.find((s) => s.kind === "set" && s.target === "2" && s.name === "Height")!;
  assert.equal((h as { mode: string }).mode, "display");
  assert.equal(st(4).status, "refused");
  assert.equal(st(5).status, "refused");
  assert.equal(planFill(rows, parseCsv("Mark\nx\n")).code, "FMC-PARAM-CSV");
  assert.equal(planFill(rows, parseCsv("Id,Mark\n")).code, "FMC-PARAM-CSV");
});

function args(partial: Record<string, unknown>): FmcParamsArgs { return z.object(FMC_PARAMS_SHAPE).parse(partial); }
function body(r: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> { return { ...JSON.parse(r.content?.[0]?.text ?? "{}"), isError: r.isError === true }; }
function io(opts: { central?: boolean; title?: string } = {}) {
  const dir = tmp();
  const calls: Array<{ cmd: string; body: Record<string, unknown> }> = [];
  const guard: GuardConfig = { ...DEFAULT_CONFIG, protected_paths: ["D:\\Live"], save_exclude: ["HEBERT HOSTELS"], sync_exclude: [] };
  const doc = { title: opts.title ?? "P1", path: "D:\\Jobs\\_Staging\\P1.rvt" };
  return {
    calls, dir, guard, kitFile: kitFile(true), reportDir: dir, env: { ...process.env, APPDATA: dir, LOCALAPPDATA: dir } as NodeJS.ProcessEnv,
    read: async (b: Record<string, unknown>) => { calls.push({ cmd: "read", body: b }); return b.action === "bindings" ? { resolved_document: doc, is_central: opts.central === true, bindings: bound } : { resolved_document: doc, is_central: opts.central === true, rows }; },
    apply: async (b: Record<string, unknown>) => { calls.push({ cmd: "apply", body: b }); return { ok: true }; },
  };
}

test("tool: audit is read-only, bind dry run then apply with hash and lease", async () => {
  const i = io();
  const audit = body(await runFmcParams(args({ action: "audit", document: "P1" }), i));
  assert.equal(audit.isError, false);
  assert.equal(audit.read_only, true);
  assert.equal(audit.kit_count, 3);
  const dry = body(await runFmcParams(args({ action: "bind", document: "P1", names: ["Status"], categories: ["OST_Walls", "OST_Doors"] }), i));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.steps, 1);
  assert.equal(i.calls.filter((c) => c.cmd === "apply").length, 0);
  const a = (extra: Record<string, unknown>) => args({ action: "bind", document: "P1", names: ["Status"], categories: ["OST_Walls", "OST_Doors"], dry_run: false, ...extra });
  assert.equal(body(await runFmcParams(a({ plan_hash: dry.plan_hash }), i)).code, "FMC-BATCH-LOCKED");
  assert.equal(body(await runFmcParams(a({ batch_lease: "L" }), i)).code, "FMC-PARAM-HASH");
  assert.equal(body(await runFmcParams(a({ batch_lease: "L", plan_hash: "000000000000" }), i)).code, "FMC-PARAM-PLAN-CHANGED");
  const ok = body(await runFmcParams(a({ batch_lease: "L", plan_hash: dry.plan_hash }), i));
  assert.equal(ok.isError, false);
  assert.equal(ok.kit_saved, false);
  const sent = i.calls.find((c) => c.cmd === "apply")!.body;
  assert.equal(sent.shared_parameter_file, i.kitFile);
  assert.equal((sent.steps as unknown[]).length, 1);
});

test("tool: copy and fill_csv plan from the model rows; a bad CSV path is refused", async () => {
  const i = io();
  const copy = body(await runFmcParams(args({ action: "copy", document: "P1", ids: [1, 2], from: "Mark", to: "Comments" }), i));
  assert.equal(copy.steps, 1);
  assert.deepEqual((i.calls[0].body as { names: string[] }).names, ["Mark", "Comments"]);
  const csvFile = path.join(tmp(), "v.csv");
  fs.writeFileSync(csvFile, "Id,Mark\n1,W9\n2,W2\n");
  const fill = body(await runFmcParams(args({ action: "fill_csv", document: "P1", csv_path: csvFile }), io()));
  assert.equal(fill.steps, 2);
  assert.equal(body(await runFmcParams(args({ action: "fill_csv", document: "P1", csv_path: path.join(tmp(), "no.csv") }), io())).code, "FMC-PARAM-CSV");
  assert.equal(body(await runFmcParams(args({ action: "fill_csv", document: "P1", csv_path: "C:\\x\\a.txt" }), io())).code, "FMC-PARAM-CSV");
  assert.equal(body(await runFmcParams(args({ action: "copy", document: "P1", from: "a", to: "b" }), io())).code, "FMC-PARAM-SCOPE");
  assert.equal(body(await runFmcParams(args({ action: "copy", document: "P1", ids: ["x"], from: "a", to: "b" }), io())).code, "FMC-PARAM-IDS");
  assert.equal(body(await runFmcParams(args({ action: "audit" }), io())).code, "FMC-DOC-REQUIRED");
});

test("tool: HEBERT HOSTELS and a central model are refused for every write action; audit still reads", async () => {
  const h = body(await runFmcParams(args({ action: "bind", document: "P1", names: ["Status"], categories: ["OST_Walls"] }), io({ title: "HEBERT HOSTELS" })));
  assert.equal(h.code, "FMC-PARAM-GUARD");
  const c = body(await runFmcParams(args({ action: "copy", document: "P1", ids: [1], from: "Mark", to: "Comments" }), io({ central: true })));
  assert.equal(c.code, "FMC-PARAM-GUARD");
  assert.equal(body(await runFmcParams(args({ action: "audit", document: "P1" }), io({ central: true }))).isError, false);
});

test("fmc_params is a read through sendCommand and fmc_params_apply is a write", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_params"));
  assert.ok(WRITE_COMMANDS.has("fmc_params_apply"));
});
