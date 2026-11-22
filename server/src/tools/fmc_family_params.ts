import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import {
  isKitOriginal, loadSharedMap, planFamilyParam, referenceProblems, writeFamilyParamsReport,
} from "../fmc/familyparams.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_FAMILY_PARAMS_DESCRIPTION =
  "Formcraft family and titleblock parameters. Works on the family loaded in the project. The kit family file is never opened for edit and never saved. " +
  "list reads parameters on one loaded family, or the loaded titleblock names when family is omitted. " +
  "add adds a parameter (name, type, group, shared, instance or type). shared defaults to true and the definition is taken from the kit shared parameter file by name and GUID. " +
  "A name that is not in that file is FMC-PARAM-NOT-IN-KIT, a kit change. No shared definition is created. " +
  "label adds a label bound to that parameter with FamilyItemFactory.NewLabel, then LoadFamily back into the project with overwrite. " +
  "bind binds a kit shared parameter to project categories (instance or type). " +
  "dry_run defaults to true. A real change is fmc_family_params_apply, and needs batch_lease plus references.kit, references.standards and references.rulebook. " +
  "Pass document. A missing name is FMC-DOC-REQUIRED. The active document is not a guess. " +
  "HEBERT HOSTELS, a central model, a protected path, and a kit family file are refused. The project is not saved or synced. " +
  "Example: action add, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, family the loaded architecture titleblock name, name Status, type text, group identity, shared true, binding instance, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_FAMILY_PARAMS_SHAPE = {
  action: z.enum(["list", "add", "label", "bind"]),
  document: z.string().optional().default("").describe("Title or full path of the open project. The family must already be loaded in it."),
  family: z.string().optional().default("").describe("Loaded family or titleblock name. list may omit it and returns titleblock names."),
  name: z.string().optional().default("").describe("Parameter name. For a label, the parameter the label is bound to."),
  type: z.string().optional().default("").describe("text, number, integer, yesno, material, angle, area, volume or length. Checked against the kit file when shared."),
  group: z.string().optional().default("identity"),
  shared: z.boolean().optional().default(true),
  binding: z.enum(["instance", "type"]).optional().default("instance"),
  categories: z.array(z.string()).optional().default([]).describe("bind: built-in category names, for example OST_Sheets."),
  origin_mm: z.array(z.number()).optional().default([10, 10]).describe("label: origin in the family view, millimetres. The person can move it."),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
};

export type FmcFamilyParamsArgs = z.infer<z.ZodObject<typeof FMC_FAMILY_PARAMS_SHAPE>>;

export interface FamilyParamsIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
  kitFile?: string;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-FAMILY-PARAMS";
  return reply({ tool: "fmc_family_params", refused: true, code, message, saved: false, synced: false, kit_saved: false }, true);
}

function leaseOf(args: FmcFamilyParamsArgs): string {
  return args.batch_lease.trim() || (batchLease.getStore() ?? "");
}

function kitFileOf(io: FamilyParamsIo): string {
  if (io.kitFile != null) return io.kitFile;
  const env = io.env ?? process.env;
  const direct = (env.FMC_SHARED_PARAMETER_FILE ?? "").trim();
  if (direct) return direct;
  try {
    const loaded = io.guard ? { config: io.guard } : loadConfig(configPath(env));
    return kitPaths(loaded.config).sharedParams;
  } catch {
    return "";
  }
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_family_params",
    saved: false,
    synced: false,
    kit_saved: false,
    images: [] as [],
    cites: {
      kit: "FMC-BIM-MAN-001 FMC_SharedParameters.txt",
      standards: "FMC-BIM-STD-002",
      rulebook: "Edit the family loaded in the project. Do not save the kit family file.",
    },
    ...extra,
  };
}

function guardOf(doc: { title: string; path: string }, central: boolean | undefined, io: FamilyParamsIo): { reason: string | null; config: GuardConfig } {
  const env = io.env ?? process.env;
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
  const blob = `${doc.title} ${doc.path}`;
  let reason: string | null = null;
  if (/hebert hostels/i.test(blob)) reason = "HEBERT HOSTELS is not written by fmc_family_params.";
  else if (/[\\/]centrals[\\/]/i.test(doc.path)) reason = "A file under a Centrals folder is not written by fmc_family_params.";
  else if (central) reason = "A central model is not written by fmc_family_params.";
  else if (isKitOriginal(doc.path)) reason = "A kit family file is not edited. Open the project and name the loaded family.";
  else reason = saveBlocked({ title: doc.title, path: doc.path }, loaded.config);
  if (!reason && loaded.problem) reason = loaded.problem;
  return { reason, config: loaded.config };
}

async function readModel(args: FmcFamilyParamsArgs, io: FamilyParamsIo): Promise<Record<string, unknown>> {
  const body = { document: args.document, action: "list", family: args.family };
  if (io.read) return (await io.read(body)) as Record<string, unknown>;
  return await withRevitConnection((client) => client.sendCommand("fmc_family_params", body, 180000)) as Record<string, unknown>;
}

function namesOf(snapshot: Record<string, unknown>): string[] {
  const rows = snapshot.parameters;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => (row && typeof row === "object" ? String((row as { name?: string }).name ?? "") : "")).filter(Boolean);
}

export async function runFmcFamilyParams(args: FmcFamilyParamsArgs, io: FamilyParamsIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) {
      return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: "[FMC-DOC-REQUIRED] fmc_family_params needs document: a title or a full path. Refusing to use the active document." }, true);
    }
    const kitFile = kitFileOf(io);
    const dictionary = loadSharedMap(kitFile);
    const snapshot = await readModel(args, io);
    if (snapshot.refused || (typeof snapshot.code === "string" && snapshot.code)) {
      return reply({ ...stamp(), refused: true, code: snapshot.code || "FMC-FAMILY-PARAMS", message: snapshot.message || "The read was refused." }, true);
    }
    const resolved = (snapshot.resolved_document ?? {}) as { title?: string; path?: string };
    const doc = { title: String(resolved.title || snapshot.title || args.document), path: String(resolved.path || snapshot.path || "") };
    const familyPath = String(snapshot.family_path ?? "");
    if (args.action === "list") {
      const report = writeFamilyParamsReport(env, "list", snapshot, io.reportDir);
      return reply(stamp({
        action: "list",
        read_only: true,
        document: doc.title,
        resolved_document: doc,
        family: snapshot.family ?? args.family,
        family_path: familyPath,
        titleblocks: snapshot.titleblocks ?? [],
        parameters: snapshot.parameters ?? [],
        labels: snapshot.labels ?? [],
        label_note: "A label is counted when its visible text matches the parameter name. Revit 2025 does not publish the parameter a label is bound to.",
        report,
        kit_file: kitFile,
      }));
    }
    const planned = planFamilyParam({
      action: args.action,
      family: args.family,
      name: args.name,
      type: args.type,
      group: args.group,
      shared: args.shared,
      binding: args.binding,
      categories: args.categories,
      origin_mm: args.origin_mm,
      kitFile,
      dictionary,
      existing: namesOf(snapshot),
    });
    if (!planned.ok || !planned.plan) {
      return reply({ ...stamp(), refused: true, code: planned.code, message: planned.message, kit_file: kitFile }, true);
    }
    const guard = guardOf(doc, snapshot.is_central === true, io);
    const report = writeFamilyParamsReport(env, args.action, { document: doc, plan: planned.plan, note: planned.message }, io.reportDir);
    const body = stamp({
      action: args.action,
      dry_run: args.dry_run !== false,
      document: doc.title,
      resolved_document: doc,
      plan: planned.plan,
      message: planned.message,
      already: planned.code === "FMC-PARAM-EXISTS",
      report,
      edit: "EditFamily on the loaded family, then LoadFamily into the project with overwrite, then Close(false). The family file is not saved.",
    });
    if (guard.reason) return reply({ ...body, refused: true, code: "FMC-PARAM-GUARD", dry_run: true, read_only: true, message: guard.reason }, true);
    if (planned.code === "FMC-PARAM-EXISTS") {
      return reply({ ...body, read_only: true, dry_run: true, applied: false, message: planned.message });
    }
    if (args.dry_run !== false) {
      return reply({ ...body, read_only: true, next: "Show this plan. Apply with dry_run false, batch_lease, and references. That call is fmc_family_params_apply." });
    }
    if (!leaseOf(args)) {
      return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", dry_run: true, message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was changed." }, true);
    }
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-PARAM-REFERENCES", message: refsProblem }, true);
    const roots = [...(guard.config.protected_paths ?? []), ...protectedRoots(guard.config)];
    const applyBody = {
      document: args.document,
      ...planned.plan,
      references: args.references ?? {},
      protected_roots: roots,
      _protected_roots: roots,
      shared_parameter_file: kitFile,
    };
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_family_params_apply", applyBody, 300000)) as Record<string, unknown>;
    return reply({ ...body, read_only: false, dry_run: false, applied, kit_saved: applied.kit_saved === true, saved: false, synced: false });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcFamilyParamsTool(server: McpServer) {
  server.tool("fmc_family_params", FMC_FAMILY_PARAMS_DESCRIPTION, FMC_FAMILY_PARAMS_SHAPE, async (args) => runFmcFamilyParams(args as FmcFamilyParamsArgs));
}
