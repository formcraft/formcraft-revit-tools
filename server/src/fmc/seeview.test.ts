import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import { saveTarget } from "./images.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("SEE-1: save_to as a file name is kept in the image folder and the reply says so", () => {
  const dir = "C:\\Users\\U\\AppData\\Local\\Formcraft\\images";
  const k = saveTarget("FMC_TEST_see_view_plan", dir, []);
  assert.ok(k);
  assert.equal(k!.target, dir + "\\FMC_TEST_see_view_plan.png");
  assert.equal(k!.kept_as, "name");
  assert.match(k!.note, /file name/);
  assert.equal(saveTarget("", dir, []), null);
  assert.equal(saveTarget(undefined, dir, []), null);
});

test("SEE-1: a full path inside an allowed write folder is honoured, not reduced to its basename", () => {
  const dir = "C:\\Users\\U\\AppData\\Local\\Formcraft\\images";
  const roots = ["C:\\Users\\U\\agent-tools\\revit-tests"];
  const k = saveTarget("C:\\Users\\U\\agent-tools\\revit-tests\\out-files\\FMC_TEST_see_view_1.png", dir, roots);
  assert.equal(k!.target, "C:\\Users\\U\\agent-tools\\revit-tests\\out-files\\FMC_TEST_see_view_1.png");
  assert.equal(k!.kept_as, "path");
  const inImages = saveTarget(dir + "\\sub\\a", dir, []);
  assert.equal(inImages!.target, dir + "\\sub\\a.png");
  const star = saveTarget("C:\\WIP\\P1\\01_WIP\\x.png", dir, ["C:\\WIP\\*\\01_WIP"]);
  assert.equal(star!.kept_as, "path");
});

test("SEE-1: other paths are refused clearly before any export", () => {
  const dir = "C:\\Users\\U\\AppData\\Local\\Formcraft\\images";
  assert.throws(() => saveTarget("C:\\Temp\\x.png", dir, ["C:\\WIP"]), /\[FMC-SAVE-TO\].*not inside/);
  assert.throws(() => saveTarget("D:\\Projects\\x.png", dir, ["D:\\Projects"]), /\[FMC-SAVE-TO\].*on D:/);
  assert.throws(() => saveTarget("C:\\WIP\\m.rvt\\x.png", dir, ["C:\\WIP"]), /next to a model/);
  assert.throws(() => saveTarget("out-files\\x.png", dir, ["C:\\WIP"]), /relative path/);
  assert.throws(() => saveTarget("C:\\Users\\U\\AppData\\Local\\Formcraft\\images\\..\\..\\x.png", dir, []), /not inside/);
  // A write root on D: does not make D: allowed.
  assert.throws(() => saveTarget("D:\\WIP\\x.png", dir, ["D:\\WIP"]), /on D:/);
});

test("SEE-1: see_view keeps one PNG (moves the auto-named export) and refuses save_to before Revit", () => {
  const tool = fs.readFileSync(path.join(root, "server", "src", "tools", "see_view.ts"), "utf8");
  const fn = tool.slice(tool.indexOf("export async function viewImage"), tool.indexOf("export function touchedIds"));
  assert.ok(fn.indexOf("saveTarget(") < fn.indexOf("sendCommand(\"fmc_view_image\""), "save_to is checked before the export");
  assert.match(fn, /fs\.unlinkSync\(file\)/);
  assert.match(fn, /save_to_note/);
});

test("see_view exports a named view from the named document and is a read during a batch", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_view_image"));
  assert.ok(!WRITE_COMMANDS.has("fmc_view_image"));
  const src = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcVision.cs"), "utf8");
  const handler = src.slice(src.indexOf("class FmcViewImageHandler"), src.indexOf("class FmcModelCheckHandler"));
  assert.match(handler, /FmcTarget\.Resolve\(app, Parameters, mayOpen: false\)/);
  assert.match(handler, /FmcImageExport\.Write\(doc, o\)/);
  assert.match(handler, /FmcImageExport\.PutBack\(app, prior\)/);
  const writeAt = handler.indexOf("FmcImageExport.Write");
  const rollAt = handler.indexOf("tg.RollBack()");
  const backAt = handler.indexOf("FmcImageExport.PutBack");
  assert.ok(writeAt >= 0 && writeAt < rollAt && rollAt < backAt, "the previous window is restored after the transaction group rolls back");
  assert.match(handler, /InternalException/);
  assert.match(handler, /SetViewsAndSheets\(new List<ElementId> \{ v\.Id \}\)/);
  assert.match(handler, /FmcImageExport\.Folder/);
  assert.doesNotMatch(handler, /GetTempPath/);
  assert.doesNotMatch(handler, /OpenAndActivateDocument/);
  assert.doesNotMatch(handler, /ShowElements/);
  assert.match(handler, /\["title"\] = doc\.Title/);
  assert.match(handler, /\["path"\] = doc\.PathName/);
  assert.match(handler, /\["view"\] = viewName/);
  assert.doesNotMatch(handler, /RequestViewChange/);
  assert.doesNotMatch(handler, /ActiveUIDocument \?\?/);
  const tool = fs.readFileSync(path.join(root, "server", "src", "tools", "see_view.ts"), "utf8");
  assert.match(tool, /sendCommand\("fmc_view_image"/);
  assert.match(tool, /previous document and view are restored/);
  assert.match(tool, /imageDir/);
  const exporter = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcImageExport.cs"), "utf8");
  assert.match(exporter, /OpenAndActivateDocument/);
  assert.match(exporter, /LocalApplicationData/);
  assert.doesNotMatch(exporter, /RequestViewChange/);
});
