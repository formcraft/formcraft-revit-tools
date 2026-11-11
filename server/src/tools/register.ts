import { RUNNING_BUILD } from "../fmc/buildinfo.js";
import { recordUsage } from "../fmc/usage.js";
import { usageCallerFields } from "../fmc/caller.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { batchLease, documentTarget, revitTarget } from "../fmc/target.js";

import { appStatuses, realProbe, toolsOff } from "../hub/apps.js";
import { annotateInvalidOp, annotateToolResult, isInvalidOpMessage } from "../fmc/buildinfo.js";
import { startedByFrom, withLedger } from "../fmc/ledger.js";

export const REVIT_ARG = z.string().optional()
  .describe("Which Revit, when two or more are open: a project or document name, a pid or a port (fmc_revit list shows them). Leave out with one Revit.");

export const DOCUMENT_ARG = z.string().optional()
  .describe("Which document: a title or a full path of a document that is already open (including a verification copy from " +
    "fmc_file open_copy). If that document is not open, the call fails and does not use the active document. " +
    "Name the document (title or full path) on every call when more than one document is open. new_family does not need it.");

export const BATCH_LEASE_ARG = z.string().optional()
  .describe("Lease id from fmc_batch request. Required on a model-changing call while that document is held. " +
    "The lease is also bound to this MCP session: another session's copy of the id is refused. Omit it on reads.");

/** Adds `revit`, `document` and `batch_lease` to every tool registered as server.tool(name, description, shape, handler). */
export function withRevitTarget(server: McpServer) {
  const original = server.tool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...a: unknown[]) => {
    if (a.length === 4 && typeof a[2] === "object" && a[2] !== null && typeof a[3] === "function") {
      const handler = a[3] as (args: Record<string, unknown>, extra: unknown) => unknown;
      // A tool with its own `document` argument (fmc_file) keeps it: it means the same thing, and it sets the target too.
      const own = "document" in (a[2] as object);
      const ownLease = "batch_lease" in (a[2] as object);
      return original(a[0], a[1], {
        ...(a[2] as object), revit: REVIT_ARG, ...(own ? {} : { document: DOCUMENT_ARG }), ...(ownLease ? {} : { batch_lease: BATCH_LEASE_ARG }),
      },
        (args: Record<string, unknown>, extra: unknown) => {
          const { revit, batch_lease, ...rest } = args ?? {};
          const document = typeof rest.document === "string" && rest.document.trim() ? rest.document.trim() : undefined;
          if (!own) delete rest.document;
          const lease = typeof batch_lease === "string" && batch_lease.trim() ? batch_lease.trim() : undefined;
          const argsForTool = ownLease && lease ? { ...rest, batch_lease: lease } : rest;
          // Owner 26 Oct: every call is timed by the server (fmc/usage.ts), so an AI's own report can compare builds.
          const started = Date.now();
          const done = (ok: boolean, r?: unknown) => recordUsage({ at: new Date(started).toISOString(), tool: String(a[0]), action: typeof rest.action === "string" ? rest.action : "",
            ms: Date.now() - started, ok, build: RUNNING_BUILD.commit, ...usageCallerFields(String(a[0]), args as { code?: unknown }),
            ...(!ok && queuedReply(r) ? { queued: true } : {}),
            ...(!ok ? { error: errorText(r) } : {}) });
          return Promise.resolve(revitTarget.run(typeof revit === "string" ? revit : undefined,
            () => documentTarget.run(document, () => batchLease.run(lease, () => handler(argsForTool, extra)))))
            .then((r) => { done(!(r as { isError?: boolean } | undefined)?.isError, r); return withBuildWarning(r); }, (e) => { done(false, { content: [{ text: e instanceof Error ? e.message : String(e) }] }); throw e; });
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

export type RegistrarDecision =
  | { kind: "tool"; name: string }
  | { kind: "helper" }
  | { kind: "bad"; reason: string };

/**
 * The tool registrar is the one export named register*Tool. Helpers such as registerFile(projectFolder) also start
 * with "register" and must not be called with the MCP server (that threw ERR_INVALID_ARG_TYPE and fmc_review never
 * registered). A module with only those helpers is a loud failure. A module with no register* export is a helper file.
 */
export function classifyRegistrar(module: Record<string, unknown>): RegistrarDecision {
  const tools = Object.keys(module).filter((key) => /^register.+Tool$/.test(key) && typeof module[key] === "function");
  if (tools.length > 1) return { kind: "bad", reason: `more than one register*Tool export: ${tools.join(", ")}` };
  if (tools.length === 1) return { kind: "tool", name: tools[0] };
  const helpers = Object.keys(module).filter((key) => key.startsWith("register") && typeof module[key] === "function");
  if (helpers.length > 0) return { kind: "bad", reason: `helper ${helpers.join(", ")} is not a register*Tool export, so it was not called with the MCP server` };
  return { kind: "helper" };
}

/** Calls the module's register*Tool. Throws when the module would have registered a helper instead. */
export function callRegistrar(module: Record<string, unknown>, server: McpServer): string {
  const decision = classifyRegistrar(module);
  if (decision.kind === "helper") return "";
  if (decision.kind === "bad") throw new Error(decision.reason);
  const fn = module[decision.name] as (mcp: McpServer) => unknown;
  const result = fn(server);
  if (result instanceof Promise) {
    throw new Error(`${decision.name} returned a promise; register*Tool must be synchronous`);
  }
  return decision.name;
}

export interface RegistrationReport {
  registered: string[];
  skipped: string[];
  failed: { file: string; error: string }[];
}

/** The last registration. fmc_health and /health report modules that failed. Empty until registerTools runs. */
export let lastRegistration: RegistrationReport = { registered: [], skipped: [], failed: [] };

export async function registerTools(server: McpServer): Promise<RegistrationReport> {
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

  const registered: string[] = [];
  const skipped: string[] = [];
  const failed: { file: string; error: string }[] = [];

  // 动态导入并注册每个工具
  for (const file of toolFiles) {
    const base = file.replace(/\.(ts|js)$/, "");
    if (profile === "fmc" && hiddenInFmcProfile.has(base)) {
      skipped.push(base);
      console.error(`FMC profile: skipped ${file}`);
      continue;
    }
    if (appOff.has(base)) {
      skipped.push(base);
      console.error(`Hub: ${file} skipped (its app is switched off: fmc_apps)`);
      continue;
    }
    try {
      // 构建导入路径
      const importPath = `./${file.replace(/\.(ts|js)$/, ".js")}`;

      // 动态导入模块
      const module = await import(importPath);
      const name = callRegistrar(module as Record<string, unknown>, server);
      if (!name) {
        skipped.push(base);
        continue;
      }
      registered.push(base);
      console.error(`已注册工具: ${file}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ file, error: message });
      console.error(`注册工具 ${file} 时出错:`, error);
    }
  }
  lastRegistration = { registered, skipped, failed };
  if (failed.length) {
    throw new Error("Tool registration failed (" + failed.length + "):\n" + failed.map((f) => `${f.file}: ${f.error}`).join("\n"));
  }
  return lastRegistration;
}

/** A reply that says the batch waits in the approval queue (Ogala report: those were counted as failures). */
function queuedReply(r: unknown): boolean {
  const text = ((r as { content?: Array<{ text?: string }> })?.content ?? []).map((c) => c.text ?? "").join(" ");
  return /approval queue|waits for (your|the person's) approval|fmc_ai wait with id/i.test(text);
}

/** The reason a call failed, from its answer (first 300 characters). */
function errorText(r: unknown): string {
  const t = ((r as { content?: Array<{ text?: string }> })?.content ?? []).map((c) => c.text ?? "").join(" ");
  return t.replace(/\s+/g, " ").trim().slice(0, 300);
}

let installedMemo: { at: number; commit: string } | null = null;
/** The build the updater installed last (%APPDATA%\\Formcraft\\installed.json), read at most every 30 s. */
function installedCommit(): string {
  if (installedMemo && Date.now() - installedMemo.at < 30_000) return installedMemo.commit;
  let commit = "";
  try { commit = String(JSON.parse(fs.readFileSync(path.win32.join(process.env.APPDATA ?? "", "Formcraft", "installed.json"), "utf8").replace(/^\uFEFF/, "")).commit ?? ""); } catch { /* not installed by the updater */ }
  installedMemo = { at: Date.now(), commit };
  return commit;
}

/**
 * Owner 26 Oct: after an install the Claude app keeps running the old server until it restarts. Every answer then
 * starts with that, so a session never works on a mixed build.
 */
function withBuildWarning(r: unknown): unknown {
  const installed = installedCommit();
  const running = RUNNING_BUILD.commit.replace(/\+.*$/, "");
  if (!installed || !running || running === "unknown" || installed.startsWith(running) || running.startsWith(installed)) return r;
  const c = (r as { content?: unknown[] })?.content;
  if (!Array.isArray(c)) return r;
  c.unshift({ type: "text", text: `⚠ This Claude session runs Formcraft server ${running}, but ${installed} is installed. Tell the person: quit the Claude app completely (also from the system tray) and reopen it, then start a new chat.` });
  return r;
}
