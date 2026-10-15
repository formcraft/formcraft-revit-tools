import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Part, Run, Standards, Unit, checkStandards, compute, costs, greedyFill, layoutRun, nest, packNames, parseUgx, priceBasis,
  readLibrary, summaryOf,
} from "./casework.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../src/fmc/fixtures/cw_kitchen.json"), "utf8"));
const S = FIX.standards as Standards;
const RUN = FIX.run as Run;
const REF_UNITS: Unit[] = (FIX.units as Array<[string, Unit["kind"], number, string, number, string]>).map(([mark, kind, width, wall, offset, fronts]) =>
  ({ mark, kind, width, wall, offset, fronts, layer: kind === "wall" || fronts === "hood" ? "wall" : "base" }));

/** A slice of the kit's library as it is today (07_Materials\FMC_Materials.json, 15 Oct). */
const LIB = readLibrary({ materials: [
  { name: "FMC_Board_Plywood_Marine18", price: { ugx: "60,000-90,000", unit: "per 8x4 ft sheet, 18 mm", date: "2026-10", source: "https://jiji.ug/building-materials?query=plywood", status: "secondary" } },
  { name: "FMC_Board_MDF_Raw", price: null },
  { name: "FMC_Stone_Granite_Black_Polished", price: null },
] });

test("the run lays out the example kitchen exactly as the reference does", () => {
  const l = layoutRun(RUN, S);
  assert.deepEqual(l.problems, []);
  const pick = (u: Unit) => [u.mark, u.kind, u.width, u.wall, u.offset, u.fronts];
  assert.deepEqual(l.units.map(pick), REF_UNITS.map(pick));
  assert.deepEqual(l.fillers, [{ wall: "A", layer: "base", offset: 3550, width: 50 }]);
  assert.deepEqual(l.worktop.map((w) => [w.wall, w.from, w.to]), [["A", 0, 2950], ["B", 0, 1200], ["B", 1800, 2400]]);
  assert.ok(l.notes.some((n) => /cooker.*rule 5/.test(n)));
});

test("golden: 12 units, 120 pieces, 15 sheets (ply 9 at 76 %, MDF back 3, MDF fronts 3), 98.5 m edge, 4.8 m worktop, 28 hinges", () => {
  const l = layoutRun(RUN, S);
  const c = compute(l.units, l, S);
  assert.deepEqual(c.problems, []);
  const s = summaryOf(c);
  assert.equal(s.units, 12);
  assert.equal(s.part_lines, 88);
  assert.equal(s.pieces, 120);
  assert.equal(s.sheets, 15);
  assert.deepEqual(s.boards, [
    { material: "FMC_Board_Plywood_Marine18", sheets: 9, parts: 86, yield_pct: 76 },
    { material: "FMC_Board_MDF_Back6", sheets: 3, parts: 17, yield_pct: 84 },
    { material: "FMC_Board_MDF_Raw", sheets: 3, parts: 17, yield_pct: 66 },
  ]);
  assert.equal(s.edge_m, 98.5);
  assert.equal(s.worktop_m, 4.8);
  assert.deepEqual(s.hardware, {
    "Hinges": 28, "Drawer runners (pairs, 500 mm)": 5, "Handles": 17, "Legs (adjustable 150 mm)": 32, "Shelf pins": 48, "Wall-unit hangers": 10, "Kick board": 4.8,
  });
  // the panels on the boards (CW_Pane unit editor, CW_Outputs cut list)
  const k02 = c.cutlist.filter((r) => r.mark === "K02").map((r) => [r.part, r.length, r.width, r.qty]);
  assert.deepEqual(k02.slice(0, 8), [["Side", 720, 560, 2], ["Bottom", 564, 560, 1], ["Top rail", 564, 100, 2], ["Back", 594, 714, 1],
    ["Drawer front 1", 597, 137, 1], ["Drawer side 1", 500, 80, 2], ["Drawer back 1", 506, 80, 2], ["Drawer bottom 1", 538, 490, 1]]);
  assert.deepEqual(c.cutlist.find((r) => r.mark === "K01" && r.part === "Door"), { mark: "K01", part: "Door", length: 717, width: 577, qty: 1, board: "FMC_Board_MDF_Raw", edge: "4 sides", edge_m: 2.588 });
  assert.equal(c.cutlist.find((r) => r.mark === "K01" && r.part === "Side")!.edge, "1 long edge");
  assert.equal(c.cutlist.find((r) => r.mark === "K01" && r.part === "Back")!.edge, "—");
});

test("a unit list gives the same panels and sheets as the run", () => {
  const l = layoutRun(RUN, S);
  const a = compute(l.units, l, S);
  const b = compute(REF_UNITS, { units: REF_UNITS, fillers: [], worktop: [], problems: [], notes: [] }, S);
  assert.deepEqual(b.parts, a.parts);
  assert.deepEqual(b.nests, a.nests);
});

function assertNoOverlap(sheets: Array<{ items: Array<{ x: number; y: number; l: number; w: number; label: string }> }>, L: number, W: number, kerf: number) {
  for (const sh of sheets) {
    for (const it of sh.items) {
      assert.ok(it.x >= 0 && it.y >= 0 && it.x + it.l <= L && it.y + it.w <= W, `${it.label} leaves the sheet`);
    }
    for (let i = 0; i < sh.items.length; i++) for (let j = i + 1; j < sh.items.length; j++) {
      const a = sh.items[i], b = sh.items[j];
      const apart = a.x + a.l + kerf <= b.x || b.x + b.l + kerf <= a.x || a.y + a.w + kerf <= b.y || b.y + b.w + kerf <= a.y;
      assert.ok(apart, `${a.label} and ${b.label} overlap or sit closer than the ${kerf} mm kerf`);
    }
  }
}

test("nesting never overlaps, never leaves the sheet and keeps the kerf between cuts (kitchen)", () => {
  const l = layoutRun(RUN, S);
  const c = compute(l.units, l, S);
  for (const n of c.nests) assertNoOverlap(n.sheets, 2440, 1220, 4);
  // every piece is placed exactly once
  for (const n of c.nests) assert.equal(n.sheets.reduce((a, s) => a + s.items.length, 0), n.parts);
});

test("nesting holds for random parts and kerfs", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 40; round++) {
    const kerf = [0, 3, 4, 6][round % 4];
    const parts: Part[] = Array.from({ length: 30 }, (_, i) => ({ mark: `P${i}`, part: "x", length: 50 + Math.floor(rnd() * 2390), width: 40 + Math.floor(rnd() * 1180),
      material: "B", qty: 1 + Math.floor(rnd() * 3), edges: [] }));
    const n = nest(parts, "B", { length: 2440, width: 1220 }, kerf);
    assertNoOverlap(n.sheets, 2440, 1220, kerf);
    assert.equal(n.parts, parts.reduce((a, p) => a + p.qty, 0));
  }
});

test("the kerf is real: two 1220 pieces don't share a 2440 row with a 4 mm saw, and do with none", () => {
  const two: Part[] = [{ mark: "A", part: "x", length: 1220, width: 500, material: "B", qty: 2, edges: [] }];
  const withKerf = nest(two, "B", { length: 2440, width: 1220 }, 4);
  assert.deepEqual(withKerf.sheets[0].items.map((i) => [i.x, i.y]), [[0, 0], [0, 504]]);
  const noKerf = nest(two, "B", { length: 2440, width: 1220 }, 0);
  assert.deepEqual(noKerf.sheets[0].items.map((i) => [i.x, i.y]), [[0, 0], [1220, 0]]);
});

test("a part bigger than the sheet is named, not placed", () => {
  const n = nest([{ mark: "T1", part: "Side", length: 2600, width: 560, material: "B", qty: 1, edges: [] }], "B", { length: 2440, width: 1220 }, 4);
  assert.equal(n.sheets.length, 0);
  assert.deepEqual(n.too_big, ["T1 Side (2600 × 560)"]);
});

test("cost: prices come from the library only; missing ones say price needed and boards not in the kit are change requests", () => {
  const l = layoutRun(RUN, S);
  const c = compute(l.units, l, S);
  const r = costs({ boards: c.nests.map((n) => ({ material: n.material, sheets: n.sheets.length })), edge_m: c.edge_m, worktop_m: c.worktop_m, hardware: c.hardware }, S, LIB);
  const ply = r.lines.find((x) => x.material === "FMC_Board_Plywood_Marine18")!;
  assert.deepEqual([ply.ugx_low, ply.ugx_high, ply.price, ply.status], [540000, 810000, "UGX 540,000–810,000", "secondary"]);
  for (const l2 of r.lines.filter((x) => x !== ply)) {
    assert.equal(l2.ugx_low, null, `${l2.item} got a price`);
    assert.match(l2.price, /^price needed/);
  }
  assert.match(r.lines.find((x) => x.material === "FMC_Board_MDF_Back6")!.price, /not in the kit's material library/);
  assert.deepEqual(r.kit_requests.map((k) => k.item), ["FMC_Board_MDF_Back6", "Edge band", "Hardware"]);
  assert.deepEqual(r.total, { ugx_low: 540000, ugx_high: 810000, priced: 1, price_needed: r.lines.length - 1 });
  // without the library nothing is priced
  const none = costs({ boards: [{ material: "FMC_Board_Plywood_Marine18", sheets: 9 }], edge_m: 1, worktop_m: 0, hardware: [] }, S, null);
  assert.match(none.lines[0].price, /isn't readable/);
});

test("prices: ranges and units are read, never stretched", () => {
  assert.deepEqual(parseUgx("60,000-90,000"), [60000, 90000]);
  assert.deepEqual(parseUgx("105,000"), [105000, 105000]);
  assert.equal(parseUgx("about 5,000"), null);
  assert.equal(priceBasis("per 8x4 ft sheet, 18 mm", S.sheet), "sheet");
  assert.equal(priceBasis("per 8x4 ft sheet", { length: 2800, width: 2070 }), null);
  assert.equal(priceBasis("per sheet", S.sheet), null);
  assert.equal(priceBasis("per m2", S.sheet), "m2");
  assert.equal(priceBasis("per m", S.sheet), "m");
  assert.equal(priceBasis("per roll", S.sheet), null);
});

test("standards are never filled in: a missing field is named", () => {
  const partial = JSON.parse(JSON.stringify(S));
  delete partial.kerf;
  delete partial.construction.drawer.side_length;
  const r = checkStandards(partial);
  assert.equal(r.standards, null);
  assert.deepEqual(r.missing, ["kerf", "construction.drawer.side_length"]);
  assert.ok(checkStandards(S).standards);
});

test("greedy fill and run checks", () => {
  assert.deepEqual(greedyFill(1100, [900, 600, 450, 300]), { widths: [900], leftover: 200 });
  assert.deepEqual(greedyFill(1350, [600, 450]), { widths: [600, 600], leftover: 150 });
  const bad = layoutRun({ walls: [{ name: "A", length: 2000, fixed: [{ kind: "sink", offset: 1500, width: 900 }] }], modules: [600] }, S);
  assert.ok(bad.problems.some((p) => /runs off the wall/.test(p)));
  const door = layoutRun({ walls: [{ name: "A", length: 3000, openings: [{ kind: "door", offset: 1200, width: 900 }] }], modules: [600] }, S);
  assert.deepEqual(door.units.filter((u) => u.layer === "base").map((u) => [u.offset, u.width]), [[0, 600], [600, 600], [2100, 600]]);
  assert.ok(door.units.every((u) => u.offset + u.width <= 1200 || u.offset >= 2100), "nothing in the door");
});

test("pack names are the same for the same inputs", () => {
  assert.deepEqual(packNames("HA", "K-01 Kitchen"), packNames("HA", "K-01 Kitchen"));
  assert.equal(packNames("HA", "  K-01 Kitchen! ").cutlist, "HA_Casework_K-01-Kitchen_CutList.csv");
});

test("fmc_casework: refuses without standards, packs only inside the write roots after a dry run, and a re-run changes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-casework-"));
  const project = path.join(dir, "Projects", "HA");
  fs.mkdirSync(path.join(project, "01_WIP"), { recursive: true });
  const kit = path.join(dir, "kit");
  fs.mkdirSync(path.join(kit, "07_Materials"), { recursive: true });
  fs.writeFileSync(path.join(kit, "07_Materials", "FMC_Materials.json"), JSON.stringify({ materials: [
    { name: "FMC_Board_Plywood_Marine18", price: { ugx: "60,000-90,000", unit: "per 8x4 ft sheet, 18 mm", date: "2026-10", source: "jiji.ug", status: "secondary" } },
    { name: "FMC_Board_MDF_Raw", price: null }, { name: "FMC_Stone_Granite_Black_Polished", price: null }] }));
  const guard = path.join(dir, "fmc_guard.json");
  fs.writeFileSync(guard, JSON.stringify({ write_roots: [path.join(dir, "Projects", "*", "01_WIP")], reports_dir: path.join(dir, "reports"),
    materials_file: path.join(kit, "07_Materials", "FMC_Materials.json") }));
  const old = process.env.FMC_GUARD_CONFIG;
  process.env.FMC_GUARD_CONFIG = guard;
  try {
    const { runFmcCasework, FMC_CASEWORK_SHAPE } = await import("../tools/fmc_casework.js");
    const { z } = await import("zod");
    const schema = z.object(FMC_CASEWORK_SHAPE);
    const call = async (a: object) => { const r = await runFmcCasework(schema.parse(a)); return { body: JSON.parse(r.content[0].text), isError: r.isError }; };

    const none = await call({ action: "summary", run: RUN });
    assert.equal(none.isError, true);
    assert.ok(none.body.missing.includes("kerf"));
    assert.equal(none.body.kit_requests[0].item, "Casework workshop standards");

    const sum = await call({ action: "summary", run: RUN, standards: S });
    assert.equal(sum.isError, false);
    assert.equal(sum.body.sheets, 15);
    assert.equal(sum.body.cost.total.ugx_low, 540000);
    assert.deepEqual(sum.body.kit_requests.map((k: { item: string }) => k.item), ["Casework workshop standards", "FMC_Board_MDF_Back6", "Edge band", "Hardware"]);

    const nest1 = await call({ action: "nest", run: RUN, standards: S, board: "FMC_Board_MDF_Raw", sheet: 1 });
    assert.equal(nest1.body.boards.length, 1);
    assert.equal(nest1.body.boards[0].sheets.length, 1);

    const base = { action: "pack", run: RUN, standards: S, project_folder: project, project_code: "HA", label: "K-01 Kitchen" };
    const folder = path.join(project, "01_WIP", "_Casework");
    const dry = await call(base);
    assert.equal(dry.body.dry_run, true);
    assert.deepEqual(dry.body.files.map((f: { action: string }) => f.action), ["new", "new", "new", "new"]);
    assert.equal(fs.existsSync(folder), false, "a dry run writes nothing");

    const done = await call({ ...base, dry_run: false });
    assert.equal(done.body.done, true);
    const names = fs.readdirSync(folder).sort();
    assert.deepEqual(names, ["HA_Casework_K-01-Kitchen_BoQ.csv", "HA_Casework_K-01-Kitchen_CutList.csv", "HA_Casework_K-01-Kitchen_Hardware.csv", "HA_Casework_K-01-Kitchen_Nesting.csv"]);
    const cut = fs.readFileSync(path.join(folder, "HA_Casework_K-01-Kitchen_CutList.csv"), "utf8").trim().split(/\r\n/);
    assert.equal(cut.length, 89);
    assert.equal(fs.readFileSync(path.join(folder, "HA_Casework_K-01-Kitchen_Nesting.csv"), "utf8").trim().split(/\r\n/).length, 121);
    assert.match(fs.readFileSync(path.join(folder, "HA_Casework_K-01-Kitchen_BoQ.csv"), "utf8"), /FMC_Board_MDF_Raw,3,sheet,,,price needed/);

    const again = await call({ ...base, dry_run: false });
    assert.deepEqual(again.body.files.map((f: { action: string }) => f.action), ["unchanged", "unchanged", "unchanged", "unchanged"]);
    assert.deepEqual(fs.readdirSync(folder).sort(), names, "same names, nothing new");

    const changed = await call({ ...base, dry_run: false, run: { ...RUN, fronts: { K02: "3drawer", K08: "3drawer" } } });
    assert.ok(changed.body.files.some((f: { action: string }) => /replace/.test(f.action)));
    assert.ok(fs.readdirSync(path.join(folder, "_Archive")).length > 0, "the old file is archived, not deleted");

    const outside = await call({ ...base, project_folder: path.join(dir, "Elsewhere") });
    assert.equal(outside.isError, true);
    assert.match(outside.body.reasons.join(" "), /Not inside an allowed write folder/);

    fs.writeFileSync(guard, JSON.stringify({ write_roots: [dir], reports_dir: path.join(dir, "reports"), materials_file: path.join(kit, "07_Materials", "FMC_Materials.json") }));
    const published = await call({ ...base, project_folder: path.join(dir, "03_Published", "HA") });
    assert.equal(published.isError, true);
    assert.match(published.body.reasons.join(" "), /CDE gate/);

    assert.match(fs.readFileSync(path.join(dir, "reports", "FMC_MCP_FileLog.csv"), "utf8"), /casework_pack/);
  } finally {
    if (old === undefined) delete process.env.FMC_GUARD_CONFIG; else process.env.FMC_GUARD_CONFIG = old;
  }
});
