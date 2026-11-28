import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import {
  DETAIL_CAP, detailsFolder, isKitOriginal, loadCatalogue, planDetails, readBatchFile, referenceProblems,
  writeDetailsReport, type DetailRequest,
} from "../fmc/detailcat.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_DETAILS_DESCRIPTION =
  "Formcraft typical details from the kit. list reads the kit Details folder (.rvt and .rfa) and FMC_Details.json. " +
  "It does not invent a detail. A missing folder is FMC-DETAILS-CATALOGUE, a kit change. " +
  "place copies one detail, or a list, into the named project: a new drafting view, then CopyElements of detail components, lines, text and filled regions from the kit source, " +
  "or a detail-item family placed in that view. The source opens in the background and is closed without saving. The kit file is not edited. " +
  "view_name names the drafting view. sheet places the view when the sheet exists. " +
  "detail_ids or details or batch_file (a JSON file of detail ids) places more than one. A batch file runs without an AI composing each id. At most 50. " +
  "dry_run defaults to true. A real place is fmc_details_apply, one transaction, one subtransaction per detail, and needs batch_lease plus references.kit, references.standards and references.rulebook. " +
  "Pass document on place. A missing name is FMC-DOC-REQUIRED. The active document is not a guess. " +
  "HEBERT HOSTELS, a central model, a protected path, and a kit original are refused. The project is not saved or synced. " +
  "Example: action list. Example place: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, detail_id D-A-001, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

const detailRow = z.object({
  detail_id: z.string(),
  view_name: z.string().optional().default(""),
  sheet: z.string().optional().default(""),
});

export const FMC_DETAILS_SHAPE = {
  action: z.enum(["list", "place"]),
  document: z.string().optional().default("").describe("Title or full path of the open project. Required for place."),
  detail_id: z.string().optional().default(""),
  detail_ids: z.array(z.string()).optional().default([]),
  details: z.array(detailRow).optional().default([]),
  batch_file: z.string().optional().default("").describe("JSON file listing detail_ids or details. Used so a batch can run without an AI."),
  view_name: z.string().optional().default(""),
  sheet: z.string().optional().default(""),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
};

export type FmcDetailsArgs = z.infer<z.ZodObject<typeof FMC_DETAILS_SHAPE>>;

export interface DetailsIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
  catalogueFolder?: string;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-DETAILS";
  return reply({ tool: "fmc_details", refused: true, code, message, saved: false, synced: false, kit_saved: false }, true);
}

function leaseOf(args: FmcDetailsArgs): string {
  return args.batch_lease.trim() || (batchLease.getStore() ?? "");
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_details",
    saved: false,
    synced: false,
    kit_saved: false,
    images: [] as [],
    cites: {
      kit: "FMC-BIM-MAN-001 Details folder and FMC_Details.json",
      standards: "FMC-BIM-STD-002",
      rulebook: "Copy a kit detail into the project. Do not edit or save the kit original.",
    },
    ...extra,
  };
}

function requestsOf(args: FmcDetailsArgs): { requests: DetailRequest[]; error: string } {
  const requests: DetailRequest[] = [];
  if (args.detail_id.trim()) requests.push({ detail_id: args.detail_id.trim(), view_name: args.view_name, sheet: args.sheet });
  for (const id of args.detail_ids) if (id.trim()) requests.push({ detail_id: id.trim(), view_name: args.view_name, sheet: args.sheet });
  for (const row of args.details) requests.push({ detail_id: row.detail_id, view_name: row.view_name || args.view_name, sheet: row.sheet || args.sheet });
  if (args.batch_file.trim()) {
    try {
      const fromFile = readBatchFile(args.batch_file.trim());
      for (const row of fromFile) requests.push({ detail_id: row.detail_id, view_name: row.view_name || args.view_name, sheet: row.sheet || args.sheet });
    } catch (error) {
      return { requests: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { requests, error: "" };
}

function guardOf(doc: { title: string; path: string }, central: boolean | undefined, io: DetailsIo): { reason: string | null; config: GuardConfig } {
  const env = io.env ?? process.env;
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
  const blob = `${doc.title} ${doc.path}`;
  let reason: string | null = null;
  if (/hebert hostels/i.test(blob)) reason = "HEBERT HOSTELS is not written by fmc_details.";
  else if (/[\\/]centrals[\\/]/i.test(doc.path)) reason = "A file under a Centrals folder is not written by fmc_details.";
  else if (central) reason = "A central model is not written by fmc_details.";
  else if (isKitOriginal(doc.path)) reason = "A kit original is not written by fmc_details. Place the detail in the project.";
  else reason = saveBlocked(doc, loaded.config);
  if (!reason && loaded.problem) reason = loaded.problem;
  return { reason, config: loaded.config };
}

async function readModel(args: FmcDetailsArgs, io: DetailsIo): Promise<Record<string, unknown>> {
  const body = { document: args.document, action: "resolve" };
  if (io.read) return (await io.read(body)) as Record<string, unknown>;
  return await withRevitConnection((client) => client.sendCommand("fmc_details", body, 120000)) as Record<string, unknown>;
}

export async function runFmcDetails(args: FmcDetailsArgs, io: DetailsIo = {}) {
  const env = io.env ?? process.env;
  try {
    const folder = io.catalogueFolder ?? detailsFolder(env, io.guard);
    const catalogue = loadCatalogue(folder);
    if (args.action === "list") {
      const report = writeDetailsReport(env, "list", { folder: catalogue.folder, catalogue_file: catalogue.catalogue_file, details: catalogue.details, problems: catalogue.problems }, io.reportDir);
      return reply(stamp({
        action: "list",
        read_only: true,
        folder: catalogue.folder,
        catalogue_file: catalogue.catalogue_file,
        count: catalogue.details.length,
        details: catalogue.details.map((row) => ({
          id: row.id, name: row.name, kind: row.kind, source: row.source, view: row.view, sheet: row.sheet, type_name: row.type_name, from: row.from, exists: row.exists,
        })),
        problems: catalogue.problems,
        report,
      }));
    }
    if (!args.document.trim()) {
      return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: "[FMC-DOC-REQUIRED] fmc_details place needs document: a title or a full path. Refusing to use the active document." }, true);
    }
    const { requests, error } = requestsOf(args);
    if (error) return reply({ ...stamp(), refused: true, code: "FMC-DETAIL-BATCH", message: `[FMC-DETAIL-BATCH] ${error}` }, true);
    if (!requests.length) return reply({ ...stamp(), refused: true, code: "FMC-DETAIL-ID", message: "[FMC-DETAIL-ID] place needs detail_id, detail_ids, details, or batch_file." }, true);
    if (requests.length > DETAIL_CAP) {
      return reply({ ...stamp(), refused: true, code: "FMC-DETAIL-CAP", message: `[FMC-DETAIL-CAP] ${requests.length} details. One place call takes at most ${DETAIL_CAP}.` }, true);
    }
    const { ops, missing } = planDetails(catalogue, requests);
    if (missing.length) {
      return reply({ ...stamp(), refused: true, code: "FMC-DETAIL-NOT-FOUND", message: `[FMC-DETAIL-NOT-FOUND] Not in the kit catalogue: ${missing.join(", ")}.`, missing, folder: catalogue.folder }, true);
    }
    const absent = ops.filter((op) => !op.exists || !op.source);
    if (absent.length) {
      return reply({ ...stamp(), refused: true, code: "FMC-DETAIL-SOURCE", message: `[FMC-DETAIL-SOURCE] ${absent.map((op) => op.detail_id).join(", ")} has no source file.`, ops: absent }, true);
    }
    const snapshot = await readModel(args, io);
    if (snapshot.refused || snapshot.code) {
      return reply({ ...stamp(), refused: true, code: snapshot.code || "FMC-DETAILS", message: snapshot.message || "The document was not resolved." }, true);
    }
    const resolved = (snapshot.resolved_document ?? {}) as { title?: string; path?: string };
    const doc = { title: String(resolved.title || snapshot.title || args.document), path: String(resolved.path || snapshot.path || "") };
    const guard = guardOf(doc, snapshot.is_central === true, io);
    const report = writeDetailsReport(env, "place", { document: doc, ops, catalogue_problems: catalogue.problems }, io.reportDir);
    const body = stamp({
      action: "place",
      dry_run: args.dry_run !== false,
      document: doc.title,
      resolved_document: doc,
      count: ops.length,
      ops,
      catalogue_problems: catalogue.problems,
      report,
      source_note: "The kit source is opened in the background, copied, and closed without saving. OpenOptions has no read-only flag.",
    });
    if (guard.reason) {
      return reply({ ...body, refused: true, code: "FMC-DETAIL-GUARD", dry_run: true, read_only: true, message: guard.reason }, true);
    }
    if (args.dry_run !== false) {
      return reply({ ...body, read_only: true, next: "Show this plan. Apply with dry_run false, batch_lease, and references. That call is fmc_details_apply, one transaction." });
    }
    if (!leaseOf(args)) {
      return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", dry_run: true, message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was changed." }, true);
    }
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-DETAIL-REFERENCES", message: refsProblem }, true);
    const roots = [...(guard.config.protected_paths ?? []), ...protectedRoots(guard.config)];
    const applyBody = {
      document: args.document,
      ops,
      references: args.references ?? {},
      protected_roots: roots,
      _protected_roots: roots,
    };
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_details_apply", applyBody, 300000)) as Record<string, unknown>;
    return reply({ ...body, read_only: false, dry_run: false, applied, kit_saved: false, saved: false, synced: false });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcDetailsTool(server: McpServer) {
  server.tool("fmc_details", FMC_DETAILS_DESCRIPTION, FMC_DETAILS_SHAPE, async (args) => runFmcDetails(args as FmcDetailsArgs));
}
