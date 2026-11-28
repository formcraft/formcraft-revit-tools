/**
 * Drawing register. Rebuilds or filters a sheet-list schedule so PARKED sheets drop out.
 * dry_run defaults to true. Apply is fmc_register_apply, one transaction, with a batch lease and references.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { referenceProblems } from "../fmc/sheetlayout.js";
import { planRegister, sheetParked, type RegisterSheet, type ScheduleFact } from "../fmc/registerdraw.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_REGISTER_DESCRIPTION =
  "Refresh a drawing register. document is the open model. schedule is G100 or the sheet-list schedule name. " +
  "Parked sheets (FMC_Sheet_Status PARKED, or the browser parameter when that is the status) are filtered out with NotEqual PARKED and NotEqual Parked. " +
  "Fields are sheet number, sheet name, current revision and the status parameter. dry_run defaults to true and lists the changes. " +
  "Apply is fmc_register_apply, one transaction. It needs batch_lease and references.kit, references.standards and references.rulebook. " +
  "A missing status parameter is FMC-REGISTER-STATUS and is not invented. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, schedule G100, dry_run true.";

export const FMC_REGISTER_SHAPE = {
  document: z.string().optional().default(""),
  schedule: z.string().optional().default("G100"),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: z.object({
    kit: z.array(z.string()).optional(),
    standards: z.array(z.string()).optional(),
    rulebook: z.array(z.string()).optional(),
  }).optional(),
};

export type FmcRegisterArgs = z.infer<z.ZodObject<typeof FMC_REGISTER_SHAPE>>;

export interface RegisterIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_register",
    saved: false,
    synced: false,
    cites: {
      kit: "FMC_Sheet_Status and the sheet list schedule",
      standards: "FMC-BIM-STD-002 sheet register",
      rulebook: "PARKED sheets stay in the model and drop out of the drawing list.",
    },
    ...extra,
  };
}

function asSchedule(raw: unknown, name: string): ScheduleFact {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const schedule = body.schedule && typeof body.schedule === "object" ? body.schedule as Record<string, unknown> : body;
  return {
    name: String(schedule.name ?? name),
    exists: schedule.exists !== false && schedule.found !== false,
    fields: Array.isArray(schedule.fields) ? schedule.fields.map((item) => String(item)) : [],
    filters: Array.isArray(schedule.filters) ? schedule.filters.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      return [{ field: String(row.field ?? ""), type: String(row.type ?? ""), value: String(row.value ?? "") }];
    }) : [],
    status_parameter: typeof schedule.status_parameter === "string" ? schedule.status_parameter : null,
  };
}

function asSheets(raw: unknown): RegisterSheet[] {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rows = Array.isArray(body.sheets) ? body.sheets : [];
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const status = String(row.status ?? "");
    const browser = String(row.browser ?? "");
    return [{
      number: String(row.number ?? ""),
      name: String(row.name ?? ""),
      revision: String(row.revision ?? ""),
      status,
      parked: row.parked === true || sheetParked(status, browser),
    }];
  });
}

export async function runFmcRegister(args: FmcRegisterArgs, io: RegisterIo = {}) {
  try {
    if (!args.document.trim()) return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: "[FMC-DOC-REQUIRED] fmc_register needs document." }, true);
    const schedule = args.schedule.trim() || "G100";
    const readBody = { document: args.document.trim(), schedule };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_register_read", readBody, 120000));
    const fact = asSchedule(raw, schedule);
    if (raw && typeof raw === "object" && (raw as { exists?: boolean }).exists === false) fact.exists = false;
    const plan = planRegister(fact, asSheets(raw));
    const dry = args.dry_run !== false;
    const summary = stamp({
      dry_run: dry,
      read_only: dry,
      document: args.document.trim(),
      ...plan,
    });
    if (dry) return reply({ ...summary, next: "Apply with dry_run false, batch_lease, and references. That call is fmc_register_apply, one transaction." });
    if (plan.code) return reply({ ...summary, refused: true }, true);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was changed." }, true);
    const refs = referenceProblems(args.references);
    if (refs) return reply({ ...stamp(), refused: true, code: "FMC-REGISTER-REFERENCES", message: refs }, true);
    const applyBody = { document: args.document.trim(), schedule, plan };
    const applied = io.apply
      ? await io.apply(applyBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_register_apply", applyBody, 120000));
    return reply({ ...summary, dry_run: false, read_only: false, applied });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ...stamp(), refused: true, code: "FMC-REGISTER", message }, true);
  }
}

export function registerFmcRegisterTool(server: McpServer) {
  server.tool("fmc_register", FMC_REGISTER_DESCRIPTION, FMC_REGISTER_SHAPE, (args) => runFmcRegister(args));
}
