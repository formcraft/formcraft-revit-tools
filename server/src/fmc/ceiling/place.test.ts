import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { CeilingInput, Evaluated, Kind, evaluate, standardFor } from "./engine.js";
import { Rect, polyRects } from "./geometry.js";
import { emptyKit } from "./standard.js";
import { mergeRuns, placementPlan, regionComponents, regionLoops, signedArea, steps, walls } from "./place.js";
import { parseCsv, rcpSheet, rcpSpec, registerFamilies, sectionProfile, sectionView, setoutView, RCP_SYMBOLS } from "./drawings.js";
import { WRITE_COMMANDS } from "../policy.js";
import { FMC_CEILING_SHAPE, placeParams, runFmcCeiling } from "../../tools/fmc_ceiling.js";

// The golden room of the CL boards (as in ceiling.test.ts): 6.0 × 4.5 m, tray with a 600 bulkhead dropped 300, cove and
// cornice, fan in the middle, 6 downlights in the bulkhead, a smoke detector, an AC grille and a 600 hatch.
const L = 6000, W = 4500, B = 600;
const args = (extra: Record<string, unknown> = {}) => z.object(FMC_CEILING_SHAPE).parse({
  action: "designs",
  room: { name: "L-01 Living", width_mm: L, depth_mm: W, structure_height_mm: 3000 },
  fixtures: {
    fan: { x: L / 2, y: W / 2 },
    downlights: [[B / 2, 1125], [B / 2, 3375], [L - B / 2, 1125], [L - B / 2, 3375], [2000, B / 2], [4000, B / 2]].map(([x, y]) => ({ x, y })),
    detectors: [{ x: 1500, y: W / 2, kind: "smoke" }],
    ac_grilles: [{ x: 4300, y: W - B / 2 }],
    hatch: { x: L - 900, y: W / 2 },
  },
  brief: { styles: ["tray", "cove", "cornice"] },
  ...extra,
});
const golden = () => args() as unknown as CeilingInput;
const KIT = emptyKit();
const ev = (kind: Kind, input = golden()) => evaluate(kind, input, standardFor(input, KIT).std, kind) as Evaluated;
const total = (xs: Array<{ length_mm: number }>) => xs.reduce((s, x) => s + x.length_mm, 0);

test("loops: a rectangle is one counter-clockwise loop; a ring has a clockwise hole; an L keeps its six corners", () => {
  const rect = regionLoops([{ x0: 0, y0: 0, x1: 6000, y1: 4500 }]);
  assert.deepEqual(rect.outer, [[0, 0], [6000, 0], [6000, 4500], [0, 4500]]);
  assert.equal(rect.holes.length, 0);
  const ring = ev("tray").design.zones.find((z) => z.id === "bulkhead")!.rects;
  assert.equal(regionComponents(ring).length, 1);
  const r = regionLoops(ring);
  assert.equal(r.outer.length, 4);
  assert.ok(signedArea(r.outer) > 0);
  assert.equal(r.holes.length, 1);
  assert.ok(signedArea(r.holes[0]) < 0);
  assert.equal(signedArea(r.outer) + signedArea(r.holes[0]), 11.16e6);
  const l = regionLoops(polyRects([[0, 0], [5000, 0], [5000, 2000], [2000, 2000], [2000, 4000], [0, 4000]]));
  assert.equal(l.outer.length, 6);
  assert.equal(signedArea(l.outer), 5000 * 2000 + 2000 * 2000);
});

test("runs: collinear pieces join only within their own tag", () => {
  const m = mergeRuns([
    { a: [0, 0], b: [600, 0], t: "a" }, { a: [1200, 0], b: [600, 0], t: "a" }, { a: [1200, 0], b: [1800, 0], t: "b" },
  ], (s) => s.t);
  assert.equal(m.length, 2);
  assert.deepEqual(m.find((x) => x.t === "a"), { a: [0, 0], b: [1200, 0], t: "a" });
});

test("golden place plan: two ceilings at 2850 and 2550, faces, cove and cornice as the quantities, marks only for fixtures", () => {
  const e = ev("tray");
  const p = placementPlan(e.design, golden(), { x: 10000, y: 20000 });
  assert.deepEqual(p.problems, []);
  assert.equal(p.ceilings.length, 2);
  const field = p.ceilings.find((c) => c.zone === "field")!, bulk = p.ceilings.find((c) => c.zone === "bulkhead")!;
  assert.equal(field.height_mm, 2850);
  assert.equal(field.area_m2, 15.84);
  assert.deepEqual(field.loops, [[[10600, 20600], [15400, 20600], [15400, 23900], [10600, 23900]]]);
  assert.equal(bulk.height_mm, 2550);
  assert.equal(bulk.area_m2, 11.16);
  assert.equal(bulk.loops.length, 2); // the outer edge and the field's opening
  const role = (r: string) => p.lines.filter((l) => l.role === r);
  assert.equal(role("face").length, 4);
  assert.equal(total(role("face")), 16200); // = cove LED 16.2 m in the golden quantities
  assert.ok(role("face").every((l) => l.z_mm === 2550 && l.drop_mm === 300));
  assert.equal(total(role("cove")), e.q.cove_led_m * 1000);
  assert.equal(total(role("cornice")), e.q.cornice_m * 1000);
  assert.ok(role("cornice").every((l) => l.z_mm === 2550 && l.zones === "bulkhead"));
  assert.equal(role("coffer_moulding").length, 0);
  assert.deepEqual(p.summary.marks, { fan: 1, downlight: 6, detector: 1, ac_grille: 1, hatch: 1 });
  const fan = p.marks.find((m) => m.kind === "fan")!;
  assert.deepEqual([fan.x, fan.y, fan.z_mm, fan.sweep_mm], [13000, 22250, 2850, 1200]);
  assert.ok(p.marks.filter((m) => m.kind === "downlight").every((m) => m.z_mm === 2550 && /position only/.test(m.label)));
  assert.deepEqual(new Set(p.lines.map((l) => l.key)).size, p.lines.length);
});

test("coffered plan: one ceiling per coffer, the beams one ceiling with an opening per coffer, mouldings round each coffer", () => {
  const e = ev("coffer");
  const p = placementPlan(e.design, golden());
  const coffers = p.ceilings.filter((c) => c.zone === "coffer");
  const base = p.ceilings.filter((c) => c.zone === "field");
  assert.ok(coffers.length >= 2);
  assert.equal(base.length, 1);
  assert.equal(base[0].loops.length, 1 + coffers.length);
  const perim = e.design.zones.find((z) => z.id === "coffer")!.rects.reduce((s, r) => s + 2 * (r.x1 - r.x0 + r.y1 - r.y0), 0);
  assert.equal(total(p.lines.filter((l) => l.role === "coffer_moulding")), perim);
  assert.equal(p.lines.filter((l) => l.role === "cove").length, 0); // no cove on a coffered ceiling
});

test("a fixture outside the room is reported, not marked; walls and steps carry their heights", () => {
  const input = golden();
  input.fixtures.downlights.push({ x: 7000, y: 100 });
  const p = placementPlan(ev("tray", input).design, input);
  assert.equal(p.marks.filter((m) => m.kind === "downlight").length, 6);
  assert.match(p.problems[0], /outside the room/);
  const d = ev("raft").design;
  assert.ok(steps(d).every((s) => s.top_mm - s.bottom_mm === 150));
  assert.ok(walls(d).every((w) => w.zone === "field" && w.height_mm === 2850));
});

test("section: the golden tray cut along the width reads bulkhead, field, bulkhead", () => {
  const d = ev("tray").design;
  assert.deepEqual(sectionProfile(d, "x", 2250).map((r) => [r.from, r.to, r.height_mm]), [[0, 600, 2550], [600, 5400, 2850], [5400, 6000, 2550]]);
  assert.deepEqual(sectionProfile(d, "y", 300).map((r) => r.height_mm), [2550]);
  // a cut on an edge moves 1 mm off it and reads one ceiling each side, not two
  assert.deepEqual(sectionProfile(d, "y", 600).map((r) => [r.from, r.to, r.height_mm]), [[0, 600, 2550], [600, 3900, 2850], [3900, 4500, 2550]]);
  const v = sectionView(d, golden(), "I-CLG-L-01-Living-Section");
  assert.ok(v.items.some((i) => i.t === "text" && /\+2850 field/.test(i.text)));
  assert.equal(new Set(v.items.map((i) => i.source_id)).size, v.items.length);
});

test("set-out drawing: every board numbered, paper mm at 1:50, stable unique source ids", () => {
  const e = ev("tray");
  const v = setoutView(e, golden(), "I-CLG-L-01-Living-SetOut", 50, undefined, "I-1201");
  assert.equal(v.scale, 50);
  assert.equal(v.sheet_hint, "I-1201");
  const labels = v.items.filter((i) => i.t === "text" && i.source_id.startsWith("board-label:")).map((i) => (i as { text: string }).text.replace("*", ""));
  for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.ok(labels.includes(`F${n}`), `F${n} labelled`);
  const ids = v.items.map((i) => i.source_id);
  assert.equal(new Set(ids).size, ids.length);
  const xs = v.items.flatMap((i) => (i.t === "line" && i.source_id.startsWith("board:") ? i.points.map((p) => p[0]) : []));
  assert.ok(Math.max(...xs) <= 6000 / 50 + 1e-9 && Math.min(...xs) >= -1e-9);
  assert.equal(v.items.filter((i) => i.source_id.startsWith("hanger:") && i.source_id.endsWith(":a")).length, e.setout.hangers.length);
  assert.equal(v.items.filter((i) => i.source_id.startsWith("room:")).length, 4);
});

test("RCP: a kit symbol on every mark, a height symbol in each ceiling part, a level change on each step; unknown symbols left out", () => {
  const d = ev("tray").design;
  const p = placementPlan(d, golden());
  const all = rcpSpec(d, p, golden(), { x: 0, y: 0 }, null);
  assert.equal(all.symbols.filter((s) => s.family === RCP_SYMBOLS.downlight).length, 6);
  assert.equal(all.symbols.filter((s) => s.family === RCP_SYMBOLS.height).length, 2);
  assert.equal(all.symbols.filter((s) => s.family === RCP_SYMBOLS.level_change).length, 4);
  assert.ok(all.symbols.every((s) => s.type === "Standard"));
  assert.ok(all.texts.some((t) => t.text === "+2850") && all.texts.some((t) => t.text === "+2550"));
  assert.ok(all.texts.find((t) => t.key === "rcp:key")!.text.includes("positions only"));
  const reg = new Set(Object.values(RCP_SYMBOLS).filter((f) => f !== RCP_SYMBOLS.fan));
  const some = rcpSpec(d, p, golden(), { x: 0, y: 0 }, reg);
  assert.deepEqual(some.left_out, [RCP_SYMBOLS.fan]);
  assert.match(some.kit_change_requests[0], /FMC_SYM_E_CeilingFan isn't in the kit's family register/);
  assert.equal(some.symbols.length, all.symbols.length - 1);
  const [x0, y0, x1, y1] = all.crop_mm;
  assert.ok(x0 < 0 && y0 < 0 && x1 > 6000 && y1 > 4500);
});

test("registers: the family register's names and the VT_I_RCP sheet row", () => {
  const reg = 'Role,Family,Category\r\nI,FMC_SYM_I_CeilingHeightTag,Generic Annotations\r\nE,"FMC_SYM_E_Downlight",Generic Annotations\r\n';
  assert.deepEqual([...registerFamilies(reg)], ["FMC_SYM_I_CeilingHeightTag", "FMC_SYM_E_Downlight"]);
  const sheets = [
    "Role,Discipline,SheetNumber,SheetName,Series,Scale,Core,IssueSet,Placed",
    'Z,General,Z-0001,"Cover, Drawing Index & Project Directory",0xxx General,NTS,Core,PERMIT,Z10_Sheet_Index; FMC_TB_Panel_ProjectData',
    "A,Architecture,A-1101,Ground Floor Reflected Ceiling Plan,1xxx Plans,1:100,Optional,TENDER,VT_A_RCP",
    "I,Interior Design,I-1201,Ground Floor Reflected Ceiling Plan,1xxx Plans,1:50,Optional,TENDER+CONSTRUCTION,VT_I_RCP",
  ].join("\n");
  assert.deepEqual(rcpSheet(sheets), { number: "I-1201", name: "Ground Floor Reflected Ceiling Plan", scale: "1:50" });
  assert.equal(parseCsv(sheets)[1][3], "Cover, Drawing Index & Project Directory");
  assert.equal(rcpSheet("Role,SheetNumber\nI,I-1\n"), null);
});

test("place, edit and the RCP sheet are model writes behind the lock; the tool asks for the level and a yes", async () => {
  for (const c of ["fmc_ceiling_place", "fmc_ceiling_edit", "fmc_ceiling_sheet"]) assert.ok(WRITE_COMMANDS.has(c), c);
  const noLevel = await runFmcCeiling(args({ action: "place" }) as any, KIT);
  assert.equal(noLevel.isError, true);
  assert.match(noLevel.content[0].text, /place\.level/);
  const noYes = await runFmcCeiling(args({ action: "drawings", dry_run: false, place: { level: "L00" } }) as any, KIT);
  assert.match(noYes.content[0].text, /confirm=true/);
  const edit = await runFmcCeiling(args({ action: "edit", place: { level: "L00" } }) as any, KIT);
  assert.match(edit.content[0].text, /project_folder/);
  const p = placementPlan(ev("tray").design, golden());
  const params = placeParams(p, "L-01 Living", "L00", "I.CLG_02", "", ["uid-1"], true);
  assert.equal(params.tag, "FMC:CEILING:L-01-Living");
  assert.equal(params.dry_run, true);
  assert.deepEqual(params.replace, ["uid-1"]);
});
