import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import { TAGS_FIX, planTags, referenceProblems, writeTagsReport, type TagCategory, type TagSnapshot } from "../fmc/tags.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_TAGS_DESCRIPTION =
  "Tag every untagged door, window and room on floor plans placed on issued sheets. No leaders. " +
  "views is all_sheets or a list of sheet numbers, sheet names or plan names. categories defaults to Doors, Windows and Rooms. " +
  "tag_types names a loaded type per category. Empty, or first, uses the first loaded tag type of that category. " +
  "Already tagged elements are skipped (IndependentTag and RoomTag in the view, including a link id). " +
  "A host-only collector returns 0 when the doors are in a link: those are tagged with CreateLinkReference, and rooms with NewRoomTag(LinkElementId). " +
  "Model elements are not filtered by OwnerViewId. A view that is not a floor plan is FMC-TAGS-NOT-PLAN. " +
  "Candidate offsets keep a new tag off existing tag boxes. " +
  "dry_run defaults to true and returns the point and the tag id that would be created, per view. " +
  "A write is fmc_tags_apply, one transaction, one subtransaction per tag, and needs batch_lease plus references.kit, references.standards and references.rulebook. " +
  "JSON under %LOCALAPPDATA%\\Formcraft\\tags. No pictures. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, views all_sheets, categories [\"Doors\",\"Windows\",\"Rooms\"], dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_TAGS_SHAPE = {
  document: z.string().optional().default(""),
  views: z.union([z.literal("all_sheets"), z.array(z.string()).min(1)]).optional().default("all_sheets"),
  categories: z.array(z.string()).optional().default(["Doors", "Windows", "Rooms"]),
  tag_types: z.object({
    Doors: z.string().optional(),
    Windows: z.string().optional(),
    Rooms: z.string().optional(),
  }).optional(),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
};

export type FmcTagsArgs = z.infer<z.ZodObject<typeof FMC_TAGS_SHAPE>>;

export interface TagsIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-TAGS";
  return reply({ tool: "fmc_tags", refused: true, code, message, saved: false, synced: false }, true);
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_tags",
    images: [] as [],
    saved: false,
    synced: false,
    cites: {
      kit: "FMC-BIM-MAN-001 annotation",
      standards: "FMC-BIM-STD-002 tags",
      rulebook: "Door, window and room tags go on issued floor plans. No leaders. Linked elements are tagged. Rooms use NewRoomTag.",
    },
    ...extra,
  };
}

export async function runFmcTags(args: FmcTagsArgs, io: TagsIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: TAGS_FIX["FMC-DOC-REQUIRED"] }, true);
    const readBody = { document: args.document.trim(), views: args.views, categories: args.categories };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_tags", readBody, 180000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return reply({ ...stamp(), refused: true, code: String(body.code ?? "FMC-TAGS"), message: String(body.message ?? "The read was refused.") }, true);
    const snapshot = body as TagSnapshot;
    const doc = { title: String(body.title ?? args.document), path: String(body.path ?? ""), is_central: body.is_central === true };
    const plan = planTags(snapshot, {
      views: args.views,
      categories: args.categories,
      tag_types: args.tag_types as Partial<Record<TagCategory, string>> | undefined,
    });
    const report = writeTagsReport(env, { document: doc.title, plan }, io.reportDir);
    const dry = args.dry_run !== false;
    const tags = plan.views.map((view) => ({ view: view.view, view_id: view.view_id, tag_ids: view.placed.map((row) => row.element), placed: view.placed }));
    const summary = stamp({
      dry_run: dry,
      read_only: dry,
      document: doc.title,
      views: plan.views.map((view) => ({ view: view.view, view_id: view.view_id, placed: view.placed, skipped: view.skipped, why_zero: view.why_zero })),
      tags,
      placed: plan.placed,
      skipped: plan.skipped,
      why_zero: plan.why_zero,
      leaders: false,
      report,
    });
    if (dry) return reply({ ...summary, next: "Nothing was tagged. Apply with dry_run false, batch_lease, and references. That call is fmc_tags_apply, one transaction." });
    const blob = `${doc.title} ${doc.path}`;
    if (/hebert hostels/i.test(blob) || doc.is_central) return reply({ ...stamp(), refused: true, code: "FMC-TAGS-GUARD", message: "HEBERT HOSTELS and a central model are not written by fmc_tags." }, true);
    const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
    const blocked = saveBlocked(doc, loaded.config) || loaded.problem;
    if (blocked) return reply({ ...stamp(), refused: true, code: "FMC-TAGS-GUARD", message: blocked }, true);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: TAGS_FIX["FMC-BATCH-LOCKED"] }, true);
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-TAGS-REFERENCES", message: refsProblem }, true);
    if (!plan.placed) return reply({ ...summary, refused: true, read_only: true }, true);
    const roots = [...(loaded.config.protected_paths ?? []), ...protectedRoots(loaded.config)];
    const applyBody = {
      document: args.document.trim(),
      views: plan.views.filter((view) => view.placed.length).map((view) => ({ view_id: view.view_id, view: view.view, placed: view.placed })),
      protected_roots: roots,
      _protected_roots: roots,
      references: args.references ?? {},
    };
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_tags_apply", applyBody, 180000)) as Record<string, unknown>;
    const byView = Array.isArray(applied.views) ? applied.views as Array<Record<string, unknown>> : [];
    const withIds = plan.views.map((view) => {
      const hit = byView.find((row) => String(row.view_id ?? "") === view.view_id);
      const ids = Array.isArray(hit?.tag_ids) ? hit.tag_ids.map(String) : view.placed.map((row) => row.element);
      return { view: view.view, view_id: view.view_id, tag_ids: ids };
    });
    return reply({ ...summary, read_only: false, dry_run: false, tags: withIds, applied });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcTagsTool(server: McpServer) {
  server.tool("fmc_tags", FMC_TAGS_DESCRIPTION, FMC_TAGS_SHAPE, async (args) => runFmcTags(args as FmcTagsArgs));
}
