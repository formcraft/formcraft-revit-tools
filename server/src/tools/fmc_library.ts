import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { FamilySpec, SpParam, SpecFile, parseSharedParameters } from "../fmc/specs.js";
import { DEFAULT_LIMIT, worstFamilies } from "../fmc/digest.js";
import {
  ScannedFamily, categoryTokens, checkFamily, decodeKeynoteFile, keynoteTableWarnings, nextKeynoteCode, parseKeynotes, searchKeynotes, standardName, summarise,
} from "../fmc/library.js";
import { kitRootFrom } from "../fmc/dynamo.js";
import { findScript, loadLibrary, resolveEntry, validateManifest, withResolved } from "../fmc/scriptlib.js";
import { prepareLibraryStep } from "../fmc/batchstep.js";
import { runFmcDynamo } from "./fmc_dynamo.js";
import { runFmcScriptRun } from "./fmc_script_run.js";
import { namedDocument } from "../fmc/scriptexec.js";
import { writeFileLog } from "../fmc/filelog.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  // F10: one shared writer (fmc/filelog.ts): adds the source column, reports a failed write
  writeFileLog(cfg, action, dryRun, target, result, detail);
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
  "Script library and families. list, validate and run are the script library in 05_Scripts/library (index.json plus a manifest per script). " +
  "list is read-only. validate checks the manifest, including references.kit, references.standards and references.rulebook. " +
  "run dispatches to fmc_dynamo or fmc_script_run. A manifest missing any of those references is refused. background true submits and returns a job id. " +
  "Families: scan (read-only, also on live models): every loadable family in the named document " +
    "project, checked for the naming rule, the required FMC parameters by GUID (from FMC_Family_Specs.json), keynotes " +
    "and type names; each gets a score and Compliant, Fixable or Needs a person. inspect: the same for an outside .rfa, " +
    "plus file size and imported CAD, and a proposed standard name. bring_in: saves an outside family to library " +
    "staging under its standard name with the kit's parameters and a keynote; a dry run unless dry_run is false. " +
    "parameters and keynotes search the kit's files; keynote_request records a new keynote for the BIM Manager.";

export const FMC_LIBRARY_SHAPE = {
  action: z.enum(["scan", "inspect", "bring_in", "parameters", "keynotes", "keynote_request", "list", "validate", "run"]),
  id: z.string().optional().describe("list is unused. validate and run: the script id in 05_Scripts/library/index.json"),
  background: z.boolean().optional().default(false).describe("run: submit a background job instead of waiting"),
  arguments: z.record(z.unknown()).optional().describe("run: arguments for the script. references are filled from the manifest when omitted."),
  revit_version: z.string().optional().describe("run apply: this Revit's version, checked against the manifest before apply"),
  workshared: z.boolean().optional().describe("run apply: whether the document is workshared"),
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

function callInputs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const raw = { ...(args ?? {}) };
  if (raw.inputs && typeof raw.inputs === "object" && !Array.isArray(raw.inputs)) return raw.inputs as Record<string, unknown>;
  delete raw.references;
  delete raw.dry_run;
  delete raw.mode;
  delete raw.background;
  return raw;
}

async function runScriptLibrary(args: FmcLibraryArgs) {
  const { config } = loadConfig();
  const kit = kitRootFrom(config, process.env, "");
  if (args.action === "list") {
    const loaded = loadLibrary(kit);
    return reply({
      folder: loaded.folder, index: loaded.index, problems: loaded.problems,
      scripts: loaded.entries.map((entry) => ({
        id: entry.id, manifest: entry.manifest_path, runner: entry.manifest?.runner,
        revit_version: entry.manifest?.revit_version, writes_model: entry.manifest?.writes_model,
        workshared_safe: entry.manifest?.workshared_safe, est_ai_calls_saved: entry.manifest?.est_ai_calls_saved,
        problems: entry.problems.length ? entry.problems : undefined,
      })),
      resolved_document: null,
    }, loaded.problems.length > 0 && loaded.entries.length === 0);
  }
  const id = (args.id ?? "").trim();
  if (!id) return reply({ refused: true, message: `${args.action} needs id.`, resolved_document: null }, true);
  const found = findScript(kit, id);
  if (!found) return reply({ refused: true, code: "FMC-SCRIPT-NOT-FOUND", message: `No library script ${id}.`, resolved_document: null }, true);
  if (args.action === "validate") {
    const fresh = found.manifest ? validateManifest(found.manifest) : { ok: false as const, problems: found.problems };
    return reply({ id, ok: fresh.ok && found.problems.length === 0, problems: fresh.ok ? found.problems : fresh.problems, manifest: found.manifest, resolved_document: null }, !fresh.ok || found.problems.length > 0);
  }
  if (!found.manifest || found.problems.length) return reply({ refused: true, id, problems: found.problems, resolved_document: null }, true);
  const prepared = prepareLibraryStep(
    { tool: "library", id, arguments: args.arguments, background: args.background },
    found.manifest,
    {
      previewOnly: args.dry_run !== false && args.arguments?.mode !== "apply",
      revitVersion: args.revit_version,
      document: { title: namedDocument(), path: namedDocument(), workshared: args.workshared },
    },
  );
  if (prepared.problems.length) return reply(withResolved({ refused: true, id, problems: prepared.problems }, null), true);
  const mode = prepared.mode;
  const inputs = callInputs(prepared.arguments);
  if (found.manifest.runner === "dynamo") {
    const entry = resolveEntry(kit, found.manifest_path, found.manifest.entry);
    if (!entry.ok) return reply(withResolved({ refused: true, code: "FMC-SCRIPT-ROOT", message: entry.message }, null), true);
    return runFmcDynamo({
      action: prepared.background ? "submit" : "run",
      path: entry.file,
      inputs, mode, dry_run: prepared.dry_run, job_id: "", state: "", priority: 0, label: id, kit_folder: kit,
    });
  }
  return runFmcScriptRun({
    action: prepared.background ? "submit" : "run",
    id, inputs, mode, dry_run: prepared.dry_run, job_id: "", state: "", priority: 0, label: id, kit_folder: kit,
  });
}

export async function runFmcLibrary(args: FmcLibraryArgs) {
  if (args.action === "list" || args.action === "validate" || args.action === "run") return runScriptLibrary(args);
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
        let warnings: string[] = [];
        try {
          const text = decodeKeynoteFile(fs.readFileSync(expandEnv(config.keynote_file)));
          all = parseKeynotes(text);
          warnings = keynoteTableWarnings(text);
        }
        catch { return reply({ refused: true, reasons: [`Keynote file not readable at ${config.keynote_file} (keynote_file in fmc_guard.json)`] }, true); }
        const groups = [...new Set(all.filter((x) => !x.parent).map((x) => x.code))];
        return reply({ file: config.keynote_file, count: all.length, groups, keynotes: searchKeynotes(all, args.query ?? ""),
          ...(warnings.length ? { warnings } : {}),
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

    const facts = await withRevitConnection((c) => c.sendRaw("fmc_family_inspect", { path: source, document: source }, 300000));
    // F-039: each type's keynote from the saved file (the Keynote parameter, or the kit's keynote code parameter)
    const typeKeynotes = new Map<string, Record<string, string>>(((facts.type_keynotes ?? []) as Array<{ name: string; values: Record<string, string> }>).map((t) => [t.name, t.values ?? {}]));
    const keynoteOf = (t: string) => {
      const v = typeKeynotes.get(t) ?? {};
      return (v["Keynote"] ?? "").trim() || (Object.entries(v).find(([n, x]) => n !== "Keynote" && /keynote/i.test(n) && x.trim())?.[1] ?? "").trim();
    };
    const scanned: ScannedFamily = {
      name: facts.name, category: facts.category, size_mb: facts.size_mb, imported_cad: facts.imported_cad, nested: facts.nested,
      types: (facts.types ?? []).map((t: string) => ({ name: t, keynote: keynoteOf(t) })),
      shared_guids: (facts.parameters ?? []).filter((p: any) => p.shared).map((p: any) => p.guid),
    };
    const verdict = checkFamily(scanned, k.specMap, k.kit, "Outside file");
    const keynoteCheck = verdict.checks.find((c) => c.check === "Keynote set");
    if (keynoteCheck?.applies === false) { /* F-045: title blocks and annotations carry no keynote */ }
    else if (keynoteCheck && !facts.type_keynotes) Object.assign(keynoteCheck, { state: "na", detail: "This add-in doesn't read type keynotes from the file: update the add-in" });
    else if (keynoteCheck && keynoteCheck.state === "pass") {
      const codes = [...new Set(scanned.types.map((t) => t.keynote))];
      keynoteCheck.detail = `${scanned.types.length} types: ${codes.slice(0, 3).join(", ")}${codes.length > 3 ? "…" : ""}`;
      const differ = [...typeKeynotes].filter(([, v]) => Object.entries(v).some(([n, x]) => n !== "Keynote" && /keynote_code/i.test(n) && x.trim() && (v["Keynote"] ?? "").trim() && x.trim() !== v["Keynote"].trim()));
      if (differ.length) keynoteCheck.detail += `; Keynote and the keynote code differ in ${differ.map(([t]) => t).join(", ")}`;
    }
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
      shared_parameters: (facts.parameters ?? []).filter((p: any) => p.shared).map((p: any) => ({ name: p.name, guid: p.guid })),
      type_keynotes: scanned.types.map((t) => ({ type: t.name, keynote: t.keynote })), already_open: facts.already_open ?? false,
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
