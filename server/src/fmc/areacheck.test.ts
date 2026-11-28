import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS, loadConfig } from "./policy.js";
import {
  buildChecks, chainLines, chooseSource, classify, judge, lineDistances, parseValues, polygonArea, segDist, summarize, usable,
  type CheckArgs, type Facts, type Line, type PlanningValue,
} from "./areacheck.js";
import { FMC_AREA_CHECK_SHAPE, loadValues, runFmcAreaCheck, type FmcAreaCheckArgs } from "../tools/fmc_area_check.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fmcarea-"));
const listAll = (dir: string): string[] => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? listAll(path.join(dir, d.name)) : [path.join(dir, d.name)]);

// ---------------------------------------------------------------------------------------------------------------
// FAKE FIXTURE VALUES. Every number below is an invented test value with the source "FAKE-TEST-ONLY". They are NOT
// planning law, not KCCA values and not from the kit. They exist so the tests can exercise pass and fail.
// ---------------------------------------------------------------------------------------------------------------
const fake = (key: string, value: number, unit: string, extra: Record<string, unknown> = {}) =>
  [key, { value, unit, source: "FAKE-TEST-ONLY", clause: "FAKE-1", status: "approved", ...extra }] as const;
function fakeValuesFile(over: Record<string, unknown> = {}) {
  return {
    schema: "fmc.planning_values/1", jurisdiction: "FAKE", authority: "FAKE", zone: "FAKE-ZONE", notice: "FAKE FIXTURE VALUES - NOT PLANNING LAW",
    values: Object.fromEntries([
      fake("plot_coverage.max_pct", 25, "%"), fake("plot_ratio.max", 0.35, "ratio"),
      fake("setback.front_min_m", 4.5, "m"), fake("setback.side_min_m", 3, "m"), fake("setback.rear_min_m", 10, "m"),
      fake("parking.residential", 1, "spaces", { basis: "per_dwelling_unit" }),
      fake("parking.office", 2, "spaces", { basis: "per_100_m2_gfa" }),
    ]),
    ...over,
  };
}
const fakeValues = () => parseValues(fakeValuesFile()).values;

// a 20 x 30 plot, a 10 x 12 footprint at x 5..15, y 4..16 (distances 4, 5, 14, 5), two levels of 120 and 110 m2
const rect = (x1: number, y1: number, x2: number, y2: number): [number, number][] => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
const plotLines = (): Line[] => [
  { n: 1, element_id: "900", curved: false, points: [[0, 0], [20, 0]] },
  { n: 2, element_id: "900", curved: false, points: [[20, 0], [20, 30]] },
  { n: 3, element_id: "900", curved: false, points: [[20, 30], [0, 30]] },
  { n: 4, element_id: "900", curved: false, points: [[0, 30], [0, 0]] },
];
function facts(over: Partial<Facts> = {}): Facts {
  return {
    document: "M1", area_schemes: ["Gross Building"],
    sources: {
      areas: {
        available: true, scheme: "Gross Building", total_m2: 230, count: 2, skipped_count: 1, skipped_ids: ["77"],
        levels: [
          { level: "L1", level_id: "10", elevation_m: 0, area_m2: 120, count: 1, element_ids: ["101"] },
          { level: "L2", level_id: "11", elevation_m: 3, area_m2: 110, count: 1, element_ids: ["102"] },
        ],
        footprint: { found: true, level: "L1", level_id: "10", area_m2: 120, loops: [{ element_id: "101", points: rect(5, 4, 15, 16) }] } as never,
      },
      rooms: { available: false, problem: "No rooms with an area." },
      floors: { available: false, problem: "No floors with an area." },
    },
    named_areas: [], property_lines: { elements: [{ id: "900", name: "Property Line", curves: 4 }], lines: plotLines() },
    parking: { count: 10, by_type: [{ type: "Bay : 2.5x5", count: 10 }], element_ids: ["1", "2"] },
    ...over,
  };
}
const args = (over: Partial<CheckArgs> = {}): CheckArgs => ({
  source: "auto", use: "", front_segments: [], side_segments: [], rear_segments: [], zone: "", plot_area_name: "", ...over,
});
const byName = (r: ReturnType<typeof buildChecks>, name: string) => r.checks.find((c) => c.check === name)!;

test("values file: good entries kept, bad ones dropped and listed, nothing invented", () => {
  const v = parseValues({ schema: "fmc.planning_values/1", zone: "Z", values: {
    "plot_ratio.max": { value: 2, unit: "ratio", source: "S", clause: "C", status: "Approved" },
    "plot_coverage.max_pct": { value: "sixty" },
    "setback.front_min_m": "3",
    "colour.red": { value: 1 },
    "parking.residential": { value: 1, basis: "per_dwelling_unit" },
    "parking.office": { value: 1, basis: "per_planet" },
  } });
  assert.deepEqual(Object.keys(v.values).sort(), ["parking.residential", "plot_ratio.max"]);
  assert.equal(v.values["plot_ratio.max"].status, "approved");
  assert.equal(v.problems.length, 4);
  assert.match(v.problems.join(" | "), /plot_coverage\.max_pct: value must be a number/);
  assert.match(v.problems.join(" | "), /colour\.red: not a key this tool uses/);
  assert.match(v.problems.join(" | "), /basis must be one of/);
  assert.deepEqual(parseValues("nope").values, {});
  assert.deepEqual(parseValues({ schema: "other/9", values: {} }).problems.length, 1);
});

test("status model: provisional never decides; approved or draft needs a source and a clause", () => {
  const e = (o: Partial<PlanningValue>): PlanningValue => ({ key: "plot_ratio.max", value: 1, unit: "", source: "S", clause: "C", status: "approved", ...o });
  assert.equal(usable(e({})).ok, true);
  assert.equal(usable(e({ status: "draft" })).ok, true);
  assert.match(usable(e({ status: "provisional" })).why, /provisional/);
  assert.match(usable(e({ status: "" })).why, /no status/);
  assert.match(usable(e({ clause: "" })).why, /no clause/);
  assert.match(usable(e({ source: "" })).why, /no source/);
  assert.equal(judge(0.5, e({}), "max").result, "pass");
  assert.equal(judge(1, e({}), "max").result, "pass");
  assert.equal(judge(1.01, e({}), "max").result, "fail");
  assert.equal(judge(3, e({}), "min").result, "pass");
  assert.equal(judge(0.5, e({ status: "provisional" }), "max").result, "unknown");
  const none = judge(0.5, undefined, "max");
  assert.equal(none.result, "unknown");
  assert.equal(none.limit, null);
  assert.equal(none.limit_status, "no_limit_configured");
  assert.match(none.reason, /no limit configured/);
});

test("geometry: polygon area, segment distance, crossing, closing the property line", () => {
  assert.equal(polygonArea(rect(0, 0, 20, 30)), 600);
  assert.equal(segDist([0, 0], [10, 0], [0, 4], [10, 4]), 4);
  assert.equal(segDist([0, 0], [10, 10], [0, 10], [10, 0]), 0);
  assert.ok(Math.abs(segDist([0, 0], [1, 0], [4, 4], [4, 8]) - 5) < 1e-9);
  const c = chainLines([plotLines()[0], plotLines()[2], plotLines()[1], plotLines()[3]]);
  assert.equal(c.loops.length, 1);
  assert.equal(c.open.length, 0);
  assert.equal(polygonArea(c.loops[0]), 600);
  const gap = chainLines(plotLines().slice(0, 3));
  assert.equal(gap.loops.length, 0);
  assert.deepEqual(gap.open.sort(), [1, 2, 3]);
  assert.deepEqual(lineDistances([rect(5, 4, 15, 16)], plotLines()).map((d) => d.min_distance_m), [4, 5, 14, 5]);
});

test("GFA source: areas first, then rooms, then floors, and it says why; a forced source without data is a problem", () => {
  const f = facts();
  assert.equal(chooseSource(f, "auto").used, "areas");
  f.sources.areas = { available: false, problem: "The model has no area schemes (no Area Plans)." };
  f.sources.rooms = { available: true, total_m2: 90, levels: [], count: 3 };
  let c = chooseSource(f, "auto");
  assert.equal(c.used, "rooms");
  assert.match(c.why.join(" "), /areas: The model has no area schemes/);
  f.sources.rooms = { available: false, problem: "none" };
  f.sources.floors = { available: true, total_m2: 80, levels: [], count: 1 };
  assert.equal(chooseSource(f, "auto").used, "floors");
  c = chooseSource(f, "rooms");
  assert.equal(c.used, null);
  assert.match(c.problem, /rooms was asked for but has no data/);
  f.sources.floors = { available: false, problem: "none" };
  assert.match(chooseSource(f, "auto").problem, /no areas, rooms or floors/);
});

test("full check with FAKE values: coverage, ratio, setbacks (rear and sides inferred) and parking", () => {
  const r = buildChecks(facts(), args({ front_segments: [1], use: "residential", units: 12 }), fakeValues());
  const gfa = byName(r, "gfa");
  assert.equal(gfa.value, 230);
  assert.equal((gfa.evidence as any).source, "areas");
  assert.match(gfa.assumptions.join(" "), /1 element\(s\) have no area/);
  assert.equal(byName(r, "plot_area").value, 600);
  assert.equal((byName(r, "plot_area").evidence as any).property_line_area_m2, 600);
  const cov = byName(r, "plot_coverage");
  assert.equal(cov.value, 20);
  assert.equal(cov.result, "pass");
  assert.equal(cov.limit!.source, "FAKE-TEST-ONLY");
  assert.equal(cov.limit!.clause, "FAKE-1");
  const ratio = byName(r, "plot_ratio");
  assert.equal(ratio.value, 0.383);
  assert.equal(ratio.result, "fail");
  assert.equal(byName(r, "setback_front").value, 4);
  assert.equal(byName(r, "setback_front").result, "fail");
  assert.equal(byName(r, "setback_side").value, 5);
  assert.equal(byName(r, "setback_side").result, "pass");
  assert.equal(byName(r, "setback_rear").value, 14);
  assert.equal(byName(r, "setback_rear").result, "pass");
  assert.equal((byName(r, "setback_rear").evidence as any).classified_by, "inferred");
  assert.match(byName(r, "setback_rear").assumptions.join(" "), /INFERRED/);
  assert.equal(byName(r, "setback_overall").value, 4);
  const p = byName(r, "parking");
  assert.equal(p.value, 10);
  assert.equal(p.result, "fail");
  assert.equal(p.limit!.value, 12);
  assert.equal((p.evidence as any).required, 12);
  assert.deepEqual((p.evidence as any).element_ids, ["1", "2"]);
  assert.deepEqual(summarize(r.checks), { pass: 3, fail: 3, unknown: 3 });
});

test("with no values at all every limit is 'no limit configured', never pass or fail, and the numbers are still computed", () => {
  const r = buildChecks(facts(), args({ front_segments: [1], use: "residential", units: 12 }), {});
  for (const name of ["plot_coverage", "plot_ratio", "setback_front", "setback_side", "setback_rear", "parking"]) {
    const c = byName(r, name);
    assert.equal(c.result, "unknown", name);
    assert.equal(c.limit, null, name);
    assert.equal(c.limit_status, "no_limit_configured", name);
    assert.match(c.reason, /no limit configured/, name);
  }
  assert.equal(byName(r, "plot_coverage").value, 20);
  assert.equal(byName(r, "setback_front").value, 4);
  assert.equal(summarize(r.checks).pass, 0);
  assert.equal(summarize(r.checks).fail, 0);
});

test("provisional values, or ones without a clause, never pass or fail", () => {
  const v = parseValues(fakeValuesFile({ values: Object.fromEntries([
    fake("plot_coverage.max_pct", 25, "%", { status: "provisional" }),
    fake("plot_ratio.max", 0.35, "ratio", { clause: "" }),
  ]) })).values;
  const r = buildChecks(facts(), args(), v);
  assert.equal(byName(r, "plot_coverage").result, "unknown");
  assert.equal(byName(r, "plot_coverage").limit_status, "not_usable");
  assert.match(byName(r, "plot_coverage").reason, /provisional/);
  assert.equal(byName(r, "plot_ratio").result, "unknown");
  assert.match(byName(r, "plot_ratio").reason, /no clause/);
});

test("plot area: input beats a named area beats the property line; ambiguity and open lines are unknown, not guessed", () => {
  const f = facts({ named_areas: [{ id: "5", name: "Plot", scheme: "Site", level: "L1", placed: true, area_m2: 590 }] });
  let r = buildChecks(f, args({ plot_area_m2: 500, plot_area_name: "Plot" }), {});
  assert.equal(byName(r, "plot_area").value, 500);
  assert.equal((byName(r, "plot_area").evidence as any).input_m2, 500);
  assert.match(byName(r, "plot_area").assumptions.join(" "), /differs from the property-line area/);
  r = buildChecks(f, args({ plot_area_name: "Plot" }), {});
  assert.equal(byName(r, "plot_area").value, 590);
  r = buildChecks(f, args(), {});
  assert.equal(byName(r, "plot_area").value, 600);
  const two = facts({ named_areas: [{ id: "5", name: "Plot", scheme: "A", level: "L1", placed: true, area_m2: 1 }, { id: "6", name: "Plot", scheme: "B", level: "L1", placed: true, area_m2: 2 }] });
  r = buildChecks(two, args({ plot_area_name: "Plot" }), {});
  assert.equal(byName(r, "plot_area").value, null);
  assert.match(byName(r, "plot_area").reason, /2 placed areas are named/);
  assert.equal(byName(r, "plot_coverage").result, "unknown");
  const open = facts(); open.property_lines!.lines = plotLines().slice(0, 3);
  r = buildChecks(open, args(), fakeValues());
  assert.equal(byName(r, "plot_area").value, null);
  assert.match(byName(r, "plot_area").reason, /do not close into one loop/);
  assert.equal(byName(r, "plot_coverage").result, "unknown");
  assert.equal(byName(r, "plot_ratio").result, "unknown");
  const none = facts(); none.property_lines = { elements: [], lines: [] };
  r = buildChecks(none, args(), fakeValues());
  assert.match(byName(r, "plot_area").reason, /no Property Line/);
  assert.match(byName(r, "setback_front").reason, /no Property Line/);
});

test("setback sides: as given; inferred only for a four straight sides plot; otherwise unknown with the reason", () => {
  const lines = plotLines();
  const given = classify(lines, { front_segments: [1], side_segments: [2], rear_segments: [3] });
  assert.deepEqual([given.front, given.side, given.rear, given.inferred], [[1], [2], [3], false]);
  const inferred = classify(lines, { front_segments: [2], side_segments: [], rear_segments: [] });
  assert.deepEqual([inferred.rear, inferred.side.sort(), inferred.inferred], [[4], [1, 3], true]);
  const two = classify(lines, { front_segments: [1, 2], side_segments: [], rear_segments: [] });
  assert.equal(two.inferred, false);
  assert.match(two.note, /cannot be inferred/);
  const none = classify(lines, { front_segments: [], side_segments: [], rear_segments: [] });
  assert.match(none.note, /no segments were classified/);
  assert.match(classify(lines, { front_segments: [9], side_segments: [], rear_segments: [] }).note, /Segment numbers not found: 9/);
  const curved = plotLines(); curved[1].curved = true;
  assert.equal(classify(curved, { front_segments: [1], side_segments: [], rear_segments: [] }).inferred, false);
  const r = buildChecks(facts(), args(), fakeValues());
  assert.equal(byName(r, "setback_front").result, "unknown");
  assert.match(byName(r, "setback_front").reason, /not identified/);
  assert.equal(byName(r, "setback_overall").value, 4);
});

test("setbacks: a footprint over the boundary is reported (distance 0 and points outside the plot)", () => {
  const f = facts();
  f.sources.areas!.footprint!.loops = [{ element_id: "101", points: rect(-1, 4, 15, 16) }];
  const r = buildChecks(f, args({ front_segments: [4], side_segments: [1], rear_segments: [2] }), fakeValues());
  assert.equal(byName(r, "setback_front").value, 0);
  assert.equal(byName(r, "setback_front").result, "fail");
  assert.ok((byName(r, "setback_overall").evidence as any).footprint_points_outside_plot > 0);
  assert.match(byName(r, "setback_front").assumptions.join(" "), /outside the plot polygon/);
});

test("parking: needs a use, a rule and a base; rounds up; input overrides the model count; per GFA uses the GFA source", () => {
  let r = buildChecks(facts(), args(), fakeValues());
  assert.match(byName(r, "parking").reason, /no use was given/);
  assert.equal(byName(r, "parking").result, "unknown");
  r = buildChecks(facts(), args({ use: "school" }), fakeValues());
  assert.match(byName(r, "parking").reason, /no limit configured for parking for the use "school"/);
  r = buildChecks(facts(), args({ use: "residential" }), fakeValues());
  assert.match(byName(r, "parking").reason, /pass units/);
  assert.equal(byName(r, "parking").result, "unknown");
  r = buildChecks(facts(), args({ use: "office", parking_provided: 5 }), fakeValues());
  assert.equal((byName(r, "parking").evidence as any).required, 5);
  assert.equal(byName(r, "parking").result, "pass");
  assert.equal((byName(r, "parking").evidence as any).provided_from, "input");
  r = buildChecks(facts(), args({ use: "office", parking_provided: 4 }), fakeValues());
  assert.equal(byName(r, "parking").result, "fail");
  assert.match(byName(r, "parking").assumptions.join(" "), /rounded UP to a whole space \(5\)/);
  const pv = parseValues(fakeValuesFile({ values: Object.fromEntries([fake("parking.residential", 1.5, "spaces", { basis: "per_dwelling_unit", status: "provisional" })]) })).values;
  r = buildChecks(facts(), args({ use: "residential", units: 3, parking_provided: 99 }), pv);
  assert.equal(byName(r, "parking").result, "unknown");
});

test("floors and rooms are used, and flagged as such, when there are no areas", () => {
  const f = facts();
  f.sources.areas = { available: false, problem: "The model has no area schemes (no Area Plans)." };
  f.sources.floors = { available: true, total_m2: 200, count: 4, levels: [], footprint: { found: true, level: "L1", area_m2: 100, loops: [{ element_id: "8", points: rect(5, 4, 15, 14) }] } };
  const r = buildChecks(f, args(), fakeValues());
  assert.equal(r.source.used, "floors");
  assert.equal(byName(r, "gfa").value, 200);
  assert.match(byName(r, "gfa").assumptions.join(" "), /not a gross-area scheme/);
  assert.match(JSON.stringify(byName(r, "gfa").evidence), /areas: The model has no area schemes/);
  assert.equal(byName(r, "plot_coverage").value, round(100 / 600 * 100));
  const none = facts(); none.sources = { areas: { available: false, problem: "x" }, rooms: { available: false }, floors: { available: false } };
  const r2 = buildChecks(none, args(), fakeValues());
  assert.equal(byName(r2, "gfa").value, null);
  assert.equal(byName(r2, "plot_ratio").result, "unknown");
  assert.match(byName(r2, "gfa").reason, /no areas, rooms or floors/);
});
function round(n: number) { return Math.round(n * 100) / 100; }

// ------------------------------------------------------------------ the tool

function toolArgs(over: Partial<FmcAreaCheckArgs> = {}): FmcAreaCheckArgs {
  return FMC_AREA_CHECK_SHAPE_PARSE(over);
}
function FMC_AREA_CHECK_SHAPE_PARSE(over: Record<string, unknown>): FmcAreaCheckArgs {
  const out: Record<string, unknown> = {};
  for (const [k, schema] of Object.entries(FMC_AREA_CHECK_SHAPE)) out[k] = (schema as any).parse(over[k]);
  return out as FmcAreaCheckArgs;
}
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const guardFor = (dir: string) => {
  const file = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(file, JSON.stringify({ write_roots: [path.join(dir, "Projects")], reports_dir: path.join(dir, "reports"), specs_path: path.join(dir, "kit", "03_Master_Data", "FMC_Family_Specs.json") }));
  return loadConfig(file).config;
};

test("the tool reads a values file by path, by env, or from the kit folder; with none it says where it looked and what is needed", async () => {
  const dir = temp();
  const file = path.join(dir, "fake_values.json");
  fs.writeFileSync(file, JSON.stringify(fakeValuesFile()));
  const before = listAll(dir).sort();
  const send = async () => facts();
  const a = parse(await runFmcAreaCheck(toolArgs({ values_file: file, use: "residential", units: 12, front_segments: [1] }), { send, env: {} }));
  assert.equal(a.planning_values.found, true);
  assert.equal(a.planning_values.zone, "FAKE-ZONE");
  assert.match(a.planning_values.notice, /FAKE FIXTURE VALUES/);
  assert.deepEqual(a.summary, { pass: 3, fail: 3, unknown: 3 });
  assert.equal(a.model_changed, false);
  assert.equal(a.read_only, true);
  const guard = guardFor(dir);
  const viaEnv = parse(await runFmcAreaCheck(toolArgs(), { send, env: { FMC_PLANNING_VALUES_FILE: file }, guard }));
  assert.equal(viaEnv.planning_values.file, file);
  // the kit folder
  const kit = path.join(dir, "kit", "03_Master_Data");
  const none = parse(await runFmcAreaCheck(toolArgs(), { send, env: {}, guard }));
  assert.equal(none.planning_values.found, false);
  assert.equal(none.planning_values.values_loaded.length, 0);
  assert.ok(none.planning_values.where_looked.some((w: string) => w.includes(path.join(kit, "FMC_Planning_Values.json"))));
  assert.deepEqual(none.planning_values.values_missing, ["plot_coverage.max_pct", "plot_ratio.max", "setback.front_min_m", "setback.side_min_m", "setback.rear_min_m", "parking.<use>"]);
  assert.match(none.notes.join(" "), /no limit configured/);
  assert.equal(none.summary.pass + none.summary.fail, 0);
  assert.ok(none.needed_values.length >= 6);
  fs.mkdirSync(kit, { recursive: true });
  fs.writeFileSync(path.join(kit, "FMC_Planning_Values.json"), JSON.stringify(fakeValuesFile()));
  const kitFile = fs.readdirSync(kit).length;
  const viaKit = parse(await runFmcAreaCheck(toolArgs(), { send, env: {}, guard }));
  assert.equal(viaKit.planning_values.file, path.join(kit, "FMC_Planning_Values.json"));
  assert.equal(viaKit.planning_values.values_missing.length, 0);
  assert.equal(fs.readdirSync(kit).length, kitFile, "the tool wrote into the kit folder");
  assert.deepEqual(listAll(dir).filter((f) => !f.includes(`${path.sep}kit${path.sep}`)).sort().filter((f) => !before.includes(f)), [path.join(dir, "fmc_guard.json")]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a bad file, a wrong zone, a bad id or a bad reply never turns into a pass", async () => {
  const dir = temp();
  const bad = path.join(dir, "bad.json"); fs.writeFileSync(bad, "{ not json");
  const send = async () => facts();
  const a = parse(await runFmcAreaCheck(toolArgs({ values_file: bad }), { send, env: {} }));
  assert.match(a.notes.join(" "), /not valid JSON/);
  assert.equal(a.summary.pass + a.summary.fail, 0);
  const wrong = path.join(dir, "v.json"); fs.writeFileSync(wrong, JSON.stringify(fakeValuesFile()));
  const z = parse(await runFmcAreaCheck(toolArgs({ values_file: wrong, zone: "OTHER" }), { send, env: {} }));
  assert.match(z.notes.join(" "), /none of its values were used/);
  assert.equal(z.summary.pass + z.summary.fail, 0);
  const notJson = parse(await runFmcAreaCheck(toolArgs({ values_file: path.join(dir, "v.txt") }), { send, env: {} }));
  assert.match(notJson.notes.join(" "), /must be a \.json file/);
  const id = await runFmcAreaCheck(toolArgs({ property_line_ids: ["x"] }), { send, env: {} });
  assert.equal(id.isError, true);
  assert.match(id.content[0].text, /FMC-AREA-IDS/);
  const empty = await runFmcAreaCheck(toolArgs(), { send: async () => ({}), env: {} });
  assert.match(empty.content[0].text, /FMC-AREA-BAD-REPLY/);
  const thrown = await runFmcAreaCheck(toolArgs(), { send: async () => { throw new Error("fmc_area_check: [FMC-DOC-NOT-FOUND] No open document"); }, env: {} });
  assert.match(thrown.content[0].text, /FMC-DOC-NOT-FOUND/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the request to Revit carries only what Revit needs; the values never go to Revit", async () => {
  let body: Record<string, unknown> = {};
  await runFmcAreaCheck(toolArgs({ document: " M1 ", area_scheme: "Gross Building", footprint_level: "L1", plot_area_name: "Plot", property_line_ids: [900, "901"], plot_area_m2: 500 }), { send: async (b) => { body = b; return facts(); }, env: {} });
  assert.deepEqual(body, { document: "M1", area_scheme: "Gross Building", footprint_level: "L1", plot_area_name: "Plot", property_line_ids: ["900", "901"] });
  assert.equal(loadValues({ values_file: "" }, {}, undefined).found, false);
});

test("registry: command.json, the policy read list and the docs know fmc_area_check; it is not a write", () => {
  const cmds = JSON.parse(read("command.json"));
  const list = (cmds.commands ?? cmds) as Array<{ commandName: string; assemblyPath: string }>;
  assert.equal(list.find((c) => c.commandName === "fmc_area_check")?.assemblyPath, "RevitMCPCommandSet.dll");
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_area_check"));
  assert.ok(!WRITE_COMMANDS.has("fmc_area_check"));
  const doc = read("docs/tools/fmc_area_check.md");
  for (const k of ["plot_coverage.max_pct", "plot_ratio.max", "setback.front_min_m", "setback.side_min_m", "setback.rear_min_m", "parking.<use>", "no limit configured", "fmc.planning_values/1", "FMC_PLANNING_VALUES_FILE"]) assert.ok(doc.includes(k), `docs miss ${k}`);
});

test("the planning limits are not in the source: no planning number is built into the tool or the add-in", () => {
  const ts = [read("server/src/fmc/areacheck.ts"), read("server/src/tools/fmc_area_check.ts")].join("\n");
  const code = ts.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /\b(?:coverage|ratio|setback|parking)\w*\s*[:=]\s*[0-9]/i);
  assert.doesNotMatch(code, /FAKE/);
  assert.doesNotMatch(code, /KCCA\s*[:=]/);
});

test("the Revit side (source): no transaction, nothing created or set, no writes, no network", () => {
  const src = ["commandset/Services/Fmc/FmcAreaFacts.cs", "commandset/Services/Fmc/FmcAreaCheckHandler.cs", "commandset/Commands/Fmc/FmcAreaCheckCommand.cs"].map(read).join("\n");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/\/|\/\/)/.test(l)).join("\n");
  assert.doesNotMatch(code, /new\s+(Transaction|TransactionGroup|SubTransaction)\b|\.Start\(\)|\.Commit\(\)/);
  assert.doesNotMatch(code, /\.Create\(|\.Delete\(|DeleteElements|\.SetParameter\(|\.Set\(\s*[^)]|\.Regenerate\(|SaveAs|Synchronize|File\.|StreamWriter|HttpClient|WebClient|NewArea|NewRoom|\.Name\s*=[^=]|\.Location\s*=/);
  for (const call of ["OST_Areas", "OST_Rooms", "OST_Floors", "OST_SiteProperty", "OST_Parking", "AreaScheme", "GetBoundarySegments(", "HOST_AREA_COMPUTED", "GetTopFaces(", "Tessellate()"]) assert.ok(code.includes(call), `the add-in never uses ${call}`);
  assert.doesNotMatch(code, /[0-9]+\s*%|coverage|plot ratio|setback/i, "a planning word or number leaked into the add-in");
  assert.match(code, /CommandName => "fmc_area_check"/);
  assert.match(code, /mayOpen:\s*false/);
  assert.match(code, /\["model_changed"\] = false/);
});
