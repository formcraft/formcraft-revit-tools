import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { resolve, type StandardsFile } from "./standards.js";
import {
  CHECKLIST, DB_SCHEMA, FORM_FIELDS, TBC, buildRecord, emptyDb, fieldsFromModel, formView, kitLookup, mergeFields, nextId, parseDb,
  registerReport, seismicResult, toGeoJson, toHtml, toMarkdown, upsert, validateInput, type Field, type ModelFacts,
} from "./seismic.js";
import { runFmcSeismicScreen, databasePath, writeGate, type FmcSeismicArgs } from "../tools/fmc_seismic_screen.js";

/** The kit's seismic.* entries as the standards bank holds them (FMC_Standards_Building.json 0.5-proposed, US 319:2003). */
const KIT: StandardsFile = {
  version: "0.5-proposed", status: "proposed: typical design values",
  standards: {
    "seismic.applies_to": { value: ["floor area > 20 m2", "height > 5 m", "masonry/concrete walls > 1.5 m", "public buildings"], unit: "list", note: "US 319:2003 cl 1.1", status: "proposed" },
    "seismic.zone_factor": { value: { zone_1: 1, zone_2: 0.8, zone_3: 0.7, kampala: "on the zone 2/3 boundary (Fig 2): use zone 2, 0.8" }, unit: "factor", note: "US 319:2003 cl 9.1.6", status: "proposed" },
    "seismic.basic_coefficient": { value: { plateau_C: 0.08, plateau_to_T_s: { I_rock_stiff: 0.4, II_medium: 0.5, III_soft: 1 }, beyond: "falls about 1/T: 0.03-0.04 at 1 s (I, II)" }, unit: "coefficient", status: "proposed" },
    "seismic.subsoil": { value: { I: "rock", III: "deep soft soils", II: "all other sites" }, unit: "text", status: "proposed" },
    "seismic.importance": { value: { hospitals_power: 1.5, schools_halls: 1.5, minor_agricultural: 1, high_risk: 2, dwellings: "not listed: 1.0 assumed, engineer to confirm" }, unit: "factor", status: "proposed" },
    "seismic.performance_K": { value: { ductile_moment_frame: 1, frame_with_rc_shear_walls: 1, frame_with_rc_infill: 1.5, frame_with_masonry_infill: 2, minimal_ductility: 4 }, unit: "factor", status: "proposed" },
    "seismic.coefficient": { value: "Cd = C.Z.I.K; V = Cd.Wt; Fi = V.Wi.hi / sum(Wi.hi); T1 = 0.06H for RC frames", unit: "formula", status: "proposed" },
    "seismic.foundation_ties": { value: "foundations tied both ways", unit: "rule", status: "proposed" },
    "seismic.wall_anchorage": { value: "walls anchored to floors and roof", unit: "rule", status: "proposed" },
    "seismic.principles": { value: ["clear load path", "symmetry, avoid re-entrant corners"], unit: "list", status: "proposed" },
  },
};
const kit = kitLookup(resolve(KIT, null));
const noKit = kitLookup(resolve(null, null));

const masonry = [{ function: "Structure", material: "Masonry - Concrete Block", class: "Masonry" }];
const FACTS: ModelFacts = {
  from: "SAMPLE-FMC-ZZ-ZZ-M3-A-0001",
  levels: [{ name: "B1", elevation_mm: -3000 }, { name: "L0", elevation_mm: 0 }, { name: "L1", elevation_mm: 3200 }, { name: "Roof", elevation_mm: 6400 }],
  walls: [
    { type: "Block 200", length_mm: 10000, height_mm: 3200, base_level: "L0", start_mm: [0, 0, 0], end_mm: [10000, 0, 0], layers: masonry },
    { type: "Block 200", length_mm: 6000, height_mm: 3200, base_level: "L1", start_mm: [10000, 0, 0], end_mm: [10000, 6000, 0], layers: masonry },
    { type: "Block 200", length_mm: 6000, height_mm: 1200, base_level: "L0", start_mm: [0, 6000, 0], end_mm: [0, 0, 0], layers: masonry },
    { type: "Curtain", length_mm: 20000, height_mm: 6000, base_level: "L0", start_mm: [0, 6000, 0], end_mm: [10000, 6000, 0], layers: [{ function: "Structure", material: "Glass" }] },
  ],
  floors: [{ level: "B1", area_m2: 60 }, { level: "L0", area_m2: 60 }, { level: "L1", area_m2: 60 }],
  roofs: [{ level: "Roof", area_m2: 70, plan_max_mm: [10000, 6000, 7100] }],
  rooms: [{ level: "L0", area_m2: 50 }, { level: "L1", area_m2: 52.5 }],
  columns: [{ material: "Concrete C25/30" }, { material: "Concrete C25/30" }],
  framing: [{}, {}, {}],
  foundations: [{}],
};

const fieldsWith = (values: Record<string, unknown>): Record<string, Field> =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, source: "user" as const }]));

test("the form's seismic choices are the kit's own keys, and a missing kit gives none", () => {
  const f = formView(kit);
  const zone = f.fields.find((x) => x.key === "seismic_zone")!;
  assert.deepEqual(zone.choices, ["zone_1", "zone_2", "zone_3", "kampala"]);
  assert.deepEqual(f.fields.find((x) => x.key === "structural_system")!.choices?.includes("frame_with_masonry_infill"), true);
  assert.equal(f.checklist.length, CHECKLIST.length);
  assert.deepEqual(formView(noKit).fields.find((x) => x.key === "seismic_zone")!.choices, []);
});

test("model fields: storeys, height, areas, plan, walls and members, each with its rule", () => {
  const m = fieldsFromModel(FACTS, kit);
  assert.equal(m.model_name.value, "SAMPLE-FMC-ZZ-ZZ-M3-A-0001");
  assert.equal(m.storeys_above_ground.value, 2);
  assert.equal(m.basement_levels.value, 1);
  assert.equal(m.height_m.value, 7.1, "roof top 7100 above L0");
  assert.equal(m.gross_floor_area_m2.value, 180);
  assert.equal(m.rooms_area_m2.value, 102.5);
  assert.deepEqual([m.plan_length_m.value, m.plan_width_m.value, m.plan_aspect_ratio.value], [10, 6, 1.67]);
  assert.equal(m.main_wall_material.value, "masonry", "glazing is left out even when it is the longest");
  assert.equal(m.masonry_concrete_walls_tall.value, 2, "the 1.2 m wall is under the kit's 1.5 m");
  assert.match(String(m.masonry_concrete_walls_tall.basis), /masonry\/concrete walls > 1\.5 m/);
  assert.deepEqual([m.structural_columns.value, m.structural_beams.value, m.foundations.value], [2, 3, 1]);
  assert.deepEqual(m.column_materials.value, ["Concrete C25/30"]);
  assert.equal(m.system_hint.value, "frame_with_masonry_infill");
  for (const f of FORM_FIELDS.filter((x) => x.from === "model")) assert.ok(m[f.key].source === "model" || m[f.key].source === "TBC", f.key);
});

test("no model: every model field is TBC with the reason; no kit: the wall count is TBC, never a code value", () => {
  const m = fieldsFromModel(null, kit, "model not reachable");
  assert.ok(Object.values(m).every((f) => f.value === TBC && f.source === "TBC" && f.basis === "model not reachable"));
  const k = fieldsFromModel(FACTS, noKit);
  assert.equal(k.masonry_concrete_walls_tall.value, TBC);
  assert.equal(k.system_hint.value, TBC, "a hint only names a key the kit lists");
});

test("Cd = C·Z·I·K from kit values only: a school frame on medium soil", () => {
  const s = seismicResult(fieldsWith({ height_m: 7.2, gross_floor_area_m2: 640, masonry_concrete_walls_tall: 4, public_building: "yes",
    seismic_zone: "zone_2", subsoil_class: "II", importance_class: "schools_halls", structural_system: "frame_with_masonry_infill" }), kit);
  assert.deepEqual([s.Z, s.I, s.K, s.T1_s, s.C, s.Cd], [0.8, 1.5, 2, 0.43, 0.08, 0.192]);
  assert.equal(s.applies, "yes");
  assert.equal(s.criteria.length, 4);
  assert.match(s.notes.join(" "), /proposed/);
});

test("values the kit gives in words, past the plateau, or for systems without a kit period are TBC", () => {
  const dwelling = seismicResult(fieldsWith({ height_m: 6, seismic_zone: "kampala", subsoil_class: "I", importance_class: "dwellings", structural_system: "ductile_moment_frame" }), kit);
  assert.equal(dwelling.I, TBC);
  assert.equal(dwelling.Z, TBC, "the kampala entry is a sentence, not a number");
  assert.match(dwelling.notes.join(" "), /use zone 2, 0\.8/);
  assert.equal(dwelling.Cd, TBC);
  const tall = seismicResult(fieldsWith({ height_m: 20, seismic_zone: "zone_2", subsoil_class: "I", importance_class: "high_risk", structural_system: "ductile_moment_frame" }), kit);
  assert.deepEqual([tall.T1_s, tall.C, tall.Cd], [1.2, TBC, TBC]);
  assert.match(tall.notes.join(" "), /past the plateau/);
  const wall = seismicResult(fieldsWith({ height_m: 4, seismic_zone: "zone_1", subsoil_class: "II", importance_class: "high_risk", structural_system: "minimal_ductility" }), kit);
  assert.deepEqual([wall.K, wall.T1_s, wall.C], [4, TBC, TBC]);
  const none = seismicResult(fieldsWith({ height_m: 7, seismic_zone: "zone_2", subsoil_class: "II", importance_class: "schools_halls", structural_system: "frame_with_masonry_infill" }), noKit);
  assert.deepEqual([none.Z, none.C, none.I, none.K, none.Cd, none.applies, none.kit_status], [TBC, TBC, TBC, TBC, TBC, TBC, "missing"]);
});

test("the kit, not the code, sets every factor: change the kit and the result follows", () => {
  const other: StandardsFile = JSON.parse(JSON.stringify(KIT));
  (other.standards["seismic.zone_factor"].value as Record<string, number>).zone_2 = 0.5;
  (other.standards["seismic.basic_coefficient"].value as Record<string, unknown>).plateau_C = 0.1;
  (other.standards["seismic.applies_to"].value as string[])[1] = "height > 9 m";
  const s = seismicResult(fieldsWith({ height_m: 7.2, gross_floor_area_m2: 10, masonry_concrete_walls_tall: 0, public_building: "no", seismic_zone: "zone_2", subsoil_class: "II", importance_class: "schools_halls", structural_system: "frame_with_masonry_infill" }), kitLookup(resolve(other, null)));
  assert.deepEqual([s.Z, s.C, s.Cd, s.applies], [0.5, 0.1, 0.15, "no"]);
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "fmc", "seismic.ts"), "utf8");
  const logic = src.slice(0, src.indexOf("export const DEMO_INPUTS"));
  assert.doesNotMatch(logic, /\b0\.08\b|\b0\.8\b|\b0\.06\b/, "no US 319 value is written in the logic");
});

test("what the person types wins over the model and the model's value is kept; null clears to TBC", () => {
  const m = fieldsFromModel(FACTS, kit);
  const f = mergeFields(m, undefined, { storeys_above_ground: 3, building_name: "Sample block", height_m: null });
  assert.deepEqual([f.storeys_above_ground.value, f.storeys_above_ground.source, f.storeys_above_ground.model_value], [3, "user", 2]);
  assert.equal(f.building_name.source, "user");
  assert.deepEqual([f.height_m.value, f.height_m.source], [TBC, "TBC"]);
  assert.equal(f.district.value, TBC);
});

test("input check: unknown fields, choices the kit doesn't list, bad answers, dates and coordinates", () => {
  const p = validateInput({ fields: { colour: "red", seismic_zone: "zone_9", gps_lat: 123, screened_on: "9 Dec", public_building: "maybe" }, checklist: { soft_storey: "perhaps" as never, nope: "yes" } }, kit);
  assert.equal(p.length, 7, p.join("\n"));
  assert.deepEqual(validateInput({ fields: { seismic_zone: "zone_2", gps_lat: 0.31, screened_on: "2026-12-09" }, checklist: { soft_storey: "no" } }, kit), []);
});

test("records: versions and history, concerns and TBC, ids, upsert never drops a record", () => {
  const now = new Date("2026-11-28T08:00:00Z");
  let db = emptyDb(now);
  const a = buildRecord({ id: nextId(db), modelFields: fieldsFromModel(FACTS, kit), model: { name: "S", read_at: now.toISOString() }, input: { fields: { building_name: "A" }, checklist: { soft_storey: "yes", foundation_ties: "no", qualified_professional: "yes" } }, kit, now, by: "ai" });
  assert.equal(a.id, "SS-0001");
  assert.deepEqual(a.concerns, ["soft_storey", "foundation_ties"]);
  assert.ok(a.tbc.includes("seismic_zone") && a.tbc.includes("seismic.Cd") && a.tbc.includes("checklist.plan_irregular"));
  db = upsert(db, a, now);
  const a2 = buildRecord({ id: a.id, previous: a, modelFields: a.fields, model: null, input: { fields: { seismic_zone: "zone_2" } }, kit, now, by: "person" });
  assert.equal(a2.version, 2);
  assert.deepEqual(a2.history.at(-1)?.changed, ["seismic_zone"]);
  assert.equal(a2.fields.building_name.value, "A");
  db = upsert(db, a2, now);
  assert.deepEqual([db.records.length, db.revision, nextId(db), nextId(db, true)], [1, 2, "SS-0002", "DEMO-0001"]);
  assert.equal(parseDb("{ bad").error?.includes("does not parse"), true);
  assert.match(String(parseDb(JSON.stringify({ schema: "other", records: [] })).error), /not a fmc-seismic-screening/);
  assert.equal(parseDb(JSON.stringify(db)).db?.schema, DB_SCHEMA);
});

test("register: Markdown, self-contained HTML, GeoJSON points (lon, lat) and the buildings left off the map", () => {
  const now = new Date("2026-11-28T08:00:00Z");
  let db = emptyDb(now);
  const one = (id: string, fields: Record<string, unknown>) => buildRecord({ id, modelFields: fieldsFromModel(null, kit), model: null, input: { fields }, kit, now, by: "ai" });
  db = upsert(db, one("SS-0001", { building_name: "On map <b>", gps_lat: 0.31, gps_lon: 32.58, outcome: "detailed_evaluation" }), now);
  db = upsert(db, one("SS-0002", { building_name: "No coords" }), now);
  const md = toMarkdown(registerReport(db, now));
  assert.match(md, /\| SS-0001 \| On map <b> \|/);
  assert.match(md, /Not on the map \(no coordinates\): SS-0002/);
  const html = toHtml("Register", registerReport(db, now));
  assert.match(html, /On map &lt;b&gt;/);
  assert.doesNotMatch(html, /<script|https?:\/\//);
  const geo = toGeoJson(db);
  assert.equal(geo.features.length, 1);
  assert.deepEqual(geo.features[0].geometry.coordinates, [32.58, 0.31]);
});

// ---------------------------------------------------------------- the tool (files on disk)

const win = path.win32;
const onWindows = process.platform === "win32";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-seismic-"));
  const appdata = path.join(root, "AppData");
  fs.mkdirSync(path.join(appdata, "Formcraft"), { recursive: true });
  const config: GuardConfig = { ...DEFAULT_CONFIG, write_roots: [path.join(root, "Projects", "*", "01_WIP")], reports_dir: path.join(root, "Reports") };
  const env = { ...process.env, APPDATA: appdata, FMC_STARTED_BY: "ai" };
  let calls = 0;
  const deps = { config, env, kit: { file: "kit.json", data: KIT }, now: () => new Date("2026-11-28T08:00:00Z"), facts: async () => { calls++; return FACTS; } };
  const run = (a: Partial<FmcSeismicArgs>) => runFmcSeismicScreen({ include_archived: false, dry_run: true, action: "form", ...a } as FmcSeismicArgs, deps).then((r) => ({ ...r, body: JSON.parse(r.content[0].text) }));
  return { root, config, env, run, calls: () => calls, deps };
}

test("tool: prefill and a dry-run save write nothing; a real save writes the database in 01_WIP\\_Screening", { skip: !onWindows }, async () => {
  const t = setup();
  const project = path.join(t.root, "Projects", "SAMPLE", "");
  fs.mkdirSync(win.join(project, "01_WIP"), { recursive: true });
  const db = win.join(project, "01_WIP", "_Screening", "FMC_Seismic_Screening.json");
  const pre = await t.run({ action: "prefill", project_folder: project, fields: { building_name: "Sample" } });
  assert.equal(pre.isError, false, JSON.stringify(pre.body));
  assert.equal(pre.body.record.fields.storeys_above_ground.source, "model");
  assert.equal(fs.existsSync(db), false);
  const dry = await t.run({ action: "save", project_folder: project, fields: { building_name: "Sample", seismic_zone: "zone_2" } });
  assert.equal(dry.body.dry_run, true);
  assert.equal(fs.existsSync(db), false);
  const saved = await t.run({ action: "save", project_folder: project, dry_run: false, fields: { building_name: "Sample", seismic_zone: "zone_2" } });
  assert.equal(saved.body.saved, true, JSON.stringify(saved.body));
  assert.equal(saved.body.id, "SS-0001");
  assert.equal(fs.existsSync(db), true);
  assert.equal(fs.existsSync(`${db}.lock`), false);
  const upd = await t.run({ action: "save", project_folder: project, dry_run: false, id: "SS-0001", fields: { subsoil_class: "II" }, expected_revision: 1 });
  assert.equal(upd.body.version, 2, JSON.stringify(upd.body));
  assert.equal(t.calls(), 3, "an update keeps the earlier model read");
  const stale = await t.run({ action: "save", project_folder: project, dry_run: false, id: "SS-0001", fields: { notes: "x" }, expected_revision: 1 });
  assert.equal(stale.isError, true);
  const got = await t.run({ action: "get", project_folder: project, id: "SS-0001" });
  assert.deepEqual([got.body.record.fields.storeys_above_ground.source, got.body.record.fields.subsoil_class.value], ["model", "II"]);
  const archived = await t.run({ action: "save", project_folder: project, dry_run: false, id: "SS-0001", status: "archived" });
  assert.equal(archived.body.status, "archived");
  assert.equal((await t.run({ action: "list", project_folder: project })).body.count, 0);
  assert.equal((await t.run({ action: "list", project_folder: project, include_archived: true })).body.count, 1, "archive hides, never deletes");
});

test("tool: reports and demo data go next to the database, dry run first, never overwrite", { skip: !onWindows }, async () => {
  const t = setup();
  const seedDry = await t.run({ action: "seed_demo" });
  assert.equal(seedDry.body.would_add.length, 3);
  const dbFile = win.join(t.config.reports_dir, "Screening", "FMC_Seismic_Screening.json");
  assert.equal(fs.existsSync(dbFile), false);
  const seeded = await t.run({ action: "seed_demo", dry_run: false });
  assert.equal(seeded.body.added.length, 3, JSON.stringify(seeded.body));
  assert.equal(seeded.body.added[0].Cd, 0.192);
  assert.equal(seeded.body.added[2].Cd, TBC, "offices are not in Table 3: I is TBC");
  assert.equal((await t.run({ action: "seed_demo", dry_run: false })).isError, true, "demo records go in once");
  const rptDry = await t.run({ action: "report" });
  assert.equal(rptDry.body.files.length, 4);
  assert.ok(rptDry.body.files.every((f: string) => !fs.existsSync(f)));
  const rpt = await t.run({ action: "report", dry_run: false });
  assert.deepEqual(rpt.body.written.map((f: string) => win.extname(f)), [".md", ".html", ".csv", ".geojson"]);
  const geo = JSON.parse(fs.readFileSync(rpt.body.written[3], "utf8"));
  assert.equal(geo.features.length, 3);
  assert.match(fs.readFileSync(rpt.body.written[0], "utf8"), /DEMO-0001 \(demo\)/);
  assert.equal((await t.run({ action: "report", dry_run: false })).isError, true, "same minute: nothing is overwritten");
  const one = await t.run({ action: "report", id: "DEMO-0002", dry_run: false });
  assert.equal(one.body.written.length, 2);
  assert.match(fs.readFileSync(one.body.written[0], "utf8"), /DEMO DATA: this building is fictional/);
});

test("tool: refusals: Stop AI, folders outside the write roots, model files, a database that does not parse", { skip: !onWindows }, async () => {
  const t = setup();
  fs.writeFileSync(win.join(t.env.APPDATA!, "Formcraft", "ai_stop"), "");
  const stopped = await t.run({ action: "save", dry_run: false, fields: { building_name: "x" } });
  assert.equal(stopped.isError, true);
  assert.match(stopped.body.reasons.join(" "), /Stop AI/);
  assert.match(writeGate(win.join(t.config.reports_dir, "x.json"), t.config, { ...t.env, FMC_STARTED_BY: "pane" }).join(" "), /^$/);
  fs.rmSync(win.join(t.env.APPDATA!, "Formcraft", "ai_stop"));
  assert.ok(databasePath({ database: win.join(t.root, "elsewhere", "db.json") }, t.config).reasons?.length);
  assert.ok(databasePath({ database: win.join(t.config.reports_dir, "Sample.rvt") }, t.config).reasons?.length);
  assert.ok(writeGate(win.join(t.config.reports_dir, "Sample.rvt"), t.config, t.env).length);
  const outside = databasePath({ project_folder: win.join(t.root, "NotProjects", "X") }, t.config);
  assert.match(String(outside.note), /reports folder is used/);
  const bad = win.join(t.config.reports_dir, "Screening", "FMC_Seismic_Screening.json");
  fs.mkdirSync(win.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, "{ not json");
  const r = await t.run({ action: "save", dry_run: false, fields: { building_name: "x" } });
  assert.equal(r.isError, true);
  assert.equal(fs.readFileSync(bad, "utf8"), "{ not json", "a bad file is never overwritten");
});

test("tool: the model is only read (fmc_struct_facts is a read command), and save refuses when it can't read it", async () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_struct_facts") && !WRITE_COMMANDS.has("fmc_struct_facts"));
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools", "fmc_seismic_screen.ts"), "utf8");
  const sent = [...src.matchAll(/send(?:Command|Raw)\("([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sent, ["fmc_struct_facts"]);
  const t = setup();
  const failing = { ...t.deps, facts: async () => { throw new Error("Revit is not running"); } };
  const pre = await runFmcSeismicScreen({ action: "prefill", include_archived: false, dry_run: true } as FmcSeismicArgs, failing);
  const body = JSON.parse(pre.content[0].text);
  assert.equal(pre.isError, false);
  assert.match(body.warnings[0], /model fields are TBC/);
  const save = await runFmcSeismicScreen({ action: "save", include_archived: false, dry_run: true } as FmcSeismicArgs, failing);
  assert.equal(save.isError, true);
});
