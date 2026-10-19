#!/usr/bin/env node
/**
 * Command-line entry for the Formcraft Browser pane in Revit.
 *
 * The pane must never disagree with Claude about what is allowed, so it does not carry its own copy of the rules:
 * it runs this file, which calls the very same tool code Claude calls (folder rules, names, dry run, the Revit call on
 * port 8080 and the FMC_MCP_FileLog.csv row).
 *
 *   node build/fmc/cli.js <command>        JSON arguments on stdin (none for specs and probe)
 *
 *   fmc_file | fmc_family | fmc_project | fmc_template | fmc_library | fmc_qa | fmc_material | fmc_sheets | fmc_annotate | fmc_issue | fmc_links | fmc_selftest | fmc_workshare | fmc_review | fmc_report | fmc_doc | fmc_revit | fmc_brief | fmc_scripts | fmc_systems | fmc_build | fmc_ai | fmc_recipe | fmc_robot | fmc_navis | fmc_rhino | fmc_casework | fmc_ceiling | fmc_legend | fmc_apps | fmc_flow | fmc_tree | fmc_room | fmc_schedules | fmc_changes | fmc_select | fmc_find | fmc_testrun | fmc_balance | fmc_tables | fmc_powerbi | fmc_calc | fmc_diagram   run the tool with the same argument schema and defaults; prints the tool's JSON reply
 *   specs                   the families and the pilot set in FMC_Family_Specs.json, for the pane's family picker
 *   probe                   connects to Revit on port 8080 and reads the open documents (tests the whole chain)
 *   ask                     {question, history?}: asks Claude with the firm's API key; read-only Revit tools (fmc/ask.ts)
 *
 * Every tool command (fmc_*) is recorded in the call ledger (fmc/ledger.ts) as started by FMC_STARTED_BY (the pane sets "pane",
 * a scheduled task "schedule"), else "cli".
 *
 * Exit code 0: done. 1: refused or failed (the JSON says why). 2: bad usage.
 */
import fs from "node:fs";
import { z } from "zod";
import { documentTarget, revitTarget } from "./target.js";
import { loadConfig } from "./policy.js";
import { SpecFile } from "./specs.js";
import { FMC_FILE_SHAPE, runFmcFile } from "../tools/fmc_file.js";
import { FMC_FAMILY_SHAPE, runFmcFamily } from "../tools/fmc_family.js";
import { FMC_PROJECT_SHAPE, runFmcProject } from "../tools/fmc_project.js";
import { FMC_TEMPLATE_SHAPE, runFmcTemplate } from "../tools/fmc_template.js";
import { FMC_LIBRARY_SHAPE, runFmcLibrary } from "../tools/fmc_library.js";
import { FMC_QA_SHAPE, runFmcQa } from "../tools/fmc_qa.js";
import { FMC_MATERIAL_SHAPE, runFmcMaterial } from "../tools/fmc_material.js";
import { FMC_SHEETS_SHAPE, runFmcSheets } from "../tools/fmc_sheets.js";
import { FMC_ANNOTATE_SHAPE, runFmcAnnotate } from "../tools/fmc_annotate.js";
import { FMC_ISSUE_SHAPE, runFmcIssue } from "../tools/fmc_issue.js";
import { FMC_LINKS_SHAPE, runFmcLinks } from "../tools/fmc_links.js";
import { FMC_SELFTEST_SHAPE, runFmcSelftest } from "../tools/fmc_selftest.js";
import { FMC_WORKSHARE_SHAPE, runFmcWorkshare } from "../tools/fmc_workshare.js";
import { FMC_REVIEW_SHAPE, runFmcReview } from "../tools/fmc_review.js";
import { FMC_REPORT_SHAPE, runFmcReport } from "../tools/fmc_report.js";
import { FMC_DOC_SHAPE, runFmcDoc } from "../tools/fmc_doc.js";
import { FMC_REVIT_SHAPE, runFmcRevit } from "../tools/fmc_revit.js";
import { FMC_BRIEF_SHAPE, runFmcBrief } from "../tools/fmc_brief.js";
import { FMC_SCRIPTS_SHAPE, runFmcScripts } from "../tools/fmc_scripts.js";
import { FMC_SYSTEMS_SHAPE, runFmcSystems } from "../tools/fmc_systems.js";
import { FMC_BUILD_SHAPE, runFmcBuild } from "../tools/fmc_build.js";
import { FMC_AI_SHAPE, paneAi, runFmcAi } from "../tools/fmc_ai.js";
import { FMC_RECIPE_SHAPE, paneRelease, runFmcRecipe } from "../tools/fmc_recipe.js";
import { FMC_ROBOT_SHAPE, runFmcRobot } from "../tools/fmc_robot.js";
import { FMC_NAVIS_SHAPE, runFmcNavis } from "../tools/fmc_navis.js";
import { FMC_RHINO_SHAPE, runFmcRhino } from "../tools/fmc_rhino.js";
import { FMC_LEGEND_SHAPE, runFmcLegend } from "../tools/fmc_legend.js";
import { FMC_APPS_SHAPE, runFmcApps } from "../tools/fmc_apps.js";
import { FMC_ROOM_SHAPE, runFmcRoom } from "../tools/fmc_room.js";
import { FMC_TREE_SHAPE, runFmcTree } from "../tools/fmc_tree.js";
import { FMC_SCHEDULES_SHAPE, runFmcSchedules } from "../tools/fmc_schedules.js";
import { FMC_CHANGES_SHAPE, runFmcChanges } from "../tools/fmc_changes.js";
import { FMC_FLOW_SHAPE, runFmcFlow } from "../tools/fmc_flow.js";
import { FMC_SELECT_SHAPE, runFmcSelect } from "../tools/fmc_select.js";
import { FMC_FIND_SHAPE, runFmcFind } from "../tools/fmc_find.js";
import { FMC_CASEWORK_SHAPE, runFmcCasework } from "../tools/fmc_casework.js";
import { FMC_CEILING_SHAPE, runFmcCeiling } from "../tools/fmc_ceiling.js";
import { FMC_DIAGRAM_SHAPE, runFmcDiagram } from "../tools/fmc_diagram.js";
import { FMC_TESTRUN_SHAPE, runFmcTestrun } from "../tools/fmc_testrun.js";
import { FMC_BALANCE_SHAPE, runFmcBalance } from "../tools/fmc_balance.js";
import { appendLedger, callLine, startedByFrom } from "./ledger.js";
import { FMC_TABLES_SHAPE, runFmcTables } from "../tools/fmc_tables.js";
import { FMC_POWERBI_SHAPE, runFmcPowerbi } from "../tools/fmc_powerbi.js";
import { FMC_CALC_SHAPE, runFmcCalc } from "../tools/fmc_calc.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { askLogFile, askStatus, readApiKey, runAsk } from "./ask.js";
import { annotateInvalidOp } from "./buildinfo.js";

type Reply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** F74: the command running now, recorded in the call ledger when it answers (never blocks or fails the command). */
let pending: { tool: string; args: Record<string, unknown>; t0: number; at: Date } | null = null;
function record(ok: boolean) {
  if (!pending) return;
  try {
    appendLedger("calls", callLine(pending.tool, pending.args, ok, Date.now() - pending.t0, startedByFrom(process.env, "cli"), pending.at,
      documentTarget.getStore()), process.env, pending.at);
  } catch { /* never block the work */ }
  pending = null;
}

function print(body: unknown, failed: boolean): never {
  record(!failed);
  process.stdout.write(JSON.stringify(body, null, 2) + "\n");
  process.exit(failed ? 1 : 0);
}

function printReply(r: Reply): never {
  record(!r.isError);
  process.stdout.write((r.content[0]?.text ?? "{}") + "\n");
  process.exit(r.isError ? 1 : 0);
}

async function readStdin(): Promise<unknown> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "").trim();
  return text ? JSON.parse(text) : {};
}

function specs() {
  const { config, problem } = loadConfig();
  let file: SpecFile;
  try {
    file = JSON.parse(fs.readFileSync(config.specs_path, "utf8").replace(/^﻿/, ""));
  } catch {
    print({ error: `Cannot read the family specs at ${config.specs_path}: run the kit build (py build_all.py)`, config_problem: problem }, true);
  }
  print({
    specs_path: config.specs_path,
    version: file.version,
    pilot_set: file.pilot_set ?? [],
    families: file.families.map((f) => ({
      family: f.family, role: f.role, priority: f.priority, category: f.category,
      connectors: (f.connectors ?? []).filter((c) => ["Electrical", "Piping", "Duct", "ELV"].includes(c.domain)).length,
      parameters: f.shared_parameters.length,
      open_item: f.open_item || undefined,
    })),
  }, false);
}

async function probe() {
  const started = Date.now();
  try {
    const info = await withRevitConnection((c) => c.sendRaw("fmc_document_info", {}, 15000));
    print({ ok: true, ms: Date.now() - started, ...info }, false);
  } catch (e) {
    print({ ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) }, true);
  }
}

async function main() {
  // Tool code reports progress on stderr; stdout carries only the JSON reply.
  console.log = (...a: unknown[]) => console.error(...a);
  const command = process.argv[2];
  try {
    // One read of the arguments; "revit" (a project name, pid or port) picks the Revit when two or more are open.
    const raw = (await readStdin()) as Record<string, unknown>;
    const { revit, ...input } = raw && typeof raw === "object" ? raw : {};
    revitTarget.enterWith(typeof revit === "string" ? revit : undefined);
    // "document" (a title or path) is the document every command goes to; tools that have their own keep it in input.
    const doc = (input as Record<string, unknown>).document;
    documentTarget.enterWith(typeof doc === "string" && doc.trim() ? doc.trim() : undefined);
    // the tools only: housekeeping (specs, probe, ask_status) and a person's own acts in the pane aren't automation
    if (/^fmc_[a-z_]+$/.test(command ?? "")) pending = { tool: command, args: input as Record<string, unknown>, t0: Date.now(), at: new Date() };
    switch (command) {
      case "fmc_file":
        return printReply(await runFmcFile(z.object(FMC_FILE_SHAPE).parse(input)));
      case "fmc_family":
        return printReply(await runFmcFamily(z.object(FMC_FAMILY_SHAPE).parse(input)));
      case "fmc_project":
        return printReply(await runFmcProject(z.object(FMC_PROJECT_SHAPE).parse(input)));
      case "fmc_template":
        return printReply(await runFmcTemplate(z.object(FMC_TEMPLATE_SHAPE).parse(input)));
      case "fmc_library":
        return printReply(await runFmcLibrary(z.object(FMC_LIBRARY_SHAPE).parse(input)));
      case "fmc_qa":
        return printReply(await runFmcQa(z.object(FMC_QA_SHAPE).parse(input)));
      case "fmc_material":
        return printReply(await runFmcMaterial(z.object(FMC_MATERIAL_SHAPE).parse(input)));
      case "fmc_sheets":
        return printReply(await runFmcSheets(z.object(FMC_SHEETS_SHAPE).parse(input)));
      case "fmc_annotate":
        return printReply(await runFmcAnnotate(z.object(FMC_ANNOTATE_SHAPE).parse(input)));
      case "fmc_issue":
        return printReply(await runFmcIssue(z.object(FMC_ISSUE_SHAPE).parse(input)));
      case "fmc_links":
        return printReply(await runFmcLinks(z.object(FMC_LINKS_SHAPE).parse(input)));
      case "fmc_selftest":
        return printReply(await runFmcSelftest(z.object(FMC_SELFTEST_SHAPE).parse(input)));
      case "fmc_workshare":
        return printReply(await runFmcWorkshare(z.object(FMC_WORKSHARE_SHAPE).parse(input)));
      case "fmc_review":
        return printReply(await runFmcReview(z.object(FMC_REVIEW_SHAPE).parse(input)));
      case "fmc_report":
        return printReply(await runFmcReport(z.object(FMC_REPORT_SHAPE).parse(input)));
      case "fmc_doc":
        return printReply(await runFmcDoc(z.object(FMC_DOC_SHAPE).parse(input)));
      case "fmc_revit":
        return printReply(await runFmcRevit(z.object(FMC_REVIT_SHAPE).parse(input)));
      case "fmc_brief":
        return printReply(await runFmcBrief(z.object(FMC_BRIEF_SHAPE).parse(input)));
      case "fmc_scripts":
        return printReply(await runFmcScripts(z.object(FMC_SCRIPTS_SHAPE).parse(input)));
      case "fmc_systems":
        return printReply(await runFmcSystems(z.object(FMC_SYSTEMS_SHAPE).parse(input)));
      case "fmc_build":
        return printReply(await runFmcBuild(z.object(FMC_BUILD_SHAPE).parse(input)));
      case "specs":
        return specs();
      case "probe":
        return await probe();
      case "ask": {
        const r = await runAsk(z.object({
          question: z.string(),
          history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).optional(),
        }).parse(input), {
          fetch, env: process.env, now: () => new Date(), apiKey: () => readApiKey(), logFile: askLogFile,
          revit: (command, params) => withRevitConnection((c) => command === "fmc_document_info"
            ? c.sendRaw(command, params, 15000) : c.sendCommand(command, params, 60000)),
        });
        return print(r.body, !r.ok);
      }
      case "fmc_ai":
        return printReply(await runFmcAi(z.object(FMC_AI_SHAPE).parse(input)));
      case "fmc_recipe":
        return printReply(await runFmcRecipe(z.object(FMC_RECIPE_SHAPE).parse(input)));
      case "fmc_robot":
        return printReply(await runFmcRobot(z.object(FMC_ROBOT_SHAPE).parse(input)));
      case "fmc_navis":
        return printReply(await runFmcNavis(z.object(FMC_NAVIS_SHAPE).parse(input)));
      case "fmc_rhino":
        return printReply(await runFmcRhino(z.object(FMC_RHINO_SHAPE).parse(input)));
      case "fmc_legend":
        return printReply(await runFmcLegend(z.object(FMC_LEGEND_SHAPE).parse(input)));
      case "fmc_apps":
        return printReply(await runFmcApps(z.object(FMC_APPS_SHAPE).parse(input)));
      case "fmc_flow":
        return printReply(await runFmcFlow(z.object(FMC_FLOW_SHAPE).parse(input)));
      case "fmc_schedules":
        return printReply(await runFmcSchedules(z.object(FMC_SCHEDULES_SHAPE).parse(input)));
      case "fmc_changes":
        return printReply(await runFmcChanges(z.object(FMC_CHANGES_SHAPE).parse(input)));
      case "fmc_select":
        return printReply(await runFmcSelect(z.object(FMC_SELECT_SHAPE).parse(input)));
      case "fmc_find":
        return printReply(await runFmcFind(z.object(FMC_FIND_SHAPE).parse(input)));
      case "fmc_tree":
        return printReply(await runFmcTree(z.object(FMC_TREE_SHAPE).parse(input)));
      case "fmc_room":
        return printReply(await runFmcRoom(z.object(FMC_ROOM_SHAPE).parse(input)));
      case "fmc_casework":
        return printReply(await runFmcCasework(z.object(FMC_CASEWORK_SHAPE).parse(input)));
      case "fmc_ceiling":
        return printReply(await runFmcCeiling(z.object(FMC_CEILING_SHAPE).parse(input)));
      // F75: unattended Revit tests (no AI); foreground runs until the run ends
      case "fmc_testrun":
        return printReply(await runFmcTestrun(z.object(FMC_TESTRUN_SHAPE).parse(input)));
      case "fmc_balance":
        return printReply(await runFmcBalance(z.object(FMC_BALANCE_SHAPE).parse(input)));
      case "fmc_tables":
        return printReply(await runFmcTables(z.object(FMC_TABLES_SHAPE).parse(input)));
      case "fmc_powerbi":
        return printReply(await runFmcPowerbi(z.object(FMC_POWERBI_SHAPE).parse(input)));
      case "fmc_calc":
        return printReply(await runFmcCalc(z.object(FMC_CALC_SHAPE).parse(input)));
      // LD5: line diagrams from the pane (Engineer › Systems › Diagrams: Scan, Plan, Generate, Gate D)
      case "fmc_diagram":
        return printReply(await runFmcDiagram(z.object(FMC_DIAGRAM_SHAPE).parse(input)));
      // A person releases a family, or sends it back, in the pane. Never MCP tools.
      case "family_release": case "family_sendback": {
        const r = paneRelease(command, input as Record<string, unknown>, process.env.USERNAME || "unknown");
        return print(r, "error" in r);
      }
      // The pane's AI commands: a person approves, rejects, resumes or sets the policy. Never MCP tools.
      case "ai_approve": case "ai_reject": case "ai_resume": case "ai_config": {
        const r = paneAi(command, input as Record<string, unknown>, process.env.USERNAME || "unknown");
        return print(r, "error" in r);
      }
      case "ask_status": {
        const file = askLogFile();
        let text = "";
        try { text = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch { text = ""; }
        return print(askStatus(text, new Date(), process.env, !!readApiKey()), false);
      }
      default:
        process.stderr.write("Usage: node build/fmc/cli.js <fmc_file|fmc_family|fmc_project|fmc_template|fmc_library|fmc_qa|fmc_material|fmc_sheets|fmc_annotate|fmc_issue|fmc_links|fmc_selftest|fmc_workshare|fmc_review|fmc_report|fmc_doc|fmc_revit|fmc_brief|fmc_scripts|fmc_systems|fmc_build|fmc_ai|fmc_recipe|fmc_robot|fmc_navis|fmc_rhino|fmc_casework|fmc_ceiling|fmc_legend|fmc_apps|fmc_flow|fmc_tree|fmc_room|fmc_schedules|specs|probe|ask|ask_status|fmc_changes|fmc_select|fmc_find|fmc_testrun|fmc_balance|fmc_tables|fmc_powerbi|fmc_calc|fmc_diagram>  (JSON arguments on stdin)\n");
        process.exit(2);
    }
  } catch (e) {
    const msg = e instanceof z.ZodError
      ? "Bad arguments: " + e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      : e instanceof Error ? e.message : String(e);
    // F-042: an invalid op names the build that refused it
    print({ error: annotateInvalidOp(msg) }, true);
  }
}

main();
