/**
 * GAP-26 fmc_groups: group audit (read-only) and an explode plan.
 * audit is fmc_groups_audit (READ_VIA_SEND_COMMAND). explode is a dry run of what ungrouping would do;
 * a real explode is not sent: a self-set confirm flag is not enough, and no approval route that always
 * asks a person (even with auto-approve and on library files) is wired for it yet. That route is with Builder 1.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { EXPLODE_MAX, GROUPS_FIX, asGroupsRead, auditGroups, planExplode } from "../fmc/groups.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_GROUPS_DESCRIPTION =
  "Formcraft group audit and a safe explode plan. document is required on every call. " +
  "audit (read-only): unused group types, nested structure (depth), text notes in groups, and instances likely mirrored " +
  "(inferred from member family instances; Revit has no mirrored flag on a group). " +
  "explode: a dry run of ungrouping the instance ids from audit (default dry_run true, at most 50). " +
  "A real explode is refused until a person's approval (the pane route, even with auto-approve and on library files) is wired; " +
  "a confirm flag is not enough. Nested groups inside stay groups; types are not purged. " +
  "Example: action audit, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER.";

export const FMC_GROUPS_SHAPE = {
  action: z.enum(["audit", "explode"]),
  document: z.string().optional().default(""),
  ids: z.array(z.string()).optional().default([]).describe("explode: group instance ids from audit"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcGroupsArgs = z.infer<z.ZodObject<typeof FMC_GROUPS_SHAPE>>;

export interface GroupsIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_groups",
    saved: false,
    synced: false,
    cites: {
      kit: "none (no kit values)",
      standards: "none (no kit values)",
      rulebook: "Gap analysis 26: audit unused types, nesting, text in groups, mirrored instances; exploding needs a person's approval",
    },
    ...extra,
  };
}

function refused(code: string, extra: Record<string, unknown> = {}) {
  return reply({ ...stamp(), refused: true, code, message: GROUPS_FIX[code] ?? code, ...extra }, true);
}

export async function runFmcGroups(args: FmcGroupsArgs, io: GroupsIo = {}) {
  try {
    const document = args.document.trim();
    if (!document) return refused("FMC-DOC-REQUIRED");
    const raw = io.read
      ? await io.read({ document })
      : await withRevitConnection((client) => client.sendCommand("fmc_groups_audit", { document }, 180000));
    const payload = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (payload.refused === true) return reply({ ...stamp(), refused: true, code: String(payload.code ?? "FMC-GROUPS"), message: String(payload.message ?? "The read was refused.") }, true);
    const read = asGroupsRead(payload);
    const doc = String(payload.title ?? document);
    if (args.action === "audit") {
      return reply({ ...stamp({ action: "audit", read_only: true, document: doc }), ...auditGroups(read) });
    }
    const ids = args.ids.map((id) => String(id).trim()).filter(Boolean);
    if (!ids.length) return refused("FMC-GROUPS-IDS");
    if (ids.length > EXPLODE_MAX) return refused("FMC-GROUPS-TOO-MANY", { count: ids.length, max: EXPLODE_MAX });
    const plan = planExplode(read, ids, doc);
    const dry = args.dry_run !== false;
    const summary = stamp({ action: "explode", dry_run: dry, read_only: true, document: doc, ...plan });
    if (!dry) return refused("FMC-GROUPS-APPROVAL", { plan, next: "Show the dry run to the person; they can ungroup in Revit until Builder 1 wires a person-approval route that cannot be skipped." });
    return reply({ ...summary, next: plan.runnable
      ? "Nothing was changed. Show this to the person. A real explode is not available until a person's approval is wired (Builder 1)."
      : "Nothing to ungroup (missing or blocked ids)." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refused(message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-GROUPS", { message });
  }
}

export function registerFmcGroupsTool(server: McpServer) {
  server.tool("fmc_groups", FMC_GROUPS_DESCRIPTION, FMC_GROUPS_SHAPE, (args) => runFmcGroups(args));
}
