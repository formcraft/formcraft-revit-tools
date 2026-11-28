import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import { RUNNING_BUILD } from "../fmc/buildinfo.js";
import { writeZip, type ZipSource } from "../fmc/zipwrite.js";
import {
  HANDOVER_FIX, checkOutputFolder, cleanMilestone, defaultOutputFolder, handoverStatus, loadHandoverSpec, manifestFor, planHandover,
  type HandoverRead,
} from "../fmc/handover.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_HANDOVER_DESCRIPTION =
  "Handover package for a milestone (NBRB and DITACO, Manual 15.5): one zip with parameters/elements.csv, parameters/project_info.csv, " +
  "reports/parameter_completeness.csv, any report_files you name, the saved model file when include_model is true, and manifest.json " +
  "(every file with its size and SHA-256, the counts, the gaps). COBie and IDS are not in it yet. " +
  "Read-only against the model: no transaction, nothing saved or synced. The only write is the zip, in output_folder " +
  "(default reports_dir\\Handover), which must be inside write_roots or reports_dir and never 02_Shared, 03_Published, 04_Archive, 05_Incoming or a protected original. " +
  "categories (OST_ names), parameters and required values come from the kit 03_Master_Data/FMC_Handover.json; without it the sample is used and the package is PROVISIONAL. " +
  "include_model copies the last saved .rvt; a workshared, cloud or unsaved model is refused (detach and save a handover copy in Revit first). " +
  "dry_run defaults to true and writes nothing; it returns plan_id. Write with dry_run false and that plan_id. " +
  "Status: PROVISIONAL (sample spec), GAPS (required values missing or the read was cut short) or READY; nothing is marked passed. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0001, milestone S4, dry_run true.";

export const FMC_HANDOVER_SHAPE = {
  document: z.string().optional().default(""),
  milestone: z.string().optional().default(""),
  output_folder: z.string().optional().default(""),
  categories: z.array(z.string()).optional(),
  parameters: z.array(z.string()).optional(),
  report_files: z.array(z.string()).optional(),
  include_model: z.boolean().optional().default(false),
  max_elements: z.number().int().min(1).max(200000).optional().default(20000),
  spec: z.string().optional().default(""),
  dry_run: z.boolean().optional().default(true),
  plan_id: z.string().optional().default(""),
};

export type FmcHandoverArgs = z.infer<z.ZodObject<typeof FMC_HANDOVER_SHAPE>>;

export interface HandoverIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  kitRoot?: string;
  specText?: string;
  now?: () => Date;
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_handover",
    images: [] as [],
    saved: false,
    synced: false,
    model_changed: false,
    cites: {
      kit: "03_Master_Data/FMC_Handover.json",
      standards: "FMC-BIM-MAN-001 Part 15.5 handover package",
      rulebook: "One zip with a manifest at each milestone; COBie and IDS later.",
    },
    ...extra,
  };
}

function refuse(code: string, message?: string, extra: Record<string, unknown> = {}) {
  return reply({ ...stamp(), refused: true, code, message: message ?? HANDOVER_FIX[code] ?? code, ...extra }, true);
}

function kitRootOf(io: HandoverIo): string {
  if (io.kitRoot != null) return io.kitRoot;
  try { return kitPaths(loadConfig(configPath(io.env ?? process.env)).config).root; } catch { return ""; }
}

export async function runFmcHandover(args: FmcHandoverArgs, io: HandoverIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) return refuse("FMC-DOC-REQUIRED");
    const milestone = cleanMilestone(args.milestone);
    if (!milestone) return refuse("FMC-HANDOVER-MILESTONE");
    let loaded;
    try {
      loaded = loadHandoverSpec({ file: args.spec, kitRoot: kitRootOf(io), env, ...(io.specText != null ? { read: () => io.specText as string } : {}) });
    } catch (error) {
      return refuse("FMC-HANDOVER-SPEC", error instanceof Error ? error.message : String(error));
    }
    const categories = args.categories?.length ? args.categories : (loaded.spec.categories ?? []);
    const parameters = args.parameters?.length ? args.parameters : (loaded.spec.parameters ?? []);
    const required = Object.values(loaded.spec.required ?? {}).flat();
    const readBody = { document: args.document.trim(), categories, parameters: [...new Set([...parameters, ...required])], max_elements: args.max_elements };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_handover_read", readBody, 300000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return refuse(String(body.code ?? "FMC-HANDOVER"), String(body.message ?? "The read was refused."));
    const read = { ...(body as unknown as HandoverRead), title: String(body.title ?? args.document), path: String(body.path ?? "") };
    const now = io.now ? io.now() : new Date();
    const plan = planHandover(read, loaded, { milestone, categories, parameters, report_files: args.report_files, include_model: args.include_model, now });
    const cfgLoaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
    const cfg = cfgLoaded.config;
    const folderRaw = args.output_folder.trim() || defaultOutputFolder(cfg, env);
    const folder = checkOutputFolder(folderRaw, cfg, [...(cfg.protected_paths ?? []), ...protectedRoots(cfg)], env);
    const status = handoverStatus(plan, loaded.provisional);
    const dry = args.dry_run !== false;
    const summary = stamp({
      dry_run: dry,
      read_only: true,
      document: read.title,
      milestone,
      status,
      can_pass: status === "READY",
      provisional: loaded.provisional,
      spec: loaded.path,
      spec_source: loaded.source,
      output_folder: folder.folder,
      output_folder_ok: folder.ok,
      ...(folder.ok ? {} : { output_folder_reasons: folder.reasons }),
      zip: path.win32.join(folder.folder, plan.zip_name),
      elements: plan.elements,
      counts: plan.counts,
      missing_required: plan.missing_required,
      completeness: plan.completeness.filter((r) => r.required || r.missing > 0).slice(0, 60),
      files: plan.files.map((f) => ({ name: f.name, kind: f.kind, bytes: f.bytes, ...(f.source ? { source: f.source } : {}) })),
      model: plan.model,
      warnings: plan.warnings,
      blockers: plan.blockers,
      later: { cobie: "later", ids: "later" },
      plan_id: plan.plan_id,
    });
    if (dry) {
      return reply({
        ...summary,
        next: plan.blockers.length || !folder.ok
          ? "Nothing was written. Fix the blockers (or the output folder) and run the dry run again."
          : `Nothing was written. To write the zip, call fmc_handover again with the same arguments, dry_run false and plan_id ${plan.plan_id}.`,
      });
    }
    if (cfgLoaded.problem) return refuse("FMC-HANDOVER-FOLDER", cfgLoaded.problem);
    if (!args.plan_id.trim()) return refuse("FMC-HANDOVER-PLAN-REQUIRED", undefined, { plan_id: plan.plan_id });
    if (args.plan_id.trim() !== plan.plan_id) return refuse("FMC-HANDOVER-PLAN", undefined, { plan_id: plan.plan_id });
    if (plan.blockers.length) return refuse(plan.blockers[0].code, plan.blockers[0].message, { blockers: plan.blockers });
    if (!folder.ok) return refuse("FMC-HANDOVER-FOLDER", `${HANDOVER_FIX["FMC-HANDOVER-FOLDER"]} ${folder.reasons.join("; ")}`);
    fs.mkdirSync(folder.folder, { recursive: true });
    const target = path.win32.join(folder.folder, plan.zip_name);
    // The files first; manifest.json goes last and lists each one with the size and SHA-256 the writer measured.
    const sources: ZipSource[] = plan.files.map((f) => f.data ? { name: f.name, data: f.data } : { name: f.name, file: f.source as string });
    const kinds = new Map(plan.files.map((f) => [f.name, f.kind]));
    let manifestEntries: Array<{ name: string; bytes: number; sha256: string; kind: string }> = [];
    const result = writeZipWithManifest(target, sources, now, (entries) => {
      manifestEntries = entries.map((e) => ({ name: e.name, bytes: e.bytes, sha256: e.sha256, kind: kinds.get(e.name) ?? "file" }));
      return manifestFor({ plan, read, loaded, status, build: RUNNING_BUILD.commit, now, entries: manifestEntries });
    });
    return reply({
      ...summary,
      dry_run: false,
      written: true,
      zip: target,
      zip_bytes: result.bytes,
      zip_sha256: result.sha256,
      files: manifestEntries,
      next: "The zip is written. The person checks it and marks the milestone; nothing is marked passed by the tool.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-HANDOVER";
    return reply({ tool: "fmc_handover", refused: true, code, message, saved: false, synced: false, model_changed: false }, true);
  }
}

/** Writes the entries, then manifest.json built from their real hashes, as the last entry of the same zip. */
function writeZipWithManifest(target: string, sources: ZipSource[], now: Date, manifest: (entries: Array<{ name: string; bytes: number; sha256: string }>) => Buffer) {
  return writeZip(target, sources, now, (entries) => [{ name: "manifest.json", data: manifest(entries) }]);
}

export function registerFmcHandoverTool(server: McpServer) {
  server.tool("fmc_handover", FMC_HANDOVER_DESCRIPTION, FMC_HANDOVER_SHAPE, async (args) => runFmcHandover(args as FmcHandoverArgs));
}
