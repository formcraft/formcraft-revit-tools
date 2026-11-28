import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { DEFAULT_MAX_GAP_MM, MAX_GAP_LIMIT_MM, fixtureConnectCall } from "../fmc/connectfixture.js";
import { loadConfig, type DocInfo, type GuardConfig } from "../fmc/policy.js";
import { writeGuard } from "../fmc/opencopy.js";
import { batchBoard } from "../fmc/batchline.js";
import { batchLease } from "../fmc/target.js";

export const FMC_CONNECT_FIXTURE_DESCRIPTION =
  "Connect an open pipe end to a plumbing fixture in a named open document. Works with the add-in installed today: " +
  "it sends one fixed script through send_code_to_revit, under this session's batch lease. The live-model lock, the " +
  "keynote check and the reference check still apply, the same as any other model change. The script uses the fixture's " +
  "MEPModel.ConnectorManager, picks the nearest unconnected piping connector (sanitary for waste and soil, domestic hot " +
  "or cold for supply), then ConnectTo when the ends meet, or creates one pipe of the pipe's type, system and level when " +
  "they do not. One transaction. A failure rolls it back. Two connectors the same distance apart are refused with a fix " +
  "hint. The reply names the document title and path. A basin: waste, hot supply, cold supply. A WC: soil and cold supply. " +
  `dry_run defaults to true: the script checks and reports (how, gap_mm) and the add-in rolls it back. A gap longer than max_gap_mm (default ${DEFAULT_MAX_GAP_MM}) is refused. ` +
  "Refused on a central, a protected original or a forbidden project. A real run needs batch_lease (the caller must hold the document's lease). Not available to the AI-assisted modeller.";

const shape = {
  document: z.string().min(1).describe("Title or full path of the open model that holds the pipe and the fixture."),
  pipe: z.union([z.number().int(), z.string().regex(/^\d+$/)]).describe("Element id of the pipe, or of a fitting at the open pipe end."),
  fixture: z.union([z.number().int(), z.string().regex(/^\d+$/)]).describe("Element id of the plumbing fixture (a basin or a WC)."),
  system: z.string().optional().describe("sanitary, waste, soil, supply, domestic hot, or domestic cold. Omit to use the pipe's own system classification."),
  dry_run: z.boolean().optional().default(true).describe("Check and report, rolled back. Default true."),
  max_gap_mm: z.number().min(0).max(MAX_GAP_LIMIT_MM).optional().describe(`Longest gap a new pipe may bridge, mm. Default ${DEFAULT_MAX_GAP_MM}.`),
  batch_lease: z.string().optional().default("").describe("A real run needs the lease on document from fmc_batch request."),
};

export interface ConnectFixtureIo {
  send?: (command: string, params: Record<string, unknown>) => Promise<unknown>;
  holder?: (document: string) => { lease: string; client: string } | null;
  config?: () => GuardConfig;
}

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function runConnectFixture(
  args: { document: string; pipe: number | string; fixture: number | string; system?: string; dry_run?: boolean; max_gap_mm?: number; batch_lease?: string },
  io: ConnectFixtureIo = {},
) {
  const send = io.send ?? ((command: string, params: Record<string, unknown>) => withRevitConnection((client) => client.sendCommand(command, params)));
  const dry = args.dry_run !== false;
  const refuse = (code: string, message: string, path = "") =>
    reply({ ok: false, refused: true, code, message, dry_run: dry, document: { title: args.document ?? "", path } }, true);
  let call;
  try {
    call = fixtureConnectCall(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, refused: true, message, document: { title: args.document ?? "", path: "" } }, true);
  }
  // B4: the central and protected-path guard runs here for dry and real runs, whatever live_model_lock is set to.
  let active: (DocInfo & { isLocal?: boolean }) | null = null;
  try {
    const info = asRecord(await send("fmc_document_info", { document: call.params.document }));
    active = (asRecord(info?.active) as (DocInfo & { isLocal?: boolean }) | null) ?? null;
  } catch (error) {
    return refuse("FMC-CONNECT-GUARD", `The document could not be read (${error instanceof Error ? error.message : String(error)}), so nothing was sent.`);
  }
  if (!active) return refuse("FMC-CONNECT-GUARD", "The document could not be read, so nothing was sent.");
  const cfg = io.config ? io.config() : loadConfig().config;
  const guard = writeGuard(active, "fmc_connect_fixture", { dry_run: false }, cfg);
  if (!guard.ok) return refuse("FMC-CONNECT-GUARD", `${guard.reasons.join(" ")} Nothing was sent.`, active.path ?? "");
  if (active.isWorkshared && active.isLocal !== true)
    return refuse("FMC-CONNECT-CENTRAL", `${active.title} is a central model (or its local status is unknown). Connect in a person's local. Nothing was sent.`, active.path ?? "");
  if (!dry) {
    // A real lease check: the caller's lease must be the one the board holds for this document.
    const caller = (args.batch_lease ?? "").trim() || batchLease.getStore() || "";
    const holderOf = io.holder ?? ((d: string) => batchBoard().activeHolder(d));
    let holder: { lease: string; client: string } | null = null;
    try { holder = holderOf(active.path || active.title) ?? holderOf(active.title); } catch { holder = null; }
    if (!caller || !holder || holder.lease !== caller)
      return refuse("FMC-CONNECT-LEASE", `A real connect needs the batch lease on ${active.title}: fmc_batch request, then pass batch_lease. ${!caller ? "No lease was passed." : !holder ? "Nobody holds this document's lease." : "The lease passed is not the one held."} Nothing was sent.`, active.path ?? "");
  }
  try {
    // A dry run is the same script in the add-in's read_only mode (rolled back); the real run is the gated
    // fmc_connect_fixture write (lease, memory, live lock, never the AI gate), sent to the add-in as send_code_to_revit.
    const response = asRecord(await send(dry ? "send_code_to_revit" : "fmc_connect_fixture", call.params));
    const stamped = asRecord(response?.document);
    let result = response?.result;
    if (typeof result === "string") {
      try { result = JSON.parse(result); } catch { /* keep the text */ }
    }
    const row = asRecord(result);
    const title = typeof row?.title === "string" && row.title ? row.title : (typeof stamped?.title === "string" ? stamped.title : "");
    const path = typeof row?.path === "string" && row.path ? row.path : (typeof stamped?.path === "string" ? stamped.path : "");
    const document = { title, path };
    if (response?.success === false) {
      return reply({
        ok: false, refused: false, rolled_back: true,
        message: response.errorMessage || response.error || "The connect was rolled back. Nothing was changed.",
        title, path, document,
      }, true);
    }
    return reply({
      ok: true, dry_run: dry, title, path, document,
      fixture: row?.fixture ?? args.fixture,
      pipe: row?.pipe ?? args.pipe,
      system: row?.system ?? args.system ?? "",
      how: row?.how ?? "",
      made: row?.made ?? 0,
      gap_mm: row?.gap_mm,
      max_gap_mm: args.max_gap_mm ?? DEFAULT_MAX_GAP_MM,
      ...(dry ? { next: "Show the person how it would connect and the gap; run again with dry_run false and batch_lease." } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, message, document: { title: args.document, path: "" } }, true);
  }
}

export function registerFmcConnectFixtureTool(server: McpServer) {
  server.tool("fmc_connect_fixture", FMC_CONNECT_FIXTURE_DESCRIPTION, shape, (args) => runConnectFixture(args));
}
