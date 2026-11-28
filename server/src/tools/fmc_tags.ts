import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import {
  MAX_VIEWS_DEFAULT,
  TAGS_FIX,
  auditTags,
  loadTagScaleRules,
  planTags,
  referenceProblems,
  writeTagsReport,
  type LoadedScaleRules,
  type TagCategory,
  type TagScope,
  type TagSnapshot,
} from "../fmc/tags.js";

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
  "Bulk: views takes many sheets and plans at once (numbers, names or ids). scope issued_sheets (default) keeps the issued-sheet rule; any_sheet takes every plan on a sheet; any_plan every floor plan. max_views caps one call (default 200). " +
  "Overlap: the tag box is the kit's paper size times the view scale; candidate shifts grow with the scale and keep off existing tags, other annotation, other elements, and inside the crop (FMC-TAGS-OVERLAP, FMC-TAGS-OUT-OF-CROP). " +
  "Scale: with no tag_types for a category, the kit's FMC_TagScale.json (03_Master_Data) picks the tag type by view scale; a kit type that is not loaded is FMC-TAGS-KIT-TYPE-MISSING, never a silent fallback. " +
  "mode tag (default) plans and, with dry_run false, applies. mode plan is a preview only: it never writes the model or a report. mode audit lists elements with no tag (FMC-TAGS-MISSING) and tags that show no text (FMC-TAGS-BLANK); it never writes the model. " +
  "Every element in scope has one row in items: planned, skipped with a code, or after a write placed or failed. " +
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
  mode: z.enum(["tag", "plan", "audit"]).optional().default("tag"),
  scope: z.enum(["issued_sheets", "any_sheet", "any_plan"]).optional().default("issued_sheets"),
  max_views: z.number().int().positive().max(1000).optional().default(MAX_VIEWS_DEFAULT),
  scale_rules_file: z.string().optional().default(""),
  avoid_elements: z.boolean().optional().default(true),
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
  /** Kit root for FMC_TagScale.json. Tests pass it; live calls read it from the guard config. */
  kitRoot?: string;
  /** Scale rules as text, for tests. */
  scaleRulesText?: string;
}

function kitRootOf(io: TagsIo): string {
  if (io.kitRoot != null) return io.kitRoot;
  try { return kitPaths(loadConfig(configPath(io.env ?? process.env)).config).root; } catch { return ""; }
}

function scaleRulesOf(args: FmcTagsArgs, io: TagsIo): LoadedScaleRules {
  return loadTagScaleRules({
    file: args.scale_rules_file,
    kitRoot: kitRootOf(io),
    env: io.env ?? process.env,
    ...(io.scaleRulesText != null ? { read: () => io.scaleRulesText as string } : {}),
  });
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
    const mode = args.mode ?? "tag";
    const scope = (args.scope ?? "issued_sheets") as TagScope;
    const readBody = { document: args.document.trim(), views: args.views, categories: args.categories, scope, audit: mode === "audit" };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_tags", readBody, 180000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return reply({ ...stamp(), refused: true, code: String(body.code ?? "FMC-TAGS"), message: String(body.message ?? "The read was refused.") }, true);
    const snapshot = body as TagSnapshot;
    const doc = { title: String(body.title ?? args.document), path: String(body.path ?? ""), is_central: body.is_central === true };
    if (mode === "audit") {
      const audit = auditTags(snapshot, { views: args.views, categories: args.categories, scope, max_views: args.max_views });
      const report = writeTagsReport(env, { document: doc.title, audit }, io.reportDir);
      return reply({
        ...stamp({ mode, scope, dry_run: true, read_only: true, document: doc.title }),
        views: audit.views,
        skipped: audit.skipped,
        missing: audit.missing,
        blank: audit.blank,
        tagged: audit.tagged,
        report,
        next: audit.missing || audit.blank
          ? "Nothing was changed. Missing tags can be planned with mode tag. A blank tag needs its parameter filled (Mark, Type Mark, Number or Name); a tool does not invent values."
          : "Nothing was changed. Every element in scope is tagged and every tag shows text.",
      });
    }
    let scaleRules: LoadedScaleRules;
    try { scaleRules = scaleRulesOf(args, io); } catch (error) { return failed(error); }
    const plan = planTags(snapshot, {
      views: args.views,
      categories: args.categories,
      tag_types: args.tag_types as Partial<Record<TagCategory, string>> | undefined,
      scope,
      max_views: args.max_views,
      scale_rules: scaleRules.rules,
      avoid_elements: args.avoid_elements,
    });
    const planOnly = mode === "plan";
    const report = planOnly ? "" : writeTagsReport(env, { document: doc.title, plan }, io.reportDir);
    const dry = planOnly || args.dry_run !== false;
    const tags = plan.views.map((view) => ({ view: view.view, view_id: view.view_id, tag_ids: [] as string[], placed: view.placed }));
    const summary = stamp({
      mode,
      scope,
      plan_only: planOnly,
      dry_run: dry,
      read_only: dry,
      document: doc.title,
      scale_rules: { source: scaleRules.source, path: scaleRules.path, provisional: scaleRules.provisional },
      views: plan.views.map((view) => ({ view: view.view, view_id: view.view_id, scale: view.scale, placed: view.placed, skipped: view.skipped, items: view.items, why_zero: view.why_zero })),
      tags,
      placed: plan.placed,
      items: plan.items,
      skipped: plan.skipped,
      why_zero: plan.why_zero,
      leaders: false,
      report,
    });
    if (planOnly) return reply({ ...summary, next: "Preview only. Nothing was tagged and no report was written. Run mode tag for a dry run, then dry_run false to apply." });
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
    const results = appliedItems(plan.views, applied);
    return reply({ ...summary, read_only: false, dry_run: false, tags: results.tags, results: results.items, applied_count: results.placed, failed_count: results.failed, unknown_count: results.unknown, applied });
  } catch (error) {
    return failed(error);
  }
}

/**
 * One row per planned tag after a write. The add-in answers per item (items: element, status, tag_id, code). An older
 * add-in that answers only tag_ids gives rows with status unknown: a tag id is never guessed from an element id.
 */
export function appliedItems(views: Array<{ view: string; view_id: string; placed: Array<{ element: string; link_id: string; category: string }> }>, applied: Record<string, unknown>) {
  const byView = Array.isArray(applied.views) ? applied.views as Array<Record<string, unknown>> : [];
  const items: Array<Record<string, unknown>> = [];
  let placed = 0;
  let failed = 0;
  let unknown = 0;
  const tags = views.map((view) => {
    const hit = byView.find((row) => String(row.view_id ?? "") === view.view_id);
    const ids = Array.isArray(hit?.tag_ids) ? (hit!.tag_ids as unknown[]).map(String) : [];
    const rows = Array.isArray(hit?.items) ? hit!.items as Array<Record<string, unknown>> : null;
    for (const want of view.placed) {
      const row = rows?.find((item) => String(item.element ?? "") === want.element && String(item.link_id ?? "") === (want.link_id ?? ""));
      if (row && row.status === "placed") {
        placed++;
        items.push({ view_id: view.view_id, element: want.element, link_id: want.link_id, category: want.category, status: "placed", tag_id: String(row.tag_id ?? "") });
      } else if (row) {
        failed++;
        items.push({ view_id: view.view_id, element: want.element, link_id: want.link_id, category: want.category, status: "failed", code: String(row.code ?? "FMC-TAGS-PLACE-FAILED"), reason: String(row.reason ?? "") });
      } else {
        unknown++;
        items.push({ view_id: view.view_id, element: want.element, link_id: want.link_id, category: want.category, status: "unknown", reason: hit ? "The add-in did not report this item. Check the view with see_view." : "The add-in did not report this view." });
      }
    }
    return { view: view.view, view_id: view.view_id, tag_ids: ids };
  });
  return { tags, items, placed, failed, unknown };
}

export function registerFmcTagsTool(server: McpServer) {
  server.tool("fmc_tags", FMC_TAGS_DESCRIPTION, FMC_TAGS_SHAPE, async (args) => runFmcTags(args as FmcTagsArgs));
}
