/** fmc_casework's Revit actions: room (read), place and shop_drawings (dry run rolled back; real runs behind the lock). */
import fs from "node:fs";
import path from "node:path";
import { checkWritePath, expandEnv } from "./policy.js";
import { packLabel, packNames } from "./casework.js";
import { a3Frame, kitParams, placementPlan, registerSheet, registerSheetFor, runFromRoom, shopLayout } from "./casework_place.js";
import { finishExport, swapPlan } from "./casework_run.js";
import { Ctx, Prepared, Reply, checksFor, kitFamily, log, masterDir, projectCode, readCsv, readJson, readRoom, stamp } from "./casework_tool.js";

/** room: a room's walls, doors, windows and services as a run's walls (read only); needs no standards. */
export async function roomAction(ctx: Ctx): Promise<Reply> {
  const { args, reply, send } = ctx;
  if (!args.room.trim()) return reply({ refused: true, reasons: ["Name the room (its number or name in the active model)"] }, true);
  const read = await readRoom(send, args.room.trim());
  const r = runFromRoom(read);
  const count = (k: string) => r.services.filter((s) => s.kind === k).length;
  // a ready run: the walls with their place in the model, modules left for the person (nothing is defaulted)
  const run = { walls: r.walls, modules: [] as number[] };
  ctx.entry.run = run;
  ctx.entry.room_read = { room: args.room.trim(), at: new Date().toISOString(), read };
  return reply({ room: read.room, run, services: { water: count("water"), waste: count("waste"), gas: count("gas"), sockets: count("socket"), other: count("other") },
    window_sills: r.sills, notes: r.notes,
    next: `This run is saved: call again with run_id "${ctx.run_id}" and modules (the unit widths), plus a corner, sink and appliances on the walls if there are any; then lay out (units, summary) and check against the room` });
}

/** place: the units as the kit's family types, one Undo; a re-run replaces what the same label placed. */
export async function placeAction(ctx: Ctx, p: Prepared): Promise<Reply> {
  const { args, config, problem, dry, run_id, send, reply } = ctx;
  const c = p.casework;
  const reasons: string[] = [];
  if (problem && !dry) reasons.push(problem);
  if (!packLabel(args.label)) reasons.push("Name what this is (label), e.g. K-01 Kitchen: a re-run replaces what the same label placed");
  if (!args.level.trim()) reasons.push("Name the level the units stand on");
  if (c.problems.length) reasons.push("Fix the problems first; nothing is placed from a run that doesn't fit");
  if (reasons.length) return reply({ refused: true, reasons, problems: c.problems }, true);
  const fam = kitFamily(config, args.family.trim());
  if ("refused" in fam) return reply(fam.refused, true);
  const mdFile = path.join(masterDir(config), "FMC_Master_Data.json");
  const md = readJson(mdFile);
  if (!md) return reply({ refused: true, reasons: [`The kit's master data isn't readable at ${mdFile}`] }, true);
  const kp = kitParams(md);
  const plan = placementPlan(c.layout.units, (args.run?.walls ?? []) as Parameters<typeof placementPlan>[1], p.standards,
    { family: fam.family, type_for: args.type_for, wall_unit_bottom: args.wall_unit_bottom, params: kp.found, lib: p.lib });
  const kit_requests = [...p.requests, ...kp.requests, ...plan.kit_requests];
  if (plan.problems.length || !plan.ops.length)
    return reply({ refused: true, reasons: plan.problems.length ? plan.problems : ["Nothing to place: every unit was skipped"], skipped: plan.skipped, kit_requests }, true);
  const widthParam = fam.family.key_parameters.includes("Width") ? "Width" : "";
  const tag = `FMC:casework:${packLabel(args.label)}`;
  const payload = { dry_run: dry, level: args.level.trim(), family: plan.family, tag, width_param: widthParam,
    ops: plan.ops.map((o) => ({ mark: o.mark, type: o.type, width: o.width, at: o.at, facing: o.facing, params: o.params })), type_params: plan.type_params };
  const checks = dry && args.room.trim() ? await checksFor(ctx, p) : null;
  // the dry run places and rolls back, so it changes nothing and needs no lock; the real run goes through the lock
  const result = await send("fmc_casework_place", payload, dry, 300000);
  log(config, dry, args.level, dry ? "dry run" : "done", `${plan.ops.length} units of ${plan.family} (${tag})`, "casework_place", run_id);
  return reply({ dry_run: dry, family: plan.family, will_place: plan.ops.map((o) => `${o.mark} ${o.type} ${o.width}`), type_params: plan.type_params,
    skipped: plan.skipped, notes: [...plan.notes, ...(widthParam ? [] : [`${plan.family} has no Width key parameter in the register, so the width isn't set`])],
    kit_requests, ...(checks ? { checks } : {}), result,
    next: dry ? "Show this to the person; run again with dry_run=false once they say yes (one Undo takes it all out)" : "Check the units in the model; then shop_drawings (dry run first)" });
}

/** shop_drawings: elevations on the register's A3 sheets, the cut-list schedule, the PDF swapped in only after a successful export. */
export async function shopAction(ctx: Ctx, p: Prepared): Promise<Reply> {
  const { args, config, problem, dry, run_id, send, reply } = ctx;
  const c = p.casework;
  const reasons: string[] = [];
  if (problem) reasons.push(problem);
  const code = projectCode(args, reasons);
  if (!packLabel(args.label)) reasons.push("Name what this is (label), e.g. K-01 Kitchen");
  if (!args.sheets.length) reasons.push("Name the register's joinery sheet(s) for the drawings, e.g. [\"I-4001\"]");
  if (c.problems.length) reasons.push("Fix the problems first");
  if (reasons.length) return reply({ refused: true, reasons, problems: c.problems }, true);
  const regFile = path.join(masterDir(config), "FMC_Sheet_Register.csv");
  const reg = readCsv(regFile);
  if (!reg) return reply({ refused: true, reasons: [`The kit's sheet register isn't readable at ${regFile}`] }, true);
  const rows = args.sheets.map((n) => ({ n, row: registerSheet(reg, n.trim()) }));
  const unknown = rows.filter((r) => !r.row || !r.row.scale).map((r) => r.n);
  if (unknown.length) return reply({ refused: true, reasons: [`Not in the sheet register with a scale: ${unknown.join(", ")}`] }, true);
  const scales = [...new Set(rows.map((r) => r.row!.scale))];
  if (scales.length > 1) return reply({ refused: true, reasons: [`The sheets have different scales (${scales.map((s) => `1:${s}`).join(", ")}); give sheets of one scale`] }, true);
  const rbFile = path.join(expandEnv(config.rulebooks_dir), "FMC_Rulebook_Sheets.json");
  const { frame, problem: frameProblem } = a3Frame(readJson(rbFile));
  if (!frame) return reply({ refused: true, reasons: [`${frameProblem} (${rbFile})`],
    kit_requests: [{ item: "A3 sheet frame", request: "Give FMC_Rulebook_Sheets.json the A3 title block, margins, drawing area and A3 scale", why: "Shop drawings go on the kit's A3 sheets" }] }, true);
  const margin = 150; // mm of model around each unit: room for its sizes and mark
  const layout = shopLayout(c.layout.units, p.standards, scales[0], frame, rows.map((r) => r.row!.number), margin);
  if (layout.overflow.length) return reply({ refused: true, reasons: [`These don't fit on the sheets given: ${layout.overflow.join(", ")}; add another register sheet`] }, true);
  const cut = registerSheetFor(reg, "I11_Joinery_Cutlist");
  const names = packNames(code, args.label);
  const folder = args.project_folder.trim() ? path.join(args.project_folder.trim(), "01_WIP", "_Casework") : "";
  let exportTo: { folder: string; file: string } | null = null;
  let swap: ReturnType<typeof swapPlan> | null = null;
  let action = "";
  if (folder) {
    for (const target of [path.join(folder, names.shop), path.join(folder, "_Archive", "x.pdf")]) {
      const v = checkWritePath(target, config, { checkName: false });
      if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
    }
    // Revit exports under a temporary name beside the current PDF; the swap happens only after it reports success
    swap = swapPlan(folder, names.shop, run_id, stamp());
    const pv = checkWritePath(path.join(folder, `${swap.pendingBase}.pdf`), config, { checkName: false });
    if (!pv.ok) return reply({ refused: true, reasons: pv.reasons }, true);
    exportTo = { folder, file: swap.pendingBase };
    action = fs.existsSync(path.join(folder, names.shop)) ? "replace (only after a successful export; the old one then moves to _Archive)" : "new";
  }
  const payload = {
    dry_run: dry, view_prefix: `CW ${packLabel(args.label)} `, scale: scales[0], margin_mm: margin, title_block: frame.title_block,
    views: layout.views.map((v) => ({ mark: v.mark, sheet: v.sheet, centre: v.centre })),
    sheets: rows.map((r) => ({ number: r.row!.number, name: r.row!.name, view_template: r.row!.placed })),
    // the schedule's top-left corner just inside the drawing area's top-left
    schedule: cut ? { name: "I11_Joinery_Cutlist", sheet: cut.number, sheet_name: cut.name, at: [frame.origin[0] + 5, frame.origin[1] + frame.area[1] - 5] } : null,
    export: dry ? null : exportTo,
  };
  if (!dry && exportTo) fs.mkdirSync(folder, { recursive: true });
  let result: unknown;
  let sendError: string | undefined;
  try {
    result = await send("fmc_casework_pack", payload, dry, 600000);
  } catch (e) {
    if (dry || !swap) throw e;
    sendError = e instanceof Error ? e.message : String(e);
  }
  // the old PDF is archived only now, and only if the export succeeded; a failure leaves it exactly as it was
  const exported = !dry && swap ? finishExport(swap, sendError !== undefined ? { error: sendError } : { result }) : null;
  log(config, dry, folder || rows.map((r) => r.n).join(", "), dry ? "dry run" : "done", `${layout.views.length} elevations on ${rows.length} sheet(s)${exported ? `; pdf ${exported.state}${exported.reason ? ` (${exported.reason})` : ""}${exported.archived ? `; old pdf archived to ${exported.archived}` : ""}` : ""}`, "casework_shop", run_id);
  if (exported?.state === "failed")
    return reply({ error: `The PDF export failed (${exported.reason}); the current shop PDF was left in place`, pdf: { folder, file: names.shop, action: "left as it was", ...exported }, result }, true);
  return reply({ dry_run: dry, scale: `1:${scales[0]}`, title_block: `${frame.title_block.family} : ${frame.title_block.type}`,
    sheets: rows.map((r) => ({ number: r.row!.number, name: r.row!.name, views: layout.views.filter((v) => v.sheet === r.row!.number).map((v) => v.mark) })),
    schedule: cut ? `I11_Joinery_Cutlist on ${cut.number}` : "The sheet register names no sheet for I11_Joinery_Cutlist",
    pdf: exportTo ? { folder, file: names.shop, action, ...(exported ? { export: exported } : {}) } : "No project folder, so the sheets aren't exported as PDF",
    result, next: dry ? "Show this to the person; run again with dry_run=false once they say yes" : "Make the workshop pack (pack): its PDF names these sheets" });
}
