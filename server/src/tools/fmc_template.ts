import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, isInside, loadConfig } from "../fmc/policy.js";
import { parseSharedParameters } from "../fmc/specs.js";
import { BrandPack, TemplateFacts, auditTemplate } from "../fmc/template.js";

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

export const FMC_TEMPLATE_DESCRIPTION =
  "Formcraft templates: audit reads a .rte (opened in the background if needed) and checks it against the kit: shared " +
    "parameters by GUID against FMC_SharedParameters.txt, view templates and filters, fonts against a brand pack, title " +
    "blocks, browser organisation, size, unused families and warnings (Must, Should, Advice). brand sets a brand pack's " +
    "fonts on the text and dimension types of a template in a staging folder; sizes never change. brand is a dry run " +
    "unless dry_run is false; show the user the dry run first.";

export const FMC_TEMPLATE_SHAPE = {
  action: z.enum(["audit", "brand"]),
  template_path: z.string().describe("Absolute path of the .rte"),
  brand: z.object({ name: z.string(), main_font: z.string(), title_font: z.string().optional() }).optional()
    .describe("The brand pack (from the kit): fonts for text and dimension types"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcTemplateArgs = z.infer<z.ZodObject<typeof FMC_TEMPLATE_SHAPE>>;

export async function runFmcTemplate(args: FmcTemplateArgs) {
  const { config, problem } = loadConfig();
  const target = args.template_path;
  const reasons: string[] = [];
  if (win.extname(target).toLowerCase() !== ".rte") reasons.push("A template is a .rte file");
  if (!fs.existsSync(target)) reasons.push(`Template not found: ${target}`);
  const dry = args.dry_run !== false;

  if (args.action === "audit") {
    const readable = [...config.template_roots, ...config.write_roots, ...config.library_roots];
    if (!readable.some((r) => isInside(target, r))) reasons.push(`Audits read templates in the template, library or write folders of fmc_guard.json`);
    if (reasons.length) return reply({ refused: true, reasons, config_problem: problem }, true);
    try {
      const facts = (await withRevitConnection((c) => c.sendRaw("fmc_template_audit", { template_path: target }, 300000))) as TemplateFacts;
      let kit = null;
      try { kit = parseSharedParameters(fs.readFileSync(expandEnv(config.shared_parameter_file), "utf8")); } catch { kit = null; }
      const lines = auditTemplate(facts, kit, (args.brand as BrandPack) ?? null);
      log(config, "template_audit", false, target, "done", lines.filter((l) => l.severity !== "Pass").map((l) => `${l.area}: ${l.status}`).join(" | "));
      return reply({ audited: target, title: facts.title, lines });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(config, "template_audit", false, target, "error", msg);
      return reply({ error: msg }, true);
    }
  }

  // brand: changes a template, so only in a write root (a staging folder), never a released one.
  if (!args.brand) reasons.push("brand needs the brand pack (name, main_font, title_font)");
  reasons.push(...checkWritePath(target, config, { checkName: false }).reasons);
  if (reasons.length) {
    log(config, "template_brand", dry, target, "refused", reasons.join(" | "));
    return reply({ refused: true, reasons, config_problem: problem }, true);
  }
  try {
    const r = await withRevitConnection((c) => c.sendRaw("fmc_template_brand",
      { template_path: target, main_font: args.brand!.main_font, title_font: args.brand!.title_font ?? args.brand!.main_font, dry_run: dry }, 300000));
    if (!dry) log(config, "template_brand", false, target, "done", `${(r?.changes ?? []).length} types · ${args.brand!.name}`);
    return reply(dry ? { dry_run: true, would_change: r?.changes ?? [], next: "Run again with dry_run=false" } : { done: true, changed: r?.changes ?? [], saved: r?.saved });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "template_brand", dry, target, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcTemplateTool(server: McpServer) {
  server.tool("fmc_template", FMC_TEMPLATE_DESCRIPTION, FMC_TEMPLATE_SHAPE, (args) => runFmcTemplate(args));
}
