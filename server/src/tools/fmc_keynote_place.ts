import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import {
  KEYNOTE_FIX, keynoteSeedPath, normalizeKeynote, planKeynotes, referenceProblems, writeKeynoteReport,
  type KeyBy, type KeynoteDoc,
} from "../fmc/keynoteplace.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_KEYNOTE_PLACE_DESCRIPTION =
  "Place keynote tags without a hand-placed seed in each view. The API cannot create the keynote link (FMC-NO-API-KEYNOTE-LINK), " +
  "so this tool finds a linked tag of the right type in any view, or copies one from the kit seed model " +
  "(02_Keynotes/Seeds/FMC_Keynote_Seed.rvt) with CopyElements, then copies that seed into every target view and retargets the host. " +
  "by is element, material or user. views is all_plans or a list of plan names. categories limits the hosts. " +
  "one_per_key true (the default) keeps one tag per keynote value per view, on the element nearest the middle of that value. Hosts with an empty key are not collapsed. " +
  "leader true (the default) puts the head off the wall face along the wall normal, past half the wall width, with a leader. " +
  "status is PLANNED or NOTHING_TO_PLACE (0 hosts can be tagged); summary is one line; seed_check says whether a linked tag is in the model and whether the kit seed is on disk. " +
  "The tag box for overlap tests is the seed tag's own size, else the median linked tag of this type, else 900 x 450 mm (tag_size.source). " +
  "A head that overlaps an existing tag box is shifted. If every offset overlaps, the host is FMC-KEYNOTE-OVERLAP and is not tagged. The answer includes counts. " +
  "dry_run defaults to true and returns the per-view plan. A write is fmc_keynote_place_apply, one transaction, one subtransaction per host, " +
  "and needs batch_lease plus references.kit, references.standards and references.rulebook. A blank copy is rolled back. " +
  "The full JSON is under %LOCALAPPDATA%\\Formcraft\\keynote. No pictures. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, views all_plans, categories [\"Walls\",\"Doors\"], by element, one_per_key true, leader true, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_KEYNOTE_PLACE_SHAPE = {
  document: z.string().optional().default(""),
  views: z.union([z.literal("all_plans"), z.array(z.string())]).optional().default("all_plans"),
  categories: z.array(z.string()).optional().default([]),
  by: z.enum(["element", "material", "user"]),
  one_per_key: z.boolean().optional().default(true),
  leader: z.boolean().optional().default(true),
  offset_mm: z.number().positive().optional().default(600),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
};

export type FmcKeynotePlaceArgs = z.infer<z.ZodObject<typeof FMC_KEYNOTE_PLACE_SHAPE>>;

export interface KeynotePlaceIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
  kitRoot?: string;
  seedExists?: (file: string) => boolean;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-KEYNOTE";
  return reply({ tool: "fmc_keynote_place", refused: true, code, message, saved: false, synced: false }, true);
}

function leaseOf(args: FmcKeynotePlaceArgs): string {
  return args.batch_lease.trim() || (batchLease.getStore() ?? "");
}

function kitRootOf(io: KeynotePlaceIo): string {
  if (io.kitRoot != null) return io.kitRoot;
  try {
    const loaded = loadConfig(configPath(io.env ?? process.env));
    return kitPaths(loaded.config).root;
  } catch {
    return "";
  }
}

function guardReason(doc: KeynoteDoc, io: KeynotePlaceIo): string | null {
  const blob = `${doc.title} ${doc.path ?? ""}`;
  if (/hebert hostels/i.test(blob)) return "HEBERT HOSTELS is not written by fmc_keynote_place.";
  if (/[\\/]centrals[\\/]/i.test(doc.path ?? "")) return "A file under a Centrals folder is not written by fmc_keynote_place.";
  if (doc.is_central) return "A central model is not written by fmc_keynote_place.";
  const env = io.env ?? process.env;
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
  return saveBlocked({ title: doc.title, path: doc.path }, loaded.config) || loaded.problem || null;
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_keynote_place",
    images: [] as [],
    saved: false,
    synced: false,
    cites: {
      kit: "FMC-BIM-MAN-001 keynotes",
      standards: "FMC-BIM-STD-002",
      rulebook: "Keynotes are copied from a linked tag. The API does not create the keynote link.",
    },
    ...extra,
  };
}

export async function runFmcKeynotePlace(args: FmcKeynotePlaceArgs, io: KeynotePlaceIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: KEYNOTE_FIX["FMC-DOC-REQUIRED"] }, true);
    const by = args.by as KeyBy;
    const body = { document: args.document.trim(), by, views: args.views, categories: args.categories };
    const raw = io.read
      ? await io.read(body)
      : await withRevitConnection((client) => client.sendCommand("fmc_keynote_place", body, 180000));
    const snapshot = normalizeKeynote(raw);
    if (snapshot.refused) return reply({ ...stamp(), refused: true, code: snapshot.code || "FMC-KEYNOTE", message: snapshot.message }, true);
    const doc = snapshot.documents?.[0];
    if (!doc) return reply({ ...stamp(), refused: true, code: "FMC-DOC-NOT-FOUND", message: "The document was not in the read." }, true);
    const seedFile = keynoteSeedPath(kitRootOf(io));
    const exists = io.seedExists ? io.seedExists(seedFile) : (seedFile ? fs.existsSync(seedFile) : false);
    const plan = planKeynotes(doc, {
      by, views: args.views, categories: args.categories, seedPath: seedFile, seedExists: exists,
      one_per_key: args.one_per_key !== false, leader: args.leader !== false, offset_mm: args.offset_mm,
    });
    const report = writeKeynoteReport(env, { document: doc.title, by, plan }, io.reportDir);
    const dry = args.dry_run !== false;
    const viewsTotal = plan.views.length;
    const viewsTagged = plan.views.filter((view) => view.placed.length).length;
    const why = plan.code === "FMC-KEYNOTE-SEED-MISSING" ? "seed missing" : plan.code ? plan.code : plan.counts.hosts === 0 ? "no hosts in the views" : plan.counts.placed === 0 ? "every host is skipped" : "";
    const seedCheck = {
      linked_in_model: plan.seed.route === "document",
      kit_seed_on_disk: exists,
      kit_seed: seedFile,
      ok: plan.seed.route === "document" || exists,
      ...(plan.seed.route === "document" || exists ? {} : { how_to: "Place one keynote tag of this type (by " + by + ") by hand in any plan view, pick its keynote value so it is linked, then run fmc_keynote_place again. Or add the kit seed (K-02)." }),
    };
    const summary = stamp({
      status: plan.counts.placed === 0 ? "NOTHING_TO_PLACE" : "PLANNED",
      summary: `${viewsTagged} of ${viewsTotal} views can be tagged, ${plan.counts.placed} tags planned${why ? ": " + why : ""}.`,
      seed_check: seedCheck,
      tag_size: plan.tag_size,
      dry_run: dry,
      read_only: dry,
      document: doc.title,
      path: doc.path ?? "",
      by,
      seed: plan.seed,
      views: plan.views,
      placed: plan.counts.placed,
      skipped: plan.counts.skipped,
      counts: plan.counts,
      one_per_key: args.one_per_key !== false,
      leader: args.leader !== false,
      ...(plan.code ? { code: plan.code, message: KEYNOTE_FIX[plan.code] ?? plan.seed.reason } : {}),
      report,
    });
    if (dry) {
      return reply({ ...summary, next: "Nothing was copied. Apply with dry_run false, batch_lease, and references. That call is fmc_keynote_place_apply, one transaction." });
    }
    const guard = guardReason(doc, io);
    if (guard) return reply({ ...stamp(), refused: true, dry_run: false, code: "FMC-KEYNOTE-GUARD", message: guard }, true);
    if (!leaseOf(args)) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: KEYNOTE_FIX["FMC-BATCH-LOCKED"] }, true);
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-KEYNOTE-REFERENCES", message: refsProblem }, true);
    if (plan.code || !plan.views.some((view) => view.placed.length)) {
      return reply({ ...summary, refused: true, read_only: true, dry_run: true }, true);
    }
    const loaded = io.guard ? { config: io.guard } : loadConfig(configPath(env));
    const roots = [...(loaded.config.protected_paths ?? []), ...protectedRoots(loaded.config)];
    const applyBody = {
      document: args.document.trim(),
      by,
      seed: plan.seed,
      views: plan.views.filter((view) => view.placed.length).map((view) => ({
        view_id: view.view_id,
        view: view.view,
        hosts: view.placed.map((row) => ({ host: row.host, leader: row.leader === true, ...(row.head_mm ? { head_mm: row.head_mm } : {}) })),
      })),
      protected_roots: roots,
      _protected_roots: roots,
      references: args.references ?? {},
    };
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_keynote_place_apply", applyBody, 180000)) as Record<string, unknown>;
    const appliedCode = typeof applied.code === "string" ? applied.code : "";
    return reply({ ...summary, read_only: false, dry_run: false, applied, ...(appliedCode ? { code: appliedCode, message: KEYNOTE_FIX[appliedCode] ?? appliedCode } : {}) });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcKeynotePlaceTool(server: McpServer) {
  server.tool("fmc_keynote_place", FMC_KEYNOTE_PLACE_DESCRIPTION, FMC_KEYNOTE_PLACE_SHAPE, async (args) => runFmcKeynotePlace(args as FmcKeynotePlaceArgs));
}
