import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import {
  DEFAULTS_NEED_CONFIRMATION, NUMBERING_FIX, NUMBERING_TARGETS, planNumbering, referenceProblems,
  type NumberingPlan, type NumberingSnapshot,
} from "../fmc/numbering.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_NUMBERING_DESCRIPTION =
  "Renumber doors (Mark), windows (Mark), rooms (Room Number), sheets (Sheet Number), views (the Detail Number of each viewport, restarting on every sheet) " +
  "and grids (vertical grids 1, 2, 3; horizontal grids A, B, C) by rule, using the kit prefix. " +
  "dry_run defaults to true: it returns one row per element with old and new and changes nothing. " +
  "Every element gets a result row: rename, unchanged, skipped with a reason, or error. " +
  "A resulting number carried by two items is an error on each of them (FMC-NUM-DUPLICATE) and nothing is written while any exists. " +
  "categories defaults to all six. rules overrides per category: prefix, separator, start, step, width, order (x_then_y, y_then_x, current), level_block, alpha_skip. " +
  "levels limits doors, windows and rooms to named levels; numbers elsewhere stay and still count for duplicates. " +
  "The defaults are not kit values (the kit has no numbering table): " + DEFAULTS_NEED_CONFIRMATION + " " +
  "A write is fmc_numbering_apply, one transaction, all or nothing, with batch_lease and references.kit, references.standards and references.rulebook; " +
  "the add-in checks each old value first and rolls everything back on a stale one. Never saves or syncs. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, categories [\"Doors\"], rules {\"Doors\": {\"prefix\": \"D\", \"width\": 3}}, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

const rule = z.object({
  prefix: z.string().optional(),
  separator: z.string().optional(),
  start: z.number().int().optional(),
  step: z.number().int().optional(),
  width: z.number().int().optional(),
  order: z.enum(["x_then_y", "y_then_x", "current"]).optional(),
  level_block: z.number().int().optional(),
  alpha_skip: z.string().optional(),
});

export const FMC_NUMBERING_SHAPE = {
  document: z.string().optional().default(""),
  categories: z.array(z.string()).optional().default(["Doors", "Windows", "Rooms", "Sheets", "Views", "Grids"]),
  rules: z.object({
    Doors: rule.optional(), Windows: rule.optional(), Rooms: rule.optional(),
    Sheets: rule.optional(), Views: rule.optional(), Grids: rule.optional(),
  }).optional(),
  levels: z.array(z.string()).optional(),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
};

export type FmcNumberingArgs = z.infer<z.ZodObject<typeof FMC_NUMBERING_SHAPE>>;

export interface NumberingIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-NUMBERING";
  return reply({ tool: "fmc_numbering", refused: true, code, message, saved: false, synced: false }, true);
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_numbering",
    images: [] as [],
    saved: false,
    synced: false,
    targets: NUMBERING_TARGETS,
    defaults_need_confirmation: DEFAULTS_NEED_CONFIRMATION,
    cites: {
      kit: "FMC-BIM-MAN-001 naming and numbering (no table in the kit yet)",
      standards: "FMC-BIM-STD-002 numbering",
      rulebook: "Numbers are unique. Dry run first. A duplicate stops the write.",
    },
    ...extra,
  };
}

function summary(plan: NumberingPlan) {
  return {
    categories: plan.categories,
    rules: plan.rules,
    counts: plan.counts,
    by_category: plan.by_category,
    duplicates: plan.duplicates,
    can_write: plan.can_write,
    items: plan.rows,
  };
}

export async function runFmcNumbering(args: FmcNumberingArgs, io: NumberingIo = {}) {
  try {
    if (!args.document.trim()) return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: NUMBERING_FIX["FMC-DOC-REQUIRED"] }, true);
    // Bad rules and categories are refused before Revit is asked anything.
    planNumbering({}, { categories: args.categories, rules: args.rules as never, levels: args.levels });
    const readBody = { document: args.document.trim(), categories: args.categories };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_numbering", readBody, 180000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return reply({ ...stamp(), refused: true, code: String(body.code ?? "FMC-NUMBERING"), message: String(body.message ?? "The read was refused.") }, true);
    const snapshot = body as NumberingSnapshot;
    const doc = { title: String(body.title ?? args.document), path: String(body.path ?? ""), is_central: body.is_central === true };
    const plan = planNumbering(snapshot, { categories: args.categories, rules: args.rules as never, levels: args.levels });
    const dry = args.dry_run !== false;
    const base = stamp({ dry_run: dry, read_only: dry, document: doc.title, ...summary(plan) });
    if (dry) {
      return reply({
        ...base,
        next: plan.duplicates.length
          ? "Nothing was renamed. Duplicate numbers must be fixed first; a write is refused while any exist."
          : "Nothing was renamed. Apply with dry_run false, batch_lease and references. That call is fmc_numbering_apply, one transaction.",
      });
    }
    if (plan.duplicates.length) return reply({ ...base, read_only: true, refused: true, code: "FMC-NUM-DUPLICATE", message: NUMBERING_FIX["FMC-NUM-DUPLICATE"] }, true);
    const blob = `${doc.title} ${doc.path}`;
    if (/hebert hostels/i.test(blob) || doc.is_central) return reply({ ...stamp(), refused: true, code: "FMC-NUM-GUARD", message: "HEBERT HOSTELS and a central model are not written by fmc_numbering." }, true);
    const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(io.env ?? process.env));
    const blocked = saveBlocked(doc, loaded.config) || loaded.problem;
    if (blocked) return reply({ ...stamp(), refused: true, code: "FMC-NUM-GUARD", message: blocked }, true);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: NUMBERING_FIX["FMC-BATCH-LOCKED"] }, true);
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-NUM-REFERENCES", message: refsProblem }, true);
    const renames = plan.rows.filter((row) => row.status === "rename");
    if (!renames.length) return reply({ ...base, read_only: true, refused: true, code: "FMC-NUM-NOTHING", message: NUMBERING_FIX["FMC-NUM-NOTHING"] }, true);
    const roots = [...(loaded.config.protected_paths ?? []), ...protectedRoots(loaded.config)];
    const applyBody = {
      document: args.document.trim(),
      ops: renames.map((row) => ({ category: row.category, id: row.id, old: row.old, new: row.new })),
      protected_roots: roots,
      _protected_roots: roots,
      references: args.references ?? {},
    };
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_numbering_apply", applyBody, 180000)) as Record<string, unknown>;
    const results = Array.isArray(applied.results) ? applied.results as Array<Record<string, unknown>> : [];
    const items = plan.rows.map((row) => {
      if (row.status !== "rename") return row;
      const hit = results.find((r) => String(r.id ?? "") === row.id && String(r.category ?? "") === row.category);
      return { ...row, written: hit ? hit.written === true : false, result: hit ? String(hit.result ?? "") : "no result from the add-in" };
    });
    return reply({ ...base, read_only: false, dry_run: false, items, applied: { ok: applied.ok === true, renamed: applied.renamed ?? null } });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcNumberingTool(server: McpServer) {
  server.tool("fmc_numbering", FMC_NUMBERING_DESCRIPTION, FMC_NUMBERING_SHAPE, async (args) => runFmcNumbering(args as FmcNumberingArgs));
}

export { DEFAULT_RULES };