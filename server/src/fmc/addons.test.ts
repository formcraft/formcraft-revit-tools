import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AddonHeader, addonCall, addonStep, addonSummary, checkJob, jobResultFile, parseAddonHeader, parseJob, readAddons, runJob,
  validateAddonParams,
} from "./addons.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADDONS = path.resolve(HERE, "..", "..", "..", "resources", "addons");
const SAMPLES = path.join(ADDONS, "samples");
const CLI = path.join(HERE, "cli.js");

const header = (lines: string[], body = "var args = FmcScript.Params(parameters);\nFmcScript.Tx(document, \"x\", true, () => { });\nreturn null;") =>
  lines.map((l) => "// " + l).join("\n") + "\n" + body;

test("the saved add-ons in resources/addons read cleanly from their headers", () => {
  const files = readAddons(ADDONS);
  const names = files.map((f) => f.addon?.name).sort();
  assert.deepEqual(names, ["export_png_pdf", "qa_orphans", "strips_on_room_walls"]);
  for (const f of files) assert.deepEqual(f.problems, [], `${f.file}: ${f.problems.join("; ")}`);
  const by = new Map(files.map((f) => [f.addon!.name, f.addon!]));
  assert.equal(by.get("export_png_pdf")!.writes, "none");
  assert.deepEqual(by.get("export_png_pdf")!.paths, ["out_dir"]);
  assert.equal(by.get("qa_orphans")!.writes, "model");
  assert.equal(by.get("strips_on_room_walls")!.writes, "model");
  assert.deepEqual(by.get("strips_on_room_walls")!.required, ["rooms", "type"]);
  for (const a of by.values()) {
    assert.ok(a.dryrun && a.does.length > 20 && a.returns.startsWith("{"), a.name);
    assert.ok(a.usings.includes("Newtonsoft.Json.Linq"), `${a.name} names JArray/JObject: it needs Newtonsoft.Json.Linq`);
  }
});

test("each add-on's sample parameters pass its own header, and the sample job checks", () => {
  const files = readAddons(ADDONS);
  for (const f of files) {
    const sample = JSON.parse(fs.readFileSync(path.join(SAMPLES, `${f.addon!.name}.params.json`), "utf8"));
    const v = validateAddonParams(f.addon!, sample);
    assert.deepEqual(v.problems, [], f.addon!.name);
    for (const k of Object.keys(f.addon!.params)) assert.ok(k in v.params, `${f.addon!.name}: ${k} filled from the default`);
  }
  const job = parseJob(JSON.parse(fs.readFileSync(path.join(SAMPLES, "kisic_relight.job.json"), "utf8")));
  assert.ok(job.job, job.problems.join("; "));
  assert.equal(job.job!.dry_run, true);
  const checked = checkJob(job.job!, new Map(files.map((f) => [f.addon!.name, f.addon!])));
  assert.deepEqual(checked.problems, []);
});

test("the KISIC lessons are encoded in the add-on bodies", () => {
  const body = (n: string) => fs.readFileSync(path.join(ADDONS, `${n}.cs`), "utf8");
  for (const n of ["qa_orphans", "strips_on_room_walls"]) {
    assert.match(body(n), /OfClass\(typeof\(FamilyInstance\)\)/, `${n}: lesson 5`);
    assert.match(body(n), /HostObjectUtils\.Get(Side|Bottom|Top)Faces/, `${n}: lesson 2`);
    assert.match(body(n), /FmcScript\.Tx\(document/, `${n}: lesson 1`);
    assert.doesNotMatch(body(n), /new (Sub)?Transaction(Group)?\(/, `${n}: transactions only through FmcScript.Tx`);
  }
  assert.match(body("strips_on_room_walls"), /FMC Switch/, "lesson 4: the shared FMC Switch parameter, not Switch ID");
  assert.match(body("qa_orphans"), /Host == null/, "lesson 3: orphans after a host change");
  // no project coordinates: the KISIC scripts' P(x, y, z) helpers and hard-coded element ids are gone
  for (const n of ["export_png_pdf", "qa_orphans", "strips_on_room_walls"]) {
    assert.doesNotMatch(body(n), /PointMm\(\s*-?\d|new ElementId\(\d|KISASI|L00 FFL/, `${n}: no hard-coded project data`);
  }
});

test("a header: several tags on one line, @params over two lines, defaults give the types", () => {
  const r = parseAddonHeader(header([
    "@addon demo_one  @version 1.2  @writes model  @dryrun yes",
    "@does Demonstrates the header.",
    "@params {\"rooms\":[],\"height_mm\":2850,",
    "  \"walls\":\"all\",\"replace\":true,\"any\":null}",
    "@required rooms",
    "@returns {\"placed\":n}",
    "@usings System.IO, Newtonsoft.Json.Linq",
  ]), "C:\\x\\demo_one.cs");
  assert.deepEqual(r.problems, []);
  assert.equal(r.addon!.version, "1.2");
  assert.deepEqual(r.addon!.params, { rooms: [], height_mm: 2850, walls: "all", replace: true, any: null });
  assert.deepEqual(r.addon!.usings, ["System.IO", "Newtonsoft.Json.Linq"]);
});

test("a header with faults lists each one", () => {
  assert.deepEqual(parseAddonHeader("var x = 1;").problems, ["No // @addon <name> header"]);
  const r = parseAddonHeader(header(["@addon Bad-Name  @version one  @writes everything  @dryrun no", "@params {\"a\":1}", "@required b"],
    "return null;"), "C:\\x\\other.cs");
  const all = r.problems.join(" | ");
  for (const bit of ["names are lower case", "the file must be Bad-Name.cs", "@version \"one\"", "@writes is model or none", "b is in @required",
    "FmcScript.Params(parameters)"]) assert.ok(all.includes(bit), bit);
  const model = parseAddonHeader(header(["@addon m1  @version 1.0  @writes model  @dryrun no", "@params {}"], "var args = FmcScript.Params(parameters);\nreturn null;"));
  assert.ok(model.problems.some((p) => p.includes("must support a dry run")));
  assert.ok(model.problems.some((p) => p.includes("FmcScript.Tx")));
  assert.ok(parseAddonHeader(header(["@addon m2  @version 1.0  @writes none  @dryrun yes", "@params {not json"])).problems.some((p) => p.startsWith("@params is not valid JSON")));
});

const demo: AddonHeader = {
  name: "demo", version: "1.0", writes: "model", dryrun: true, does: "", file: "",
  params: { rooms: [], height_mm: 2850, walls: "all", replace: true, corners: {}, any: null }, required: ["rooms"], paths: [], returns: "", usings: ["System.IO"],
};

test("parameters: unknown names, wrong types and missing required ones are refused; the rest take their default", () => {
  const ok = validateAddonParams(demo, { rooms: ["06"], height_mm: 2600, any: "x" });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.params, { rooms: ["06"], height_mm: 2600, walls: "all", replace: true, corners: {}, any: "x" });
  assert.deepEqual(validateAddonParams(demo, "{\"rooms\":[\"all\"]}").problems, [], "JSON text is accepted");
  const bad = validateAddonParams(demo, { rooms: [], height_mm: "2850", colour: "red", corners: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.includes("rooms is required"));
  assert.ok(bad.problems.includes("height_mm is a number, not string"));
  assert.ok(bad.problems.includes("corners is an object, not a list"));
  assert.ok(bad.problems.some((p) => p.startsWith("demo has no parameter \"colour\"")));
  assert.match(validateAddonParams(demo, "{oops").problems[0], /^params is not valid JSON/);
  assert.deepEqual(validateAddonParams(demo, [1]).problems, ["params is a JSON object"]);
});

test("the bridge call: the whole file as the body, parameters [json, dry|real], no wrapping transaction", () => {
  const c = addonCall(demo, "\uFEFF// @addon demo\nreturn null;", { rooms: ["06"] }, true);
  assert.equal(c.code, "// @addon demo\nreturn null;");
  assert.deepEqual(c.parameters, ["{\"rooms\":[\"06\"]}", "dry"]);
  assert.equal(c.transactionMode, "none");
  assert.deepEqual(c.usings, ["System.IO"]);
  assert.equal(addonCall(demo, "x", {}, false).parameters[1], "real");
});

test("jobs: parsed with dry run by default, run in order, stopped at the first failure", async () => {
  assert.deepEqual(parseJob({ steps: [] }).problems, ["A job needs at least one step"]);
  assert.ok(parseJob({ steps: [{ params: {} }] }).problems[0].includes("no addon"));
  assert.ok(parseJob({ dry_run: "no", steps: [{ addon: "demo" }] }).problems.includes("dry_run is true or false"));
  const list = parseJob([{ addon: "demo", params: { rooms: ["06"] } }]);
  assert.equal(list.job!.dry_run, true);
  assert.equal(list.job!.name, "job");
  assert.equal(parseJob({ name: "KISIC relight!", dry_run: false, steps: [{ addon: "demo" }] }).job!.name, "KISIC_relight_");

  const second: AddonHeader = { ...demo, name: "second", required: [] };
  const addons = new Map([["demo", demo], ["second", second]]);
  const job = parseJob({ name: "j", dry_run: false, steps: [{ addon: "demo", params: { rooms: ["06"] } }, { addon: "second" }, { addon: "demo", params: { rooms: ["07"] } }] }).job!;
  const calls: string[] = [];
  let t = 0;
  const clock = () => new Date(Date.UTC(2026, 9, 19, 10, 0, t++));
  const result = await runJob(job, addons, async (a, p, dry) => {
    calls.push(`${a.name}:${(p.rooms as string[]).join(",")}:${dry ? "dry" : "real"}`);
    return a.name === "second" ? { ok: false, error: "[FMC-CODE-RUNTIME] boom" } : { ok: true, result: { placed: 3 } };
  }, clock);
  assert.deepEqual(calls, ["demo:06:real", "second::real"], "the third step never ran; defaults filled (rooms [])");
  assert.equal(result.done, false);
  assert.equal(result.stopped_at, "step 2 (second)");
  assert.deepEqual(result.skipped, ["step 3 (demo)"]);
  assert.equal(result.steps[1].error, "[FMC-CODE-RUNTIME] boom");
  assert.equal(result.started, "2026-10-19T10:00:00.000Z");

  const thrown = await runJob(parseJob([{ addon: "demo", params: { rooms: ["1"] } }]).job!, addons, async () => { throw new Error("socket closed"); });
  assert.equal(thrown.steps[0].error, "socket closed");
  await assert.rejects(runJob(parseJob([{ addon: "nope" }]).job!, addons, async () => ({ ok: true })), /no add-on nope/);
  await assert.rejects(runJob(parseJob([{ addon: "demo" }]).job!, addons, async () => ({ ok: true })), /rooms is required/);
});

test("results file name, automation step names and the one-line summary", () => {
  assert.equal(path.basename(jobResultFile("C:\\r", "kisic_relight", new Date(2026, 9, 19, 7, 5, 9))), "kisic_relight_2026-10-19_070509.json");
  assert.equal(addonStep("addon:qa_orphans"), "qa_orphans");
  assert.equal(addonStep("qa"), null);
  assert.equal(addonStep("addon:Bad"), null);
  assert.equal(addonSummary({ dry_run: true, placed: 4, skipped: ["a", "b"], rooms: [], note: "x" }), "dry_run true, placed 4, skipped 2");
  assert.equal(addonSummary(undefined), "done");
});

// The CLI runs the same tool code as the pane and a scheduled task. None of these calls reaches Revit: each is refused first.
function cli(args: unknown, guard: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-addons-"));
  const config = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(config, JSON.stringify({ reports_dir: dir, write_roots: [], ...guard }));
  const r = spawnSync(process.execPath, [CLI, "fmc_scripts"], { input: JSON.stringify(args), encoding: "utf8",
    env: { ...process.env, FMC_GUARD_CONFIG: config, REVIT_PORT: "1" } });
  return { code: r.status, body: r.stdout.trim() ? JSON.parse(r.stdout) : null, dir };
}

test("CLI: addon_list reads the add-ons shipped with this build", () => {
  const r = cli({ action: "addon_list" });
  assert.equal(r.code, 0);
  assert.equal(r.body.count, 3);
  assert.ok(r.body.folder.endsWith(path.join("build", "addons")), r.body.folder);
  assert.deepEqual(r.body.addons.map((a: any) => a.name), ["export_png_pdf", "qa_orphans", "strips_on_room_walls"]);
});

test("CLI: addon_run and job refuse bad parameters and write folders outside the rules before Revit", () => {
  const bad = cli({ action: "addon_run", name: "strips_on_room_walls", params: { rooms: [] } });
  assert.equal(bad.code, 1);
  assert.ok(bad.body.refused && bad.body.reasons.includes("rooms is required"));
  const none = cli({ action: "addon_run", name: "no_such_addon" });
  assert.ok(none.body.refused && none.body.reasons[0].includes("Saved add-ons: export_png_pdf"));
  const outside = cli({ action: "addon_run", name: "export_png_pdf", params: { views: ["A-101"], out_dir: "D:\\P\\02_Shared\\x" } });
  assert.ok(outside.body.refused && outside.body.reasons.some((x: string) => /^out_dir: Writing into 02_Shared/i.test(x)));
  const job = cli({ action: "job", job: { name: "t", steps: [{ addon: "export_png_pdf", params: { views: ["A-101"], out_dir: "D:\\P\\02_Shared\\x" } }, { addon: "nope" }] } });
  assert.ok(job.body.refused);
  assert.ok(job.body.reasons.some((x: string) => x.startsWith("Step 2: no add-on nope")));
  assert.ok(job.body.reasons.some((x: string) => x.startsWith("Step 1 (export_png_pdf): out_dir:")));
  const auto = cli({ action: "run", steps: ["addon:no_such_addon"] });
  assert.ok(auto.body.refused && auto.body.reasons.includes("No add-on no_such_addon"));
  const missingFile = cli({ action: "job", job_file: path.join(os.tmpdir(), "no-such-job.json") });
  assert.ok(missingFile.body.refused && missingFile.body.reasons[0].startsWith("Can't read the job file"));
});
