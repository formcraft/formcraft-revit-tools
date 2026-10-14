import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { AnnotationFacts, AnnotationStandard, checkAnnotation, parseStandard } from "../fmc/annotation.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, false, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function readStandard(cfg: GuardConfig): AnnotationStandard | null {
  try { return parseStandard(JSON.parse(fs.readFileSync(expandEnv(cfg.annotation_standard_file), "utf8").replace(/^﻿/, ""))); }
  catch { return null; }
}

export const FMC_ANNOTATE_DESCRIPTION =
  "Formcraft annotation against the kit's annotation standard (FMC_Annotation_Standard.json: pens, line patterns, text " +
    "types, dimension styles, tag naming, symbols, colours). standard returns the standard. check (read-only) lists the " +
    "model's text types, line patterns, dimension types and tag families outside the standard. missing_tags (read-only) " +
    "counts untagged doors, windows, rooms and electrical fixtures in the current view or the views on the current sheet. " +
    "request records a proposed change to the standard for the BIM Manager.";

export const FMC_ANNOTATE_SHAPE = {
  action: z.enum(["standard", "check", "missing_tags", "request"]),
  scope: z.enum(["current_view", "sheet_views"]).optional().default("current_view"),
  text: z.string().optional().describe("request: the proposed change and why"),
};

export type FmcAnnotateArgs = z.infer<z.ZodObject<typeof FMC_ANNOTATE_SHAPE>>;

export async function runFmcAnnotate(args: FmcAnnotateArgs) {
  const { config } = loadConfig();
  const standard = readStandard(config);
  const notReadable = `Annotation standard not readable at ${config.annotation_standard_file} (annotation_standard_file in fmc_guard.json)`;
  try {
    switch (args.action) {
      case "standard":
        if (!standard) return reply({ refused: true, reasons: [notReadable] }, true);
        return reply({ file: config.annotation_standard_file, ...standard });
      case "request": {
        if (!(args.text ?? "").trim()) return reply({ refused: true, reasons: ["request needs the proposed change"] }, true);
        const file = win.join(expandEnv(config.reports_dir), "FMC_Annotation_Requests.csv");
        fs.mkdirSync(win.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "change", "status"]));
        fs.appendFileSync(file, csvLine([new Date().toISOString(), args.text!.trim(), "requested"]));
        log(config, "annotation_request", file, "done", args.text!);
        return reply({ requested: true, file, next: "The BIM Manager approves changes into the standard" });
      }
      case "check": {
        const facts = (await withRevitConnection((c) => c.sendRaw("fmc_annotation_facts", {}, 120000))) as AnnotationFacts;
        const checks = checkAnnotation(facts, standard);
        log(config, "annotation_check", facts.model, "done", checks.map((c) => `${c.check}: ${c.found}`).join(" | "));
        return reply({ model: facts.model, checks, standard_problem: standard ? undefined : notReadable });
      }
      case "missing_tags": {
        const r = await withRevitConnection((c) => c.sendRaw("fmc_missing_tags", { scope: args.scope }, 120000));
        return reply(r);
      }
    }
    return reply({ refused: true, reasons: ["Unknown action"] }, true);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "annotation_" + args.action, "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcAnnotateTool(server: McpServer) {
  server.tool("fmc_annotate", FMC_ANNOTATE_DESCRIPTION, FMC_ANNOTATE_SHAPE, (args) => runFmcAnnotate(args));
}
