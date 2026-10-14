import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { LinkFact, auditLinks, candidates, linkProblems, roleOf } from "../fmc/links.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

/** .rvt files in the folder and one level of subfolders (02_Shared\<Role>\). */
export function listModels(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = win.join(dir, e.name);
      if (e.isDirectory() && depth < 2 && !e.name.toLowerCase().endsWith("_backup")) walk(full, depth + 1);
      else if (e.isFile() && /\.rvt$/i.test(e.name)) out.push(full);
    }
  };
  walk(folder, 0);
  return out;
}

export const FMC_LINKS_DESCRIPTION =
  "Formcraft links. audit (read-only) reads the model's coordinates (shared position of the project origin, angle to " +
    "true north, site, FMC_CRS) and every Revit link (path, pinned, loaded, overlay or attachment, workset) and lists " +
    "what breaks the Manual: links from 02_Shared only, relative paths, overlay, pinned, workset Z_Links_<Role>. With " +
    "link_from it also lists the models there that could be linked. link links models from 02_Shared by shared " +
    "coordinates (and pins them); pin pins every unpinned link. link and pin are dry runs unless dry_run is false and " +
    "are refused on live projects. Coordinates are never moved by this tool.";

export const FMC_LINKS_SHAPE = {
  action: z.enum(["audit", "link", "pin"]),
  link_from: z.string().optional().default("").describe("audit: folder to list models from, normally <project>\\02_Shared"),
  models: z.array(z.string()).optional().default([]).describe("link: absolute paths of .rvt models in 02_Shared"),
  pin: z.boolean().optional().default(true).describe("link: pin after linking"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcLinksArgs = z.infer<z.ZodObject<typeof FMC_LINKS_SHAPE>>;

export async function runFmcLinks(args: FmcLinksArgs) {
  const { config } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    const facts = await withRevitConnection((c) => c.sendRaw("fmc_link_facts", {}, 60000));
    const links = (facts?.links ?? []) as LinkFact[];
    const model = String(facts?.model ?? "");

    if (args.action === "audit") {
      const audit = auditLinks(links, !!facts?.workshared, (facts?.worksets ?? []) as string[]);
      const folder = args.link_from.trim();
      const found = folder ? candidates(listModels(folder), links, model) : [];
      return reply({ model, workshared: !!facts?.workshared, coordinates: facts?.coordinates ?? {}, links, audit,
        to_fix: audit.filter((a) => a.state === "Fix").length, link_from: folder, candidates: found,
        link_from_problem: folder && !fs.existsSync(folder) ? `Folder not found: ${folder}` : "" });
    }

    if (args.action === "pin") {
      const ids = links.filter((l) => !l.pinned).map((l) => l.id);
      if (!ids.length) return reply({ dry_run: dry, nothing: true, message: "Every link is pinned" });
      if (dry) return reply({ dry_run: true, would: links.filter((l) => !l.pinned).map((l) => ({ id: l.id, name: l.name })), next: "Run again with dry_run=false" });
      const r = await withRevitConnection((c) => c.sendCommand("fmc_link_pin", { element_ids: ids }, 60000));
      log(config, "links_pin", false, model, "done", `${ids.length} links pinned`);
      return reply({ done: true, pinned: r?.pinned ?? ids.length });
    }

    // link
    const wanted = args.models.map((m) => m.trim()).filter(Boolean);
    if (!wanted.length) return reply({ refused: true, reasons: ["Choose the models to link"] }, true);
    const reasons = wanted.flatMap((m) => linkProblems(m, model)).concat(wanted.filter((m) => !fs.existsSync(m)).map((m) => `${m}: not found`));
    if (reasons.length) return reply({ refused: true, reasons }, true);
    const linkedNames = new Set(links.map((l) => win.basename(l.path || l.name).toLowerCase()));
    const items = wanted.map((m) => ({ path: m, name: win.basename(m), workset: `Z_Links_${roleOf(m) || "<Role>"}`, already: linkedNames.has(win.basename(m).toLowerCase()) }));
    const todo = items.filter((i) => !i.already);
    if (dry) return reply({ dry_run: true, would: items.map((i) => ({ ...i, result: i.already ? "already linked" : "would link by shared coordinates" + (args.pin ? " and pin" : "") })),
      positioning: "Auto – By Shared Coordinates", next: "Run again with dry_run=false" });
    if (!todo.length) return reply({ done: true, nothing: true, message: "Already linked" });
    const r = await withRevitConnection((c) => c.sendCommand("fmc_link_add", { models: todo.map((t) => ({ path: t.path, workset: t.workset })), pin: args.pin }, 300000));
    const results = (r?.models ?? []) as Array<{ name: string; result: string }>;
    log(config, "links_add", false, model, "done", results.map((x) => `${x.name}: ${x.result}`).join("; "));
    return reply({ done: true, models: results });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "links_" + args.action, dry, "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcLinksTool(server: McpServer) {
  server.tool("fmc_links", FMC_LINKS_DESCRIPTION, FMC_LINKS_SHAPE, (args) => runFmcLinks(args));
}
