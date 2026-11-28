import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { projectSaveVerdict, type ProjectFile } from "../fmc/saveproject.js";

export const FMC_SAVE_PROJECT_DESCRIPTION =
  "THE safe project save. Saves one open project file only when its title and its path both match the values you pass. " +
  "A family document is refused. The live-model lock and the batch lease apply, the same as any other model-changing call. " +
  "revit_file action save does not check the title and the path and does not refuse a family: do not use it to save a project.";

const shape = {
  title: z.string().min(1).describe("The open project's title, exactly as fmc_document_info reports it."),
  path: z.string().min(1).describe("The open project's full path, exactly as fmc_document_info reports it. A .rfa is refused."),
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export async function runSaveProject(args: { title: string; path: string }) {
  const expected = { title: args.title.trim(), path: args.path.trim() };
  let active: ProjectFile | undefined;
  try {
    const info = await withRevitConnection((client) => client.sendCommand("fmc_document_info", { document: expected.path })) as { active?: ProjectFile };
    active = info?.active;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, refused: true, message: `[FMC-SAVE] Could not read the open document, so nothing was saved. ${message}` }, true);
  }
  const verdict = projectSaveVerdict(expected, active);
  if (!verdict.ok) return reply({ ok: false, refused: true, message: verdict.message, document: active ?? null }, true);
  try {
    const saved = await withRevitConnection((client) => client.sendCommand("fmc_revit_file", { action: "save", document: expected.path }));
    const document = saved && typeof saved === "object" && saved.document && typeof saved.document === "object"
      ? saved.document
      : { title: active?.title ?? expected.title, path: active?.path ?? expected.path };
    return reply({ ok: true, saved: true, ...(saved && typeof saved === "object" ? saved : { result: saved }), document });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ok: false, saved: false, message, document: { title: active?.title ?? "", path: active?.path ?? "" } }, true);
  }
}

export function registerFmcSaveProjectTool(server: McpServer) {
  server.tool("fmc_save_project", FMC_SAVE_PROJECT_DESCRIPTION, shape, (args) => runSaveProject(args));
}
