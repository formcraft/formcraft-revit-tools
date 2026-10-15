import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  CeilingInput, Design, Evaluated, Kind, boq, boqCsv, buildDesign, checks, designs, evaluate, quantities, setout, setoutCsv, standardFor,
} from "./engine.js";
import { Rect, area, edgeStats, erode, polyRects, subtract } from "./geometry.js";
import { CeilingKit, FALLBACKS, parseLibrary, resolveStandard, sheetSizeOf } from "./standard.js";
import { packPlan } from "./pack.js";
import { DEFAULT_CONFIG } from "../policy.js";
import { FMC_CEILING_SHAPE, loadCeilingKit } from "../../tools/fmc_ceiling.js";

// The golden example (famres/cl_room.py): a 6.0 × 4.5 m living room, truss ties at 3000, tray ceiling with a 600
// bulkhead dropped 300, cove LED and cornice, fan in the middle, 6 downlights in the bulkhead, a smoke detector, an AC
// grille in the bulkhead on the far wall and a 600 hatch.
const L = 6000, W = 4500, B = 600;
const golden = (): CeilingInput => z.object(FMC_CEILING_SHAPE).parse({
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
}) as unknown as CeilingInput;

const KIT: CeilingKit = {
  materials: parseLibrary({ materials: [
    { name: "FMC_Board_Gypsum_9", class: "Board", keynote: "I.CLG_02", description: "9 mm gypsum board 1200 x 2400 for ceilings and feature walls",
      price: { ugx: "28,000", unit: "per 9 mm board (Lion King); Knauf 30,000", date: "2026-10", source: "https://jiji.ug/building-materials?query=gypsum", status: "secondary" } },
    { name: "FMC_Finish_Plaster_Gypsum_Painted", class: "Finish", keynote: "I.MLD_00", description: "Gypsum crown (cornice) mouldings", price: null },
    { name: "FMC_Paint_Emulsion_Vinyl_Generic", class: "Paint", keynote: "I.PNT_00", description: "", price: { ugx: "95,000-140,000", unit: "per 20 L tin", date: "2025-07", source: "x", status: "secondary" } },
    { name: "FMC_Paint_Plascon_VinylSilk", class: "Paint", keynote: "I.PNT_00", description: "", price: { ugx: "332,000", unit: "per 20 L", date: "2026-09-29", source: "y", status: "secondary" } },
  ] }),
  keynotes: [
    { code: "I.CLG", description: "Ceilings", parent: "I" },
    { code: "I.CLG_02", description: "9 mm gypsum ceiling board on metal furring", parent: "I.CLG" },
    { code: "I.MLD_00", description: "Gypsum crown (cornice) moulding, painted", parent: "I.MLD" },
    { code: "I.PNT_00", description: "Internal emulsion, two coats on prepared plaster", parent: "I.PNT" },
  ],
  codes: { "I.CLG_02": { waste: null } },
  standard: null,
  problems: [],
};

const std = () => standardFor(golden(), KIT).std;
const ev = (kind: Kind, input = golden()) => evaluate(kind, input, standardFor(input, KIT).std, kind) as Evaluated;

test("golden: the tray ceiling's quantities match cl_room.py", () => {
  const q = ev("tray").q;
  const zone = (id: string) => q.zones.find((x) => x.zone === id)!;
  assert.equal(zone("field").area_m2, 15.84);
  assert.equal(zone("field").height_mm, 2850);
  assert.equal(zone("bulkhead").area_m2, 11.16);
  assert.equal(zone("bulkhead").height_mm, 2550);
  assert.equal(q.face_m2, 4.86);
  assert.equal(q.board_m2, 31.86);
  assert.equal(q.sheets, 13);
  assert.equal(q.sheet, "2400 × 1200");
  assert.equal(q.main_m, 30);
  assert.equal(q.furring_m, 99.9);
  assert.equal(q.hangers, 30);
  assert.equal(q.cornice_m, 21);
  assert.equal(q.cove_led_m, 16.2);
  assert.equal(q.joint_tape_m, 21.9);
  assert.equal(q.paint_m2, 31.9);
  assert.equal(q.downlights, 6);
  assert.equal(q.screws, 796);
  assert.equal(ev("tray").lux, 258);
});

test("golden: the checks read as on the CL_Pane board, and the light level is never a pass", () => {
  const cs = Object.fromEntries(ev("tray").checks.map((c) => [c.id, c]));
  assert.equal(cs.clearance.result, "OK");
  assert.match(cs.clearance.detail, /150 mm for mains and hangers/);
  assert.equal(cs.hangers.result, "Info"); // tie positions not given
  assert.equal(cs.ac.result, "OK");
  assert.match(cs.ac.detail, /in the bulkhead; duct 150 high fits the 300 mm/);
  assert.equal(cs.fan.result, "OK");
  assert.match(cs.fan.detail, /Centred in the tray; blades about 2\.50 m/);
  assert.equal(cs.detectors.result, "OK");
  assert.equal(cs.access.result, "Info");
  assert.equal(cs.light.result, "Engineer");
  assert.match(cs.light.detail, /About 258 lx.*CA-E-03/);
  assert.equal(cs.joints.result, "OK");
  assert.equal(cs.sprinklers.result, "N/A");
  assert.equal(cs.headroom.result, "Info");
  for (const d of ["tray", "raft", "coffer", "flat"] as Kind[]) assert.equal(ev(d).checks.find((c) => c.id === "light")!.result, "Engineer");
});

test("hangers: ties at 600 take every hanger; ties at 900 leave some between", () => {
  const on = golden(); on.room.tie_spacing_mm = 600;
  assert.equal(ev("tray", on).checks.find((c) => c.id === "hangers")!.result, "OK");
  const off = golden(); off.room.tie_spacing_mm = 900;
  const h = ev("tray", off).checks.find((c) => c.id === "hangers")!;
  assert.equal(h.result, "Decide");
  assert.match(h.detail, /land between ties: add noggins/);
  const slab = golden(); slab.room.structure = "slab";
  assert.equal(ev("tray", slab).checks.find((c) => c.id === "hangers")!.result, "OK");
});

test("designs: three options, the brief's tray first and recommended; the coffered fan clash flagged as on the board", () => {
  const out = designs(golden(), std());
  assert.deepEqual(out.options.map((o) => [o.id, o.kind]), [["A", "tray"], ["B", "raft"], ["C", "coffer"]]);
  assert.equal(out.options[0].recommended, true);
  assert.deepEqual(out.options[0].heights_mm, [2850, 2550]);
  assert.equal(out.options[0].sheets, 13);
  assert.equal(out.options[0].light_lx_indicative, 258);
  assert.deepEqual(out.options[1].heights_mm, [2850, 2700]);
  assert.equal(out.options[1].sheets, 11); // as on the board: flat field around a 3000 × 2100 raft
  assert.ok(out.options[1].flags.some((f) => /AC supply.*shows/.test(f)), "the raft design shows the AC duct");
  const fan = ev("coffer").checks.find((c) => c.id === "fan")!;
  assert.equal(fan.result, "Fail");
  assert.match(fan.detail, /off-centre/);
  assert.equal(out.options[2].checks.fail, 1);
  assert.deepEqual(out.options[2].heights_mm, [2850, 2650]);
});

test("designs follow the brief: a raft brief puts the raft first", () => {
  const g = golden(); g.brief.styles = ["raft", "cove"];
  assert.deepEqual(designs(g, std()).options.map((o) => o.kind), ["raft", "tray", "coffer"]);
});

function assertCovers(rects: Rect[], boards: Rect[], where: string) {
  for (let i = 0; i < boards.length; i++) for (let j = i + 1; j < boards.length; j++) {
    const [a, b] = [boards[i], boards[j]];
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    assert.ok(!(w > 0.5 && h > 0.5), `${where}: boards ${i} and ${j} overlap`);
  }
  assert.ok(Math.abs(area(boards) - area(rects)) < 1, `${where}: boards cover ${area(boards)} of ${area(rects)}`);
  assert.equal(area(subtract(rects, boards)), 0, `${where}: part of the zone has no board`);
}

const pieces = (so: ReturnType<typeof setout>, zone: string): Rect[] =>
  so.zones.find((z) => z.zone === zone)!.boards.flatMap((b) => b.pieces.length ? b.pieces : [{ x0: b.x_mm, y0: b.y_mm, x1: b.x_mm + b.width_mm, y1: b.y_mm + b.depth_mm }]);

test("golden set-out: 7 numbered field boards from the field corner, as on the pack board", () => {
  const so = ev("tray").setout;
  const f = so.zones.find((z) => z.zone === "field")!;
  assert.deepEqual(f.setting_out_points, [[600, 600]]);
  assert.deepEqual(f.boards.map((b) => b.id), ["F1", "F2", "F3", "F4", "F5", "F6", "F7"]);
  assert.deepEqual(f.boards.map((b) => [b.x_mm, b.y_mm, b.width_mm, b.depth_mm]), [
    [600, 600, 2400, 1200], [3000, 600, 2400, 1200],
    [600, 1800, 1200, 1200], [1800, 1800, 2400, 1200], [4200, 1800, 1200, 1200],
    [600, 3000, 2400, 900], [3000, 3000, 2400, 900],
  ]);
  assert.equal(f.min_end_joint_stagger_mm, 1200);
  assert.equal(so.mains.length, 5);
  assert.equal(so.furring.length, 15);
  assert.equal(so.hangers.length, 30);
});

const LROOM: [number, number][] = [[0, 0], [7000, 0], [7000, 3000], [4100, 3000], [4100, 5300], [0, 5300]];

test("set-out: boards never overlap, cover every zone, leave no sliver and stagger their end joints", () => {
  const s = std();
  const lroom = golden(); lroom.room.outline_mm = LROOM; lroom.room.width_mm = undefined; lroom.room.depth_mm = undefined;
  lroom.fixtures.fan = { x: 2050, y: 2650, sweep_mm: 1200, drop_mm: 350 };
  const odd = golden(); odd.room.width_mm = 5170; odd.room.depth_mm = 3830; // dimensions that would leave slivers from the corner
  for (const [name, input] of [["golden", golden()], ["L-shaped", lroom], ["odd", odd]] as const)
    for (const kind of ["tray", "raft", "coffer", "flat"] as Kind[]) {
      const d = buildDesign(kind, input, s);
      if ("skipped" in d) continue;
      const so = setout(d, s);
      const joints = checks(d, input, s, so).find((c) => c.id === "joints")!;
      for (const z of d.zones) {
        const where = `${name} ${kind} ${z.id}`;
        assertCovers(z.rects, pieces(so, z.id), where);
        const zs = so.zones.find((x) => x.zone === z.id)!;
        // The coffer beam grid in an irregular room can't always avoid a short leg at a joint: then the check says so.
        if (name !== "golden" && kind === "coffer" && z.id === "field" && zs.slivers.length) assert.equal(joints.result, "Decide", where);
        else assert.deepEqual(zs.slivers, [], `${where}: slivers`);
        if (zs.min_end_joint_stagger_mm !== null) assert.ok(zs.min_end_joint_stagger_mm >= s.end_joint_stagger_mm, `${where}: joints ${zs.min_end_joint_stagger_mm}`);
        for (const b of zs.boards) {
          assert.ok(b.width_mm <= s.sheet_length_mm && b.depth_mm <= s.sheet_width_mm, `${where}: ${b.id} bigger than a sheet`);
        }
      }
    }
});

test("set-out shifts the start to avoid slivers and says where it starts", () => {
  const odd = golden(); odd.room.width_mm = 5170; odd.room.depth_mm = 3830;
  const s = std();
  const d = buildDesign("flat", odd, s) as Design;
  const z = setout(d, s).zones[0];
  assert.deepEqual(z.slivers, []);
  assert.notDeepEqual(z.setting_out_points[0], [0, 0]); // from the corner, the last row would be 230 deep
  for (const b of z.boards) assert.ok(b.width_mm >= 300 && b.depth_mm >= 300, `${b.id} ${b.width_mm} × ${b.depth_mm}`);
});

test("geometry: an L-shaped room erodes square and the edges add up", () => {
  const room = polyRects(LROOM);
  assert.equal(area(room), 7000 * 3000 + 4100 * 2300);
  const field = erode(room, 600);
  assert.equal(area(field), 5800 * 1800 + 2900 * 2300);
  const es = edgeStats([{ id: "f", height: 2850, rects: field }, { id: "b", height: 2550, rects: subtract(room, field) }]);
  assert.equal(es.wall_mm, 2 * (7000 + 5300));
  assert.equal(es.step_mm, 2 * (5800 + 4100));
  assert.equal(es.face_mm2, 2 * (5800 + 4100) * 300);
});

test("a room that isn't orthogonal or is missing its structure is refused", async () => {
  const g = golden(); g.room.outline_mm = [[0, 0], [5000, 0], [4000, 3000], [0, 3000]];
  const { inputProblems } = await import("./engine.js");
  assert.match(inputProblems(g).join(" "), /orthogonal/);
  const h = golden(); h.room.structure_height_mm = 0;
  assert.match(inputProblems(h).join(" "), /structure_height_mm/);
});

test("standard: every missing kit value falls back and is a kit change request; kit values win", () => {
  const none = resolveStandard(null, null, null);
  assert.equal(none.std.furring_cc_mm, FALLBACKS.furring_cc_mm.value);
  assert.match(none.kit_change_requests.join(" "), /FMC_Ceiling_Standard\.json.*furring_cc_mm = 450/);
  assert.match(none.kit_change_requests.join(" "), /minimum ceiling height/);
  const kit = resolveStandard({ values: { furring_cc_mm: 400, min_ceiling_height_mm: 2400 } }, 12, "board 1220 x 2440");
  assert.equal(kit.std.furring_cc_mm, 400);
  assert.equal(kit.sources.furring_cc_mm, "kit");
  assert.equal(kit.std.board_waste, 0.12);
  assert.equal(kit.std.sheet_length_mm, 2440);
  assert.equal(kit.std.sheet_width_mm, 1220);
  assert.doesNotMatch(kit.kit_change_requests.join(" "), /furring_cc_mm|board_waste|sheet_length|minimum ceiling height/);
  assert.deepEqual(sheetSizeOf("9 mm gypsum board 1200 x 2400 for ceilings"), [2400, 1200]);
  const head = ev("tray", golden());
  const withMin = checks(head.design, golden(), { ...std(), min_ceiling_height_mm: 2600 });
  assert.equal(withMin.find((c) => c.id === "headroom")!.result, "Fail"); // the bulkhead at 2550
});

test("boq: prices only from the library, 'price needed' where it has none, keynotes from the kit", () => {
  const g = golden();
  const e = ev("tray", g);
  const bill = boq(e, g, std(), KIT);
  const line = (rx: RegExp) => bill.lines.find((l) => rx.test(l.item))!;
  const board = line(/gypsum/);
  assert.equal(board.qty, 13);
  assert.equal(board.keynote, "I.CLG_02");
  assert.equal(board.material, "FMC_Board_Gypsum_9");
  assert.equal(board.total_ugx, 13 * 28000);
  assert.equal(board.price_status, "secondary");
  assert.equal(line(/Cornice/).keynote, "I.MLD_00");
  assert.equal(line(/Cornice/).price_status, "price needed");
  assert.equal(line(/Cornice/).total_ugx, null);
  assert.equal(line(/Main channels/).qty, 30);
  assert.equal(line(/Main channels/).keynote, "missing");
  assert.equal(line(/Main channels/).price_status, "price needed");
  assert.match(line(/emulsion/).note, /choose the material/);
  assert.equal(line(/Downlights/).total_ugx, null);
  assert.match(line(/Downlights/).note, /electrical engineer/);
  assert.equal(bill.priced_total_ugx, 364000);
  assert.ok(bill.kit_change_requests.some((k) => /Main channels/.test(k)));
  // a chosen paint with a per-20 L price: shown, but no total in m²
  g.brief.paint_material = "FMC_Paint_Plascon_VinylSilk";
  const paint = boq(e, g, std(), KIT).lines.find((l) => /emulsion/.test(l.item))!;
  assert.equal(paint.rate_ugx, "332,000");
  assert.equal(paint.total_ugx, null);
  assert.match(paint.note, /not per m2/);
  // no library: everything is price needed
  assert.equal(boq(e, g, std(), { ...KIT, materials: [] }).priced_total_ugx, 0);
  assert.equal(boqCsv(bill.lines)[0][0], "item");
});

test("pack: only into the project's 01_WIP inside the guard's write roots, never over an earlier pack", () => {
  const cfg = { ...DEFAULT_CONFIG, write_roots: ["Z:\\Projects\\*\\01_WIP"] };
  const ok = packPlan("Z:\\Projects\\HA_House", "L-01 Living", "tray", cfg, "2026-10-15", () => false);
  assert.equal(ok.ok, true, ok.reasons.join("; "));
  assert.equal(ok.folder, "Z:\\Projects\\HA_House\\01_WIP\\_Ceilings\\2026-10-15_L-01-Living_tray");
  assert.match(ok.files.boq, /FMC_Ceiling_L-01-Living_tray_BoQ\.csv$/);
  const again = packPlan("Z:\\Projects\\HA_House", "L-01 Living", "tray", cfg, "2026-10-15", (p) => p === ok.folder);
  assert.match(again.folder, /_tray_2$/);
  assert.equal(packPlan("Z:\\Projects\\HA_House\\02_Shared", "L", "tray", cfg, "2026-10-15", () => false).ok, false);
  assert.equal(packPlan("Z:\\Elsewhere\\X", "L", "tray", cfg, "2026-10-15", () => false).ok, false);
  assert.equal(packPlan("Z:\\Projects\\HA_House", "L", "tray", DEFAULT_CONFIG, "2026-10-15", () => false).ok, false);
  assert.equal(packPlan("", "L", "tray", cfg, "2026-10-15", () => false).ok, false);
  const rows = setoutCsv(ev("tray").setout);
  assert.ok(rows.some((r) => r[0] === "board" && r[1] === "F1"));
  assert.equal(rows.filter((r) => r[0] === "hanger").length, 30);
});

test("the tool's schema fills the defaults: a bare room is enough", () => {
  const a = z.object(FMC_CEILING_SHAPE).parse({ action: "designs", room: { width_mm: 4000, depth_mm: 3000, structure_height_mm: 2900 } });
  assert.deepEqual(a.fixtures.downlights, []);
  assert.equal(a.brief.board, "I.CLG_02");
  assert.equal(a.brief.bulkhead_width_mm, 600);
  assert.equal(a.room.structure, "ties");
  assert.equal(a.dry_run, true);
  const out = designs(a as unknown as CeilingInput, std());
  assert.equal(out.options.length, 3);
  assert.equal(out.options[0].heights_mm[0], 2750);
});

test("the kit loader reads the library, keynotes and master data, and reports what it can't read", () => {
  const files: Record<string, string> = {
    "K:\\Kit\\07_Materials\\FMC_Materials.json": JSON.stringify({ materials: [{ name: "FMC_Board_Gypsum_9", keynote: "I.CLG_02", class: "Board", description: "1200 x 2400", price: null }] }),
    "K:\\Kit\\02_Keynotes\\FMC_Keynotes.txt": "I.CLG\tCeilings\tI\r\nI.CLG_02\t9 mm gypsum ceiling board on metal furring\tI.CLG\r\n",
  };
  const kit = loadCeilingKit("K:\\Kit", DEFAULT_CONFIG, (p) => { if (p in files) return files[p]; throw new Error("missing"); });
  assert.equal(kit.materials.length, 1);
  assert.equal(kit.keynotes.length, 2);
  assert.equal(kit.standard, null);
  assert.ok(kit.problems.some((p) => /Master data/.test(p)));
  const q = quantities(ev("tray").design, golden(), standardFor(golden(), kit).std);
  assert.equal(q.sheets, 13);
});
