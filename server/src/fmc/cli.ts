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
 *   fmc_file | fmc_family | fmc_project | fmc_template | fmc_library | fmc_qa | fmc_material | fmc_sheets | fmc_annotate | fmc_issue | fmc_links   run the tool with the same argument schema and defaults; prints the tool's JSON reply
 *   specs                   the families and the pilot set in FMC_Family_Specs.json, for the pane's family picker
 *   probe                   connects to Revit on port 8080 and reads the open documents (tests the whole chain)
 *   ask                     {question, history?}: asks Claude with the firm's API key; read-only Revit tools (fmc/ask.ts)
 *
 * Exit code 0: done. 1: refused or failed (the JSON says why). 2: bad usage.
 */
import fs from "node:fs";
import { z } from "zod";
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
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { askLogFile, readApiKey, runAsk } from "./ask.js";

type Reply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function print(body: unknown, failed: boolean): never {
  process.stdout.write(JSON.stringify(body, null, 2) + "\n");
  process.exit(failed ? 1 : 0);
}

function printReply(r: Reply): never {
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
    switch (command) {
      case "fmc_file":
        return printReply(await runFmcFile(z.object(FMC_FILE_SHAPE).parse(await readStdin())));
      case "fmc_family":
        return printReply(await runFmcFamily(z.object(FMC_FAMILY_SHAPE).parse(await readStdin())));
      case "fmc_project":
        return printReply(await runFmcProject(z.object(FMC_PROJECT_SHAPE).parse(await readStdin())));
      case "fmc_template":
        return printReply(await runFmcTemplate(z.object(FMC_TEMPLATE_SHAPE).parse(await readStdin())));
      case "fmc_library":
        return printReply(await runFmcLibrary(z.object(FMC_LIBRARY_SHAPE).parse(await readStdin())));
      case "fmc_qa":
        return printReply(await runFmcQa(z.object(FMC_QA_SHAPE).parse(await readStdin())));
      case "fmc_material":
        return printReply(await runFmcMaterial(z.object(FMC_MATERIAL_SHAPE).parse(await readStdin())));
      case "fmc_sheets":
        return printReply(await runFmcSheets(z.object(FMC_SHEETS_SHAPE).parse(await readStdin())));
      case "fmc_annotate":
        return printReply(await runFmcAnnotate(z.object(FMC_ANNOTATE_SHAPE).parse(await readStdin())));
      case "fmc_issue":
        return printReply(await runFmcIssue(z.object(FMC_ISSUE_SHAPE).parse(await readStdin())));
      case "fmc_links":
        return printReply(await runFmcLinks(z.object(FMC_LINKS_SHAPE).parse(await readStdin())));
      case "specs":
        return specs();
      case "probe":
        return await probe();
      case "ask": {
        const r = await runAsk(z.object({
          question: z.string(),
          history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })).optional(),
        }).parse(await readStdin()), {
          fetch, env: process.env, now: () => new Date(), apiKey: () => readApiKey(), logFile: askLogFile,
          revit: (command, params) => withRevitConnection((c) => command === "fmc_document_info"
            ? c.sendRaw(command, params, 15000) : c.sendCommand(command, params, 60000)),
        });
        return print(r.body, !r.ok);
      }
      default:
        process.stderr.write("Usage: node build/fmc/cli.js <fmc_file|fmc_family|fmc_project|fmc_template|fmc_library|fmc_qa|fmc_material|fmc_sheets|fmc_annotate|fmc_issue|fmc_links|specs|probe|ask>  (JSON arguments on stdin)\n");
        process.exit(2);
    }
  } catch (e) {
    const msg = e instanceof z.ZodError
      ? "Bad arguments: " + e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      : e instanceof Error ? e.message : String(e);
    print({ error: msg }, true);
  }
}

main();
