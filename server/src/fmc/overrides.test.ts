import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STANDARDS_OVERRIDES_PARSE, overridesParseRefusal, parseOverrides, readOverridesFile, setOverride } from "./overrides.js";
import { registerFmcStandardsTool } from "../tools/fmc_standards.js";

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-overrides-"));
  const file = path.join(root, "01_WIP", "FMC_Project_Standards.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { root, file };
}

const GOOD = JSON.stringify({ "levels.floor_to_floor": { value: 3400, status: "project" }, "stairs.riser_max": { value: 175, status: "project" } }, null, 2);

test("parseOverrides: missing, object, BOM, and everything that is not a JSON object", () => {
  assert.deepEqual(parseOverrides(null), { state: "missing" });
  assert.deepEqual(parseOverrides('{"a":1}'), { state: "ok", data: { a: 1 } });
  assert.deepEqual(parseOverrides('\uFEFF{"a":1}'), { state: "ok", data: { a: 1 } });
  for (const bad of ['{"a":', "", "   ", "not json", "[1,2]", "null", '"text"', "42"]) {
    const r = parseOverrides(bad);
    assert.equal(r.state, "unparseable", `${JSON.stringify(bad)} is not an object of overrides`);
    assert.ok(r.state === "unparseable" && r.error.length > 0);
  }
});

test("readOverridesFile: no file is missing, a bad file is unparseable, a folder in its place is not read as empty", () => {
  const { root, file } = tmpProject();
  assert.deepEqual(readOverridesFile(file), { state: "missing" });
  fs.writeFileSync(file, GOOD);
  assert.equal(readOverridesFile(file).state, "ok");
  fs.writeFileSync(file, GOOD.slice(0, 40));
  assert.equal(readOverridesFile(file).state, "unparseable");
  const dirAsFile = path.join(root, "01_WIP", "dir.json");
  fs.mkdirSync(dirAsFile);
  const r = readOverridesFile(dirAsFile);
  assert.equal(r.state, "unparseable");
  assert.match(r.state === "unparseable" ? r.error : "", /could not read the file/);
});

test("setOverride: a file that does not parse is refused and left byte for byte as it was", () => {
  const { file } = tmpProject();
  const broken = GOOD.slice(0, GOOD.length - 25); // a half-synced copy
  fs.writeFileSync(file, broken);
  const before = fs.statSync(file).mtimeMs;
  const done = setOverride(file, "doors.internal.width", 900, "note");
  assert.equal(done.ok, false);
  if (done.ok) return;
  assert.equal(done.body.code, STANDARDS_OVERRIDES_PARSE);
  assert.equal(done.body.file, file);
  assert.ok(done.body.parse_error.length > 0);
  assert.match(done.body.message, /FMC-STANDARDS-OVERRIDES-PARSE/);
  assert.equal(fs.readFileSync(file, "utf8"), broken, "the file is untouched");
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["FMC_Project_Standards.json"], "no .bak or temp file is left");
});

test("setOverride: a JSON array or null is refused too (spreading it would wreck the file)", () => {
  const { file } = tmpProject();
  for (const text of ["[1,2,3]", "null"]) {
    fs.writeFileSync(file, text);
    assert.equal(setOverride(file, "k", 1).ok, false);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
});

test("setOverride: a good file keeps its other overrides; a missing file (and folder) is created", () => {
  const { root, file } = tmpProject();
  fs.writeFileSync(file, GOOD);
  const done = setOverride(file, "doors.internal.width", 900, "per brief");
  assert.deepEqual(done, { ok: true, set: "doors.internal.width", value: 900, file });
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after["levels.floor_to_floor"].value, 3400);
  assert.equal(after["stairs.riser_max"].value, 175);
  assert.deepEqual(after["doors.internal.width"], { value: 900, note: "per brief", status: "project" });

  const fresh = path.join(root, "other", "01_WIP", "FMC_Project_Standards.json");
  assert.equal(setOverride(fresh, "a", 1).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, "utf8")), { a: { value: 1, status: "project" } });
});

test("overridesParseRefusal names the code, the file and the parse error", () => {
  const body = overridesParseRefusal("C:\\P\\01_WIP\\FMC_Project_Standards.json", "Unexpected end of JSON input");
  assert.equal(body.code, "FMC-STANDARDS-OVERRIDES-PARSE");
  assert.match(body.message, /C:\\P\\01_WIP\\FMC_Project_Standards\.json/);
  assert.match(body.message, /Unexpected end of JSON input/);
});

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
function standardsHandler(): Handler {
  let handler: Handler | undefined;
  registerFmcStandardsTool({ tool: (_n: string, _d: string, _s: unknown, h: Handler) => { handler = h; } } as never);
  return handler!;
}

// The tool builds its paths with path.win32 (it runs on the pilot PC), so the tool-level tests run on the Windows CI runner.
const onWindows = { skip: process.platform !== "win32" && "tool paths are Windows paths" };

test("fmc_standards set (the tool): isError with the code, file and parse error on a corrupt overrides file; nothing written", onWindows, async () => {
  const { root, file } = tmpProject();
  const broken = '{ "levels.floor_to_floor": { "value": 3400 ';
  fs.writeFileSync(file, broken);
  const res = await standardsHandler()({ action: "set", key: "doors.internal.width", value: 900, project_folder: root });
  assert.equal(res.isError, true);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.code, "FMC-STANDARDS-OVERRIDES-PARSE");
  assert.equal(body.file, file);
  assert.ok(body.parse_error);
  assert.equal(fs.readFileSync(file, "utf8"), broken);
});

test("fmc_standards set (the tool): a good file is updated and answers without isError", onWindows, async () => {
  const { root, file } = tmpProject();
  fs.writeFileSync(file, GOOD);
  const res = await standardsHandler()({ action: "set", key: "doors.internal.width", value: 900, project_folder: root });
  assert.equal(res.isError, false);
  assert.equal(JSON.parse(res.content[0].text).set, "doors.internal.width");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["stairs.riser_max"].value, 175);
});

test("fmc_standards get (the tool): a corrupt overrides file is surfaced as a warning, not silently ignored", onWindows, async () => {
  const { root, file } = tmpProject();
  fs.writeFileSync(file, "{ nope");
  const res = await standardsHandler()({ action: "get", topic: "stairs", project_folder: root });
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.overrides_warning?.code, "FMC-STANDARDS-OVERRIDES-PARSE");
  assert.equal(body.overrides_warning.file, file);
  fs.writeFileSync(file, GOOD);
  const ok = JSON.parse((await standardsHandler()({ action: "get", topic: "stairs", project_folder: root })).content[0].text);
  assert.equal(ok.overrides_warning, undefined);
});
