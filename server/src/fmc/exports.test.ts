import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { DEFAULT_SETUPS, exportGate, outputName, parseSetups, targetFolder, verifyOutput } from "./exports.js";
import { FMC_EXPORTS_SHAPE, runFmcExports, type FmcExportsArgs } from "../tools/fmc_exports.js";

const win = path.win32;
const root = new URL("../../../", import.meta.url);
const args = (p: Record<string, unknown>): FmcExportsArgs => z.object(FMC_EXPORTS_SHAPE).parse(p);
const out = (r: { content: Array<{ text: string }>; isError?: boolean }) => ({ ...JSON.parse(r.content[0].text), isError: r.isError === true });

const IFC4 = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
const IFC2X3 = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\n";

test("exports: the built-in setups are IFC4 RV with the kit property sets, FMC_DWG, shared-coordinate NWC and gbXML", () => {
  assert.equal(DEFAULT_SETUPS.ifc.format === "ifc" && DEFAULT_SETUPS.ifc.version, "IFC4RV");
  assert.equal(DEFAULT_SETUPS.ifc.format === "ifc" && DEFAULT_SETUPS.ifc.psets_file, "07_IFC_IDS\\FMC_IFC_PropertySets.txt");
  assert.equal(DEFAULT_SETUPS.dwg.format === "dwg" && DEFAULT_SETUPS.dwg.setup, "FMC_DWG");
  assert.equal(DEFAULT_SETUPS.nwc.format === "nwc" && DEFAULT_SETUPS.nwc.coordinates, "shared");
  assert.equal(DEFAULT_SETUPS.gbxml.format, "gbxml");
  assert.deepEqual(parseSetups({ schema: "fmc-exports/0.1", setups: { ifc: { format: "ifc", version: "IFC4" } } }).problems, []);
  assert.ok(parseSetups({ schema: "fmc-exports/0.1", setups: { ifc: { format: "ifc", version: "IFC2X3" } } }).problems.length > 0, "only IFC4 versions");
});

test("exports: the target is the project's 02_Shared or 03_Published, with a plain subfolder", () => {
  assert.equal(targetFolder("C:\\Jobs\\P", "shared").folder, "C:\\Jobs\\P\\02_Shared");
  assert.equal(targetFolder("C:\\Jobs\\P", "published", "IFC").folder, "C:\\Jobs\\P\\03_Published\\IFC");
  assert.ok(targetFolder("C:\\Jobs\\P", "shared", "..\\x").problem);
  assert.ok(targetFolder("C:\\Jobs\\P", "shared", ".hidden").problem);
  assert.ok(targetFolder("", "shared").problem);
});

test("exports: a real export needs confirm, the named approver, a folder in the target and a write root", () => {
  const g = { dry_run: false, confirm: false, approver: "", target: "published" as const, folder: "C:\\Jobs\\P\\03_Published", projectRoot: "C:\\Jobs\\P", writeRoots: ["C:\\Jobs"] };
  assert.deepEqual(exportGate({ ...g, dry_run: true }), [], "a dry run is never gated");
  const r = exportGate(g);
  assert.equal(r.length, 2);
  assert.match(r.join(), /confirm=true/);
  assert.match(r.join(), /named approver/);
  assert.deepEqual(exportGate({ ...g, confirm: true, approver: "Emlyn" }), []);
  assert.match(exportGate({ ...g, confirm: true, approver: "E", folder: "C:\\Jobs\\P\\01_WIP" }).join(), /inside the project's 03_Published/);
  assert.match(exportGate({ ...g, confirm: true, approver: "E", writeRoots: ["D:\\Other"] }).join(), /not inside a write root/);
});

test("exports: outputs are verified by their headers", () => {
  const b = (s: string) => Buffer.from(s, "latin1");
  assert.equal(verifyOutput("a.ifc", "ifc", b(IFC4), 100).ok, true);
  assert.match(verifyOutput("a.ifc", "ifc", b(IFC2X3), 100).reason!, /not IFC4/);
  assert.match(verifyOutput("a.ifc", "ifc", b("hello"), 100).reason!, /STEP/);
  assert.equal(verifyOutput("a.dwg", "dwg", b("AC1032\u0000\u0000"), 5000).detail, "AC1032");
  assert.equal(verifyOutput("a.dwg", "dwg", b("PK\u0003\u0004"), 5000).ok, false);
  assert.equal(verifyOutput("a.xml", "gbxml", b('<?xml version="1.0"?>\n<gbXML xmlns="http://www.gbxml.org/schema">'), 500).ok, true);
  assert.equal(verifyOutput("a.nwc", "nwc", Buffer.alloc(2048, 7), 2048).ok, true);
  assert.equal(verifyOutput("a.nwc", "nwc", b("<html>"), 2048).ok, false);
  assert.equal(verifyOutput("a.ifc", "ifc", b(""), 0).reason, "empty file");
  assert.equal(outputName("F26901-FMC-ZZ-ZZ-M3-A-0001.rvt", "gbxml"), "F26901-FMC-ZZ-ZZ-M3-A-0001.xml");
});

test("exports: the run command is a known read through sendCommand (the model is not changed)", () => {
  const names = (JSON.parse(fs.readFileSync(new URL("command.json", root), "utf8")) as { commands: Array<{ commandName: string }> }).commands.map((c) => c.commandName);
  assert.ok(names.includes("fmc_exports_run"));
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_exports_run") && !WRITE_COMMANDS.has("fmc_exports_run"));
  const cs = fs.readFileSync(new URL("commandset/Services/Fmc/FmcExports.cs", root), "utf8");
  for (const api of ["IFCExportOptions", "DWGExportOptions", "NavisworksExportOptions", "GBXMLExportOptions", "RollBack"]) assert.ok(cs.includes(api), api);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-exp-"));
const job = win.join(tmp, "F26901");
const title = "F26901-FMC-ZZ-ZZ-M3-A-0001";
const docPath = win.join(job, "01_WIP", `${title}.rvt`);
const kit = win.join(tmp, "kit");
fs.mkdirSync(win.join(kit, "07_IFC_IDS"), { recursive: true });
fs.writeFileSync(win.join(kit, "07_IFC_IDS", "FMC_IFC_PropertySets.txt"), "PropertySet:\tFMC_Common\tI\tIfcElement\n");
const guard = { ...DEFAULT_CONFIG, write_roots: [tmp], reports_dir: win.join(tmp, "reports") };
const check = async () => ({ title, path: docPath, checks: { ifc: "ok" }, problems: [] });
const writer = (content: string) => async (b: Record<string, unknown>) => {
  const names = b.names as Record<string, string>;
  for (const [fmt, name] of Object.entries(names)) fs.writeFileSync(win.join(String(b.folder), `${name}${fmt === "gbxml" ? ".xml" : "." + fmt}`), content);
  return { exported: Object.keys(names) };
};

test("exports tool: setups reports the built-in setups and the missing kit file", async () => {
  const r = out(await runFmcExports(args({ action: "setups", kit_folder: kit }), { guard }));
  assert.equal(r.source, "built-in");
  assert.match(r.warnings.join(), /FMC_Export_Setups\.json/);
});

test("exports tool: plan and a default export are dry runs that write nothing", async () => {
  let ran = 0;
  const io = { check, run: async () => { ran++; return {}; }, guard };
  const plan = out(await runFmcExports(args({ action: "plan", document: "A", kit_folder: kit }), io));
  assert.equal(plan.dry_run, true);
  assert.equal(plan.planned[0].file, win.join(job, "02_Shared", `${title}.ifc`));
  assert.match(plan.needs_for_real_run.join(), /confirm=true/);
  const dry = out(await runFmcExports(args({ action: "export", document: "A", kit_folder: kit, confirm: true, approver: "E" }), io));
  assert.equal(dry.dry_run, true);
  assert.equal(ran, 0);
  assert.equal(fs.existsSync(win.join(job, "02_Shared")), false);
});

test("exports tool: a real export without confirm and approver is refused", async () => {
  const r = out(await runFmcExports(args({ action: "export", document: "A", kit_folder: kit, dry_run: false }), { check, run: writer(IFC4), guard }));
  assert.equal(r.code, "FMC-EXPORTS-GATE");
});

test("exports tool: a real export arrives hidden, is verified, then moved into 03_Published", async () => {
  const r = out(await runFmcExports(args({ action: "export", document: "A", kit_folder: kit, target: "published", dry_run: false, confirm: true, approver: "Emlyn" }),
    { check, run: writer(IFC4), guard, now: new Date("2026-11-28T11:00:00Z") }));
  assert.equal(r.ok, true, JSON.stringify(r));
  const pub = win.join(job, "03_Published");
  assert.deepEqual(fs.readdirSync(pub), [`${title}.ifc`], "only the verified file; no arrival folder left");
  assert.equal(r.verified[0].detail, "IFC4 (IFC4RV)");
  assert.ok(fs.existsSync(r.record));
  const again = out(await runFmcExports(args({ action: "export", document: "A", kit_folder: kit, target: "published", dry_run: false, confirm: true, approver: "Emlyn" }), { check, run: writer(IFC4), guard }));
  assert.equal(again.code, "FMC-EXPORTS-GATE", "an existing file is kept");
  const over = out(await runFmcExports(args({ action: "export", document: "A", kit_folder: kit, target: "published", dry_run: false, confirm: true, approver: "Emlyn", overwrite: true }),
    { check, run: writer(IFC4), guard, now: new Date("2026-11-28T11:05:00Z") }));
  assert.equal(over.ok, true);
  assert.ok(over.moved[0].archived && fs.existsSync(over.moved[0].archived), "the old file is archived, never deleted");
});

test("exports tool: a failed check leaves nothing in the target", async () => {
  const r = out(await runFmcExports(args({ action: "export", document: "A", kit_folder: kit, subfolder: "Bad", dry_run: false, confirm: true, approver: "E" }), { check, run: writer(IFC2X3), guard }));
  assert.equal(r.code, "FMC-EXPORTS-VERIFY");
  assert.deepEqual(fs.readdirSync(win.join(job, "02_Shared", "Bad")), []);
});

test("exports tool: DWG needs views; verify checks a folder", async () => {
  assert.equal(out(await runFmcExports(args({ action: "plan", document: "A", formats: ["dwg"], kit_folder: kit }), { check, guard })).code, "FMC-EXPORTS-VIEWS");
  const v = out(await runFmcExports(args({ action: "verify", folder: win.join(job, "03_Published"), kit_folder: kit }), { guard }));
  assert.equal(v.ok, true);
  assert.equal(v.files.length, 1);
});
