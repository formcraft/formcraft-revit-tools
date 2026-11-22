/**
 * seed, create_view and place for fmc_legend. chain stays in the tool module.
 * Writes go through fmc_legend_apply, one transaction. Reads use fmc_legend_views.
 */
import path from "node:path";
import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "./context.js";
import { batchLease } from "./target.js";
import { saveBlocked } from "./savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "./policy.js";
import { protectedRoots } from "./opencopy.js";
import type { LabelMode } from "./legendmath.js";
import {
  LEGEND_FIX, buildPlace, legendReferenceProblems, seedVerdict, writeLegendReport,
  type LegendDoc, type LegendSnapshot,
} from "./legendviews.js";

export const LEGEND_VIEW_FIELDS = {
  document: z.string().optional().default("").describe("Title or full path of an open document. Required for seed, create_view and place."),
  source_document: z.string().optional().default("").describe("Another open document to read a seed legend from."),
  seed_view: z.string().optional().default("").describe("Legend view name or id. Default: the view that holds the seed component."),
  seed_component: z.string().optional().default("").describe("Legend component id. Default: the first component."),
  name: z.string().optional().default("").describe("create_view: the new legend view's name."),
  duplicate: z.enum(["duplicate", "with_detailing"]).optional().default("duplicate"),
  view: z.string().optional().default("").describe("place: the legend view name or id."),
  types: z.array(z.object({
    id: z.union([z.string(), z.number()]),
    category: z.string(),
  })).optional().default([]).describe("place: type ids with category door, window, wall, floor, roof or ceiling."),
  columns: z.number().int().positive().optional().default(1),
  spacing_x_mm: z.number().optional().default(185),
  spacing_y_mm: z.number().optional().default(34),
  origin_x_mm: z.number().optional().default(15),
  origin_y_mm: z.number().optional().default(0),
  length_mm: z.number().positive().optional().default(1000).describe("Wall section length in millimetres. Set on LEGEND_COMPONENT_LENGTH."),
  label: z.enum(["none", "keynote", "type_mark"]).optional().default("none"),
  batch_lease: z.string().optional().default(""),
  references: z.object({
    kit: z.array(z.string()).optional(),
    standards: z.array(z.string()).optional(),
    rulebook: z.array(z.string()).optional(),
  }).optional(),
  sample_limit: z.number().int().min(1).max(100).optional().default(20),
};

export type LegendViewArgs = z.infer<z.ZodObject<typeof LEGEND_VIEW_FIELDS>> & {
  action: "seed" | "create_view" | "place";
  dry_run?: boolean;
};

export interface LegendIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_legend",
    images: [] as [],
    saved: false,
    synced: false,
    free_text: false,
    cites: {
      kit: "FMC-BIM-MAN-001",
      standards: "FMC-BIM-STD-002",
      rulebook: "No free text on sheets. A legend is a copied seed, not a created LegendComponent.",
    },
    ...extra,
  };
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-LEGEND";
  return reply({ ...stamp(), refused: true, code, message }, true);
}

function normalize(raw: unknown): LegendSnapshot {
  const row = (raw && typeof raw === "object" ? raw : {}) as LegendSnapshot;
  return { ...row, documents: Array.isArray(row.documents) ? row.documents : [] };
}

function guardOf(doc: { title: string; path: string }, central: boolean | undefined, io: LegendIo): { reason: string | null; config: GuardConfig } {
  const env = io.env ?? process.env;
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
  const blob = `${doc.title} ${doc.path}`;
  let reason: string | null = null;
  if (/hebert hostels/i.test(blob)) reason = "HEBERT HOSTELS is not written by fmc_legend.";
  else if (/[\\/]centrals[\\/]/i.test(doc.path)) reason = "A file under a Centrals folder is not written by fmc_legend.";
  else if (central) reason = "A central model is not written by fmc_legend.";
  else reason = saveBlocked(doc, loaded.config);
  if (!reason && loaded.problem) reason = loaded.problem;
  return { reason, config: loaded.config };
}

function standardsNote(io: LegendIo): string {
  const env = io.env ?? process.env;
  const direct = (env.FMC_STANDARDS_FILE ?? "").trim();
  if (direct) return direct;
  try {
    const loaded = io.guard ? { config: io.guard } : loadConfig(configPath(env));
    return path.win32.join(path.win32.dirname(kitPaths(loaded.config).recipesDir), "FMC_Standards_Building.json");
  } catch {
    return "";
  }
}

async function readModel(args: LegendViewArgs, io: LegendIo): Promise<LegendSnapshot> {
  const body = {
    action: "seed",
    document: args.document,
    source_document: args.source_document,
    seed_view: args.seed_view,
  };
  if (io.read) return normalize(await io.read(body));
  return normalize(await withRevitConnection((client) => client.sendCommand("fmc_legend_views", body, 180000)));
}

function pickView(doc: LegendDoc | undefined, key: string) {
  const views = doc?.views ?? [];
  if (!key.trim()) return views[0];
  const want = key.trim().toLowerCase();
  return views.find((view) => view.id === key || view.name.trim().toLowerCase() === want);
}

function pickComponent(doc: LegendDoc | undefined, key: string, viewId?: string) {
  let rows = doc?.components ?? [];
  if (viewId) {
    const inView = rows.filter((row) => row.view_id === viewId);
    if (inView.length) rows = inView;
  }
  if (!key.trim()) return rows[0];
  return rows.find((row) => row.id === key) ?? rows[0];
}

export async function runLegendViews(args: LegendViewArgs, io: LegendIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) {
      return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: LEGEND_FIX["FMC-DOC-REQUIRED"] }, true);
    }
    const snapshot = await readModel(args, io);
    if (snapshot.refused) return reply({ ...stamp(), refused: true, code: snapshot.code || "FMC-LEGEND", message: snapshot.message }, true);
    const doc = snapshot.documents?.[0];
    const source = args.source_document.trim() ? snapshot.documents?.find((row) => row.title.toLowerCase() === args.source_document.trim().toLowerCase() || (row.path ?? "").toLowerCase() === args.source_document.trim().toLowerCase()) : undefined;
    const host = doc ?? source;
    const verdict = seedVerdict(doc, source);
    const report = writeLegendReport(env, args.action, { snapshot, verdict, standards: standardsNote(io) }, io.reportDir);
    const sample = args.sample_limit ?? 20;

    if (args.action === "seed") {
      const noSeed = !verdict.seed_component && !verdict.source_component;
      return reply({
        ...stamp({
          action: "seed",
          read_only: true,
          document: doc?.title ?? args.document,
          source_document: source?.title ?? "",
          views: (doc?.views ?? []).slice(0, sample),
          view_count: (doc?.views ?? []).length,
          components: (doc?.components ?? []).slice(0, sample),
          component_count: (doc?.components ?? []).length,
          source_component_count: (source?.components ?? []).length,
          seed_view: verdict.seed_view ?? null,
          seed_component: verdict.seed_component ?? verdict.source_component ?? null,
          report,
          ...(noSeed ? { code: "FMC-LEGEND-NO-SEED", fix: LEGEND_FIX["FMC-LEGEND-NO-SEED"] } : {}),
        }),
      }, noSeed);
    }

    const guard = guardOf({ title: host?.title ?? args.document, path: host?.path ?? "" }, host?.is_central === true || snapshot.is_central === true, io);
    if (guard.reason) {
      return reply({ ...stamp(), refused: true, code: "FMC-LEGEND-GUARD", dry_run: true, message: guard.reason, protected_paths: guard.config.protected_paths ?? [] }, true);
    }

    if (args.action === "create_view") {
      if (!args.name.trim()) return reply({ ...stamp(), refused: true, code: "FMC-LEGEND-NAME", message: "create_view needs name." }, true);
      const seedView = pickView(source ?? doc, args.seed_view) ?? verdict.seed_view;
      if (!seedView) return reply({ ...stamp(), refused: true, code: "FMC-LEGEND-NO-VIEW", message: LEGEND_FIX["FMC-LEGEND-NO-VIEW"], fix: LEGEND_FIX["FMC-LEGEND-NO-VIEW"], report }, true);
      const taken = (doc?.views ?? []).some((view) => view.name.trim().toLowerCase() === args.name.trim().toLowerCase());
      if (taken) return reply({ ...stamp(), refused: true, code: "FMC-LEGEND-NAME-TAKEN", message: LEGEND_FIX["FMC-LEGEND-NAME-TAKEN"], fix: LEGEND_FIX["FMC-LEGEND-NAME-TAKEN"] }, true);
      const plan = {
        action: "create_view",
        seed_view_id: seedView.id,
        seed_view: seedView.name,
        name: args.name.trim(),
        duplicate: args.duplicate,
        source_document: source ? args.source_document : "",
        same_document: !source,
      };
      if (args.dry_run !== false) {
        return reply(stamp({ ...plan, dry_run: true, read_only: true, report, next: "Apply with dry_run false and batch_lease. Copy across documents is reported if Revit refuses. No text notes are created." }));
      }
      return applyWrite(args, plan, guard.config, io, report);
    }

    const seedComponent = pickComponent(doc, args.seed_component, pickView(doc, args.view)?.id) ?? verdict.seed_component ?? verdict.source_component;
    if (!seedComponent) {
      return reply({ ...stamp(), refused: true, code: "FMC-LEGEND-NO-SEED", message: LEGEND_FIX["FMC-LEGEND-NO-SEED"], fix: LEGEND_FIX["FMC-LEGEND-NO-SEED"], report }, true);
    }
    const view = pickView(doc, args.view) ?? (doc?.views ?? []).find((row) => row.id === seedComponent.view_id) ?? verdict.seed_view;
    if (!view) return reply({ ...stamp(), refused: true, code: "FMC-LEGEND-NO-VIEW", message: LEGEND_FIX["FMC-LEGEND-NO-VIEW"], fix: LEGEND_FIX["FMC-LEGEND-NO-VIEW"] }, true);
    if (!args.types.length) return reply({ ...stamp(), refused: true, code: "FMC-LEGEND-CATEGORY", message: "place needs types: id and category.", fix: LEGEND_FIX["FMC-LEGEND-CATEGORY"] }, true);
    const built = buildPlace({
      types: args.types,
      columns: args.columns,
      spacing_x_mm: args.spacing_x_mm,
      spacing_y_mm: args.spacing_y_mm,
      origin_x_mm: args.origin_x_mm,
      origin_y_mm: args.origin_y_mm,
      length_mm: args.length_mm,
      label: args.label as LabelMode,
      scale: view.scale || 50,
    });
    const plan = {
      action: "place",
      view_id: view.id,
      view: view.name,
      scale: view.scale || 50,
      seed_id: seedComponent.id,
      source_document: seedComponent === verdict.source_component ? args.source_document : "",
      items: built.items,
      rejected: built.rejected,
      label: built.label,
    };
    writeLegendReport(env, "place", plan, io.reportDir);
    if (!built.items.length) {
      return reply({ ...stamp(), refused: true, code: "FMC-LEGEND-CATEGORY", rejected: built.rejected, fix: LEGEND_FIX["FMC-LEGEND-CATEGORY"], report }, true);
    }
    if (args.dry_run !== false) {
      return reply(stamp({
        ...plan,
        items: built.items.slice(0, sample),
        item_count: built.items.length,
        dry_run: true,
        read_only: true,
        report,
        next: "Each component is a copy of the seed, then LEGEND_COMPONENT, LEGEND_COMPONENT_VIEW and, for a wall, LEGEND_COMPONENT_LENGTH. One transaction, a SubTransaction per component. No text notes.",
      }));
    }
    return applyWrite(args, plan, guard.config, io, report);
  } catch (error) {
    return failed(error);
  }
}

async function applyWrite(args: LegendViewArgs, plan: Record<string, unknown>, config: GuardConfig, io: LegendIo, report: string) {
  const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
  if (!lease) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: LEGEND_FIX["FMC-BATCH-LOCKED"] }, true);
  const refs = legendReferenceProblems(args.references);
  if (refs) return reply({ ...stamp(), refused: true, code: "FMC-LEGEND-REFERENCES", message: refs }, true);
  const roots = [...(config.protected_paths ?? []), ...protectedRoots(config)];
  const body = { document: args.document, ...plan, protected_roots: roots, _protected_roots: roots, references: args.references ?? {} };
  try {
    const applied = io.apply
      ? await io.apply(body) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_legend_apply", body, 180000)) as Record<string, unknown>;
    const refused = applied.ok === false;
    return reply(stamp({
      action: args.action,
      dry_run: false,
      read_only: false,
      document: args.document,
      report,
      applied,
      free_text: false,
      refused,
      code: typeof applied.code === "string" ? applied.code : undefined,
      message: typeof applied.message === "string" ? applied.message : undefined,
      label_note: applied.label_possible === false ? LEGEND_FIX["FMC-LEGEND-LABEL-UNSUPPORTED"] : undefined,
    }), refused);
  } catch (error) {
    return failed(error);
  }
}
