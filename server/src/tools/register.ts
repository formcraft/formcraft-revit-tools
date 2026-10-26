import { RUNNING_BUILD } from "../fmc/buildinfo.js";
import { recordUsage } from "../fmc/usage.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { documentTarget, revitTarget } from "../fmc/target.js";

import { appStatuses, realProbe, toolsOff } from "../hub/apps.js";
import { annotateInvalidOp, annotateToolResult, isInvalidOpMessage } from "../fmc/buildinfo.js";
import { startedByFrom, withLedger } from "../fmc/ledger.js";

export const REVIT_ARG = z.string().optional()
  .describe("Which Revit, when two or more are open: a project or document name, a pid or a port (fmc_revit list shows them). Leave out with one Revit.");

export const DOCUMENT_ARG = z.string().optional()
  .describe("Which document: a title or a full path. It may be open in the background; read-only tools open a closed file " +
    "in the background themselves (detached if workshared) and close it without saving. Leave out for the active document.");

/** Adds `revit` and `document` to every tool registered as server.tool(name, description, shape, handler). */
export function withRevitTarget(server: McpServer) {
  const original = server.tool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...a: unknown[]) => {
    if (a.length === 4 && typeof a[2] === "object" && a[2] !== null && typeof a[3] === "function") {
      const handler = a[3] as (args: Record<string, unknown>, extra: unknown) => unknown;
      // A tool with its own `document` argument (fmc_file) keeps it: it means the same thing, and it sets the target too.
      const own = "document" in (a[2] as object);
      return original(a[0], a[1], { ...(a[2] as object), revit: REVIT_ARG, ...(own ? {} : { document: DOCUMENT_ARG }) },
        (args: Record<string, unknown>, extra: unknown) => {
          const { revit, ...rest } = args ?? {};
          const document = typeof rest.document === "string" && rest.document.trim() ? rest.document.trim() : undefined;
          if (!own) delete rest.document;
          // Owner 26 Oct: every call is timed by the server (fmc/usage.ts), so an AI's own report can compare builds.
          const started = Date.now();
          const done = (ok: boolean, r?: unknown) => recordUsage({ at: new Date(started).toISOString(), tool: String(a[0]), action: typeof rest.action === "string" ? rest.action : "",
            ms: Date.now() - started, ok, build: RUNNING_BUILD.commit, ...(!ok && queuedReply(r) ? { queued: true } : {}) });
          return Promise.resolve(revitTarget.run(typeof revit === "string" ? revit : undefined,
            () => documentTarget.run(document, () => handler(rest, extra))))
            .then((r) => { done(!(r as { isError?: boolean } | undefined)?.isError, r); return r; }, (e) => { done(false); throw e; });
        });
    }
    return original(...a);
  };
}

/**
 * F-042 (issue #143): every tools/call answer that refuses an "invalid op" (the SDK's argument check of a zod
 * discriminated union, "Invalid discriminator value", or a tool's own) names the build this process runs, and says
 * to restart the Claude app when a newer build is installed on disk. Call after the tools are registered (the SDK
 * installs its tools/call handler with the first tool). Returns false when the SDK's handler table isn't there.
 */
export function annotateInvalidOpErrors(server: McpServer): boolean {
  const low = (server as unknown as { server?: { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> } }).server;
  const handlers = low?._requestHandlers;
  const original = handlers?.get("tools/call");
  if (!handlers || !original) return false;
  handlers.set("tools/call", async (req: unknown, extra: unknown) => {
    try {
      return annotateToolResult(await original(req, extra));
    } catch (error) {
      if (error instanceof Error && isInvalidOpMessage(error.message)) error.message = annotateInvalidOp(error.message);
      throw error;
    }
  });
  return true;
}

export async function registerTools(server: McpServer) {
  // 获取当前文件的目录路径
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  // 读取tools目录下的所有文件
  const files = fs.readdirSync(__dirname);

  // 过滤出.ts或.js文件，但排除index文件和register文件
  const toolFiles = files.filter(
    (file) =>
      (file.endsWith(".ts") || file.endsWith(".js")) &&
      file !== "index.ts" &&
      file !== "index.js" &&
      file !== "register.ts" &&
      file !== "register.js"
  );

  // Formcraft tool profile: hide upstream tools Formcraft does not use, so their descriptions do not
  // load into every conversation. FMC_TOOL_PROFILE=full restores every tool.
  const profile = (process.env.FMC_TOOL_PROFILE || "fmc").toLowerCase();
  const hiddenInFmcProfile = new Set([
    "say_hello", "color_elements", "tag_all_walls", "tag_all_rooms", "store_project_data", "store_room_data",
    "query_stored_data", "export_room_data", "search_modules", "use_module",
  ]);

  // Two or more Revits: every tool takes an optional `revit` (a project or document name, a pid or a port) saying which
  // Revit the call goes to. The wrapper strips it before the tool sees its arguments and runs the call in that context.
  withRevitTarget(server);

  // F74: every call is recorded in the local call ledger (%APPDATA%\Formcraft\ledger: tool, action, ok, ms, project, who
  // started it; never model content or names). Installed after the target wrapper, so the call's document names the
  // project when no argument does. MCP stdio is an AI unless FMC_STARTED_BY says otherwise.
  withLedger(server, startedByFrom(process.env, "ai"), () => documentTarget.getStore());

  // The engineering hub (H0): an app's tools load only while the app is switched on (fmc_apps; by default every
  // installed app is on, and Revit always), so an app nobody uses costs no tokens.
  let appOff = new Set<string>();
  try { appOff = toolsOff(appStatuses(realProbe(path.resolve(__dirname, "..", "..")))); } catch { /* the hub can't tell: load everything */ }

  // 动态导入并注册每个工具
  for (const file of toolFiles) {
    if (profile === "fmc" && hiddenInFmcProfile.has(file.replace(/\.(ts|js)$/, ""))) {
      console.error(`FMC profile: skipped ${file}`);
      continue;
    }
    if (appOff.has(file.replace(/\.(ts|js)$/, ""))) {
      console.error(`Hub: ${file} skipped (its app is switched off: fmc_apps)`);
      continue;
    }
    try {
      // 构建导入路径
      const importPath = `./${file.replace(/\.(ts|js)$/, ".js")}`;

      // 动态导入模块
      const module = await import(importPath);

      // 查找并执行注册函数
      const registerFunctionName = Object.keys(module).find(
        (key) => key.startsWith("register") && typeof module[key] === "function"
      );

      if (registerFunctionName) {
        module[registerFunctionName](server);
        console.error(`已注册工具: ${file}`);
      } else {
        console.warn(`警告: 在文件 ${file} 中未找到注册函数`);
      }
    } catch (error) {
      console.error(`注册工具 ${file} 时出错:`, error);
    }
  }
}

/** A reply that says the batch waits in the approval queue (Ogala report: those were counted as failures). */
function queuedReply(r: unknown): boolean {
  const text = ((r as { content?: Array<{ text?: string }> })?.content ?? []).map((c) => c.text ?? "").join(" ");
  return /approval queue|waits for (your|the person's) approval|fmc_ai wait with id/i.test(text);
}
