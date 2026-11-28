import { z } from "zod";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { DATUM_FIX, mergeResults, originOf, summarize, type DatumItem, type DatumSnapshot, type RelativeTo, type Xyz } from "../fmc/datum.js";

/** Shared by create_grid, create_level, create_dimensions and create_point_based_element. */
export const DATUM_COMMON_SHAPE = {
  document: z.string().optional().describe("Document title or full path. Empty uses the call's target document."),
  relative_to: z.enum(["project_base_point", "internal_origin"]).optional().default("project_base_point")
    .describe("What the coordinates (mm) are measured from. project_base_point (default) moves them by the base point's position; internal_origin sends them as given."),
};

export interface DatumIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  write?: (command: string, body: Record<string, unknown>) => Promise<unknown>;
}

export interface DatumPlan {
  items: DatumItem[];
  errors: number;
  /** Body for the add-in write command, coordinates already internal. */
  send: Record<string, unknown>;
  /** For each row the add-in will answer, the index of the input it came from. */
  sent: number[];
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export async function runDatumTool(opts: {
  tool: string;
  command: string;
  document?: string;
  dryRun: boolean;
  relativeTo: RelativeTo;
  readBody: Record<string, unknown>;
  plan: (snapshot: DatumSnapshot, origin: Xyz) => DatumPlan;
  io?: DatumIo;
}) {
  const io = opts.io ?? {};
  const document = (opts.document ?? "").trim();
  const withDoc = (body: Record<string, unknown>) => (document ? { ...body, document } : body);
  const head = { tool: opts.tool, dry_run: opts.dryRun, read_only: opts.dryRun, relative_to: opts.relativeTo, saved: false, synced: false };
  let snapshot: DatumSnapshot;
  try {
    const raw = io.read
      ? await io.read(withDoc(opts.readBody))
      : await withRevitConnection((client) => client.sendCommand("fmc_datum_read", withDoc(opts.readBody), 60000));
    snapshot = (raw && typeof raw === "object" ? raw : {}) as DatumSnapshot;
    if ((snapshot as Record<string, unknown>).refused === true) throw new Error(String((snapshot as Record<string, unknown>).message ?? "refused"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ...head, refused: true, code: "FMC-DATUM-READ", message: `${DATUM_FIX["FMC-DATUM-READ"]} ${message}` }, true);
  }
  const origin = originOf(snapshot, opts.relativeTo);
  if (!origin) return reply({ ...head, refused: true, code: "FMC-DATUM-NO-BASE-POINT", message: DATUM_FIX["FMC-DATUM-NO-BASE-POINT"] }, true);
  const plan = opts.plan(snapshot, origin);
  const base = { ...head, origin_internal_mm: origin, base_point_internal_mm: snapshot.base_point ?? null };
  if (opts.dryRun) {
    return reply({
      ...base,
      items: plan.items,
      summary: { total: plan.items.length, would_create: plan.items.length - plan.errors, errors: plan.errors },
      next: plan.errors
        ? `Nothing was written. ${plan.errors} item(s) have errors; a write is refused until they are fixed (${DATUM_FIX["FMC-DATUM-BLOCKED"]})`
        : "Nothing was written. Run again with dry_run false (and batch_lease) to apply.",
    });
  }
  if (plan.errors || !plan.sent.length) {
    return reply({ ...base, refused: true, code: "FMC-DATUM-BLOCKED", message: DATUM_FIX["FMC-DATUM-BLOCKED"], items: plan.items }, true);
  }
  let response: unknown;
  try {
    response = io.write
      ? await io.write(opts.command, withDoc(plan.send))
      : await withRevitConnection((client) => client.sendCommand(opts.command, withDoc(plan.send)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const items = plan.items.map((item) => (item.status === "error" ? item : { ...item, status: "unknown", reason: "The write failed or timed out; check the model before running again." }));
    return reply({ ...base, refused: true, code: message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-TOOL-FAILED", message, items }, true);
  }
  const items = mergeResults(plan.items, plan.sent, response);
  const summary = summarize(items);
  const body = response && typeof response === "object" ? response as Record<string, unknown> : {};
  const ok = body.Success !== false && summary.failed === 0 && summary.unknown === 0;
  return reply({ ...base, ok, items, summary, message: body.Message ?? "", response }, !ok);
}
