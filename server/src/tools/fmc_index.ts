import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IndexEntry, RepoIndex, describe, entryOf, loadIndex, queryIndex } from "../fmc/repoindex.js";

export const FMC_INDEX_DESCRIPTION =
  "Where every part of Formcraft Revit Tools is (docs/INDEX.md): one lookup instead of reading docs or code. find: a " +
  "key (F-041, U28, D1, PR-133, fmc_ai, a Revit command, a pane section) or words (\"stop ai switch\"), answered with " +
  "the entry, where it lives and what it links to; a weak or empty answer means the app has no such part, so don't " +
  "guess one. get: one key with its neighbours. tools: every MCP tool with its actions, by heart. Read-only.";

export const FMC_INDEX_SHAPE = {
  action: z.enum(["find", "get", "tools"]),
  q: z.string().optional().describe("find: a key or words; get: a key"),
  n: z.number().int().min(1).max(20).optional().default(5),
  kinds: z.array(z.string()).optional().describe("find: only these kinds (finding, work, decision, pr, doc, section, file, symbol, tool, command, ui, app)"),
};
export type FmcIndexArgs = z.infer<z.ZodObject<typeof FMC_INDEX_SHAPE>>;

let loaded: { index: RepoIndex; root: string | null } | null = null;
/** The plugin uses the copy shipped with the server; FMC_REPO_INDEX_ROOT points it at a work tree instead (development). */
function index(): { index: RepoIndex; root: string | null } {
  if (!loaded) {
    const root = process.env.FMC_REPO_INDEX_ROOT || null;
    loaded = { index: loadIndex({ root }).index, root };
  }
  return loaded;
}

const toolLine = (e: IndexEntry) => `${e.title}${e.actions?.length ? ` (${e.actions.join(", ")})` : ""}: ${(e.summary ?? "").split(/(?<=\.)\s/)[0]}`;

/** Plain text, so the AI and a person read the same short answer. */
export function runFmcIndexText(args: FmcIndexArgs): string {
  const { index: ix, root } = index();
  if (args.action === "tools") return ix.entries.filter((e) => e.kind === "tool").map(toolLine).join("\n");
  const q = (args.q ?? "").trim();
  if (!q) return "Give q: a key or words.";
  if (args.action === "get") {
    const e = entryOf(ix, q);
    return e ? describe(ix, root, { exact: true, strong: true, results: [{ entry: e, score: 1, cover: 1 }] }) : `Not found: no entry ${q}.`;
  }
  return describe(ix, root, queryIndex(ix, q, args.n ?? 5, args.kinds));
}

export async function runFmcIndex(args: FmcIndexArgs) {
  try {
    return { content: [{ type: "text" as const, text: runFmcIndexText(args) }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: "The repo index isn't available: " + (e instanceof Error ? e.message : String(e)) }], isError: true };
  }
}

export function registerFmcIndexTool(server: McpServer) {
  server.tool("fmc_index", FMC_INDEX_DESCRIPTION, FMC_INDEX_SHAPE, (args) => runFmcIndex(args));
}
