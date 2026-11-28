/** fmc_casework's engine actions (no Revit, no files) and the workshop pack. */
import fs from "node:fs";
import path from "node:path";
import { checkWritePath, csvLine } from "./policy.js";
import { packFiles, packLabel, packNames, summaryOf } from "./casework.js";
import { workshopPackPdf } from "./casework_pdf.js";
import { Ctx, Prepared, Reply, checksFor, costOf, fileAction, log, projectCode, stamp } from "./casework_tool.js";

/** units, parts, nest, cutlist, hardware, summary: computed from the run, nothing written. */
export function engineAction(ctx: Ctx, p: Prepared): Reply {
  const { args, reply } = ctx;
  const c = p.casework;
  const head = { standards_from: p.from, problems: c.problems, notes: c.layout.notes };
  switch (args.action) {
    case "units":
      return reply({ ...head, units: c.layout.units, fillers: c.layout.fillers, worktop: c.layout.worktop, worktop_m: c.worktop_m });
    case "parts":
      return reply({ ...head, part_lines: c.parts.length, pieces: c.parts.reduce((a, x) => a + x.qty, 0), parts: c.parts });
    case "nest": {
      const nests = c.nests.filter((n) => !args.board || n.material === args.board)
        .map((n) => ({ ...n, sheets: n.sheets.filter((s) => !args.sheet || s.index === args.sheet) }));
      if (args.board && !nests.length) return reply({ refused: true, reasons: [`No parts on ${args.board}; boards: ${c.nests.map((n) => n.material).join(", ")}`] }, true);
      return reply({ ...head, sheet: p.standards.sheet, kerf: p.standards.kerf, boards: nests });
    }
    case "cutlist":
      return reply({ ...head, rows: c.cutlist, edge_m: c.edge_m });
    case "hardware":
      return reply({ ...head, hardware: c.hardware });
    case "summary": {
      const cost = costOf(p);
      return reply({ ...head, ...summaryOf(c), cost: { lines: cost.lines, total: cost.total }, kit_requests: cost.kit_requests,
        ...(p.libProblem ? { library: p.libProblem } : {}) });
    }
    default:
      return reply({ refused: true, reasons: [`${args.action} isn't an engine action`] }, true);
  }
}

/** check: the layout against the room as Revit reads it (read only); flags for a person. */
export async function checkAction(ctx: Ctx, p: Prepared): Promise<Reply> {
  const { args, reply, send } = ctx;
  const c = p.casework;
  const head = { standards_from: p.from, problems: c.problems, notes: c.layout.notes };
  if (!args.room.trim()) return reply({ refused: true, reasons: ["Name the room to check against (its number or name)"] }, true);
  if (!args.run) return reply({ refused: true, reasons: ["Checks need a run whose walls have their place in the model (start, end): read the room first"] }, true);
  const ch = await checksFor(args, p, send);
  return reply({ ...head, ...ch, flagged: ch.flags.filter((f) => f.state === "flag").length,
    next: "Each flag is for a person to decide; the tool moves no service and no unit (rule 5)" });
}

/** pack: the cut list, nesting, hardware and BoQ CSVs and the workshop PDF into 01_WIP\\_Casework (old files to _Archive). */
export function packAction(ctx: Ctx, p: Prepared): Reply {
  const { args, config, problem, dry, run_id, reply } = ctx;
  const c = p.casework;
  const reasons: string[] = [];
  if (problem) reasons.push(problem);
  const code = projectCode(args, reasons);
  if (!packLabel(args.label)) reasons.push("Name what this pack is (label), e.g. K-01 Kitchen");
  if (!args.project_folder.trim()) reasons.push("The pack goes into the project's 01_WIP\\_Casework: set the project folder");
  if (c.problems.length) reasons.push("Fix the problems first; a pack is never made from a run that doesn't fit");
  if (reasons.length) return reply({ refused: true, reasons, problems: c.problems }, true);
  const folder = path.join(args.project_folder.trim(), "01_WIP", "_Casework");
  const archive = path.join(folder, "_Archive");
  const cost = costOf(p);
  const names = packNames(code, args.label);
  const files: Array<{ name: string; content: string | Buffer; rows: number }> = packFiles(c, cost, csvLine, code, args.label);
  const shop = fs.existsSync(path.join(folder, names.shop)) ? names.shop : undefined;
  const pdf = workshopPackPdf({ code, label: args.label.trim(), casework: c, cost, standards: p.standards, standards_from: p.from, shop_drawings: shop });
  files.push({ name: names.pdf, content: pdf, rows: (pdf.toString("latin1").match(/\/Type \/Page /g) ?? []).length });
  for (const target of [...files.map((f) => path.join(folder, f.name)), path.join(archive, "x.csv")]) {
    const v = checkWritePath(target, config, { checkName: false });
    if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
  }
  const plan = files.map((f) => ({ file: f.name, ...(f.name.endsWith(".pdf") ? { pages: f.rows } : { rows: f.rows }), action: fileAction(path.join(folder, f.name), f.content) }));
  const summary = { folder, files: plan, ...summaryOf(c), cost_total: cost.total, kit_requests: cost.kit_requests,
    shop_drawings: shop ?? "not made yet (shop_drawings, in Revit)" };
  if (dry) {
    log(config, true, folder, "dry run", `${plan.length} files`, "casework_pack", run_id);
    return reply({ dry_run: true, ...summary, next: "Run again with dry_run=false to write these files" });
  }
  fs.mkdirSync(folder, { recursive: true });
  const st = stamp();
  for (const f of files) {
    const target = path.join(folder, f.name);
    const step = plan.find((x) => x.file === f.name)!;
    if (step.action === "unchanged") continue;
    if (step.action !== "new") {
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(target, path.join(archive, `${st}_${f.name}`));
    }
    fs.writeFileSync(target, f.content);
  }
  const written = plan.filter((x) => x.action !== "unchanged").length;
  log(config, false, folder, "done", `${written} written, ${plan.length - written} unchanged`, "casework_pack", run_id);
  return reply({ done: true, ...summary });
}
