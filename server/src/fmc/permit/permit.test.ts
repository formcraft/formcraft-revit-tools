import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "../policy.js";
import { bankFromText, cite, loadBank, loadSources, parseScales, scaleAllowed } from "./bank.js";
import { permitDefaults } from "./defaults.js";
import { derive } from "./derive.js";
import { counts, deriveCategory, evaluate } from "./evaluate.js";
import type { PermitFacts } from "./facts.js";
import { sheetFacts, structFacts, viewportFacts } from "./facts.js";
import type { Ctx, Finding } from "./finding.js";
import { evaluatePack, sheetPattern, viewKind } from "./pack.js";
import { BANNED_WORDS, FOOTER, safeRunFile } from "./report.js";
import { roomUse } from "./roomuse.js";
import { PERMIT_READ_COMMANDS, runFmcPermitCheck, type FmcPermitCheckArgs } from "../../tools/fmc_permit_check.js";

// Fixture bank: the shape of FMC_Standards_Building.json with test values (the code reads whatever the bank holds).
const BANK = {
  version: "0.5-proposed", status: "proposed: test fixture",
  standards: {
    "permits.building_category": { value: { A: "complex", B: "residential or commercial", C: "minor works" }, unit: "text", status: "proposed", clause: "reg 8" },
    "permits.minor_works_definition": { value: { max_floor_area_m2: 30, storeys: 1 }, status: "proposed", clause: "Schedule 2" },
    "permits.multistorey_definition": { value: { height_more_than_m: 12 }, status: "proposed", clause: "s.9(b)" },
    "permits.multistorey_submission": { value: "engineering design; geotechnical report", status: "proposed" },
    "site.deep_excavation_temporary_works": { value: { depth_trigger_m: 3, rule: "x" }, status: "proposed", clause: "reg 32(2)" },
    "drawings.architectural_set": { value: { sheets: ["location plan", "site plan", "floor plans", "elevations", "sections", "door and window schedules", "boundary wall plan and details"], scales_min: { site: "1:2500 to 1:100", layouts: "1:100, 1:50 or 1:20", sections_elevations: "1:100 or 1:50" } }, status: "proposed", clause: "reg 9" },
    "drawings.general": { value: { signed_by: "architect" }, status: "proposed", clause: "reg 13" },
    "drawings.structural_set": { value: { sheets: [] } }, "drawings.electrical_set": { value: { sheets: [] } }, "drawings.mechanical_set": { value: { sheets: [] } },
    "permits.application_minor_works": { value: ["Form 1", "sketch plan"], status: "proposed" },
    "permits.application_residential_commercial": { value: ["Form 2", "architectural drawings"], status: "proposed" },
    "permits.application_complex_public_extra": { value: ["EIA certificate"], status: "proposed" },
    "rooms.habitable_first_min": { value: 9, unit: "m2", note: "para 102" },
    "rooms.habitable_additional_min": { value: 7.4, unit: "m2", note: "para 102(a)" },
    "rooms.sleeping_area_per_person": { value: 3.7, unit: "m2" },
    "rooms.kitchen_min": { value: 7.4, unit: "m2", note: "para 103(2)(a)" },
    "rooms.bathroom_legal_min": { value: 1.5, unit: "m2" },
    "rooms.bedroom_single_min": { value: 7.5 }, "rooms.living_min": { value: 14 }, "rooms.bathroom_min": { value: 3.5 }, "rooms.wc_min": { value: 1.5 },
    "stairs.riser_max": { value: 190 }, "stairs.going_min": { value: 250 }, "stairs.width_min": { value: 900 }, "stairs.headroom": { value: 2000 },
    "escape.second_staircase": { value: { storeys_over: 6, top_floor_height_over_m: 17 }, status: "proposed", clause: "para 49(2)" },
    "fire.compartment_max_floor_area": { value: 9300, status: "proposed", clause: "para 40(1)" },
    "planning.residential.plot_coverage_max": { value: { A: 0.2, B: 0.4, C: 0.6 }, status: "proposed" },
    "planning.commercial.plot_coverage_max": { value: 0.8, status: "proposed" },
  },
};
const SOURCES = { sources: [{ id: "UG-NBC-2019", gaps: [{ id: "NBC-4", what: "sleepers per room", where: "para 102", kind: "gap", status: "open" }] }] };

function ctxOf(env: NodeJS.ProcessEnv = {}, bank: object = BANK): Ctx {
  return {
    bank: bankFromText("bank.json", JSON.stringify(bank)),
    sources: loadSources("s.json", () => JSON.stringify(SOURCES)),
    defaults: permitDefaults(env), missingKeys: new Set(),
  };
}

function facts(over: Partial<PermitFacts> = {}): PermitFacts {
  return {
    document: { title: "T", path: "" },
    levels: [{ name: "Level 0", elevation_mm: 0 }, { name: "Level 1", elevation_mm: 3000 }],
    rooms: [], floors: [{ id: "f1", level: "Level 0", area_m2: 100 }, { id: "f2", level: "Level 1", area_m2: 100 }],
    roofs: [{ id: "r1", level: "Level 1", top_mm: 7000 }], stairs: [{ id: "s1", type: "Stair", bottom_mm: 0, top_mm: 3000 }],
    sheets: [], viewports: [], room_problems: [], notes: [], ...over,
  };
}

const room = (id: string, name: string, area: number, level = "Level 0") => ({ id, number: id, name, level, area_m2: area, department: "", occupancy: "", at_mm: null });
const of = (fs_: Finding[], rule: string) => fs_.filter((f) => f.rule === rule);

test("bank: cite reads value, clause and status; a missing key is not found and never defaulted", () => {
  const c = ctxOf();
  const hit = cite(c.bank, "permits.multistorey_definition", "fallback");
  assert.equal(hit.found, true); assert.equal(hit.clause, "s.9(b)"); assert.equal(hit.status, "proposed");
  const fallback = cite(c.bank, "rooms.kitchen_min", "para 103");
  assert.equal(fallback.clause, "para 103");
  const miss = cite(c.bank, "no.such.key");
  assert.equal(miss.found, false); assert.equal(miss.value, null); assert.equal(miss.status, "missing");
  const missingFile = loadBank("/nope/FMC_Standards_Building.json", () => { throw new Error("ENOENT"); });
  assert.equal(missingFile.found, false); assert.match(missingFile.error ?? "", /not readable/);
  assert.equal(bankFromText("x", "{oops").found, false);
});

test("bank: scale texts parse as a list or a range", () => {
  assert.deepEqual(parseScales("1:100, 1:50 or 1:20").list, [100, 50, 20]);
  const r = parseScales("1:2500 to 1:100");
  assert.deepEqual(r.range, [100, 2500]);
  assert.equal(scaleAllowed(500, r), true); assert.equal(scaleAllowed(5000, r), false);
  assert.equal(scaleAllowed(200, parseScales("1:100 or 1:50")), false);
});

test("defaults: interim answers are one value each and can be changed by environment", () => {
  const d = permitDefaults({});
  assert.equal(d.proposedMayFail, true); assert.equal(d.stairsState, "REVIEW"); assert.equal(d.boundaryReview, true);
  assert.match(d.passWording, /no exception found/);
  assert.equal(d.standardsDir, "C:\\Users\\USER\\agent-tools\\standards\\kit");
  const e = permitDefaults({ FMC_PERMIT_PROPOSED_MAY_FAIL: "0", FMC_PERMIT_STAIRS_STATE: "not_checked", FMC_PERMIT_STANDARDS_DIR: "D:\\kit" });
  assert.equal(e.proposedMayFail, false); assert.equal(e.stairsState, "NOT_CHECKED"); assert.equal(e.standardsDir, "D:\\kit");
  assert.equal(permitDefaults({ FMC_PERMIT_STANDARDS_DIR: "D:\\kit" }, "E:\\arg").standardsDir, "E:\\arg");
});

function categoryFor(gfa: number, heightM: number, storeys: number, use?: string, category?: "A" | "B" | "C") {
  const levels = [{ name: "L0", elevation_mm: 0 }];
  for (let i = 1; i < storeys; i++) levels.push({ name: `L${i}`, elevation_mm: i * 3000 });
  const floors = levels.map((l, i) => ({ id: `f${i}`, level: l.name, area_m2: gfa / storeys }));
  const f = facts({ levels, floors, roofs: [{ id: "r", level: "L0", top_mm: heightM * 1000 }] });
  return deriveCategory(ctxOf(), derive(f), { use, category });
}

test("category: Q10 boundaries at exactly 30 m2 and exactly 12 m are REVIEW", () => {
  const c = categoryFor(29, 3, 1, "residential");
  assert.equal(c.result.derived, "C"); assert.equal(c.finding.state, "INFO");
  const at30 = categoryFor(30, 3, 1, "residential");
  assert.equal(at30.finding.state, "REVIEW"); assert.match(at30.finding.message, /30 m2 boundary/);
  assert.equal(categoryFor(31, 3, 1, "residential").result.derived, "B");
  assert.equal(categoryFor(31, 3, 1, "residential").finding.state, "INFO");
  const at12 = categoryFor(200, 12, 3, "residential");
  assert.equal(at12.finding.state, "REVIEW"); assert.match(at12.finding.message, /12 m boundary/);
  const tall = categoryFor(400, 13, 4, "residential");
  assert.equal(tall.result.derived, "A"); assert.equal(tall.finding.state, "INFO");
  assert.equal(categoryFor(20, 3, 1, "education").result.derived, "A");
});

test("category: a blank use or a different expected category is REVIEW; boundary REVIEW can be switched off", () => {
  assert.equal(categoryFor(100, 6, 2).finding.state, "REVIEW");
  assert.match(categoryFor(100, 6, 2).finding.message, /use was not given/);
  assert.equal(categoryFor(100, 6, 2, "residential", "C").finding.state, "REVIEW");
  const levels = [{ name: "L0", elevation_mm: 0 }];
  const f = facts({ levels, floors: [{ id: "f", level: "L0", area_m2: 30 }], roofs: [{ id: "r", level: "L0", top_mm: 3000 }] });
  const off = deriveCategory(ctxOf({ FMC_PERMIT_BOUNDARY_REVIEW: "0" }), derive(f), { use: "residential" });
  assert.equal(off.finding.state, "INFO");
});

test("derive: ground, storeys, height, floor area, footprint and basement depth", () => {
  const f = facts({
    levels: [{ name: "B1", elevation_mm: -3500 }, { name: "GF", elevation_mm: 0 }, { name: "L1", elevation_mm: 3000 }, { name: "Roof", elevation_mm: 6000 }],
    floors: [{ id: "a", level: "B1", area_m2: 80 }, { id: "b", level: "GF", area_m2: 100 }, { id: "c", level: "L1", area_m2: 90 }],
    roofs: [{ id: "r", level: "Roof", top_mm: 7500 }],
  });
  const d = derive(f);
  assert.equal(d.ground?.name, "GF"); assert.equal(d.storeys, 2); assert.equal(d.height_m, 7.5); assert.equal(d.top_floor_height_m, 3);
  assert.equal(d.gfa_m2, 270); assert.equal(d.footprint_m2, 100); assert.equal(d.basement_depth_m, 3.5);
  assert.equal(derive(f, "L1").ground?.name, "L1");
  const noRoof = derive(facts({ roofs: [] }));
  assert.equal(noRoof.height_source, "levels"); assert.ok(noRoof.notes.some((n) => /understates/.test(n)));
});

test("rooms: habitable, kitchen and bathroom bands; Formcraft typical sizes are ADVICE only", () => {
  const f = facts({ rooms: [room("1", "Bedroom 1", 7), room("2", "Bedroom 2", 8), room("3", "Living Room", 12), room("4", "Kitchen", 6), room("5", "Bathroom", 1.2), room("6", "WC", 1.6), room("7", "Mystery", 5)] });
  const ev = evaluate(ctxOf(), f, derive(f), { use: "residential" }).findings;
  const st = (rule: string, id: string) => of(ev, rule).filter((x) => x.ids.includes(id)).map((x) => x.state);
  assert.deepEqual(st("ROOMS.habitable", "1"), ["FAIL"]);
  assert.deepEqual(st("ROOMS.habitable", "2"), ["REVIEW"]);
  assert.deepEqual(st("ROOMS.habitable", "3"), ["PASS"]);
  assert.deepEqual(st("ROOMS.typical", "3"), ["ADVICE"]);
  assert.deepEqual(st("ROOMS.kitchen", "4"), ["REVIEW"]);
  assert.deepEqual(st("ROOMS.bathroom", "5"), ["FAIL"]);
  assert.deepEqual(st("ROOMS.bathroom", "6"), ["PASS"]);
  const fail = of(ev, "ROOMS.habitable").find((x) => x.state === "FAIL")!;
  assert.ok(fail.caveats.some((c) => c.id === "bank-status"), "a FAIL on a proposed value carries a caveat");
  assert.ok(fail.caveats.some((c) => c.id === "NBC-4" && /sleepers/.test(c.what)));
  assert.ok(of(ev, "ROOMS.habitable").some((x) => x.state === "PASS" && /no exception found/.test(x.message)));
  assert.ok(of(ev, "ROOMS.habitable").some((x) => x.state === "NOT_CHECKED" && /sleeping/.test(x.message)));
  assert.ok(of(ev, "ROOMS.habitable").some((x) => x.state === "INFO" && x.ids.includes("7")));
});

test("rooms: a kitchen small-unit value in the bank gives FAIL below it", () => {
  const bank = structuredClone(BANK) as unknown as { standards: Record<string, unknown> };
  bank.standards["rooms.kitchen_min"] = { value: 7.4, uses: { small_units: 4.6 } };
  const f = facts({ rooms: [room("k", "Kitchen", 4), room("k2", "Kitchen", 5)] });
  const ev = evaluate(ctxOf({}, bank), f, derive(f), { use: "residential" }).findings;
  assert.equal(of(ev, "ROOMS.kitchen").find((x) => x.ids.includes("k"))?.state, "FAIL");
  assert.equal(of(ev, "ROOMS.kitchen").find((x) => x.ids.includes("k2"))?.state, "REVIEW");
});

test("Q1 off: a proposed value never produces FAIL", () => {
  const f = facts({ rooms: [room("1", "Bedroom", 5)] });
  const ev = evaluate(ctxOf({ FMC_PERMIT_PROPOSED_MAY_FAIL: "0" }), f, derive(f), { use: "residential" }).findings;
  assert.equal(ev.filter((x) => x.state === "FAIL").length, 0);
  assert.ok(of(ev, "ROOMS.habitable").some((x) => x.state === "REVIEW" && /held at REVIEW/.test(x.message)));
});

test("escape, fire, plot, stairs and excavation", () => {
  const levels = Array.from({ length: 8 }, (_, i) => ({ name: `L${i}`, elevation_mm: i * 3000 }));
  const floors = levels.map((l, i) => ({ id: `f${i}`, level: l.name, area_m2: i === 1 ? 9500 : 300 }));
  const tall = facts({ levels: [{ name: "B", elevation_mm: -4000 }, ...levels], floors: [...floors, { id: "fb", level: "B", area_m2: 300 }], roofs: [{ id: "r", level: "L7", top_mm: 24000 }] });
  const ev = evaluate(ctxOf(), tall, derive(tall), { use: "residential", plot: { area_m2: 1000, zone: "B" } }).findings;
  assert.equal(of(ev, "ESCAPE.second_stair")[0].state, "FAIL");
  assert.deepEqual(of(ev, "FIRE.compartment").map((x) => x.state), ["REVIEW"]);
  assert.equal(of(ev, "SITE.plot_coverage")[0].state, "PASS");
  assert.equal(of(ev, "SITE.excavation")[0].state, "REVIEW");
  assert.equal(of(ev, "CLASS.multistorey_docs")[0].state, "NOT_CHECKED");
  assert.deepEqual(of(ev, "STAIRS.dims").map((x) => x.state), ["REVIEW"]);
  assert.ok(of(ev, "DOCS.attach").some((x) => /EIA certificate/.test(x.message)), "category A adds the complex/public documents");

  const small = facts();
  const ev2 = evaluate(ctxOf({ FMC_PERMIT_STAIRS_STATE: "NOT_CHECKED" }), small, derive(small), { use: "residential", plot: { area_m2: 150, zone: "A" } }).findings;
  assert.equal(of(ev2, "ESCAPE.second_stair")[0].state, "NOT_APPLICABLE");
  assert.equal(of(ev2, "SITE.plot_coverage")[0].state, "FAIL");
  assert.equal(of(ev2, "SITE.excavation")[0].state, "NOT_APPLICABLE");
  assert.equal(of(ev2, "CLASS.multistorey_docs")[0].state, "NOT_APPLICABLE");
  assert.deepEqual(of(ev2, "STAIRS.dims").map((x) => x.state), ["NOT_CHECKED"]);
  assert.equal(of(evaluate(ctxOf(), small, derive(small), {}).findings, "SITE.plot_coverage")[0].state, "NOT_CHECKED");
});

test("Phase B and C rules report NOT_CHECKED with the reason", () => {
  const f = facts();
  const ev = evaluate(ctxOf(), f, derive(f), { use: "residential" }).findings;
  for (const id of ["ROOMS.ceiling_height", "DAYLIGHT.glazing", "DOORS.accessible_width", "ESCAPE.travel"]) {
    const x = of(ev, id);
    assert.equal(x.length, 1, id); assert.equal(x[0].state, "NOT_CHECKED");
  }
  assert.match(of(ev, "DAYLIGHT.glazing")[0].message, /Phase B: needs fmc_permit_facts/);
});

test("a missing bank key is NOT_CHECKED and is listed", () => {
  const bank = structuredClone(BANK) as unknown as { standards: Record<string, unknown> };
  delete bank.standards["escape.second_staircase"];
  const c = ctxOf({}, bank);
  const f = facts();
  const ev = evaluate(c, f, derive(f), { use: "residential" }).findings;
  assert.equal(of(ev, "ESCAPE.second_stair")[0].state, "NOT_CHECKED");
  assert.ok(c.missingKeys.has("escape.second_staircase"));
});

test("pack: listed sheets by name, viewport scales by view kind, a use for every room", () => {
  const f = facts({
    sheets: [
      { id: "1", number: "A-001", name: "Location and Site Plan", views: ["Site"] },
      { id: "2", number: "A-101", name: "Ground Floor Plan", views: ["Level 0"] },
      { id: "3", number: "A-201", name: "Elevations", views: ["North Elevation"] },
      { id: "4", number: "A-301", name: "Sections", views: ["Section 1"] },
    ],
    viewports: [{ id: "v1", name: "Level 0", sheet: "A-101", scale: 100 }, { id: "v2", name: "North Elevation", sheet: "A-201", scale: 200 }, { id: "v3", name: "Site", sheet: "A-001", scale: 500 }],
    rooms: [room("r1", "Room", 12), room("r2", "", 10), room("r3", "Kitchen", 9)],
    room_problems: [{ sentence: "Room 9 is not enclosed.", ids: ["r9"] }],
  });
  const ev = evaluatePack(ctxOf(), f);
  const arch = of(ev, "PACK.arch_set");
  assert.equal(arch.find((x) => /"location plan"/.test(x.message))?.state, "PASS");
  assert.equal(arch.find((x) => /"floor plans"/.test(x.message))?.state, "PASS");
  assert.equal(arch.find((x) => /"door and window schedules"/.test(x.message))?.state, "REVIEW");
  assert.equal(arch.find((x) => /"boundary wall/.test(x.message))?.state, "REVIEW");
  const scales = of(ev, "PACK.arch_scales");
  assert.deepEqual(scales.map((x) => [x.state, x.ids[0]]), [["REVIEW", "v2"]]);
  const use = of(ev, "PACK.room_use");
  assert.deepEqual(use.filter((x) => x.state === "FAIL").map((x) => x.ids[0]).sort(), ["r1", "r2"]);
  assert.ok(use.some((x) => x.state === "REVIEW" && x.ids.includes("r9")));
  assert.equal(of(ev, "PACK.paper")[0].state, "NOT_CHECKED");
  assert.equal(viewKind("Level 1"), "layouts"); assert.equal(viewKind("Section A"), "sections_elevations"); assert.equal(viewKind("3D View"), "other");
  assert.ok(sheetPattern("drainage plans (storm, foul, waste)").test("Foul Drainage Layout"));
  assert.equal(of(evaluatePack(ctxOf(), facts({ sheets: null, viewports: null })), "PACK.arch_set")[0].state, "NOT_CHECKED");
});

test("facts: the add-in read shapes normalise", () => {
  const s = structFacts({
    levels: [{ name: "L0", elevation_mm: 0 }], floors: [{ id: 5, level: "L0", area_m2: 40 }],
    roofs: [{ id: 6, level: "L0", plan_min_mm: [0, 0, 2800], plan_max_mm: [1, 1, 4200] }],
    rooms: [{ id: 7, number: "1", name: "Kitchen", level: "L0", area_m2: 8, at_mm: [1, 2, 0] }],
    stairs: [{ id: 8, type: "S", box_mm: [[0, 0, 0], [1, 1, 3000]] }],
  });
  assert.equal(s.roofs[0].top_mm, 4200); assert.equal(s.stairs[0].top_mm, 3000); assert.equal(s.floors[0].id, "5");
  assert.deepEqual(sheetFacts({ sheets: [{ id: 1, number: "A1", name: "Plan", placed: [{ name: "Level 0" }] }] })[0].views, ["Level 0"]);
  assert.equal(viewportFacts({ views: [{ id: 1, name: "a", sheet: "A1", scale: 100 }], others: [{ id: 2, name: "b", sheet: "A2", scale: 50 }] }).length, 2);
  assert.equal(roomUse("Master Bedroom"), "bedroom"); assert.equal(roomUse("En-suite"), "bathroom"); assert.equal(roomUse("Store"), "service"); assert.equal(roomUse("X", "", "Toilet"), "wc");
});

const base: FmcPermitCheckArgs = { action: "check", document: "", sample_limit: 80 };
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const files: Record<string, string> = { "FMC_Standards_Building.json": JSON.stringify(BANK), "FMC_Standards_Sources.json": JSON.stringify(SOURCES) };
const readFile = (p: string) => { const k = path.basename(p.replace(/\\/g, "/")); if (!(k in files)) throw new Error("ENOENT " + p); return files[k]; };

test("tool: no document is FMC-DOC-REQUIRED; nothing is read and the reply is read-only", async () => {
  let calls = 0;
  const r = await runFmcPermitCheck(base, { read: async () => { calls++; return {}; }, readFile });
  const body = parse(r);
  assert.equal(r.isError, true); assert.equal(body.code, "FMC-DOC-REQUIRED"); assert.equal(calls, 0);
  for (const k of ["read_only"]) assert.equal(body[k], true);
  for (const k of ["transaction", "applied", "saved", "synced"]) assert.equal(body[k], false);
});

test("tool: check reads with the document named, writes a draft report, and report renders it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permit-"));
  const sent: Array<[string, Record<string, unknown>]> = [];
  const read = async (command: string, body: Record<string, unknown>) => {
    sent.push([command, body]);
    if (command === "fmc_struct_facts") return {
      document: { title: "House.rvt", path: "C:/p/House.rvt" },
      levels: [{ name: "Level 0", elevation_mm: 0 }, { name: "Level 1", elevation_mm: 3000 }],
      floors: [{ id: 1, level: "Level 0", area_m2: 80 }, { id: 2, level: "Level 1", area_m2: 80 }],
      roofs: [{ id: 3, level: "Level 1", plan_max_mm: [0, 0, 6500] }],
      rooms: [{ id: 10, number: "01", name: "Bedroom", level: "Level 1", area_m2: 7 }, { id: 11, number: "02", name: "Living", level: "Level 0", area_m2: 20 }],
      stairs: [{ id: 20, type: "Stair", box_mm: [[0, 0, 0], [1, 1, 3000]] }],
    };
    if (command === "fmc_sheets_layout" && body.action === "park") return { sheets: [{ id: 30, number: "A-101", name: "Floor Plans", placed: [{ name: "Level 0" }] }] };
    if (command === "fmc_sheets_layout") return { views: [{ id: 31, name: "Level 0", sheet: "A-101", scale: 100 }], others: [] };
    return { rooms: { count: 0, items: [] } };
  };
  const now = () => new Date("2026-11-28T09:00:00Z");
  const r = await runFmcPermitCheck({ ...base, document: "House", use: "residential", standards_dir: "C:\\kit" }, { read, readFile, reportDir: dir, now });
  const body = parse(r);
  assert.equal(r.isError, false, JSON.stringify(body));
  assert.equal(body.read_only, true); assert.equal(body.transaction, false); assert.equal(body.applied, false);
  assert.equal(body.derived_category, "B");
  assert.ok(sent.every(([, b]) => b.document === "House"), "every read names the document");
  assert.deepEqual([...new Set(sent.map(([c]) => c))].sort(), ["fmc_model_check", "fmc_sheets_layout", "fmc_struct_facts"]);
  const c = body.counts as Record<string, number>;
  assert.ok(c.FAIL >= 1 && c.NOT_CHECKED >= 1);
  const report = body.report as { json: string; markdown: string };
  const md = fs.readFileSync(report.markdown, "utf8");
  assert.match(md, /DRAFT for the responsible registered professional/);
  assert.ok(md.includes(FOOTER));
  assert.match(md, /Sign-off/);
  for (const re of BANNED_WORDS) assert.doesNotMatch(md, re);
  assert.doesNotMatch(md, /UGX|shillings|penalty/i);
  const name = path.basename(report.json, ".json");
  const again = parse(await runFmcPermitCheck({ ...base, action: "report", run: name }, { reportDir: dir }));
  assert.match(String(again.markdown), /Permit pre-check/);
  const bad = await runFmcPermitCheck({ ...base, action: "report", run: "..\\..\\x" }, { reportDir: dir });
  assert.equal(bad.isError, true);
  assert.equal(safeRunFile(dir, "permit-a/../b"), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tool: a refused read and an unreadable bank are refusals", async () => {
  const refused = await runFmcPermitCheck({ ...base, document: "X" }, { read: async () => ({ refused: true, code: "FMC-DOC-NOT-OPEN", message: "not open" }), readFile, reportDir: os.tmpdir() });
  assert.equal(parse(refused).code, "FMC-DOC-NOT-OPEN");
  const noBank = await runFmcPermitCheck({ ...base, document: "X" }, { read: async () => ({}), readFile: () => { throw new Error("ENOENT"); } });
  assert.equal(parse(noBank).code, "FMC-PERMIT-BANK");
  const rules = parse(await runFmcPermitCheck({ ...base, action: "rules" }));
  assert.ok(Array.isArray(rules.rules) && (rules.rules as unknown[]).length > 10);
});

test("lock: every command fmc_permit_check sends is a read, never a write", () => {
  for (const c of PERMIT_READ_COMMANDS) { assert.ok(READ_VIA_SEND_COMMAND.has(c), c); assert.equal(WRITE_COMMANDS.has(c), false, c); }
});

test("source scan: the permit files write nothing to the model and read no guard or checklist file", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");
  const list = [path.join(src, "tools", "fmc_permit_check.ts"), ...fs.readdirSync(path.join(src, "fmc", "permit")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => path.join(src, "fmc", "permit", f))];
  for (const f of list) {
    const text = fs.readFileSync(f, "utf8");
    for (const re of [/send_code_to_revit/, /_apply"/, /\bTransaction\(/, /loadConfig/, /fmc_guard/, /review_checklists/, /kitPaths/]) assert.doesNotMatch(text, re, `${path.basename(f)} ${re}`);
    for (const m of text.matchAll(/sendCommand\(\s*"([a-z_]+)"/g)) assert.ok((PERMIT_READ_COMMANDS as readonly string[]).includes(m[1]), m[1]);
  }
});

test("real bank: every key the Phase A rules use is present (skipped when the kit folder is not on this machine)", (t) => {
  const dir = (process.env.FMC_PERMIT_STANDARDS_DIR ?? "").trim() || permitDefaults({}).standardsDir;
  const file = path.join(dir, "FMC_Standards_Building.json");
  if (!fs.existsSync(file)) { t.skip(`no bank at ${file}`); return; }
  const bank = loadBank(file);
  assert.equal(bank.found, true);
  const c: Ctx = { bank, sources: loadSources(path.join(dir, "FMC_Standards_Sources.json")), defaults: permitDefaults({}), missingKeys: new Set() };
  const f = facts({ rooms: [room("1", "Bedroom", 10)] });
  const ev = evaluate(c, f, derive(f), { use: "residential", plot: { area_m2: 1000, zone: "B" } });
  assert.deepEqual([...c.missingKeys], []);
  assert.ok(counts(ev.findings).PASS > 0);
  for (const id of ["NBC-4", "UG-NBC-2019-C3", "NBC-10"]) assert.ok(c.sources.gaps[id], id);
});
