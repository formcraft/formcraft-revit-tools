/**
 * fmc_permit_check (Phase A). A read-only pre-check of a Revit model against the Uganda building permit rules held in
 * the standards bank (NBRB / Building Control Act and Regulations, National Building Code, planning guidelines).
 * A DRAFT for the responsible registered professional, never a determination. No transaction, nothing applied,
 * saved or synced; nothing is submitted anywhere. Thresholds come from the bank at run time; none is in this code.
 */
import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { bankPaths, fingerprint, loadBank, loadSources, type Reader } from "../fmc/permit/bank.js";
import { describeDefaults, permitDefaults } from "../fmc/permit/defaults.js";
import { derive } from "../fmc/permit/derive.js";
import { counts, evaluate } from "../fmc/permit/evaluate.js";
import { roomProblems, sheetFacts, structFacts, viewportFacts, type PermitFacts } from "../fmc/permit/facts.js";
import type { Ctx } from "../fmc/permit/finding.js";
import { renderReport, safeRunFile, writeRun, type PermitRun } from "../fmc/permit/report.js";
import { PERMIT_RULES } from "../fmc/permit/rules.js";

/** The read-only add-in commands this tool sends. Each is in READ_VIA_SEND_COMMAND (fmc/policy.ts); a test checks it. */
export const PERMIT_READ_COMMANDS = ["fmc_struct_facts", "fmc_sheets_layout", "fmc_model_check"] as const;

const SAFE = { read_only: true, transaction: false, applied: false, saved: false, synced: false } as const;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_PERMIT_CHECK_DESCRIPTION =
  "Formcraft permit pre-check (Uganda: Building Control Act and Regulations, National Building Code, planning guidelines). Read-only: no transaction, nothing applied, saved or synced, nothing submitted to BIMS. " +
  "A DRAFT for the responsible registered professional, not a determination of the Building Committee or NBRB. " +
  "action rules lists the rule table (no Revit). action check reads the model (fmc_struct_facts, fmc_sheets_layout, fmc_model_check) and reports each rule as FAIL, REVIEW, PASS (no exception found), NOT_CHECKED, NOT_APPLICABLE, ADVICE or INFO. " +
  "action report renders a saved run by its name. Every threshold comes from FMC_Standards_Building.json in standards_dir (default C:\\Users\\USER\\agent-tools\\standards\\kit, env FMC_PERMIT_STANDARDS_DIR); a missing key is NOT_CHECKED. " +
  "Pass document for check: a missing name is FMC-DOC-REQUIRED; the active document is never used. Optional: use (residential, commercial, public_assembly, education, healthcare ...), category (A/B/C you expect), ground_level, plot { area_m2, zone A-E or commercial }. " +
  "Runs and a markdown report go under %LOCALAPPDATA%\\Formcraft\\permit (env FMC_PERMIT_DIR). " +
  "Example: action check, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, use residential, plot { area_m2: 450, zone: \"B\" }.";

export const FMC_PERMIT_CHECK_SHAPE = {
  action: z.enum(["rules", "check", "report"]).optional().default("check"),
  document: z.string().optional().default("").describe("Title or full path of an open document. Required for check."),
  use: z.string().optional().describe("The building's use. Blank leaves category A open (REVIEW)."),
  category: z.enum(["A", "B", "C"]).optional().describe("The category you expect; a different derived category is REVIEW."),
  ground_level: z.string().optional().describe("Level name taken as ground. Default: the level at elevation 0, else the lowest."),
  plot: z.object({ area_m2: z.number().positive().optional(), zone: z.string().optional() }).optional(),
  standards_dir: z.string().optional().describe("Folder holding FMC_Standards_Building.json and FMC_Standards_Sources.json."),
  run: z.string().optional().describe("For action report: the run name (permit-...)."),
  sample_limit: z.number().int().min(1).max(500).optional().default(80),
};

export type FmcPermitCheckArgs = z.infer<z.ZodObject<typeof FMC_PERMIT_CHECK_SHAPE>>;

export interface PermitIo {
  /** Replaces the add-in read (tests). Called with the command name and body. */
  read?: (command: (typeof PERMIT_READ_COMMANDS)[number], body: Record<string, unknown>) => Promise<unknown>;
  readFile?: Reader;
  env?: NodeJS.ProcessEnv;
  reportDir?: string;
  now?: () => Date;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-PERMIT";
  return reply({ tool: "fmc_permit_check", ...SAFE, refused: true, code, message }, true);
}

function refusedBody(x: unknown): { code: string; message: string } | null {
  const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  if (r.refused || (typeof r.code === "string" && r.code.startsWith("FMC-"))) return { code: String(r.code || "FMC-PERMIT"), message: String(r.message || "The read was refused.") };
  return null;
}

async function liveRead(command: (typeof PERMIT_READ_COMMANDS)[number], body: Record<string, unknown>): Promise<unknown> {
  // Literal command names, so the live-model lock test (fmc/lock.test.ts) sees each one.
  switch (command) {
    case "fmc_struct_facts": return withRevitConnection((client) => client.sendCommand("fmc_struct_facts", body, 180000));
    case "fmc_sheets_layout": return withRevitConnection((client) => client.sendCommand("fmc_sheets_layout", body, 180000));
    case "fmc_model_check": return withRevitConnection((client) => client.sendCommand("fmc_model_check", body, 180000));
  }
}

const DATA_GAPS_FIXED = [
  "Kitchen: the small-dwelling allowance (under 74 m2, at least 10% of the dwelling and never under 4.6 m2) is only in the note of rooms.kitchen_min, not a bank value, so a kitchen under the minimum is REVIEW, not FAIL.",
  "Excavation: the 2 m figure in BCR reg 14 has no bank key; only the reg 32(2) trigger is checked.",
  "The project's FMC_Project_Standards.json override is not read in Phase A (kit bank only).",
  "Placed views are typed as site, layout or section/elevation from their names; Phase A has no view type.",
];

export async function runFmcPermitCheck(args: FmcPermitCheckArgs, io: PermitIo = {}) {
  const env = io.env ?? process.env;
  const defaults = permitDefaults(env, args.standards_dir);
  const reportDir = io.reportDir ?? defaults.reportDir;
  try {
    if (args.action === "rules") {
      return reply({ tool: "fmc_permit_check", action: "rules", ...SAFE, defaults: describeDefaults(defaults), rules: PERMIT_RULES });
    }
    if (args.action === "report") {
      const file = safeRunFile(reportDir, args.run ?? "");
      if (!file) return reply({ tool: "fmc_permit_check", ...SAFE, refused: true, code: "FMC-PERMIT-RUN", message: "run must be a run name (permit-...) from this tool's report folder." }, true);
      if (!fs.existsSync(file)) return reply({ tool: "fmc_permit_check", ...SAFE, refused: true, code: "FMC-PERMIT-RUN", message: `No saved run ${args.run}.` }, true);
      const run = JSON.parse(fs.readFileSync(file, "utf8")) as PermitRun;
      return reply({ tool: "fmc_permit_check", action: "report", ...SAFE, run: args.run, markdown: renderReport(run) });
    }

    if (!args.document.trim()) {
      return reply({ tool: "fmc_permit_check", ...SAFE, refused: true, code: "FMC-DOC-REQUIRED",
        message: "[FMC-DOC-REQUIRED] fmc_permit_check needs document: a title or a full path. Refusing to use the active document." }, true);
    }
    const paths = bankPaths(defaults.standardsDir, defaults.buildingFile, defaults.sourcesFile);
    const bank = loadBank(paths.building, io.readFile);
    const sources = loadSources(paths.sources, io.readFile);
    if (!bank.found) {
      return reply({ tool: "fmc_permit_check", ...SAFE, refused: true, code: "FMC-PERMIT-BANK",
        message: `The standards bank could not be read (${bank.error}). Set standards_dir or FMC_PERMIT_STANDARDS_DIR.`, file: paths.building }, true);
    }

    const read = io.read ?? liveRead;
    const notes: string[] = [];
    const struct = await read("fmc_struct_facts", { document: args.document });
    const refused = refusedBody(struct);
    if (refused) return reply({ tool: "fmc_permit_check", ...SAFE, refused: true, ...refused }, true);
    const s = struct as Record<string, unknown>;
    const docField = s.document ?? s.resolved_document ?? {};
    const resolved = (typeof docField === "string" ? { title: docField } : docField) as { title?: string; path?: string };

    const optional = async (label: string, command: (typeof PERMIT_READ_COMMANDS)[number], body: Record<string, unknown>) => {
      try {
        const r = await read(command, body);
        const no = refusedBody(r);
        if (no) { notes.push(`${label}: ${no.code} ${no.message}`); return null; }
        return r;
      } catch (e) { notes.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); return null; }
    };
    const park = await optional("sheets", "fmc_sheets_layout", { document: args.document, action: "park", sheets: [] });
    const sheets = park ? sheetFacts(park) : null;
    const first = sheets?.find((x) => x.number)?.number;
    const pack = first ? await optional("viewport scales", "fmc_sheets_layout", { document: args.document, action: "pack", sheet: first }) : null;
    const check = await optional("room check", "fmc_model_check", { document: args.document, checks: ["rooms"] });

    const facts: PermitFacts = {
      document: { title: resolved.title || args.document, path: resolved.path || "" },
      ...structFacts(struct), sheets, viewports: pack ? viewportFacts(pack) : null, room_problems: check ? roomProblems(check) : null, notes,
    };
    const derived = derive(facts, args.ground_level, defaults.boundaryToleranceMm);
    const ctx: Ctx = { bank, sources, defaults, missingKeys: new Set() };
    const evaluation = evaluate(ctx, facts, derived, { use: args.use, category: args.category, plot: args.plot });
    const tally = counts(evaluation.findings);
    const data_gaps = [...[...ctx.missingKeys].map((k) => `Bank key ${k} is missing; its rule is NOT_CHECKED.`), ...DATA_GAPS_FIXED];
    const run: PermitRun = {
      tool: "fmc_permit_check", version: 1, created: (io.now ? io.now() : new Date()).toISOString(), document: facts.document,
      ruleset: fingerprint(bank, sources), defaults: describeDefaults(defaults), derived, category: evaluation.category,
      counts: tally, findings: evaluation.findings, data_gaps, notes,
    };
    const files = writeRun(reportDir, run);
    const order = ["FAIL", "REVIEW", "NOT_CHECKED", "ADVICE", "PASS", "NOT_APPLICABLE", "INFO"];
    const sorted = [...evaluation.findings].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
    return reply({
      tool: "fmc_permit_check", action: "check", ...SAFE, draft: true,
      disclaimer: "DRAFT for the responsible registered professional. Not a determination of the Building Committee or NBRB. Nothing submitted to BIMS.",
      document: facts.document.title, resolved_document: facts.document,
      derived_category: evaluation.category.derived, derived, counts: tally,
      findings: sorted.slice(0, args.sample_limit), truncated: sorted.length > args.sample_limit,
      data_gaps, notes, defaults: run.defaults, ruleset: run.ruleset, report: files,
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcPermitCheckTool(server: McpServer) {
  server.tool("fmc_permit_check", FMC_PERMIT_CHECK_DESCRIPTION, FMC_PERMIT_CHECK_SHAPE, async (args) => runFmcPermitCheck(args as FmcPermitCheckArgs));
}
