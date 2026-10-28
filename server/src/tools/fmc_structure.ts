import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { kitPaths } from "../fmc/context.js";
import { StandardsFile, resolve } from "../fmc/standards.js";
import { Facts, takedown } from "../fmc/loads.js";
import { frameSvg, planFrame } from "../fmc/frame.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

const win = path.win32;

export const FMC_STRUCTURE_DESCRIPTION =
  "Formcraft structural design (owner 27 Oct), preliminary until an engineer of record signs. facts {link?}: what the " +
  "structure must carry, read from the open model or a linked architecture model (link: part of its name): levels, walls " +
  "with their layers, floors, roofs, rooms, columns, beams, stairs. loads {link?, use?}: the load takedown from those " +
  "facts and the kit's standards (Uganda Structural Design Code 2019; unit weights EN 1991-1-1): every suspended slab " +
  "(self-weight, layers, finishes, services, partitions, imposed load by room), every wall's weight per metre and its " +
  "base line load, the roofs, per level and in all, with 1.35G+1.5Q, G+Q and G+ψ2Q; ground-bearing slabs listed apart; " +
  "warnings for unknown materials or slabs with nothing under them. save_to_project? writes the table (JSON and CSV) to " +
  "<project>\\01_WIP\\_Structure. Slab loads go to the bearing walls under them by length: for comparing options only. " +
  "frame {link?, max_span_mm?, bearing_kpa?}: the RC frame (owner 27 Oct): grids per wall direction, columns at wall corners, " +
  "junctions and ends (and where a span passes max_span_mm, default 6000), beams on the wall lines at each floor and ground " +
  "beams, pads; first-pass sizes, slab span checks, quantities, warnings (columns with nothing under them, walls that reach no " +
  "level), and the modify_model ops that build it. apply: true sends those ops to the open model (the structural model, with " +
  "the architecture linked) through modify_model, dry_run first.";

const reply = (body: object, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });

export function registerFmcStructureTool(server: McpServer) {
  server.tool("fmc_structure", FMC_STRUCTURE_DESCRIPTION, {
    action: z.enum(["facts", "loads", "frame"]).optional().default("loads"),
    max_span_mm: z.number().min(2000).max(12000).optional(), bearing_kpa: z.number().min(50).max(1000).optional(),
    apply: z.boolean().optional().default(false), dry_run: z.boolean().optional().default(true),
    link: z.string().optional().describe("Read from this linked model (part of its name); default the open model"),
    use: z.string().optional().default("residential").describe("The use the standards are read for"),
    save_to_project: z.string().optional().describe("The project folder (holding 01_WIP): write the load table there"),
    full: z.boolean().optional().default(false).describe("facts: every element, not only the counts and levels"),
    exclude_levels: z.array(z.string()).optional().describe("frame: leave out the walls, slabs and rooms on these levels (e.g. an outbuilding)"),
    types: z.object({ column: z.string().optional(), beam: z.string().optional(), pad: z.string().optional(), slab: z.string().optional() }).optional()
      .describe("frame: the structural model's types to build from (concrete families with b/h; slab: a floor type of the RC thickness)"),
    min_line_mm: z.number().min(0).max(20000).optional().describe("frame: wall length a grid line needs to carry columns (default 2400; exterior lines always)"),
  }, async (args) => {
    try {
      const facts = await withRevitConnection((c) => c.sendCommand("fmc_struct_facts", { link: args.link }, 300000)) as Facts & { counts?: unknown };
      if (args.action === "facts") return reply(args.full ? facts : { from: facts.from, levels: facts.levels, counts: facts.counts, walls_sample: facts.walls.slice(0, 5) });

      const { config } = loadConfig();
      const k = kitPaths(config);
      const kitFile = win.join(win.dirname(k.recipesDir), "FMC_Standards_Building.json");
      let kit: StandardsFile | null = null;
      try { kit = JSON.parse(fs.readFileSync(kitFile, "utf8").replace(/^﻿/, "")); } catch { /* reported below */ }
      if (!kit) return reply({ error: `No kit standards at ${kitFile}` }, true);
      const projFile = args.save_to_project ? win.join(expandEnv(args.save_to_project), "01_WIP", "FMC_Project_Standards.json") : "";
      let proj: Record<string, unknown> | null = null;
      try { if (projFile) proj = JSON.parse(fs.readFileSync(projFile, "utf8").replace(/^﻿/, "")); } catch { /* none yet */ }
      const values = new Map(resolve(kit, proj, args.use).map((r) => [r.key, r.value]));
      const t = takedown(facts, (key) => values.get(key));
      if (args.action === "frame") {
        const p = planFrame(facts, (key) => values.get(key), { max_span_mm: args.max_span_mm, bearing_kpa: args.bearing_kpa, exclude_levels: args.exclude_levels, types: args.types, min_line_mm: args.min_line_mm });
        let saved2: object | undefined;
        if (args.save_to_project) {
          const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
          const file = win.join(expandEnv(args.save_to_project), "01_WIP", "_Structure", `${stamp}_rc_frame.json`);
          const v = checkWritePath(file, config, { checkName: false });
          if (!v.ok) return reply({ refused: v.reasons }, true);
          fs.mkdirSync(win.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ from: facts.from, ...p }, null, 2));
          // a plan per level for approval before anything is built (owner 27 Oct)
          const plans = Object.entries(frameSvg(facts, p)).map(([lv, svg]) => {
            const f2 = file.replace(/\.json$/, `_plan_${lv.replace(/[^\w.+-]+/g, "_")}.svg`); fs.writeFileSync(f2, svg); return f2;
          });
          saved2 = { file, plans };
        }
        let applied: unknown;
        if (args.apply) applied = await withRevitConnection((c) => c.sendCommand("fmc_model_edit", { ops: p.ops, dry_run: args.dry_run, why: "Preliminary RC frame from the architecture model (fmc_structure frame)" }, 900000));
        const bySize: Record<string, number> = {};
        for (const c of p.columns) bySize[c.size_mm.join("x")] = (bySize[c.size_mm.join("x")] ?? 0) + 1;
        return reply({ from: facts.from, status: p.status, basis: p.basis, grids: p.grids,
          columns: { count: p.columns.length, by_size: bySize, heaviest: [...p.columns].sort((a, b) => b.n_uls_kn - a.n_uls_kn).slice(0, 5) },
          beams: { count: p.beams.count, ground: p.beams.ground, by_size: p.beams.by_size, longest_mm: p.beams.longest_mm },
          pads: { count: p.pads.length, largest: [...p.pads].sort((a, b) => b.size_mm[0] - a.size_mm[0]).slice(0, 5) },
          slabs: p.slabs, quantities: p.quantities, loads: p.loads, warnings: p.warnings, ops: p.ops.length,
          ...(saved2 ? { saved: saved2 } : {}), ...(applied !== undefined ? { applied } : { next: "apply: true (dry_run first) in the structural model, with the architecture model linked" }) });
      }

      let saved: object | undefined;
      if (args.save_to_project) {
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const dir = win.join(expandEnv(args.save_to_project), "01_WIP", "_Structure");
        const json = win.join(dir, `${stamp}_loads.json`), csv = win.join(dir, `${stamp}_loads.csv`);
        const v = checkWritePath(json, config, { checkName: false });
        if (!v.ok) return reply({ refused: v.reasons, loads: t.totals }, true);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(json, JSON.stringify({ from: facts.from, ...t }, null, 2));
        fs.writeFileSync(csv, csvLine(["kind", "id", "type", "level", "area_m2 or length_m", "g (kN/m² or kN/m)", "q", "note"]) +
          t.slabs.map((s) => csvLine(["slab", s.id, s.type, s.level, s.area_m2, s.g, s.q, s.rooms.join("; ")])).join("") +
          t.roofs.map((r) => csvLine(["roof", r.id, r.type, r.level, r.area_m2, r.g, r.q, ""])).join("") +
          t.walls.map((w) => csvLine(["wall", w.id, w.type, w.level, w.length_m, w.base_line_g_kn_m, w.base_line_q_kn_m, w.bearing ? "bearing" : "non-bearing"])).join(""));
        saved = { json, csv };
      }
      return reply({ from: facts.from, ...t, walls: t.walls.filter((w) => w.bearing).sort((a, b) => b.base_line_g_kn_m - a.base_line_g_kn_m).slice(0, 25),
        walls_note: `the 25 heaviest bearing walls of ${t.walls.length}; all in the saved table`, ...(saved ? { saved } : {}) });
    } catch (e) {
      return reply({ error: e instanceof Error ? e.message : String(e) }, true);
    }
  });
}
