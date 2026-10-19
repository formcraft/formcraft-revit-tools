import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Run, RunWall, Standards, layoutRun, readLibrary } from "./casework.js";
import {
  KitFamily, NO_KIT_RULE, RoomRead, a3Frame, coordinationChecks, elevationSize, kitParams, matchWalls, placementPlan, registerFamily,
  registerSheet, registerSheetFor, runFromRoom, serviceKind, shopLayout,
} from "./casework_place.js";
import { WRITE_COMMANDS } from "./policy.js";
import { csvRow } from "../tools/fmc_sheets.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../src/fmc/fixtures/cw_kitchen.json"), "utf8"));
const S = FIX.standards as Standards;

/** The kitchen's walls with their place in the model: A along +x (room on its left, +y), B up the y axis from the corner (room on its right, +x). */
const WALLS: RunWall[] = [
  { ...FIX.run.walls[0], start: [0, 0], end: [3600, 0] },
  { ...FIX.run.walls[1], start: [0, 0], end: [0, 3000], side: "right" },
];
const RUN: Run = { ...FIX.run, walls: WALLS };

/** The kit's register lines as they are (03_Master_Data\FMC_Family_Register.csv, 19 Oct). */
const REGISTER = [
  "Role,Family,Category,Template,Host,Connectors,KeyParameters,Types,Priority,Why",
  'I,FMC_I_Casework_KitchenUnit,Casework,Metric Casework,Floor / wall,Optional nested sink,"Width, carcass, door finish","Base, Wall, Tall",P1,Kitchen joinery',
  'I,FMC_I_Casework_Wardrobe,Casework,Metric Casework,Floor / wall,-,"Width, height, board, edge, FMC_Assembly_Mark","1200, 1800, 2400",P1,Workshop-made joinery with a real cut list',
].map(csvRow);

/** FMC_Master_Data.json's params as the kit has them. */
const MASTER = { params: {
  FMC_Assembly_Mark: { binding: "Instance", categories: ["OST_StructuralFraming", "OST_Casework", "OST_GenericModel"] },
  FMC_Carcass_Spec: { binding: "Type", categories: ["OST_Casework"] },
  FMC_Worktop_Spec: { binding: "Type", categories: ["OST_Casework"] },
} };

const LIB = readLibrary({ materials: [
  { name: "FMC_Board_Plywood_Marine18", keynote: "J.CAB_00", price: null },
  { name: "FMC_Board_MDF_Raw", keynote: "J.CAB_03", price: null },
  { name: "FMC_Stone_Granite_Black_Polished", keynote: "J.TOP_00", price: null },
] });

const FAMILY = registerFamily(REGISTER, "FMC_I_Casework_KitchenUnit") as KitFamily;
const PARAMS = kitParams(MASTER).found;

test("the register gives the kitchen unit family's types and key parameters", () => {
  assert.deepEqual(FAMILY, { family: "FMC_I_Casework_KitchenUnit", category: "Casework", types: ["Base", "Wall", "Tall"], key_parameters: ["Width", "carcass", "door finish"] });
  assert.equal(registerFamily(REGISTER, "FMC_I_Casework_Nothing"), null);
});

test("kit parameters: found with their binding; a missing one or a wrong binding is a kit change request", () => {
  const all = kitParams(MASTER);
  assert.deepEqual(all.found, { FMC_Assembly_Mark: "Instance", FMC_Carcass_Spec: "Type", FMC_Worktop_Spec: "Type" });
  assert.deepEqual(all.requests, []);
  const some = kitParams({ params: { FMC_Assembly_Mark: { binding: "Type", categories: ["OST_Casework"] }, FMC_Carcass_Spec: { binding: "Type", categories: ["OST_Walls"] } } });
  assert.deepEqual(Object.keys(some.found), ["FMC_Assembly_Mark"]);
  assert.deepEqual(some.requests.map((r) => r.item), ["FMC_Assembly_Mark", "FMC_Carcass_Spec", "FMC_Worktop_Spec"]);
  assert.match(some.requests[0].request, /binding/);
});

test("placement: the kit's types only; corner and sink are asked of the kit, the spaces stay empty, the rest stand on their walls", () => {
  const l = layoutRun(RUN, S);
  const plan = placementPlan(l.units, WALLS, S, { family: FAMILY, wall_unit_bottom: 1450, params: PARAMS, lib: LIB });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.ops.map((o) => `${o.mark} ${o.type}`), ["K02 Base", "K04 Base", "K05 Tall", "K06 Base", "K08 Base", "W01 Wall", "W02 Wall", "W03 Wall", "W04 Wall", "W06 Wall"]);
  assert.deepEqual(plan.skipped.map((s) => s.mark), ["K01", "K03", "K07", "K09", "W05"]);
  assert.deepEqual(plan.kit_requests.map((r) => r.item), ["FMC_I_Casework_KitchenUnit corner type", "FMC_I_Casework_KitchenUnit sink type"]);
  assert.match(plan.kit_requests[0].request, /Add a Corner type to FMC_I_Casework_KitchenUnit \(the register has Base, Wall, Tall\)/);
  const k02 = plan.ops.find((o) => o.mark === "K02")!;
  assert.deepEqual([k02.at, k02.facing, k02.params], [[1300, 0, 0], [0, 1], { FMC_Assembly_Mark: "K02" }]);
  const k06 = plan.ops.find((o) => o.mark === "K06")!;
  assert.deepEqual([k06.at, k06.facing], [[0, 900, 0], [1, 0]], "B's units face +x, into the room");
  assert.deepEqual(plan.ops.find((o) => o.mark === "W01")!.at, [300, 0, 1450]);
  assert.deepEqual(plan.type_params, {
    Base: { FMC_Carcass_Spec: "J.CAB_00", FMC_Worktop_Spec: "J.TOP_00" }, Tall: { FMC_Carcass_Spec: "J.CAB_00" }, Wall: { FMC_Carcass_Spec: "J.CAB_00" },
  });
  assert.ok(plan.notes.some((n) => /3 appliance or hood space/.test(n)));
});

test("placement: a type for the corner and sink is the person's choice and must be a register type", () => {
  const l = layoutRun(RUN, S);
  const chosen = placementPlan(l.units, WALLS, S, { family: FAMILY, type_for: { corner: "base", sink: "Base" }, wall_unit_bottom: 1450, params: PARAMS, lib: LIB });
  assert.equal(chosen.ops.length, 12);
  assert.equal(chosen.ops.find((o) => o.mark === "K01")!.type, "Base");
  assert.deepEqual(chosen.kit_requests, []);
  const wrong = placementPlan(l.units, WALLS, S, { family: FAMILY, type_for: { corner: "Corner" }, wall_unit_bottom: 1450, params: PARAMS, lib: LIB });
  assert.match(wrong.skipped.find((s) => s.mark === "K01")!.why, /type_for names Corner for corner, which isn't a FMC_I_Casework_KitchenUnit type/);
});

test("placement never assumes: the wall-unit height, the walls' place and their lengths are needed; keynotes come from the library", () => {
  const l = layoutRun(RUN, S);
  const noHeight = placementPlan(l.units, WALLS, S, { family: FAMILY, params: PARAMS, lib: LIB });
  assert.ok(noHeight.problems.some((p) => /wall_unit_bottom/.test(p)));
  assert.ok(noHeight.kit_requests.some((r) => r.item === "Wall-unit height"));
  const nowhere = placementPlan(l.units, FIX.run.walls, S, { family: FAMILY, wall_unit_bottom: 1450, params: PARAMS, lib: LIB });
  assert.ok(nowhere.problems.some((p) => /Wall A has no place in the model/.test(p)));
  const short = placementPlan(l.units, [{ ...WALLS[0], end: [3500, 0] }, WALLS[1]], S, { family: FAMILY, wall_unit_bottom: 1450, params: PARAMS, lib: LIB });
  assert.ok(short.problems.some((p) => /run says 3600 long but start → end is 3500/.test(p)));
  const noKeynote = placementPlan(l.units, WALLS, S, { family: FAMILY, wall_unit_bottom: 1450, params: PARAMS,
    lib: readLibrary({ materials: [{ name: "FMC_Board_Plywood_Marine18", keynote: "I.CLG_02" }] }) });
  assert.deepEqual(noKeynote.type_params, {});
  assert.deepEqual(noKeynote.kit_requests.map((r) => r.item), ["FMC_Board_Plywood_Marine18", "FMC_Stone_Granite_Black_Polished", "FMC_I_Casework_KitchenUnit corner type", "FMC_I_Casework_KitchenUnit sink type"]);
  assert.match(noKeynote.kit_requests[0].request, /J.CAB_xx keynote .*\(it has I.CLG_02\)/);
});

/** A 3600 × 3000 room read anticlockwise; wall 1 is the window wall (A), wall 4 runs down the y axis (B, reversed). */
const ROOM: RoomRead = {
  room: { number: "G05", name: "Kitchen", level: "Ground" },
  walls: [
    { start: [0, 0], end: [3600, 0], wall_id: 11 }, { start: [3600, 0], end: [3600, 3000], wall_id: 12 },
    { start: [3600, 3000], end: [0, 3000], wall_id: 13 }, { start: [0, 3000], end: [0, 0], wall_id: 14 },
  ],
  openings: [
    { kind: "window", wall_id: 11, at: [1800, -115], width: 1200, sill: 850 },
    { kind: "door", wall_id: 13, at: [900, 3115], width: 900 },
  ],
  points: [
    { category: "Plumbing Fixtures", family: "FMC_P_PlumbFix_WastePoint", type: "40 mm", at: [2000, 60, 400] },
    { category: "Electrical Fixtures", family: "FMC_E_ElecFix_SocketDouble", type: "13 A", at: [3200, 30, 1100] },
    { category: "Electrical Fixtures", family: "FMC_E_ElecFix_SocketDouble", type: "13 A", at: [40, 1500, 1100] },
    { category: "Pipe Accessories", family: "FMC_P_PipeAcc_GasValve", type: "15 mm", at: [40, 2700, 600] },
  ],
};

test("room reading: walls in boundary order with their place, doors and windows on them, services by kind", () => {
  const r = runFromRoom(ROOM);
  assert.deepEqual(r.walls.map((w) => [w.name, w.length, w.start, w.end]), [["W1", 3600, [0, 0], [3600, 0]], ["W2", 3000, [3600, 0], [3600, 3000]], ["W3", 3600, [3600, 3000], [0, 3000]], ["W4", 3000, [0, 3000], [0, 0]]]);
  assert.deepEqual(r.walls[0].openings, [{ kind: "window", offset: 1200, width: 1200 }]);
  assert.deepEqual(r.walls[2].openings, [{ kind: "door", offset: 2250, width: 900 }]);
  assert.deepEqual(r.sills, [{ wall: "W1", offset: 1200, width: 1200, sill: 850 }]);
  assert.deepEqual(r.services.map((s) => s.kind), ["waste", "socket", "socket", "gas"]);
});

test("service kinds: gas before waste before water; sockets by category", () => {
  assert.equal(serviceKind({ category: "Plumbing Fixtures", family: "Gas tap", type: "" }), "gas");
  assert.equal(serviceKind({ category: "Pipe Accessories", family: "Valve", type: "DCW 15" }), "water");
  assert.equal(serviceKind({ category: "Plumbing Fixtures", family: "Sink", type: "Single", system: "Sanitary" }), "waste");
  assert.equal(serviceKind({ category: "Electrical Fixtures", family: "Spur", type: "Fused" }), "socket");
  assert.equal(serviceKind({ category: "Lighting Fixtures", family: "Downlight", type: "" }), "other");
});

test("walls are matched to the room's by where they run", () => {
  const r = runFromRoom(ROOM);
  assert.deepEqual([...matchWalls(r.walls, WALLS)], [["W1", "A"]]);
  assert.deepEqual([...matchWalls(r.walls, [{ name: "B", length: 3000, start: [0, 3000], end: [0, 0] }])], [["W4", "B"]]);
});

test("coordination checks flag with the rule and decide nothing", () => {
  const l = layoutRun(RUN, S);
  const r = runFromRoom(ROOM);
  const sills = r.sills.map((x) => ({ ...x, wall: "A" }));
  const flags = coordinationChecks(l.units, WALLS, r.services, sills, S);
  const by = (check: string) => flags.filter((f) => f.check === check);
  assert.deepEqual(by("waste at the sink").map((f) => [f.mark, f.state]), [["K03", "ok"]]);
  assert.deepEqual(by("water at the sink").map((f) => [f.mark, f.state]), [["K03", "flag"]]);
  assert.match(by("water at the sink")[0].rule, /rule 5/);
  assert.deepEqual(by("socket behind a tall unit").map((f) => [f.mark, f.state]), [["K05", "flag"]]);
  assert.deepEqual(by("socket over the cooker").map((f) => [f.mark, f.state]), [["K07", "flag"]]);
  assert.deepEqual(by("gas at the cooker").map((f) => [f.mark, f.state]), [["K07", "flag"]], "the gas point is on B but not behind the cooker space");
  assert.deepEqual(by("window sill").map((f) => [f.mark, f.state]), [["K02, K03", "flag"]]);
  assert.match(by("window sill")[0].detail, /sill at 850, below the carcass top at 870/);
  assert.ok(flags.every((f) => f.rule.length > 0));
  assert.ok(flags.some((f) => f.rule.startsWith(NO_KIT_RULE)));
  // no gas anywhere: an info for the professional, not a flag
  const noGas = coordinationChecks(l.units, WALLS, r.services.filter((s) => s.kind !== "gas"), [], S);
  assert.equal(noGas.find((f) => f.check === "gas at the cooker")!.state, "info");
});

const SHEETS_RULEBOOK = { rules: [
  { id: "SHT-011", check: { params: { family: "FMC_TitleBlock", types: ["A0", "A1", "A3"] } } },
  { id: "SHT-013", check: { params: { margin_left_mm: 20, margin_other_mm: 10 } } },
  { id: "SHT-014", check: { params: { drawing_area_mm: [681, 574] } } },
  { id: "SHT-017", check: { params: { a3_scale: 0.5 } } },
] };

const SHEET_REGISTER = [
  "Role,Discipline,SheetNumber,SheetName,Series,Scale,Core,IssueSet,Placed",
  "I,Interior Design,I-4001,Joinery: Kitchen,4xxx Enlarged plans and details,1:20,Core,TENDER+CONSTRUCTION,VT_I_Joinery",
  "I,Interior Design,I-4002,Joinery: Wardrobes & Vanities,4xxx Enlarged plans and details,1:20,Optional,TENDER+CONSTRUCTION,VT_I_Joinery",
  "I,Interior Design,I-5002,Joinery Cut List,5xxx Schedules,NTS,Optional,CONSTRUCTION,I11_Joinery_Cutlist",
].map(csvRow);

test("the A3 frame and the sheets come from the kit's rulebook and register", () => {
  const { frame } = a3Frame(SHEETS_RULEBOOK);
  assert.deepEqual(frame, { title_block: { family: "FMC_TitleBlock", type: "A3" }, origin: [10, 5], area: [340.5, 287] });
  assert.match(a3Frame({ rules: SHEETS_RULEBOOK.rules.slice(0, 2) }).problem, /drawing area/);
  assert.match(a3Frame({ rules: [] }).problem, /A3 title block/);
  assert.deepEqual(registerSheet(SHEET_REGISTER, "I-4001"), { number: "I-4001", name: "Joinery: Kitchen", scale: 20, placed: "VT_I_Joinery" });
  assert.deepEqual(registerSheetFor(SHEET_REGISTER, "I11_Joinery_Cutlist"), { number: "I-5002", name: "Joinery Cut List", scale: 0, placed: "I11_Joinery_Cutlist" });
  assert.equal(registerSheet(SHEET_REGISTER, "I-9999"), null);
});

test("shop drawings: every unit's elevation fits the A3 drawing area at 1:20, none overlap, and overflow is named", () => {
  const l = layoutRun(RUN, S);
  const frame = a3Frame(SHEETS_RULEBOOK).frame!;
  const { views, overflow } = shopLayout(l.units, S, 20, frame, ["I-4001"], 150);
  assert.deepEqual(overflow, []);
  assert.equal(views.length, 12);
  assert.ok(views.every((v) => v.sheet === "I-4001"));
  assert.deepEqual(elevationSize(l.units.find((u) => u.mark === "K05")!, S, 150), [900, 2550]);
  for (const v of views) {
    assert.ok(v.centre[0] - v.size[0] / 2 >= frame.origin[0] - 0.1 && v.centre[0] + v.size[0] / 2 <= frame.origin[0] + frame.area[0] + 0.1, `${v.mark} leaves the area`);
    assert.ok(v.centre[1] - v.size[1] / 2 >= frame.origin[1] - 0.1 && v.centre[1] + v.size[1] / 2 <= frame.origin[1] + frame.area[1] + 0.1, `${v.mark} leaves the area`);
  }
  for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) {
    const a = views[i], b = views[j];
    const apart = Math.abs(a.centre[0] - b.centre[0]) >= (a.size[0] + b.size[0]) / 2 || Math.abs(a.centre[1] - b.centre[1]) >= (a.size[1] + b.size[1]) / 2;
    assert.ok(apart, `${a.mark} and ${b.mark} overlap`);
  }
  const small = { ...frame, area: [200, 140] as [number, number] };
  const two = shopLayout(l.units, S, 20, small, ["I-4001", "I-4002"], 150);
  assert.ok(two.views.some((v) => v.sheet === "I-4002"));
  const one = shopLayout(l.units, S, 20, small, ["I-4001"], 150);
  assert.ok(one.overflow.length > 0);
});

test("the Revit commands are behind the live-model lock", () => {
  assert.ok(WRITE_COMMANDS.has("fmc_casework_place"));
  assert.ok(WRITE_COMMANDS.has("fmc_casework_pack"));
  assert.ok(!WRITE_COMMANDS.has("fmc_casework_room"), "reading a room changes nothing");
});

test("fmc_casework place and shop_drawings refuse before Revit when something is missing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-casework-place-"));
  const md = path.join(dir, "kit", "03_Master_Data");
  fs.mkdirSync(md, { recursive: true });
  fs.mkdirSync(path.join(dir, "kit", "07_Materials"), { recursive: true });
  fs.writeFileSync(path.join(md, "FMC_Family_Register.csv"), REGISTER.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c}"` : c)).join(",")).join("\r\n"));
  fs.writeFileSync(path.join(md, "FMC_Master_Data.json"), JSON.stringify(MASTER));
  fs.writeFileSync(path.join(dir, "kit", "07_Materials", "FMC_Materials.json"), JSON.stringify({ materials: [] }));
  const guard = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(guard, JSON.stringify({ write_roots: [dir], reports_dir: path.join(dir, "reports"), specs_path: path.join(md, "FMC_Family_Specs.json"),
    materials_file: path.join(dir, "kit", "07_Materials", "FMC_Materials.json"), rulebooks_dir: path.join(md, "FMC_Rulebook") }));
  const old = process.env.FMC_GUARD_CONFIG;
  process.env.FMC_GUARD_CONFIG = guard;
  try {
    const { runFmcCasework, FMC_CASEWORK_SHAPE } = await import("../tools/fmc_casework.js");
    const { z } = await import("zod");
    const schema = z.object(FMC_CASEWORK_SHAPE);
    const call = async (a: object) => { const r = await runFmcCasework(schema.parse(a)); return { body: JSON.parse(r.content[0].text), isError: r.isError }; };

    const room = await call({ action: "room" });
    assert.equal(room.isError, true);
    assert.match(room.body.reasons[0], /Name the room/);

    const bare = await call({ action: "place", run: FIX.run, standards: S });
    assert.equal(bare.isError, true);
    assert.match(bare.body.reasons.join(" "), /label/);
    assert.match(bare.body.reasons.join(" "), /level/);

    const noPlace = await call({ action: "place", run: FIX.run, standards: S, label: "K-01 Kitchen", level: "Ground", wall_unit_bottom: 1450 });
    assert.equal(noPlace.isError, true);
    assert.match(noPlace.body.reasons.join(" "), /Wall A has no place in the model/);
    assert.ok(noPlace.body.kit_requests.some((k: { item: string }) => k.item === "FMC_I_Casework_KitchenUnit corner type"));

    const notKit = await call({ action: "place", run: RUN, standards: S, label: "K-01 Kitchen", level: "Ground", family: "FMC_I_Casework_Pantry" });
    assert.equal(notKit.isError, true);
    assert.match(notKit.body.reasons[0], /isn't in the kit's family register/);

    const noSheets = await call({ action: "shop_drawings", run: RUN, standards: S, label: "K-01 Kitchen", project_code: "HA" });
    assert.equal(noSheets.isError, true);
    assert.match(noSheets.body.reasons.join(" "), /joinery sheet/);
  } finally {
    if (old === undefined) delete process.env.FMC_GUARD_CONFIG; else process.env.FMC_GUARD_CONFIG = old;
  }
});
