// Formcraft RC frame -> Robot (docs/ROBOT_RC_FRAME_PROCESS.md): the frame plan + the Revit ids of the build batch,
// loads from the kit takedown, seismic (US 319), masonry infill struts, RC shear walls; send, calculate, results.
//   node scripts/structure/robot-run.mjs <work dir> <robot runs dir> [dry|send]
// <work dir> holds facts.json (fmc_struct_facts), plan.json (fmc_structure frame), build.out.json (the build batch),
// sizes.json (Revit id -> [b, h], from member-check) and config.json (below; defaults are the Ogala main house).
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
const R = new URL("../../server/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const imp = (m) => import(pathToFileURL(R + "build/fmc/" + m).href);
const { assemble } = await imp("robot.js");
const { takedown, inside } = await imp("loads.js");
const { resolve } = await imp("standards.js");
const W = process.argv[2], OUT = process.argv[3], mode = process.argv[4] ?? "dry";
const CFG = { exclude_levels: ["BQ GF +0.17", "BQ FF +3.15"], pad_top_mm: -250, floors: ["FF +3.85", "Roof +7.25"], attic: { level: "Roof +7.25", g_kn_m2: 0.6 },
  seismic: { C: 0.08, Z: 0.8, I: 1.0, K: 2 }, supports: "Fixed", model: "OGL-FMC-ZZ-ZZ-M3-S-0001", infill: true, shear_walls: true,
  ...(fs.existsSync(W + "/config.json") ? JSON.parse(fs.readFileSync(W + "/config.json", "utf8")) : {}) };
const plan = JSON.parse(fs.readFileSync(W + "/plan.json", "utf8"));
const built = JSON.parse(fs.readFileSync(W + "/build.out.json", "utf8"));
const sizes = fs.existsSync(W + "/sizes.json") ? JSON.parse(fs.readFileSync(W + "/sizes.json", "utf8")) : {};
const f0 = JSON.parse(fs.readFileSync(W + "/facts.json", "utf8"));
const EX = new Set(CFG.exclude_levels);
const f = { ...f0, floors: f0.floors.filter((x) => !EX.has(x.level)), rooms: f0.rooms.filter((x) => !EX.has(x.level)), roofs: f0.roofs.filter((x) => !EX.has(x.level)), walls: f0.walls.filter((w) => !EX.has(w.base_level)) };
const kit = JSON.parse(fs.readFileSync("D:/Fomcraft/FMC_BIM_27/FMC_Kit_v2.2/FMC_Kit_v2.2/03_Master_Data/FMC_Standards_Building.json", "utf8").replace(/^\uFEFF/, ""));
const values = new Map(resolve(kit, null, "residential").map((r) => [r.key, r.value]));
const t = takedown(f, (k) => values.get(k));
const elev = Object.fromEntries(f.levels.map((l) => [l.name, l.elevation_mm]));
const padTop = CFG.pad_top_mm;

// Revit ids in op order: columns (grouped ops, ids in point order), beams (one each)
// the planned frame (plan.json + build.out.json) and the architect's given members (extra.json + extra.out.json)
const extraOps = fs.existsSync(W + "/extra.json") && fs.existsSync(W + "/extra.out.json") ? JSON.parse(fs.readFileSync(W + "/extra.json", "utf8")).map((o, i) => [o, JSON.parse(fs.readFileSync(W + "/extra.out.json", "utf8")).ops[i]]) : [];
const allPairs = [...plan.ops.map((o, i) => [o, built.ops[i + 2]]), ...extraOps];
const colOps = allPairs.filter(([o]) => o.op === "column");
const beamOps = allPairs.filter(([o]) => o.op === "beam");
const members = [];
for (const [o, r] of colOps) o.points_mm.forEach((p, j) => {
  const id = r.created_ids[j], sz = sizes[id] ?? o.size_mm;
  const z0 = o.level.startsWith("S Pad top") ? padTop : elev[o.level];
  members.push({ id, kind: "column", start: [p[0], p[1], z0], end: [p[0], p[1], elev[o.top_level]], section: "", b_mm: sz[0], h_mm: sz[1], material_class: "Concrete", concrete_grade: "C25/30", steel_grade: "" });
});
const beams = [];
for (const [o, r] of beamOps) {
  const z = elev[o.level], id = r.created_ids[0], sz = sizes[id] ?? o.size_mm;
  if (z < 500) continue;   // ground beams bear on the ground and pads: not in the frame model
  const m = { id, key: String(id), kind: "beam", start: [o.start_mm[0], o.start_mm[1], z], end: [o.end_mm[0], o.end_mm[1], z], section: "", b_mm: sz[0], h_mm: sz[1], material_class: "Concrete", concrete_grade: "C25/30", steel_grade: "" };
  members.push(m); beams.push(m);
}
// ---- stairs (owner 28 Oct: "I'm not seeing stairs"): each designed stair (stairs.json from stair-slab.py) in the frame as
// a dog-leg: flight 1 up one side to a half landing at the far end, flight 2 back up the other side to the floor; flights
// are inclined waist-slab bars (flight width x waist), the landing beam rests on two stub columns from the pads and the
// flight foot on a stub to the ground. Their weight and their bracing of the floors are then in the analysis; the
// flights are designed by stair-slab.py (member-check skips kind "stair"); stubs have negative ids (never sent to Revit).
const stairs = fs.existsSync(W + "/stairs.json") ? JSON.parse(fs.readFileSync(W + "/stairs.json", "utf8")).filter((x) => x.waist_mm && x.box) : [];
let sidS = -9000; const stairPts = [], flights = [];
const mk = (kind, a, b, bw, h, extra = {}, rid = null) => { const m = { id: rid ?? sidS--, kind, start: a, end: b, section: "", b_mm: bw, h_mm: h, material_class: "Concrete", concrete_grade: "C25/30", steel_grade: "", ...extra }; m.key = String(m.id); members.push(m); return m; };
for (const [si, st] of stairs.entries()) {
  const RID = (CFG.stair_ids ?? [])[si] ?? {};   // the stair's supports as built in Revit (config.stair_ids), else analysis-only ids
  const [[x0, y0, z0], [x1, y1, z1]] = st.box, w = st.flight_width_mm ?? 1000, zl = Math.round((z0 + z1) / 2), alongY = (y1 - y0) >= (x1 - x0);
  const Q = alongY ? { a1: [x0 + w / 2, y0, z0], b1: [x0 + w / 2, y1 - w / 2, zl], a2: [x1 - w / 2, y1 - w / 2, zl], b2: [x1 - w / 2, y0, z1], l0: [x0, y1 - w / 2, zl], l1: [x1, y1 - w / 2, zl] }
                   : { a1: [x0, y0 + w / 2, z0], b1: [x1 - w / 2, y0 + w / 2, zl], a2: [x1 - w / 2, y1 - w / 2, zl], b2: [x0, y1 - w / 2, z1], l0: [x1 - w / 2, y0, zl], l1: [x1 - w / 2, y1, zl] };
  flights.push(mk("stair", Q.a1, Q.b1, w, st.waist_mm), mk("stair", Q.a2, Q.b2, w, st.waist_mm));
  for (const [k, [a, b]] of [[Q.l0, Q.b1], [Q.b1, Q.a2], [Q.a2, Q.l1]].entries()) { const m = mk("beam", a, b, 230, 300, {}, RID.landing ?? null); m.key = m.id + "#" + k; beams.push(m); }   // landing beam
  mk("column", [Q.l0[0], Q.l0[1], padTop], Q.l0, 230, 230, {}, RID.stub_l0 ?? null); mk("column", [Q.l1[0], Q.l1[1], padTop], Q.l1, 230, 230, {}, RID.stub_l1 ?? null);   // stub columns
  mk("column", [Q.a1[0], Q.a1[1], padTop], Q.a1, 230, 230, {}, RID.stub_foot ?? null);                                                                                   // flight foot
  stairPts.push(Q.b2);
}
// ---- connectivity (owner 28 Oct: "some columns are off" in Robot): a beam end within snap_mm (150) of a column in plan
// moves onto it, and a beam is split where a column end lies on its line, so every column top and base meets the frame
// and no beam end hangs free (the architect's given columns sit a few cm off the grid lines); a beam ending on another
// beam splits that one too
const SNAP = CFG.snap_mm ?? 150, colPts = () => members.filter((m) => m.kind === "column").flatMap((m) => [m.start, m.end]);
const pd = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
for (const b of beams) for (const k of ["start", "end"]) {
  const c = colPts().filter((q) => Math.abs(q[2] - b[k][2]) < 50).sort((u, v) => pd(u, b[k]) - pd(v, b[k]))[0];
  if (c && pd(c, b[k]) <= SNAP && pd(c, b[k]) > 1) b[k] = [c[0], c[1], b[k][2]];
}
for (let pass = 0, split = true; split && pass < 10; pass++) {
  split = false;
  for (const c of [...colPts(), ...stairPts, ...beams.flatMap((x) => [x.start, x.end])]) for (const b of [...beams]) {   // columns, stair heads, and beams carried on beams
    if (Math.abs(c[2] - b.start[2]) > 50) continue;
    const dx = b.end[0] - b.start[0], dy = b.end[1] - b.start[1], L2 = dx * dx + dy * dy, u = ((c[0] - b.start[0]) * dx + (c[1] - b.start[1]) * dy) / L2;
    if (u <= 0.02 || u >= 0.98) continue;
    if (Math.abs((c[0] - b.start[0]) * dy - (c[1] - b.start[1]) * dx) / Math.sqrt(L2) > SNAP) continue;
    const P = [c[0], c[1], b.start[2]], m2 = { ...b, key: b.key + "+", start: P, end: b.end }; b.end = P;
    members.push(m2); beams.push(m2); split = true; break;
  }
}
// ---- masonry infill as diagonal struts (FEMA 356 / EC8 practice; kit seismic.performance_K "frame with masonry infill"):
// a storey panel between two adjacent columns whose wall (>= 150 mm) covers >= 80% of it with openings <= 30% gets an
// X of two struts, each half of a strut 0.15 x diagonal wide, t thick, Em = 3 GPa, given as a concrete section of equal
// axial stiffness (Ec 31 GPa). Struts are analysis members only (negative ids), never designed or written to Revit.
const Em = 3000, Ec = 31000;
const cols = members.filter((m) => m.kind === "column");
const struts = [], panels = []; let sid = -1;
if (CFG.infill) for (const [i, a] of cols.entries()) for (const b of cols.slice(i + 1)) {
  if (Math.abs(a.start[2] - b.start[2]) > 1 || Math.abs(a.end[2] - b.end[2]) > 1) continue;
  const dx = b.start[0] - a.start[0], dy = b.start[1] - a.start[1], L = Math.hypot(dx, dy);
  if (L < 1500 || L > 7000 || (Math.abs(dx) > 1 && Math.abs(dy) > 1)) continue;
  // adjacent: no column of the storey between them on the line
  if (cols.some((c) => c !== a && c !== b && Math.abs(c.start[2] - a.start[2]) < 1 && Math.abs(c.end[2] - a.end[2]) < 1 && Math.abs((c.start[0] - a.start[0]) * dy - (c.start[1] - a.start[1]) * dx) < 1 && ((c.start[0] - a.start[0]) * dx + (c.start[1] - a.start[1]) * dy) > 0 && ((c.start[0] - a.start[0]) * dx + (c.start[1] - a.start[1]) * dy) < L * L)) continue;
  const zb = a.start[2], zt = a.end[2], hgt = zt - zb;
  let cover = 0, open = 0, area = 0, tw = 0; const wids = [];
  for (const w of f.walls) {
    if (w.thickness_mm < 150 || !w.top_level && !(w.height_mm > 2400)) continue;
    const wb = elev[w.base_level] ?? 0; if (wb > zt - 1000 || wb + w.height_mm < zt - 600) continue;   // spans this storey
    const ux = dx / L, uy = dy / L, s0 = (w.start_mm[0] - a.start[0]) * ux + (w.start_mm[1] - a.start[1]) * uy, s1 = (w.end_mm[0] - a.start[0]) * ux + (w.end_mm[1] - a.start[1]) * uy;
    const off0 = Math.abs((w.start_mm[0] - a.start[0]) * uy - (w.start_mm[1] - a.start[1]) * ux), off1 = Math.abs((w.end_mm[0] - a.start[0]) * uy - (w.end_mm[1] - a.start[1]) * ux);
    if (off0 > 300 || off1 > 300) continue;
    const ov = Math.max(0, Math.min(L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1))); if (!ov) continue;
    cover += ov; tw = Math.max(tw, w.thickness_mm - 35); const share = ov / w.length_mm; open += (w.openings_area_m2 ?? 0) * share; area += (ov / 1000) * (hgt / 1000); wids.push(w.id);
  }
  if (cover < 0.8 * L) continue;
  panels.push({ a, b, L, hgt, tw, ratio: area ? open / area : 1, dir: Math.abs(dx) > 1 ? "x" : "y", at: Math.abs(dx) > 1 ? a.start[1] : a.start[0], zt, wids });
}
// ---- RC shear walls (owner 28 Oct: "do the shear wall thing"): on the top storey, per direction, the two most solid
// panels farthest apart (torsion), carried down every storey below on the same line (to the foundations). Each is an
// X of two braces giving the wall's shear stiffness G.t.L/h (G = E/2.4, t = 200): A = t.L.d / (4.8 h cos^2)
const walls = [];
if (CFG.shear_walls) {
  const topZ = Math.max(...panels.map((q) => q.zt));
  for (const dir of ["x", "y"]) {
    const key0 = (q) => [q.a.start[0], q.a.start[1], q.b.start[0], q.b.start[1]].map(Math.round).join();
    const storeys = [...new Set(panels.map((q) => q.zt))];
    // solid on every storey down to the foundations
    const stackOk = (q) => storeys.every((z) => panels.some((r) => r.zt === z && key0(r) === key0(q) && r.ratio <= 0.5));
    const c = panels.filter((q) => q.zt === topZ && q.dir === dir && stackOk(q)).sort((u, v) => u.at - v.at);
    if (!c.length) continue;
    const lo = c.filter((q) => q.at - c[0].at < 1500).sort((u, v) => u.ratio - v.ratio || v.L - u.L)[0];
    const hi = c.filter((q) => c[c.length - 1].at - q.at < 1500).sort((u, v) => u.ratio - v.ratio || v.L - u.L)[0];
    const pick = [...new Set([lo, hi])];
    // more walls (config.walls_per_dir): the most solid panels farthest from those already picked
    while (pick.length < (CFG.walls_per_dir ?? 2)) {
      const nxt = c.filter((q) => !pick.includes(q) && pick.every((p2) => Math.abs(p2.at - q.at) > 1500 || Math.abs(((p2.a.start[0] + p2.b.start[0]) - (q.a.start[0] + q.b.start[0])) + ((p2.a.start[1] + p2.b.start[1]) - (q.a.start[1] + q.b.start[1]))) > 3000))
        .sort((u, v) => Math.min(...pick.map((p2) => Math.abs(p2.at - v.at))) - Math.min(...pick.map((p2) => Math.abs(p2.at - u.at))) || u.ratio - v.ratio)[0];
      if (!nxt) break; pick.push(nxt);
    }
    for (const top of pick) {
      const key = (q) => [q.a.start[0], q.a.start[1], q.b.start[0], q.b.start[1]].map(Math.round).join();
      for (const q of panels.filter((q) => key(q) === key(top))) walls.push(q);
    }
  }
}
const wallKey = new Set(walls.map((q) => q.a.id + "|" + q.b.id));
for (const q of panels) {
  const d = Math.hypot(q.L, q.hgt), cos = q.L / d;
  if (wallKey.has(q.a.id + "|" + q.b.id)) {
    const A = (200 * q.L * d) / (4.8 * q.hgt * cos * cos) * (1 - q.ratio);   // windows kept: stiffness reduced by the opening share
    for (const [p1, p2] of [[q.a.start, q.b.end], [q.b.start, q.a.end]]) struts.push({ id: sid--, kind: "strut", wall: true, start: p1, end: p2, section: "", b_mm: 200, h_mm: Math.round(A / 200), material_class: "Concrete", concrete_grade: "C25/30", steel_grade: "" });
  } else if (q.ratio <= 0.3) {
    const hEq = Math.round((0.15 * d * Em / Ec) / 2);   // infill: half each, b = wall thickness
    for (const [p1, p2] of [[q.a.start, q.b.end], [q.b.start, q.a.end]]) struts.push({ id: sid--, kind: "strut", start: p1, end: p2, section: "", b_mm: q.tw, h_mm: Math.max(10, hEq), material_class: "Concrete", concrete_grade: "C25/30", steel_grade: "" });
  }
}
// the infill register (owner 28 Oct: walls kept as structure): every wall panel the analysis counts on, so the drawings,
// the architect's review pack and the change check (infill-diff.py) all name the same walls
fs.writeFileSync(W + "/infill.json", JSON.stringify(panels.filter((q) => !wallKey.has(q.a.id + "|" + q.b.id)).map((q) => ({
  walls: q.wids, cols: [q.a.id, q.b.id], from: q.a.start.slice(0, 2), to: q.b.start.slice(0, 2), z: [q.a.start[2], q.zt], length_mm: Math.round(q.L), thickness_mm: q.tw + 35,
  openings_pct: Math.round(q.ratio * 100), structural: q.ratio <= 0.3 })), null, 1));
fs.writeFileSync(W + "/shear_walls.json", JSON.stringify(walls.map((q) => ({ dir: q.dir, from: q.a.start, to: q.b.start, bottom_z: q.a.start[2], top_z: q.zt, length_mm: Math.round(q.L), openings_ratio: Math.round(q.ratio * 100) / 100, col_ids: [q.a.id, q.b.id] }))));
// ---- diaphragms: the RC slab (and the attic's plywood deck) tie the column tops together. Each column top is tied to
// its 4 nearest tops on the level where the slab lies between them (a triangulated in-plane mesh: works on irregular
// grids). Ties: RC slab strip 200 x 1000 equivalent; 18 mm plywood deck about 100 x 50 equivalent (E ply / E concrete).
const slabsAt = (lvl) => plan.plan.slabs.filter((x) => x.level === lvl);
const insideAny = (p, sl) => sl.some((x) => inside(p, x.loops_mm));
for (const lvl of CFG.floors) {
  const z = elev[lvl], tops2 = [...new Map(cols.filter((m) => Math.abs(m.end[2] - z) < 1).map((m) => [m.end.map(Math.round).join(), m.end])).values()];
  const timber = CFG.attic && CFG.attic.level === lvl, sz = timber ? [100, 50] : [200, 1000], seen = new Set(), sl = slabsAt(lvl);
  for (const [i, p] of tops2.entries()) {
    const near = tops2.map((q, j) => [j, Math.hypot(q[0] - p[0], q[1] - p[1])]).filter(([j, dd]) => j !== i && dd < 8000).sort((u, v) => u[1] - v[1]).slice(0, 4);
    for (const [j] of near) {
      const q = tops2[j], key = [Math.min(i, j), Math.max(i, j)].join();
      if (seen.has(key) || !insideAny([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], sl)) continue;
      // owner 28 Oct (Robot "clashing elements"): no tie where a beam already joins the two columns (two bars on the same
      // two nodes); the beam carries that tie force
      const same = (a, b) => Math.abs(a[0] - b[0]) < 1 && Math.abs(a[1] - b[1]) < 1 && Math.abs(a[2] - b[2]) < 50;
      if (beams.some((bm) => (same(bm.start, p) && same(bm.end, q)) || (same(bm.start, q) && same(bm.end, p)))) { seen.add(key); continue; }
      // nor a tie that runs past another column top (it would lie on the beams of that line)
      const dx = q[0] - p[0], dy = q[1] - p[1], L2 = dx * dx + dy * dy;
      if (tops2.some((r, k) => { if (k === i || k === j) return false; const u = ((r[0] - p[0]) * dx + (r[1] - p[1]) * dy) / L2; return u > 0.01 && u < 0.99 && Math.abs((r[0] - p[0]) * dy - (r[1] - p[1]) * dx) / Math.sqrt(L2) < 50; })) { seen.add(key); continue; }
      seen.add(key); struts.push({ id: sid--, kind: "strut", start: p, end: q, section: "", b_mm: sz[0], h_mm: sz[1], material_class: "Concrete", concrete_grade: "C25/30", steel_grade: "" });
    }
  }
}
members.push(...struts);
const model = assemble(members);
const nodeAt = (p) => model.nodes.find((q) => Math.abs(q.x - p[0]) < 1 && Math.abs(q.y - p[1]) < 1 && Math.abs(q.z - p[2]) < 1)?.n;
const barOf = new Map(beams.map((b) => { const a = nodeAt(b.start), e = nodeAt(b.end); return [b.key, model.bars.find((x) => x.id === b.id && ((x.start === a && x.end === e) || (x.start === e && x.end === a)))?.n]; }));

// ---- loads on beams (kN/m): slabs by nearest beam (500 mm samples), walls by nearest beam (250 mm samples), roof by length
const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy; let u = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2; u = Math.max(0, Math.min(1, u)); return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy); };
const len = (m) => Math.hypot(m.end[0] - m.start[0], m.end[1] - m.start[1]) / 1000;
const G = new Map(), Q = new Map(); const add = (M, id, kn) => M.set(id, (M.get(id) ?? 0) + kn);
const at = (lvl) => beams.filter((b) => Math.abs(b.start[2] - elev[lvl]) < 600);
const nearest = (bs, p) => bs.reduce((x, y) => (segDist(p, y.start, y.end) < segDist(p, x.start, x.end) ? y : x), bs[0]);
let unplaced = 0;
for (const sl of t.slabs) {
  const fl = f.floors.find((x) => x.id === sl.id); const bs = at(sl.level); if (!fl?.outline_mm || !bs.length) { unplaced += sl.total_g_kn; continue; }
  const g = CFG.attic && sl.level === CFG.attic.level ? CFG.attic.g_kn_m2 : sl.g;   // owner 28 Oct: attic as a suspended timber floor (joists, boards, plasterboard ceiling, services)
  const st = 500, cell = (st / 1000) ** 2, loop = fl.outline_mm[0], xs = loop.map((p) => p[0]), ys = loop.map((p) => p[1]);
  for (let x = Math.min(...xs) + st / 2; x < Math.max(...xs); x += st) for (let y = Math.min(...ys) + st / 2; y < Math.max(...ys); y += st) {
    if (!inside([x, y], fl.outline_mm)) continue; const b = nearest(bs, [x, y]); add(G, b.key, cell * g); add(Q, b.key, cell * (CFG.attic && sl.level === CFG.attic.level ? sl.q : Math.max(sl.q, CFG.q_floor_min_kn_m2 ?? 0)));
  }
}
for (const w of t.walls) {
  const fw = f.walls.find((x) => x.id === w.id); if (!fw || elev[fw.base_level] < 500) continue;   // ground walls: to the ground beams
  const bs = at(fw.base_level); if (!bs.length) continue;
  const L = Math.hypot(fw.end_mm[0] - fw.start_mm[0], fw.end_mm[1] - fw.start_mm[1]), n = Math.max(1, Math.round(L / 250));
  for (let i = 0; i < n; i++) { const u = (i + 0.5) / n, p = [fw.start_mm[0] + u * (fw.end_mm[0] - fw.start_mm[0]), fw.start_mm[1] + u * (fw.end_mm[1] - fw.start_mm[1])]; add(G, nearest(bs, p).key, (w.self_kn_m * L / 1000) / n); }
}
const roofBeams = at(CFG.floors[CFG.floors.length - 1]), roofLen = roofBeams.reduce((a, b) => a + len(b), 0);
for (const r of t.roofs) for (const b of roofBeams) { add(G, b.key, r.total_g_kn * len(b) / roofLen); add(Q, b.key, r.total_q_kn * len(b) / roofLen); }
for (const fl of flights) { add(G, fl.key, 1.5 * fl.b_mm / 1000 * len(fl)); add(Q, fl.key, 3.0 * fl.b_mm / 1000 * len(fl)); }   // finishes 1.5, stairs 3.0 kN/m2 (EN 1991-1-1 cat A stairs)
beams.push(...flights.filter((x) => !beams.includes(x)));
const barLoads = (M) => beams.filter((b) => M.get(b.key) && barOf.get(b.key)).map((b) => ({ bar: barOf.get(b.key), w_kn_m: Math.round((M.get(b.key) / len(b)) * 100) / 100 }));
// ---- seismic (US 319, kit seismic.*): Cd = C.Z.I.K = 0.08 x 0.8 (Kampala, zone 2) x 1.0 (dwelling) x 2 (frame with
// masonry infill); T1 = 0.06 H = 0.44 s, on the plateau (subsoil II, to 0.5 s); W = G + 25% Q (roof imposed nil);
// Fi = V.Wi.hi / sum(Wi.hi), shared equally by the column tops of the level (the slab ties them)
const SEIS = CFG.seismic, Cd = SEIS.C * SEIS.Z * SEIS.I * SEIS.K;
const lvls = CFG.floors;
const colTop = (lvl) => [...new Set(members.filter((m) => m.kind === "column" && Math.abs(m.end[2] - elev[lvl]) < 1).map((m) => JSON.stringify(m.end)))].map((k) => model.nodes.find((q) => Math.abs(q.x - JSON.parse(k)[0]) < 1 && Math.abs(q.y - JSON.parse(k)[1]) < 1 && Math.abs(q.z - JSON.parse(k)[2]) < 1).n);
const selfKn = (m) => (m.b_mm / 1000) * (m.h_mm / 1000) * (Math.hypot(m.end[0] - m.start[0], m.end[1] - m.start[1], m.end[2] - m.start[2]) / 1000) * 25;
const Wl = lvls.map((lvl) => {
  const bs = at(lvl); let w = bs.reduce((a, b) => a + (G.get(b.key) ?? 0) + selfKn(b), 0);
  const roofQ = lvl === CFG.floors[CFG.floors.length - 1] ? t.roofs.reduce((a, r) => a + r.total_q_kn, 0) : 0;
  w += 0.25 * (bs.reduce((a, b) => a + (Q.get(b.key) ?? 0), 0) - roofQ);
  for (const m of members.filter((m) => m.kind === "column")) if (Math.abs(m.end[2] - elev[lvl]) < 1 || Math.abs(m.start[2] - elev[lvl]) < 1) w += selfKn(m) / 2;
  return w;
});
const H = lvls.map((l) => elev[l] / 1000), Wt = Wl.reduce((a, b) => a + b, 0), V = Cd * Wt, sWH = Wl.reduce((a, w, i) => a + w * H[i], 0);
const F = Wl.map((w, i) => (V * w * H[i]) / sWH);
// the slab as a diaphragm, roughly: each column top takes the storey force in proportion to the stiffness (b^4) of the
// columns meeting it from below
const stiff = (lvl, n) => { const q = model.nodes.find((x) => x.n === n); return members.filter((m) => m.kind === "column" && Math.abs(m.end[0] - q.x) < 1 && Math.abs(m.end[1] - q.y) < 1 && Math.abs(m.end[2] - elev[lvl]) < 1).reduce((a, m) => a + m.b_mm ** 4, 0); };
const share = (Fl, dir) => lvls.flatMap((lvl, i) => { const ns = colTop(lvl); return ns.map((n) => ({ node: n, [dir]: Math.round((Fl[i] / ns.length) * 100) / 100 })); });
const byStiff = (Fl, dir) => lvls.flatMap((lvl, i) => { const ns = colTop(lvl), k = ns.map((n) => stiff(lvl, n) || 1), K = k.reduce((a, b) => a + b, 0);
  return ns.map((n, j) => ({ node: n, [dir]: Math.round((Fl[i] * k[j] / K) * 100) / 100 })); });
const nodeLoads = (dir) => byStiff(F, dir);
// accidental torsion (EN 1998-1 4.3.2): the storey force moved by 5% of the plan size across it, as a twisting moment
// Mt = F.0.05.L shared by the column tops in proportion to k.r about the centre of stiffness; combined with both signs
const torsion = (dir) => lvls.flatMap((lvl, i) => {
  const ns = colTop(lvl), q = ns.map((n) => model.nodes.find((x) => x.n === n)), k = ns.map((n) => stiff(lvl, n) || 1), K = k.reduce((a, b) => a + b, 0);
  const xr = q.reduce((a, p, j) => a + k[j] * p.x, 0) / K, yr = q.reduce((a, p, j) => a + k[j] * p.y, 0) / K;
  const span = (f) => (Math.max(...q.map(f)) - Math.min(...q.map(f))) / 1000, L = dir === "x" ? span((p) => p.y) : span((p) => p.x), Mt = F[i] * 0.05 * L;
  const Ip = q.reduce((a, p, j) => a + k[j] * (((p.x - xr) / 1000) ** 2 + ((p.y - yr) / 1000) ** 2), 0);
  return ns.map((n, j) => ({ node: n, fx_kn: Math.round(-Mt * k[j] * ((q[j].y - yr) / 1000) / Ip * 100) / 100, fy_kn: Math.round(Mt * k[j] * ((q[j].x - xr) / 1000) / Ip * 100) / 100 })); });
// ---- wind (EN 1991-1-4 simplified; kit wind.*: vb from UNMA when known): qp = 0.5 rho vb^2 ce, net cf; storey
// forces on the facade width across the wind, half the storey above and below (roof: half the top storey + half the rise)
const WND = { vb: 25, ce: 1.6, cf: 1.2, ...(CFG.wind ?? {}) }, qp = 0.5 * 1.25 * WND.vb ** 2 * WND.ce / 1000, pw = qp * WND.cf;
const allTop = cols.map((m) => m.end), bx = Math.max(...allTop.map((p) => p[0])) - Math.min(...allTop.map((p) => p[0])), by = Math.max(...allTop.map((p) => p[1])) - Math.min(...allTop.map((p) => p[1]));
const zs = [CFG.pad_top_mm, ...lvls.map((l) => elev[l])], roofRise = CFG.roof_rise_mm ?? 4300;
const trib = lvls.map((l, i) => ((zs[i + 1] - zs[i]) / 2 + (i + 1 < lvls.length ? (zs[i + 2] - zs[i + 1]) / 2 : roofRise / 2)) / 1000);
const FWX = trib.map((h) => pw * (by / 1000) * h), FWY = trib.map((h) => pw * (bx / 1000) * h);
const form = { supports: CFG.supports, engineer: "Formcraft BIM Manager - PRELIMINARY, no engineer of record",
  cases: [{ name: "G", nature: "PERMANENT", self_weight: true, bar_loads: barLoads(G) }, { name: "Q", nature: "EXPLOATATION", self_weight: false, bar_loads: barLoads(Q) },
    { name: "EX", nature: "SEISMIC", self_weight: false, node_loads: nodeLoads("fx_kn") }, { name: "EY", nature: "SEISMIC", self_weight: false, node_loads: nodeLoads("fy_kn") },
    { name: "TX", nature: "SEISMIC", self_weight: false, node_loads: torsion("x") }, { name: "TY", nature: "SEISMIC", self_weight: false, node_loads: torsion("y") },
    { name: "WX", nature: "WIND", self_weight: false, node_loads: share(FWX, "fx_kn") }, { name: "WY", nature: "WIND", self_weight: false, node_loads: share(FWY, "fy_kn") }],
  combinations: [{ name: "ULS 1.35G+1.5Q", kind: "ULS", factors: { G: 1.35, Q: 1.5 } }, { name: "SLS G+Q", kind: "SLS", factors: { G: 1, Q: 1 } },
    ...["EX", "EY"].flatMap((e) => [1.25, -1.25].flatMap((k) => [1, -1].flatMap((t) => { const T = e === "EX" ? "TX" : "TY", tn = `${t > 0 ? "+" : "-"}${T}`;
      return [{ name: `G+1.3Q${k > 0 ? "+" : "-"}1.25(${e}${tn})`, kind: "ULS", factors: { G: 1, Q: 1.3, [e]: k, [T]: k * t } },
              { name: `0.9G${k > 0 ? "+" : "-"}1.25(${e}${tn})`, kind: "ULS", factors: { G: 0.9, [e]: k, [T]: k * t } }]; }))),
    // wind (EN 1990: psi0 wind 0.6, imposed 0.7)
    ...["WX", "WY"].flatMap((w) => [1, -1].flatMap((sg) => [
      { name: `1.35G+1.5Q${sg > 0 ? "+" : "-"}0.9${w}`, kind: "ULS", factors: { G: 1.35, Q: 1.5, [w]: 0.9 * sg } },
      { name: `1.35G+1.05Q${sg > 0 ? "+" : "-"}1.5${w}`, kind: "ULS", factors: { G: 1.35, Q: 1.05, [w]: 1.5 * sg } },
      { name: `G${sg > 0 ? "+" : "-"}1.5${w}`, kind: "ULS", factors: { G: 1.0, [w]: 1.5 * sg } }]))] };
// redundancy check (config gravity_wind_only, with infill false): the bare frame must still carry gravity and wind if
// walls are lost; the earthquake relies on the walls by design (US 319 K = 2)
if (CFG.gravity_wind_only) form.combinations = form.combinations.filter((c) => !Object.keys(c.factors).some((k) => /^[ET][XY]$/.test(k)));
const sumG = [...G.values()].reduce((a, b) => a + b, 0), sumQ = [...Q.values()].reduce((a, b) => a + b, 0);
const summary = { nodes: model.nodes.length, bars: model.bars.length, supports: model.supports.length, skipped: model.skipped, beams: beams.length, struts: struts.length, shear_wall_panels: walls.length, applied_g_kn: Math.round(sumG), applied_q_kn: Math.round(sumQ), unplaced_g_kn: Math.round(unplaced), seismic: { Cd, W_kn: Wl.map(Math.round), V_kn: Math.round(V), F_kn: F.map(Math.round) }, wind: { qp_kpa: +qp.toFixed(2), p_kpa: +pw.toFixed(2), WX_kn: FWX.map(Math.round), WY_kn: FWY.map(Math.round) },
  max_w: { G: Math.max(...form.cases[0].bar_loads.map((l) => l.w_kn_m)), Q: Math.max(...form.cases[1].bar_loads.map((l) => l.w_kn_m)) } };
console.log(JSON.stringify(summary));
if (mode !== "send" && mode !== "local") process.exit(0);
// "local": the repo's own 3D frame solver (scripts/structure/frame3d.py) instead of Robot, same results format
if (mode === "local") {
  const run = "FEA-" + new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15) + "L";
  fs.mkdirSync(OUT, { recursive: true });
  const tops = Object.fromEntries(lvls.map((l) => [l, colTop(l)]));
  const inp = OUT + "/" + run + "_model.json";
  fs.writeFileSync(inp, JSON.stringify({ model: { nodes: model.nodes, bars: model.bars, supports: model.supports }, form, nodes: Object.values(tops).flat(), node_cases: ["EX", "EY"] }));
  const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  console.log(execFileSync("python", [here + "frame3d.py", inp, OUT + "/" + run + "_results.json"], { maxBuffer: 1 << 26 }).toString().trim());
  const res = JSON.parse(fs.readFileSync(OUT + "/" + run + "_results.json", "utf8"));
  res.levels = Object.fromEntries(lvls.map((l) => [l, { elevation_mm: elev[l], nodes: tops[l] }])); res.seismic = { Cd, V_kn: V, F_kn: F, K: SEIS.K };
  res.stacks = tops[CFG.floors[CFG.floors.length - 1]].map((n) => { const q = model.nodes.find((x) => x.n === n); const below = model.nodes.find((x) => Math.abs(x.x - q.x) < 1 && Math.abs(x.y - q.y) < 1 && Math.abs(x.z - elev[CFG.floors[CFG.floors.length - 2]]) < 1); return [n, below?.n]; });
  fs.writeFileSync(OUT + "/" + run + "_results.json", JSON.stringify(res, null, 1));
  fs.writeFileSync(OUT + "/" + run + ".json", JSON.stringify({ run, solver: "frame3d", model: CFG.model, made_at: new Date().toISOString(), summary, cfg: { seismic: CFG.seismic, q_floor_min_kn_m2: CFG.q_floor_min_kn_m2 ?? null, attic: CFG.attic ?? null }, form: { ...form, cases: form.cases.map(({ bar_loads, node_loads, ...c }) => ({ ...c, bar_loads: bar_loads?.length ?? 0, node_loads: node_loads?.length ?? 0 })) }, bars: model.bars.map((b) => ({ n: b.n, id: b.id, kind: b.kind, b_mm: b.b_mm, h_mm: b.h_mm })) }, null, 1));
  console.log(JSON.stringify({ run }));
  process.exit(0);
}
const run = "FEA-" + new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const rtd = OUT + "/" + run + ".rtd";
fs.mkdirSync(OUT, { recursive: true });
const exe = R + "robot/fmc-robot.exe";
// owner 28 Oct: a big model (stairs, split beams, torsion combinations) takes Robot over 10 min to build; a timeout kills
// the connector mid-call and leaves Robot with half a model, so allow 30 min (config robot_timeout_s) before giving up
const RTO = (CFG.robot_timeout_s ?? 1800) * 1000;
const runX = (cmd, inp) => { try { return execFileSync(exe, [cmd], { input: JSON.stringify(inp), maxBuffer: 1 << 26, timeout: RTO }).toString(); } catch (e) { return e.code === "ETIMEDOUT" || e.signal ? JSON.stringify({ error: `Robot did not finish ${cmd} within ${RTO / 60000} min: check Robot for a dialog, else raise robot_timeout_s` }) : String(e.stdout || "{}"); } };
const sent = JSON.parse(runX("send", { rtd, model: { nodes: model.nodes, bars: model.bars, supports: model.supports }, form })); if (0) JSON.parse(execFileSync(exe, ["send"], { input: JSON.stringify({ rtd, model: { nodes: model.nodes, bars: model.bars, supports: model.supports }, form }), maxBuffer: 1 << 26 }).toString());
fs.writeFileSync(OUT + "/" + run + ".json", JSON.stringify({ run, model: CFG.model, rtd, engineer: form.engineer, made_at: new Date().toISOString(), summary, cfg: { seismic: CFG.seismic, q_floor_min_kn_m2: CFG.q_floor_min_kn_m2 ?? null, attic: CFG.attic ?? null }, form: { ...form, cases: form.cases.map(({ bar_loads, node_loads, ...c }) => ({ ...c, bar_loads: bar_loads?.length ?? 0, node_loads: node_loads?.length ?? 0 })) }, bars: model.bars.map((b) => ({ n: b.n, id: b.id, kind: b.kind, b_mm: b.b_mm, h_mm: b.h_mm })) }, null, 1));
console.log(JSON.stringify({ run, error: sent.error, cases: sent.cases, unresolved: sent.unresolved_sections?.length }));
if (sent.error) process.exit(1);
const calc = JSON.parse(runX("calculate", { rtd })); if (calc.error) { console.log(JSON.stringify(calc)); process.exit(1); }
// Robot's CalcEngine.Calculate() returns a COM boolean: -1 is TRUE (calculated). The connector (fmc-robot.exe) reads
// only 0 as success; until it is rebuilt, -1 counts as calculated here (owner 28 Oct: Robot's report showed a clean run)
if (calc.status === -1) calc.calculated = true;
console.log(JSON.stringify(calc));
const tops = Object.fromEntries(lvls.map((l) => [l, colTop(l)]));
const res = JSON.parse(runX("results", { rtd, bars: model.bars.map((b) => ({ n: b.n, id: b.id })), nodes: Object.values(tops).flat(), node_cases: ["EX", "EY"] }));
res.levels = Object.fromEntries(lvls.map((l) => [l, { elevation_mm: elev[l], nodes: tops[l] }])); res.seismic = { Cd, V_kn: V, F_kn: F, K: SEIS.K };
// the stacks: which FF node each roof node stands over (same x, y)
res.stacks = tops[CFG.floors[CFG.floors.length - 1]].map((n) => { const q = model.nodes.find((x) => x.n === n); const below = model.nodes.find((x) => Math.abs(x.x - q.x) < 1 && Math.abs(x.y - q.y) < 1 && Math.abs(x.z - elev[CFG.floors[CFG.floors.length - 2]]) < 1); return [n, below?.n]; });
fs.writeFileSync(OUT + "/" + run + "_results.json", JSON.stringify(res, null, 1));
console.log(JSON.stringify({ results: res.bars?.length, error: res.error }));
