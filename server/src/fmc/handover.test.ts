import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { checkOutputFolder, cleanMilestone, completeness, loadHandoverSpec, safeName, type HandoverElement } from "./handover.js";
import { crc32, readZip, writeZip, zipEntryName } from "./zipwrite.js";
import { readZip as readZipInMemory } from "./zip.js";
import { FMC_HANDOVER_SHAPE, runFmcHandover, type FmcHandoverArgs } from "../tools/fmc_handover.js";

function args(partial: Record<string, unknown>): FmcHandoverArgs {
  return z.object(FMC_HANDOVER_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

const elements: HandoverElement[] = [
  { id: "101", unique_id: "u-101", category: "OST_Doors", family: "Single", type: "900", level: "L1", values: { Mark: "D01", "Fire Rating": "FD30" } },
  { id: "102", unique_id: "u-102", category: "OST_Doors", family: "Single", type: "900", level: "L1", values: { Mark: "", "Fire Rating": "" } },
  { id: "201", unique_id: "u-201", category: "OST_Rooms", level: "L1", values: { Number: "1.01", Name: "Ward, \"A\"", Mark: "R1" } },
];

function sampleRead(extra: Record<string, unknown> = {}) {
  return {
    title: "SAMPLE-FMC-ZZ-ZZ-M3-A-0001", path: "", is_workshared: false, is_modified: false, revit_version: "2025",
    project_info: [{ name: "Project Name", value: "Sample building" }, { name: "Project Number", value: "F00001" }],
    counts: { OST_Doors: 2, OST_Rooms: 1 }, unknown_categories: [], elements, truncated: false, ...extra,
  };
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-handover-"));
  const out = path.join(dir, "WIP", "Handover");
  const guard: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [path.join(dir, "WIP")], reports_dir: path.join(dir, "Reports"), protected_roots: [path.join(dir, "Originals")] };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, USERPROFILE: dir } as NodeJS.ProcessEnv;
  return { dir, out, guard, env };
}

const fixed = () => new Date(2026, 10, 28, 11, 30, 0);

test("our CRC-32 matches zlib's, and entry names cannot climb out of the zip", () => {
  const data = Buffer.from("Formcraft handover 123456789");
  if (typeof (zlib as unknown as { crc32?: (d: Buffer) => number }).crc32 === "function")
    assert.equal(crc32(data), (zlib as unknown as { crc32: (d: Buffer) => number }).crc32(data));
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(zipEntryName("..\\..\\x/../model/a.rvt"), "x/model/a.rvt");
  assert.equal(zipEntryName("C:\\a\\b.txt"), "C_/a/b.txt");
});

test("writeZip stores files, deflates text, never overwrites, and leaves no partial file on failure", () => {
  const { dir } = sandbox();
  const file = path.join(dir, "big.bin");
  fs.writeFileSync(file, crypto.randomBytes(3 * 1024 * 1024 + 7));
  const target = path.join(dir, "a.zip");
  const res = writeZip(target, [{ name: "a.txt", data: Buffer.from("x".repeat(5000)) }, { name: "model/big.bin", file }], fixed(),
    (written) => [{ name: "manifest.json", data: Buffer.from(JSON.stringify(written.map((w) => w.name))) }]);
  assert.equal(res.entries.length, 3);
  assert.equal(res.entries[0].method, "deflate");
  assert.equal(res.entries[1].method, "store");
  const back = readZip(target);
  assert.deepEqual(back.map((e) => e.name), ["a.txt", "model/big.bin", "manifest.json"]);
  assert.ok(back.every((e) => e.crcOk));
  assert.deepEqual(JSON.parse(back[2].data.toString()), ["a.txt", "model/big.bin"]);
  const other = readZipInMemory(fs.readFileSync(target));
  assert.equal(other.get("a.txt")?.toString(), "x".repeat(5000), "the repo's own zip reader reads it too");
  assert.equal(other.get("model/big.bin")?.length, 3 * 1024 * 1024 + 7);
  assert.throws(() => writeZip(target, [{ name: "b.txt", data: Buffer.from("b") }]), /FMC-HANDOVER-EXISTS/);
  const bad = path.join(dir, "bad.zip");
  assert.throws(() => writeZip(bad, [{ name: "x", data: Buffer.from("1") }, { name: "X", data: Buffer.from("2") }]), /DUPLICATE/);
  assert.equal(fs.existsSync(bad), false);
  assert.equal(fs.existsSync(`${bad}.partial`), false);
});

test("the sample spec is provisional; milestones and names are cleaned", () => {
  const loaded = loadHandoverSpec({ kitRoot: "", env: {} as NodeJS.ProcessEnv });
  assert.equal(loaded.source, "sample");
  assert.equal(loaded.provisional, true);
  assert.ok((loaded.spec.categories ?? []).includes("OST_Doors"));
  assert.equal(cleanMilestone(" S4 "), "S4");
  assert.equal(cleanMilestone("S4/../x"), null);
  assert.equal(cleanMilestone(""), null);
  assert.equal(safeName("F269 Ogala:model.rvt"), "F269_Ogala_model");
});

test("completeness counts required values as missing when absent or empty", () => {
  const rows = completeness(elements, { required: { "*": ["Mark"], OST_Doors: ["Fire Rating"] } }, ["Comments"]);
  const doorMark = rows.find((r) => r.category === "OST_Doors" && r.parameter === "Mark");
  assert.deepEqual([doorMark?.elements, doorMark?.filled, doorMark?.missing, doorMark?.required], [2, 1, 1, true]);
  const fire = rows.find((r) => r.category === "OST_Doors" && r.parameter === "Fire Rating");
  assert.equal(fire?.missing, 1);
  assert.equal(rows.some((r) => r.parameter === "Comments"), false, "an optional parameter no element carries is left out");
});

test("output folder: inside write_roots or reports_dir only; CDE gates and protected originals refused", () => {
  const { dir, guard, env } = sandbox();
  const prot = [path.join(dir, "Originals")];
  assert.equal(checkOutputFolder(path.join(dir, "WIP", "Handover"), guard, prot, env).ok, true);
  assert.equal(checkOutputFolder(path.join(dir, "Reports", "Handover"), guard, prot, env).ok, true);
  assert.equal(checkOutputFolder(path.join(dir, "WIP", "03_Published"), guard, prot, env).ok, false);
  assert.equal(checkOutputFolder(path.join(dir, "Elsewhere"), guard, prot, env).ok, false);
  assert.equal(checkOutputFolder("relative\\folder", guard, prot, env).ok, false);
  const g2 = { ...guard, write_roots: [dir] };
  assert.equal(checkOutputFolder(path.join(dir, "Originals", "x"), g2, prot, env).ok, false);
});

test("dry run writes nothing and returns a plan_id; the write needs that plan_id and writes one zip with a manifest", async () => {
  const { dir, out, guard, env } = sandbox();
  const report = path.join(dir, "qa.json");
  fs.writeFileSync(report, JSON.stringify({ score: 91 }));
  let reads = 0;
  const read = async (body: Record<string, unknown>) => {
    reads += 1;
    assert.ok((body.parameters as string[]).includes("Mark"), "required parameters are always read");
    return sampleRead();
  };
  const base = { document: "SAMPLE", milestone: "S4", output_folder: out, report_files: [report] };
  const dry = textOf(await runFmcHandover(args(base), { read, env, guard, kitRoot: "", now: fixed }));
  assert.equal(dry.isError, false);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.status, "PROVISIONAL");
  assert.equal(dry.can_pass, false);
  assert.equal(dry.model_changed, false);
  assert.ok(dry.plan_id);
  assert.equal(fs.existsSync(out), false, "a dry run creates nothing");
  assert.ok((dry.files as Array<{ name: string }>).some((f) => f.name === "reports/qa.json"));
  assert.ok(dry.missing_required >= 1);

  const noPlan = textOf(await runFmcHandover(args({ ...base, dry_run: false }), { read, env, guard, kitRoot: "", now: fixed }));
  assert.equal(noPlan.code, "FMC-HANDOVER-PLAN-REQUIRED");
  const wrongPlan = textOf(await runFmcHandover(args({ ...base, dry_run: false, plan_id: "0000" }), { read, env, guard, kitRoot: "", now: fixed }));
  assert.equal(wrongPlan.code, "FMC-HANDOVER-PLAN");
  assert.equal(fs.existsSync(out), false);

  const done = textOf(await runFmcHandover(args({ ...base, dry_run: false, plan_id: dry.plan_id }), { read, env, guard, kitRoot: "", now: fixed }));
  assert.equal(done.isError, false, JSON.stringify(done));
  assert.equal(done.written, true);
  assert.ok(fs.existsSync(done.zip));
  assert.equal(path.dirname(done.zip), out);
  const entries = readZip(done.zip);
  assert.deepEqual(entries.map((e) => e.name), ["parameters/elements.csv", "parameters/project_info.csv", "reports/parameter_completeness.csv", "reports/qa.json", "manifest.json"]);
  assert.ok(entries.every((e) => e.crcOk));
  const manifest = JSON.parse(entries[4].data.toString("utf8"));
  assert.equal(manifest.schema, "fmc.handover/1");
  assert.equal(manifest.milestone, "S4");
  assert.equal(manifest.status, "PROVISIONAL");
  assert.equal(manifest.files.length, 4);
  assert.match(manifest.later.cobie, /later/);
  const csv = entries[0].data.toString("utf8");
  assert.match(csv, /"Ward, ""A"""/);
  assert.ok(reads >= 4);
  // same request again: a new zip name is needed, nothing is overwritten
  const again = textOf(await runFmcHandover(args({ ...base, dry_run: false, plan_id: dry.plan_id }), { read, env, guard, kitRoot: "", now: fixed }));
  assert.equal(again.code, "FMC-HANDOVER-EXISTS");
});

test("a changed model after the dry run is refused by plan_id", async () => {
  const { out, guard, env } = sandbox();
  let mark = "D01";
  const read = async () => sampleRead({ elements: [{ ...elements[0], values: { Mark: mark } }] });
  const base = { document: "SAMPLE", milestone: "S4", output_folder: out };
  const dry = textOf(await runFmcHandover(args(base), { read, env, guard, kitRoot: "", now: fixed }));
  mark = "D99";
  const done = textOf(await runFmcHandover(args({ ...base, dry_run: false, plan_id: dry.plan_id }), { read, env, guard, kitRoot: "", now: fixed }));
  assert.equal(done.code, "FMC-HANDOVER-PLAN");
});

test("include_model: a saved local file is stored; workshared, cloud and HEBERT HOSTELS are refused; a kit spec can be READY", async () => {
  const { dir, out, guard, env } = sandbox();
  const model = path.join(dir, "SAMPLE-FMC-ZZ-ZZ-M3-A-0001.rvt");
  fs.writeFileSync(model, Buffer.alloc(1024, 7));
  const kitSpec = JSON.stringify({ status: "ISSUED", categories: ["OST_Doors"], parameters: ["Mark"], required: { "*": ["Mark"] } });
  const kit = path.join(dir, "kit");
  fs.mkdirSync(path.join(kit, "03_Master_Data"), { recursive: true });
  fs.writeFileSync(path.join(kit, "03_Master_Data", "FMC_Handover.json"), kitSpec);
  const okRead = async () => sampleRead({ path: model, elements: [elements[0]], counts: { OST_Doors: 1 } });
  const base = { document: "SAMPLE", milestone: "PC", output_folder: out, include_model: true };
  const dry = textOf(await runFmcHandover(args(base), { read: okRead, env, guard, kitRoot: kit, now: fixed }));
  assert.equal(dry.spec_source, "kit");
  assert.equal(dry.status, "READY");
  assert.equal(dry.model.included, true);
  const done = textOf(await runFmcHandover(args({ ...base, dry_run: false, plan_id: dry.plan_id }), { read: okRead, env, guard, kitRoot: kit, now: fixed }));
  assert.equal(done.written, true, JSON.stringify(done));
  const entries = readZip(done.zip);
  const m = entries.find((e) => e.name === "model/SAMPLE-FMC-ZZ-ZZ-M3-A-0001.rvt");
  assert.equal(m?.bytes, 1024);
  assert.ok(fs.existsSync(model), "the model file is only read");

  for (const [extra, code] of [
    [{ path: model, is_workshared: true }, "FMC-HANDOVER-MODEL-WORKSHARED"],
    [{ path: "", is_cloud: true }, "FMC-HANDOVER-MODEL-CLOUD"],
    [{ path: model, title: "HEBERT HOSTELS A" }, "FMC-HANDOVER-MODEL-GUARD"],
  ] as Array<[Record<string, unknown>, string]>) {
    const read = async () => sampleRead(extra);
    const d = textOf(await runFmcHandover(args(base), { read, env, guard, kitRoot: kit, now: fixed }));
    assert.ok((d.blockers as Array<{ code: string }>).some((b) => b.code === code), code);
    const w = textOf(await runFmcHandover(args({ ...base, dry_run: false, plan_id: d.plan_id }), { read, env, guard, kitRoot: kit, now: fixed }));
    assert.equal(w.code, code);
  }
});

test("refusals: no document, a bad milestone, a refused read, and a folder outside the roots", async () => {
  const { dir, guard, env } = sandbox();
  const read = async () => sampleRead();
  assert.equal(textOf(await runFmcHandover(args({ milestone: "S4" }), { read, env, guard, kitRoot: "" })).code, "FMC-DOC-REQUIRED");
  assert.equal(textOf(await runFmcHandover(args({ document: "A", milestone: "S 4" }), { read, env, guard, kitRoot: "" })).code, "FMC-HANDOVER-MILESTONE");
  const refused = textOf(await runFmcHandover(args({ document: "A", milestone: "S4" }), { read: async () => ({ refused: true, code: "FMC-DOC-NOT-FOUND", message: "no" }), env, guard, kitRoot: "" }));
  assert.equal(refused.code, "FMC-DOC-NOT-FOUND");
  const outside = path.join(dir, "Elsewhere");
  const dry = textOf(await runFmcHandover(args({ document: "A", milestone: "S4", output_folder: outside }), { read, env, guard, kitRoot: "", now: fixed }));
  assert.equal(dry.output_folder_ok, false);
  const w = textOf(await runFmcHandover(args({ document: "A", milestone: "S4", output_folder: outside, dry_run: false, plan_id: dry.plan_id }), { read, env, guard, kitRoot: "", now: fixed }));
  assert.equal(w.code, "FMC-HANDOVER-FOLDER");
  assert.equal(fs.existsSync(outside), false);
});

test("the handover read is a read, and it is in command.json", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_handover_read"));
  assert.ok(!WRITE_COMMANDS.has("fmc_handover_read"));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.ok(manifest.commands.some((row) => row.commandName === "fmc_handover_read"));
});
