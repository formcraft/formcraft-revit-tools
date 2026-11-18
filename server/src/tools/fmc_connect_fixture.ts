import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { fixtureConnectCall } from "../fmc/connectfixture.js";

export const FMC_CONNECT_FIXTURE_DESCRIPTION =
  "Connect an open pipe end to a plumbing fixture in a named open document. Works with the add-in installed today: " +
  "it sends one fixed script through send_code_to_revit, under this session's batch lease. The live-model lock, the " +
  "keynote check and the reference check still apply, the same as any other model change. The script uses the fixture's " +
  "MEPModel.ConnectorManager, picks the nearest unconnected piping connector (sanitary for waste and soil, domestic hot " +
  "or cold for supply), then ConnectTo when the ends meet, or creates one pipe of the pipe's type, system and level when " +
  "they do not. One transaction. A failure rolls it back. Two connectors the same distance apart are refused with a fix " +
  "hint. The reply names the document title and path. A basin: waste, hot supply, cold supply. A WC: soil and cold supply.";

const shape = {
  document: z.string().min(1).describe("Title or full path of the open model that holds the pipe and the fixture."),
  pipe: z.union([z.number().int(), z.string().regex(/^\d+$/)]).describe("Element id of the pipe, or of a fitting at the open pipe end."),
  fixture: z.union([z.number().int(), z.string().regex(/^\d+$/)]).describe("Element id of the plumbing fixture (a basin or a WC)."),
  system: z.string().optional().describe("sanitary, waste, soil, supply, domestic hot, or domestic cold. Omit to use the pipe's own system classification."),
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function runConnectFixture(args: { document: string; pipe: number | string; fixture: number | string; system?: string }) {
  let call;
  try {
    call = fixtureConnectCall(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, refused: true, message, document: { title: args.document ?? "", path: "" } }, true);
  }
  try {
    const response = asRecord(await withRevitConnection((client) => client.sendCommand("send_code_to_revit", call.params)));
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
      ok: true, title, path, document,
      fixture: row?.fixture ?? args.fixture,
      pipe: row?.pipe ?? args.pipe,
      system: row?.system ?? args.system ?? "",
      how: row?.how ?? "",
      made: row?.made ?? 0,
      gap_mm: row?.gap_mm,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, message, document: { title: args.document, path: "" } }, true);
  }
}

export function registerFmcConnectFixtureTool(server: McpServer) {
  server.tool("fmc_connect_fixture", FMC_CONNECT_FIXTURE_DESCRIPTION, shape, (args) => runConnectFixture(args));
}
