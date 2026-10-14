import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { IssueException, IssueInput, IssueSheet, Revision, manifest, readiness, readinessReport, registerCsv, transmittal } from "../fmc/issue.js";
import { QaFacts, neededParameters, runQa } from "../fmc/rules.js";
import { parseRegister, planned } from "../fmc/sheets.js";
import { readRulebooks } from "./fmc_qa.js";
import { DEFAULT_FIELDS, csvRow, readRegisterFile } from "./fmc_sheets.js";

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

const EXCEPTION_HEADER = ["recorded", "sheet", "item", "why", "approved_by", "until"];

/** Exceptions live with the project (01_WIP\_Issue), so the whole team sees them; without a project, in the reports folder. */
export function exceptionsFile(cfg: GuardConfig, projectFolder: string): string {
  const inProject = projectFolder ? win.join(projectFolder, "01_WIP", "_Issue", "FMC_Issue_Exceptions.csv") : "";
  return inProject && checkWritePath(inProject, cfg, { checkName: false }).ok ? inProject : win.join(expandEnv(cfg.reports_dir), "FMC_Issue_Exceptions.csv");
}

export function readExceptions(file: string): IssueException[] {
  if (!fs.existsSync(file)) return [];
  const rows = fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).map(csvRow);
  return rows.slice(1).map((r) => ({ recorded: r[0] ?? "", sheet: r[1] ?? "", item: r[2] ?? "", why: r[3] ?? "", approved_by: r[4] ?? "", until: r[5] ?? "" }))
    .filter((e) => e.sheet && e.item);
}

export const FMC_ISSUE_DESCRIPTION =
  "Formcraft Ready to issue. check (read-only) checks every sheet the register plans for an issue set and disciplines: " +
    "number, title block fields, approval, sheet status code, the Must rules (shared_to_published gate), links, and the " +
    "codes kept apart (company revision P01/C01/A01, Revit revision, status, purpose). Result: Ready, Ready with exceptions " +
    "or Blocked. except records an approved exception (sheet, item, why, approved by, until). report saves the readiness " +
    "report. issue writes PDFs per sheet named by container name, the drawing register (CSV), a transmittal and the report " +
    "into <project>\\01_WIP\\_Issue\\<date>_<revision>; it is a dry run unless dry_run is false and is refused when Blocked. " +
    "A person moves the issue to 03_Published after authorisation; the plugin never writes there.";

export const FMC_ISSUE_SHAPE = {
  action: z.enum(["check", "except", "report", "issue"]),
  register: z.string().optional().describe("Absolute path of the project's sheet register (.xlsx or .csv)"),
  project_folder: z.string().optional().default(""),
  project_code: z.string().optional().default("PROJ"),
  originator: z.string().optional().default("FMC"),
  issue_set: z.string().optional().default("CONSTRUCTION"),
  disciplines: z.array(z.string()).optional().default([]),
  purpose: z.string().optional().default("For construction"),
  company_revision: z.string().optional().default(""),
  fields: z.array(z.string()).optional().describe("Title block fields an issued sheet fills (default Drawn By, Checked By, Sheet Issue Date)"),
  approval_field: z.string().optional().default("Approved By"),
  status_field: z.string().optional().default("FMC_Sheet_Status"),
  exception: z.object({ sheet: z.string(), item: z.string(), why: z.string(), approved_by: z.string(), until: z.string().optional().default("") }).optional()
    .describe("except: the item is what the check names (title block, approval, status, missing, number, rule <id>) or * for the whole sheet"),
  send_to: z.string().optional().default(""),
  outputs: z.object({ pdf: z.boolean().default(true), register: z.boolean().default(true), transmittal: z.boolean().default(true) }).optional(),
  dry_run: z.boolean().optional().default(true),
};

export type FmcIssueArgs = z.infer<z.ZodObject<typeof FMC_ISSUE_SHAPE>>;

async function check(args: FmcIssueArgs, cfg: GuardConfig) {
  if (!args.register || !fs.existsSync(args.register)) return { refused: [`Sheet register not found: ${args.register ?? "(none)"}`] };
  const reg = parseRegister(readRegisterFile(args.register));
  if (!reg.sheets.length) return { refused: reg.problems.length ? reg.problems : ["The register lists no sheets"] };
  const plan = planned(reg.sheets, args.issue_set, args.disciplines);
  const input: IssueInput = {
    issue_set: args.issue_set.toUpperCase(), purpose: args.purpose, company_revision: args.company_revision.trim().toUpperCase(),
    fields: args.fields?.length ? args.fields : DEFAULT_FIELDS.filter((f) => f !== args.approval_field && f !== args.status_field),
    approval_field: args.approval_field, status_field: args.status_field, today: new Date().toISOString().slice(0, 10),
  };
  const books = readRulebooks(cfg.rulebooks_dir);
  const need = neededParameters(books.rules);
  need.sheet = [...new Set([...need.sheet, ...input.fields, input.approval_field, input.status_field])];
  const facts = (await withRevitConnection((c) => c.sendRaw("fmc_qa_facts", need, 300000))) as QaFacts;
  const issueFacts = await withRevitConnection((c) => c.sendRaw("fmc_issue_facts", {}, 60000));
  const current = new Map<number, string>(((issueFacts?.sheets ?? []) as Array<{ id: number; current_revision: string }>).map((s) => [s.id, s.current_revision]));
  const model: IssueSheet[] = facts.sheets.map((s) => ({ id: s.id, number: s.number, name: s.name, views: 0, fields: s.parameters, current_revision: current.get(s.id) ?? "" }));
  const qa = runQa(books, facts, "shared_to_published", input.today);
  const exFile = exceptionsFile(cfg, args.project_folder);
  const r = readiness(input, plan, model, qa.results, facts.links, (issueFacts?.revisions ?? []) as Revision[], readExceptions(exFile));
  const rulebooks = books.books.map((b) => `${b.name} v${b.version}`).join(", ") || "no rulebooks";
  return { input, plan, model, readiness: r, facts, rulebooks, exceptions_file: exFile, problems: [...reg.problems, ...books.problems] };
}

export async function runFmcIssue(args: FmcIssueArgs) {
  const { config } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    if (args.action === "except") {
      const e = args.exception;
      if (!e || !e.sheet.trim() || !e.item.trim() || !e.why.trim() || !e.approved_by.trim())
        return reply({ refused: true, reasons: ["An exception needs the sheet, the item, why it can go out anyway, and who approved it"] }, true);
      const file = exceptionsFile(config, args.project_folder);
      fs.mkdirSync(win.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(EXCEPTION_HEADER));
      fs.appendFileSync(file, csvLine([new Date().toISOString(), e.sheet.trim().toUpperCase(), e.item.trim(), e.why.trim(), e.approved_by.trim(), e.until.trim()]));
      log(config, "issue_exception", false, file, "done", `${e.sheet} ${e.item} · ${e.approved_by}`);
      return reply({ recorded: true, file, next: "Run check again: the result is recalculated" });
    }

    const c = await check(args, config);
    if ("refused" in c) return reply({ refused: true, reasons: c.refused }, true);
    const r = c.readiness;
    const code = args.project_code.trim().toUpperCase() || "PROJ";
    const revision = c.input.company_revision || "REV";

    if (args.action === "check")
      return reply({ model: c.facts.model, issue_set: c.input.issue_set, purpose: c.input.purpose, company_revision: c.input.company_revision,
        checked_against: c.rulebooks, exceptions_file: c.exceptions_file, ...r, problems: c.problems });

    const report = readinessReport(code, c.input, r, c.rulebooks, new Date());
    if (args.action === "report") {
      const name = `${code}_Readiness_${revision}_${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)}.md`;
      let file = args.project_folder ? win.join(args.project_folder, "06_QA", "Issue", name) : "";
      if (!file || !checkWritePath(file, config, { checkName: false }).ok) file = win.join(expandEnv(config.reports_dir), "Issue", name);
      fs.mkdirSync(win.dirname(file), { recursive: true });
      fs.writeFileSync(file, report);
      log(config, "issue_report", false, file, "done", `${r.result} · ${r.sheets.length} sheets`);
      return reply({ saved: file, result: r.result });
    }

    // issue
    if (r.result === "Blocked") return reply({ refused: true, reasons: ["Blocked: " + r.summary] }, true);
    if (!args.project_folder) return reply({ refused: true, reasons: ["The issue is written into the project's 01_WIP\\_Issue: set the project folder"] }, true);
    const folder = win.join(args.project_folder, "01_WIP", "_Issue", `${c.input.today}_${revision}`);
    const verdict = checkWritePath(win.join(folder, "x.pdf"), config, { checkName: false });
    if (!verdict.ok) return reply({ refused: true, reasons: verdict.reasons }, true);
    if (fs.existsSync(folder) && fs.readdirSync(folder).length) return reply({ refused: true, reasons: [`${folder} already holds an issue; nothing is overwritten`] }, true);
    const outputs = { pdf: args.outputs?.pdf ?? true, register: args.outputs?.register ?? true, transmittal: args.outputs?.transmittal ?? true };
    const files = manifest(code, args.originator.trim().toUpperCase() || "FMC", revision, r, outputs);
    if (dry) return reply({ dry_run: true, folder, result: r.result, files, next: "Run again with dry_run=false" });

    fs.mkdirSync(folder, { recursive: true });
    const pdfs = files.filter((f) => f.kind === "pdf");
    let exported: Array<{ file: string; result: string }> = [];
    if (pdfs.length) {
      const e = await withRevitConnection((x) => x.sendRaw("fmc_issue_export", { folder, sheets: pdfs.map((p) => ({ id: p.id, file: p.name.replace(/\.pdf$/i, "") })) }, 900000));
      exported = (e?.sheets ?? []) as Array<{ file: string; result: string }>;
    }
    const originator = args.originator.trim().toUpperCase() || "FMC";
    for (const f of files) {
      const target = win.join(folder, f.name);
      if (f.kind === "register") fs.writeFileSync(target, registerCsv(code, originator, c.input, r, c.model, csvLine));
      if (f.kind === "transmittal") fs.writeFileSync(target, transmittal(code, c.input, r, args.send_to, files));
      if (f.kind === "report") fs.writeFileSync(target, report);
    }
    const failed = exported.filter((x) => x.result !== "exported");
    log(config, "issue", false, folder, failed.length ? "partial" : "done", `${r.result} · ${pdfs.length - failed.length}/${pdfs.length} PDFs`);
    return reply({ done: true, folder, result: r.result, files: files.map((f) => f.name), pdfs: exported, failed: failed.length,
      next: "A person checks the folder and moves it to 03_Published after authorisation" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "issue_" + args.action, dry, args.register ?? "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcIssueTool(server: McpServer) {
  server.tool("fmc_issue", FMC_ISSUE_DESCRIPTION, FMC_ISSUE_SHAPE, (args) => runFmcIssue(args));
}
