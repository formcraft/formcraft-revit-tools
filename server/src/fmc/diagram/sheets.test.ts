import { test } from "node:test";
import assert from "node:assert/strict";
import { SCAN_RESULT, ScanResult } from "./contract.js";
import { layoutScan } from "./layout.js";
import { DEFAULT_DIAGRAM_KIT } from "./symbols.js";
import { DEFAULT_FRAME, DRAINAGE_LONG, DrawnView, a1Frame, diagramSheets, drawnSources, gateD, sheetForKind, sheetPlan, viewExtent } from "./sheets.js";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "../policy.js";

// The kit's Sheet Register rows that matter here (FMC_Kit_v2.2, 03_Master_Data\FMC_Sheet_Register.csv), word for word.
const REGISTER = [
  "Role,Discipline,SheetNumber,SheetName,Series,Scale,Core,IssueSet,Placed",
  "E,Electrical Engineering,E-0002,Electrical Legend & Mounting Heights,0xxx General,NTS,Core,PERMIT+TENDER+CONSTRUCTION,LG_E_Symbols; LG_E_MountingHeights",
  "E,Electrical Engineering,E-0003,Single-Line Diagram & Load Summary,0xxx General,NTS,Core,PERMIT+TENDER+CONSTRUCTION,VT_E_Drafting_SLD; E10_Load_Summary",
  "E,Electrical Engineering,E-0004,Earthing & Bonding Schematic,0xxx General,NTS,Optional,TENDER+CONSTRUCTION,VT_E_Drafting_SLD",
  "E,Electrical Engineering,E-1301,Ground Floor Fire Alarm Layout,1xxx Plans,1:100,Core,PERMIT+TENDER+CONSTRUCTION,VT_E_FloorPlan_FireAlarm",
  "E,Electrical Engineering,E-4101,Typical Installation Details,4xxx Enlarged plans and details,1:10,Optional,CONSTRUCTION,VT_E_Drafting_SLD",
  "E,Electrical Engineering,E-6002,Riser Diagram,6xxx 3D and visualisation,NTS,Optional,TENDER+CONSTRUCTION,VT_E_Drafting_SLD",
  "M,Mechanical / HVAC,M-4101,Typical Installation Details,4xxx Enlarged plans and details,1:10,Optional,CONSTRUCTION,VT_M_Drafting",
  "P,Plumbing & Drainage,P-0003,Water & Drainage Schematics,0xxx General,NTS,Core,PERMIT+TENDER+CONSTRUCTION,VT_P_Drafting_Schematic",
  "P,Plumbing & Drainage,P-3001,Drainage Long Sections,3xxx Sections,1:100,Optional,TENDER+CONSTRUCTION,VT_P_Section",
  "C,Civil & External Works,C-3001,Site Sections & Road Long Sections,3xxx Sections,1:200,Optional,TENDER+CONSTRUCTION,VT_C_Section",
  "C,Civil & External Works,C-3002,Drain Long Sections,3xxx Sections,1:200,Optional,TENDER+CONSTRUCTION,VT_C_Section",
].join("\r\n");

const RULEBOOK = { rules: [
  { id: "SHT-011", check: { params: { family: "FMC_TitleBlock", types: ["A0", "A1", "A3"] } } },
  { id: "SHT-012", check: { params: { default: "A1", a1_mm: [841, 594] } } },
  { id: "SHT-013", check: { params: { margin_left_mm: 20, margin_other_mm: 10 } } },
  { id: "SHT-014", check: { params: { drawing_area_mm: [681, 574] } } },
] };

type P = Record<string, string | number | null>;
const N = (id: string, kind: string, name: string, level: string | null = null, params: P = {}, family = "") => ({ id, kind, name, level, params, family, category: "", type: "" });
const E = (from: string, to: string, kind: string, params: P = {}, id: string | null = null) => ({ id, from, to, kind, params });

/** A board with three circuits, a water riser and a sprinkler riser: enough for three sheets and one with no register row. */
function scan(): ScanResult {
  return SCAN_RESULT.parse({
    model: "F26001-FMC-ZZ-XX-M3-E-0001.rvt",
    levels: [{ id: "L00", name: "Ground", elevation_mm: 0 }, { id: "L01", name: "First", elevation_mm: 3500 }],
    diagrams: [
      { kind: "e_sld", system: "MDB", nodes: [
        N("S1", "supply", "Utility supply"), N("MDB", "board", "MDB", "L00", { panel_id: "MDB", part_type: "Switchboard", distribution_system: "400/230 V", ways: 6 }),
        N("LT1", "load", "Lighting"), N("SK1", "load", "Sockets"), N("AC1", "load", "AC")],
        edges: [E("S1", "MDB", "feeder", {}, "f0"),
          E("MDB", "LT1", "circuit", { circuit: "1", rating: 10, poles: 1, cable: "1.5 mm² T+E", load_name: "Lighting", apparent_load: 600 }, "c1"),
          E("MDB", "SK1", "circuit", { circuit: "2", rating: 32, poles: 1, cable: "2.5 mm² T+E", load_name: "Sockets", apparent_load: 3000 }, "c2"),
          E("MDB", "AC1", "circuit", { circuit: "3", rating: null, poles: 2, cable: null, load_name: "AC", apparent_load: 2500 }, "c3")] },
      { kind: "p_water", system: "DCW", nodes: [N("T1", "tank", "Roof tank", "L01"), N("R1", "riser", "Riser 1", "L00"), N("WC1", "fixture", "WC", "L00", { system: "DCW" })],
        edges: [E("T1", "R1", "pipe", { size: "50 mm" }, "p1"), E("R1", "WC1", "pipe", { size: "15 mm" }, "p2")] },
      { kind: "fp_schematic", system: "Sprinklers", nodes: [N("FP1", "pump", "Fire pump", "L00"), N("SP1", "sprinkler", "Head", "L01")],
        edges: [E("FP1", "SP1", "pipe", { size: "25 mm" }, "p3")] },
    ],
    gaps: [],
  });
}

test("LD5: the register's diagram sheets and the kinds that go on each; detail and plan sheets are not diagram sheets", () => {
  const { sheets, unmapped } = diagramSheets(REGISTER);
  const kinds = Object.fromEntries(sheets.map((s) => [s.number, s.kinds]));
  assert.deepEqual(kinds, {
    "E-0003": ["e_sld"], "E-0004": ["lp_schematic"], "E-6002": ["e_power_riser", "e_fa_riser", "e_elv_riser"],
    "P-0003": ["p_water", "p_drainage"], "P-3001": [DRAINAGE_LONG], "C-3002": [DRAINAGE_LONG],
  });
  assert.deepEqual(unmapped.map((u) => u.number).sort(), ["C-3001", "E-4101"]);
  assert.match(unmapped.find((u) => u.number === "E-4101")!.why, /VT_E_Drafting_SLD/);
  assert.equal(sheetForKind("e_fa_riser", sheets)!.number, "E-6002");
  assert.equal(sheetForKind("lp_schematic", sheets)!.number, "E-0004");
  assert.equal(sheetForKind(DRAINAGE_LONG, sheets)!.number, "P-3001", "plumbing's own row first");
  assert.equal(sheetForKind("fp_schematic", sheets), null);
  assert.deepEqual(diagramSheets("nothing,here\r\n1,2"), { sheets: [], unmapped: [] });
});

test("LD5: the A1 frame comes from the sheets rulebook, with the defaults and a reason when it can't", () => {
  assert.deepEqual(a1Frame(RULEBOOK), { frame: { title_block: "FMC_TitleBlock : A1", origin: [20, 10], area: [681, 574] }, problem: "" });
  const none = a1Frame(null);
  assert.deepEqual(none.frame, DEFAULT_FRAME);
  assert.match(none.problem, /SHT-011/);
});

test("LD5: views go on their register sheets inside the drawing area, never overlapping; the rest are listed, not invented", () => {
  const plan = layoutScan(scan());
  const sp = sheetPlan(plan, diagramSheets(REGISTER), a1Frame(RULEBOOK).frame);
  const on = (n: string) => sp.sheets.find((s) => s.number === n)!;
  assert.deepEqual(on("E-0003").views.map((v) => v.name), ["E-SLD-MDB"]);
  assert.deepEqual(on("E-6002").views.map((v) => v.name), ["E-Power-Riser"]);
  assert.deepEqual(on("P-0003").views.map((v) => v.name), ["P-Water-Schematic"]);
  assert.equal(on("E-0003").title_block, "FMC_TitleBlock : A1");
  assert.equal(on("E-0004").views.length, 0, "listed, nothing to place yet");
  assert.ok(!sp.sheets.some((s) => s.number === "P-3001"), "the long section has no drafting view");
  assert.deepEqual(sp.no_sheet, [{ kind: "fp_schematic", views: ["FP-Schematic"] }]);
  assert.ok(sp.kit_change_requests.some((k) => k.includes("fp_schematic") && k.includes("FMC_Sheet_Register.csv")));
  assert.equal(sp.tbc[0].kind, DRAINAGE_LONG);
  assert.deepEqual(sp.tbc[0].sheets, ["P-3001 Drainage Long Sections", "C-3002 Drain Long Sections"]);
  assert.ok(sp.tbc[0].missing.some((m) => /invert/.test(m)) && sp.tbc[0].missing.some((m) => /manhole/.test(m)));
  for (const s of sp.sheets) for (const v of s.views) {
    const [cx, cy] = v.center_mm, [w, h] = v.size_mm;
    assert.ok(cx - w / 2 >= 20 - 0.1 && cx + w / 2 <= 701 + 0.1 && cy + h / 2 <= 584 + 0.1 && cy - h / 2 - 12 >= 10 - 0.1, `${v.name} and its title in the drawing area`);
  }
  // only some views
  assert.deepEqual(sheetPlan(plan, diagramSheets(REGISTER), DEFAULT_FRAME, DEFAULT_DIAGRAM_KIT, ["e-sld-mdb"]).sheets.flatMap((s) => s.views.map((v) => v.name)), ["E-SLD-MDB"]);
});

test("LD5: two views share a sheet side by side; a view that doesn't fit is left off with a kit change request", () => {
  const plan = layoutScan(scan(), DEFAULT_DIAGRAM_KIT, ["e_sld", "e_power_riser"]);
  const reg = diagramSheets(REGISTER);
  // both on E-0003 for this check: a register whose single-line sheet is also the riser sheet
  for (const s of reg.sheets) if (s.number === "E-0003") s.kinds = ["e_sld", "e_power_riser"];
  reg.sheets = reg.sheets.filter((s) => s.number !== "E-6002");
  const roomy = sheetPlan(plan, reg, DEFAULT_FRAME).sheets.find((s) => s.number === "E-0003")!;
  assert.equal(roomy.views.length, 2);
  const [a, b] = roomy.views;
  const apart = Math.abs(a.center_mm[0] - b.center_mm[0]) >= (a.size_mm[0] + b.size_mm[0]) / 2 || Math.abs(a.center_mm[1] - b.center_mm[1]) >= (a.size_mm[1] + b.size_mm[1]) / 2;
  assert.ok(apart, "no overlap");
  const w = Math.max(...plan.views.map((v) => { const e = viewExtent(v.view); return e.x1 - e.x0; }));
  const tight = sheetPlan(plan, reg, { title_block: "X", origin: [0, 0], area: [w + 1, 2000] });
  const sheet = tight.sheets.find((s) => s.number === "E-0003")!;
  assert.equal(sheet.views.length + sheet.left_off.length, 2);
  const small = sheetPlan(plan, reg, { title_block: "X", origin: [0, 0], area: [w + 1, 50] });
  const s2 = small.sheets.find((s) => s.number === "E-0003")!;
  assert.equal(s2.views.length, 1, "the first view goes on even when it is too big, with a warning");
  assert.match(s2.views[0].warning!, /bigger than the drawing area/);
  assert.equal(s2.left_off.length, 1);
  assert.ok(small.kit_change_requests.some((k) => k.startsWith("E-0003") && /continuation sheet/.test(k) && /never invents/.test(k)));
});

const drawnFrom = (plan: ReturnType<typeof layoutScan>, name: string, extra: string[] = [], drop: string[] = [], tbc = 0, sheets = ["E-0003"]): DrawnView => {
  const v = plan.views.find((x) => x.view.name === name)!;
  const keys = v.view.items.map((i, n) => `${name}|${i.source_id ?? n}|${i.t}`).filter((k) => !drop.some((d) => k.includes(`|${d}|`)));
  return { name, view_id: "900", keys: [...keys, ...extra.map((e) => `${name}|${e}|symbol`)], tbc_texts: tbc, kept_by_hand: 1, sheets };
};

test("LD5 Gate D: a drawing that matches the model passes; TBC is a warning; missing and gone items fail", () => {
  const s = scan();
  const plan = layoutScan(s, DEFAULT_DIAGRAM_KIT, ["e_sld"]);
  const ok = gateD(plan, [drawnFrom(plan, "E-SLD-MDB")], s, DEFAULT_DIAGRAM_KIT, ["e_sld"]);
  const tbcPlanned = plan.views[0].tbc;
  assert.equal(ok.verdict, tbcPlanned ? "Warn" : "Pass");
  assert.equal(ok.lines.find((l) => l.check === "Items in the model are on the drawing")!.state, "Pass");
  assert.equal(ok.lines.find((l) => l.check === "Drawn items are still in the model")!.state, "Pass");
  assert.equal(ok.lines.find((l) => l.check === "Every diagram is drawn")!.state, "Pass");

  const tbc = gateD(plan, [drawnFrom(plan, "E-SLD-MDB", [], [], 3)], s, DEFAULT_DIAGRAM_KIT, ["e_sld"]);
  assert.equal(tbc.verdict, "Warn");
  assert.match(tbc.lines.find((l) => l.check === "TBC values")!.detail, /3 texts with TBC/);

  const bad = gateD(plan, [drawnFrom(plan, "E-SLD-MDB", ["old-circuit-uid"], ["c2"])], s, DEFAULT_DIAGRAM_KIT, ["e_sld"]);
  assert.equal(bad.verdict, "Fail");
  assert.equal(bad.views[0].state, "Fail");
  assert.deepEqual(bad.views[0].missing, ["c2"]);
  assert.deepEqual(bad.views[0].gone, ["old-circuit-uid"]);
  assert.match(bad.summary, /regenerate/);

  // not drawn yet; a ceiling set-out drawn with the same tool is not a diagram; a diagram the model no longer makes fails
  const none = gateD(plan, [], s, DEFAULT_DIAGRAM_KIT, ["e_sld"]);
  assert.equal(none.verdict, "Warn");
  assert.match(none.lines[0].detail, /E-SLD-MDB/);
  const other = gateD(plan, [drawnFrom(plan, "E-SLD-MDB"), { name: "I-CLG-Lounge-SetOut", view_id: "1", keys: ["I-CLG-Lounge-SetOut|x|line"], tbc_texts: 0, kept_by_hand: 0, sheets: [] },
    { name: "E-SLD-DB9", view_id: "2", keys: ["E-SLD-DB9|gone-board|symbol"], tbc_texts: 0, kept_by_hand: 0, sheets: ["E-0003"] }], s, DEFAULT_DIAGRAM_KIT, ["e_sld"]);
  assert.ok(!other.views.some((v) => v.view.startsWith("I-CLG")));
  assert.equal(other.views.find((v) => v.view === "E-SLD-DB9")!.state, "Fail");
  assert.match(other.lines.find((l) => l.check === "Drawn items are still in the model")!.detail, /E-SLD-DB9/);
  // nothing anywhere
  const empty = SCAN_RESULT.parse({ model: "x", levels: [], diagrams: [], gaps: [] });
  assert.equal(gateD(layoutScan(empty), [], empty).verdict, "Not checked");
  // off a sheet
  const off = gateD(plan, [drawnFrom(plan, "E-SLD-MDB", [], [], 0, [])], s, DEFAULT_DIAGRAM_KIT, ["e_sld"]);
  assert.equal(off.lines.find((l) => l.check === "Drawn diagrams are on a sheet")!.state, "Warn");
});

test("LD5 Gate D: source keys give the source ids; index keys (items with no source) are left out", () => {
  assert.deepEqual(drawnSources({ name: "E-SLD-MDB", view_id: null, keys: ["E-SLD-MDB|c1|symbol", "E-SLD-MDB|c1|text", "E-SLD-MDB|12|line", "E-SLD-MDB|circuit:11|text", "X|c9|line"],
    tbc_texts: 0, kept_by_hand: 0, sheets: [] }), ["c1", "circuit:11"]);
});

test("LD5: the sheet command is behind the live-model lock, the drawn read is a read; real sheets need confirm", async () => {
  assert.ok(WRITE_COMMANDS.has("fmc_diagram_sheet"));
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_diagram_drawn") && !WRITE_COMMANDS.has("fmc_diagram_drawn"));
  const { runFmcDiagram, FMC_DIAGRAM_SHAPE } = await import("../../tools/fmc_diagram.js");
  assert.ok(FMC_DIAGRAM_SHAPE.action.safeParse("sheets").success && FMC_DIAGRAM_SHAPE.action.safeParse("gate").success);
  const r = await runFmcDiagram({ action: "sheets", kinds: [], kit_folder: "", views: [], save: false, dry_run: false, confirm: false });
  assert.equal(r.isError, true);
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.refused, true);
  assert.match(body.reasons[0], /creates sheets/);
});
