import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { FamilySpec, SpParam, SpecFile, parseSharedParameters } from "../fmc/specs.js";
import { DEFAULT_LIMIT, worstFamilies } from "../fmc/digest.js";
import {
  ScannedFamily, categoryTokens, checkFamily, nextKeynoteCode, parseKeynotes, searchKeynotes, standardName, summarise,
} from "../fmc/library.js";

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

function readKit(cfg: GuardConfig) {
  let specs: FamilySpec[] = [];
  let kit = new Map<string, SpParam>();
  const problems: string[] = [];
  try { specs = (JSON.parse(fs.readFileSync(expandEnv(cfg.specs_path), "utf8").replace(/^﻿/, "")) as SpecFile).families; }
  catch { problems.push(`Family specs not readable at ${cfg.specs_path}`); }
  try { kit = parseSharedParameters(fs.readFileSync(expandEnv(cfg.shared_parameter_file), "utf8")); }
  catch { problems.push(`Shared parameter file not readable at ${cfg.shared_parameter_file}`); }
  return { specs, specMap: new Map(specs.map((s) => [s.family, s])), kit, problems };
}

export const FMC_LIBRARY_DESCRIPTION =
  "Formcraft families against the kit. scan (read-only, also on live models): every loadable family in the active " +
    "project, checked for the naming rule, the required FMC parameters by GUID (from FMC_Family_Specs.json), keynotes " +
    "and type names; each gets a score and Compliant, Fixable or Needs a person. inspect: the same for an outside .rfa, " +
    "plus file size and imported CAD, and a proposed standard name. bring_in: saves an outside family to library " +
    "staging under its standard name with the kit's parameters and a keynote; a dry run unless dry_run is false. " +
    "parameters and keynotes search the kit's files; keynote_request records a new keynote for the BIM Manager.";

export const FMC_LIBRARY_SHAPE = {
  action: z.enum(["scan", "inspect", "bring_in", "parameters", "keynotes", "keynote_request"]),
  path: z.string().optional().describe("inspect, bring_in: the outside .rfa"),
  role: z.string().optional().describe("inspect, bring_in: role code for the standard name"),
  description: z.string().optional().describe("inspect, bring_in: plain words for the name, e.g. 'Socket MK'"),
  parameters: z.array(z.string()).optional().describe("bring_in: kit shared parameter names to add (default: the spec's)"),
  keynote: z.string().optional().describe("bring_in: keynote code for every type"),
  query: z.string().optional().describe("parameters, keynotes: search text"),
  group: z.string().optional().describe("keynote_request: keynote group, e.g. E.SOC"),
  text: z.string().optional().describe("keynote_request: the new keynote's description"),
  overwrite: z.boolean().optional().default(false),
  dry_run: z.boolean().optional().default(true),
  detail: z.enum(["summary", "full"]).optional().default("summary")
    .describe("scan: summary (default: counts and the worst families, each with what it fails) or full (every family and check)"),
  limit: z.number().int().min(1).max(500).optional().default(DEFAULT_LIMIT).describe("scan summary: how many of the worst families to list"),
};

export type FmcLibraryArgs = z.infer<z.ZodObject<typeof FMC_LIBRARY_SHAPE>>;

export async function runFmcLibrary(args: FmcLibraryArgs) {
  const { config, problem } = loadConfig();
  const k = readKit(config);
  try {
    switch (args.action) {
      case "scan": {
        const r = await withRevitConnection((c) => c.sendRaw("fmc_family_scan", {}, 300000));
        const verdicts = ((r?.families ?? []) as ScannedFamily[]).map((f) => checkFamily(f, k.specMap, k.kit));
        log(config, "family_scan", false, r?.document ?? "", "done", `${verdicts.length} families`);
        if (args.detail === "full") return reply({ document: r?.document, summary: summarise(verdicts), families: verdicts, kit_problems: k.problems });
        // F-009: a summary by default, so a scan fits an AI caller's context.
        return reply({ document: r?.document, summary: summarise(verdicts), worst: worstFamilies(verdicts, args.limit),
          more: Math.max(0, verdicts.filter((v) => v.state !== "Compliant").length - args.limit),
          next: "detail: \"full\" lists every family and check (large); the pane's Setup › Families shows them all", kit_problems: k.problems });
      }

      case "parameters": {
        const q = (args.query ?? "").toLowerCase();
        const list = [...k.kit.values()].filter((p) => !q || p.name.toLowerCase().includes(q) || p.group.toLowerCase().includes(q)).slice(0, 80);
        return reply({ file: config.shared_parameter_file, count: k.kit.size, parameters: list, kit_problems: k.problems });
      }

      case "keynotes": {
        let all: ReturnType<typeof parseKeynotes> = [];
        try { all = parseKeynotes(fs.readFileSync(expandEnv(config.keynote_file), "utf8")); }
        catch { return reply({ refused: true, reasons: [`Keynote file not readable at ${config.keynote_file} (keynote_file in fmc_guard.json)`] }, true); }
        const groups = [...new Set(all.filter((x) => !x.parent).map((x) => x.code))];
        return reply({ file: config.keynote_file, count: all.length, groups, keynotes: searchKeynotes(all, args.query ?? ""),
          next_code: args.group ? nextKeynoteCode(all, args.group) : undefined });
      }

      case "keynote_request": {
        if (!args.group || !(args.text ?? "").trim()) return reply({ refused: true, reasons: ["keynote_request needs group and text"] }, true);
        let all: ReturnType<typeof parseKeynotes> = [];
        try { all = parseKeynotes(fs.readFileSync(expandEnv(config.keynote_file), "utf8")); } catch { /* the code is still proposed */ }
        const code = nextKeynoteCode(all, args.group);
        const file = win.join(expandEnv(config.reports_dir), "FMC_Keynote_Requests.csv");
        fs.mkdirSync(win.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "code", "description", "parent", "status"]));
        fs.appendFileSync(file, csvLine([new Date().toISOString(), code, args.text!.trim(), args.group, "requested"]));
        log(config, "keynote_request", false, file, "done", `${code} ${args.text}`);
        return reply({ requested: code, file, next: "The BIM Manager approves it into the kit's keynote file" });
      }
    }

    // inspect and bring_in: an outside family
    const source = args.path ?? "";
    const reasons: string[] = [];
    if (win.extname(source).toLowerCase() !== ".rfa") reasons.push("Choose a family file (.rfa)");
    else if (!fs.existsSync(source)) reasons.push(`Not found: ${source}`);
    if (reasons.length) return reply({ refused: true, reasons }, true);

    const facts = await withRevitConnection((c) => c.sendRaw("fmc_family_inspect", { path: source }, 300000));
    const scanned: ScannedFamily = {
      name: facts.name, category: facts.category, size_mb: facts.size_mb, imported_cad: facts.imported_cad, nested: facts.nested,
      types: (facts.types ?? []).map((t: string) => ({ name: t, keynote: "" })),
      shared_guids: (facts.parameters ?? []).filter((p: any) => p.shared).map((p: any) => p.guid),
    };
    const verdict = checkFamily(scanned, k.specMap, k.kit, "Outside file");
    const tokens = categoryTokens(k.specs);
    const token = tokens.get(facts.category) ?? "";
    const role = (args.role ?? "").toUpperCase();
    const proposed = role && token && args.description ? standardName(role, token, args.description) : "";
    const spec = proposed ? k.specMap.get(proposed) : undefined;
    const wanted = (args.parameters?.length ? args.parameters : spec?.shared_parameters.map((p) => p.name) ?? [])
      .map((n) => k.kit.get(n)).filter((p): p is SpParam => !!p)
      .filter((p) => !scanned.shared_guids.some((g) => g.toLowerCase() === p.guid.toLowerCase()));
    const target = proposed ? win.join(config.family_staging_root, role, proposed + ".rfa") : "";
    const plan = {
      family: facts.name, category: facts.category, score: verdict.score, state: verdict.state, checks: verdict.checks,
      size_mb: facts.size_mb, imported_cad: facts.imported_cad, types: facts.types,
      proposed_name: proposed, save_path: target, add_parameters: wanted.map((p) => p.name), keynote: args.keynote ?? "",
      category_token: token,
    };
    if (args.action === "inspect") return reply({ inspected: source, plan, kit_problems: k.problems });

    if (!role) reasons.push("bring_in needs role");
    if (!token) reasons.push(`The kit has no category token for ${facts.category} (no spec of that category): a kit change request`);
    if (!args.description) reasons.push("bring_in needs a description for the name");
    if (target) {
      reasons.push(...checkWritePath(target, config).reasons);
      if (fs.existsSync(target) && !args.overwrite) reasons.push(`${target} exists; set overwrite=true to replace it`);
    }
    const dry = args.dry_run !== false;
    if (reasons.length) {
      log(config, "family_bring_in", dry, target || source, "refused", reasons.join(" | "));
      return reply({ refused: true, reasons, plan }, true);
    }
    if (dry) return reply({ dry_run: true, would_do: plan, next: "Run again with dry_run=false" });
    const r = await withRevitConnection((c) => c.sendRaw("fmc_family_bring_in", {
      path: source, save_path: target, keynote: args.keynote ?? "", overwrite: args.overwrite,
      shared_parameter_file: expandEnv(config.shared_parameter_file),
      parameters: wanted.map((p) => ({ name: p.name, guid: p.guid, instance: false })),
    }, 300000));
    log(config, "family_bring_in", false, target, "done", JSON.stringify(r));
    return reply({ done: true, result: r, next: "Release from staging to the library stays with the Family Librarian" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "family_" + args.action, args.dry_run !== false, args.path ?? "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcLibraryTool(server: McpServer) {
  server.tool("fmc_library", FMC_LIBRARY_DESCRIPTION, FMC_LIBRARY_SHAPE, (args) => runFmcLibrary(args));
}
