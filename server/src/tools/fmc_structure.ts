import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { kitPaths } from "../fmc/context.js";
import { StandardsFile, resolve } from "../fmc/standards.js";
import { Facts, takedown } from "../fmc/loads.js";
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
  "<project>\\01_WIP\\_Structure. Slab loads go to the bearing walls under them by length: for comparing options only.";

const reply = (body: object, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });

export function registerFmcStructureTool(server: McpServer) {
  server.tool("fmc_structure", FMC_STRUCTURE_DESCRIPTION, {
    action: z.enum(["facts", "loads"]).optional().default("loads"),
    link: z.string().optional().describe("Read from this linked model (part of its name); default the open model"),
    use: z.string().optional().default("residential").describe("The use the standards are read for"),
    save_to_project: z.string().optional().describe("The project folder (holding 01_WIP): write the load table there"),
    full: z.boolean().optional().default(false).describe("facts: every element, not only the counts and levels"),
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
