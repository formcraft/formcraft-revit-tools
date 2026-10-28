// Put the designed structure into the Revit model in one batch (docs/ROBOT_RC_FRAME_PROCESS.md):
// member sizes (sizes.json), pad sizes (the rc-design json), RC shear walls (shear_walls.json) with their strip
// footings, and the attic as a timber floor (config.attic). Types are made from existing ones when missing: the batch is
// dry-run first, a type the model already has is dropped from it, then it is applied.
//   node scripts/structure/revit-apply.mjs <work dir> <rc-design json> [dry|apply]
import fs from "node:fs";
const B = new URL("../../server/build/", import.meta.url);
const { withRevitConnection } = await import(new URL("utils/ConnectionManager.js", B).href);
const [W, designFile, mode = "dry"] = process.argv.slice(2);
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const plan = read(W + "/plan.json"), built = read(W + "/build.out.json"), sizes = read(W + "/sizes.json");
const cfg = fs.existsSync(W + "/config.json") ? read(W + "/config.json") : { attic: { level: "Roof +7.25" } };
const design = read(designFile), walls = fs.existsSync(W + "/shear_walls.json") ? read(W + "/shear_walls.json") : [];
const pairs = plan.ops.map((o, i) => [o, built.ops[i + 2]]);
if (fs.existsSync(W + "/extra.json") && fs.existsSync(W + "/extra.out.json")) { const xo = read(W + "/extra.out.json").ops; read(W + "/extra.json").forEach((o, i) => pairs.push([o, xo[i]])); }
const kindOf = new Map();
for (const [o, r] of pairs) for (const id of r?.created_ids ?? []) kindOf.set(id, o.op);
const ops = [];
const dup = (category, from, name, params) => ops.push({ op: "duplicate_type", type: { select: { category, types: true, type_name: from, first: true } }, new_name: name, params });

// members: "RC bxh" made from RC 230x230 (columns) / RC 230x300 (beams)
// every member to its final size (sizes.json, else the planned size): earlier runs may have left other sizes in Revit
const groups = new Map();
for (const [o, r] of pairs) {
  if (o.op !== "column" && o.op !== "beam") continue;
  for (const id of r?.created_ids ?? []) {
    const [b, h] = sizes[String(id)] ?? o.size_mm, key = `${o.op}|RC ${b}x${h}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(id);
  }
}
for (const [key, ids] of groups) {
  const [k, name] = key.split("|"), [b, h] = name.slice(3).split("x").map(Number);
  dup(k === "column" ? "Structural Columns" : "Structural Framing", k === "column" ? "RC 230x230" : "RC 230x300", name, { b, h });
  ops.push({ op: "change_type", ids, type_name: name });
}
// pads
const padIds = new Map();
for (const p of design.pads ?? []) { const n = `PAD ${p.size}`; (padIds.get(n) ?? padIds.set(n, []).get(n)).push(p.id); }
for (const [name, ids] of padIds) {
  const [Bw, L, t] = name.slice(4).split("x").map(Number);
  dup("Structural Foundations", "PAD 900x900x300", name, { Width: Bw, Length: L, "Foundation Thickness": t });
  ops.push({ op: "change_type", ids, type_name: name });
}
// shear walls: one wall per line, from the lowest panel bottom to the highest top, between the column faces
if (walls.length) {
  ops.push({ op: "duplicate_type", type: { select: { category: "Walls", types: true, type_name: "Generic - 200mm", first: true } }, new_name: "FMC RC Wall 200mm",
    layers: [{ width_mm: 200, function: "Structure", material: "Concrete, Cast-in-Place gray" }] });
  const lines = new Map();
  for (const w of walls) {
    const key = [w.from[0], w.from[1], w.to[0], w.to[1]].map(Math.round).join();
    const l = lines.get(key) ?? { from: w.from, to: w.to, lo: Infinity, hi: -Infinity }; l.lo = Math.min(l.lo, w.bottom_z); l.hi = Math.max(l.hi, w.top_z); lines.set(key, l);
  }
  const levelAt = (z) => [...Object.entries(cfg.level_by_z ?? { "-250": "S Pad top -0.25", "3850": "FF +3.85", "7250": "Roof +7.25" })].find(([k]) => Math.abs(Number(k) - z) < 1)?.[1];
  for (const l of lines.values()) {
    const dx = l.to[0] - l.from[0], dy = l.to[1] - l.from[1], L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L, cut = 150;   // stop at the column faces
    ops.push({ op: "create_wall", type_name: "FMC RC Wall 200mm", level: levelAt(l.lo), top_level: levelAt(l.hi), structural: true,
      start_mm: [Math.round(l.from[0] + ux * cut), Math.round(l.from[1] + uy * cut)], end_mm: [Math.round(l.to[0] - ux * cut), Math.round(l.to[1] - uy * cut)] });
    ops.push({ op: "wall_foundation", ids: [`$${ops.length}`] });
  }
}
// attic: the RC slab becomes a timber joist floor
if (cfg.attic) for (const [o, r] of pairs) if (o.op === "structural_floor" && o.level === cfg.attic.level)
  ops.push({ op: "change_type", ids: r.created_ids, type_name: cfg.attic.floor_type ?? "Wood Joist 235mm - Wood Finish" });

// dry-run, dropping duplicates of types the model already has, then apply
const send = (dry) => withRevitConnection((c) => c.sendCommand("fmc_model_edit", { ops, dry_run: dry, why: "Ogala structure: designed sizes, pads, shear walls, timber attic (preliminary)" }, 1800000));
for (let tries = 0; tries < 60; tries++) {
  const r = await send(true);
  if (!r.failed_op) break;
  const op = ops[r.failed_op - 1];
  if (op?.op === "duplicate_type" && /already in use/i.test(r.reason ?? "")) {
    ops.splice(r.failed_op - 1, 1);
    for (const o of ops) if (o.op === "wall_foundation") o.ids = o.ids.map((x) => (typeof x === "string" && x.startsWith("$") && Number(x.slice(1)) > r.failed_op ? `$${Number(x.slice(1)) - 1}` : x));
    continue;
  }
  if (op?.op === "wall_foundation") { console.log(`no wall foundation: ${r.reason}`); ops.splice(r.failed_op - 1, 1); continue; }
  console.log(JSON.stringify({ failed_op: r.failed_op, op, reason: r.reason })); process.exit(1);
}
fs.writeFileSync(W + "/revit-apply.ops.json", JSON.stringify(ops, null, 1));
if (mode !== "apply") { console.log(`dry run passed: ${ops.length} ops`); process.exit(0); }
const r = await send(false);
fs.writeFileSync(W + "/revit-apply.out.json", JSON.stringify(r, null, 1));
console.log(JSON.stringify({ applied: r.applied, batch: r.batch_id, failed_op: r.failed_op, reason: r.reason, ops: ops.length }));
process.exit(0);
