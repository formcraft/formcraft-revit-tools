/**
 * fmc_cloud: Autodesk Docs (ACC / BIM 360) cloud models through the Revit API.
 * Reads: facts (per open document: cloud or not, workshared, region, project and model GUIDs, hub / project / folder
 * ids, model URN, version GUID and saves, unsaved changes), cloud_path (region + GUIDs to a cloud path via
 * ModelPathUtils, no model is opened) and parse (offline: no Revit).
 * Writes: save_as_cloud (Document.SaveAsCloudModel) is a dry run unless dry_run=false AND approved_by names a person,
 * and is a WRITE_COMMANDS command, so the live-model lock applies. sync and publish are never run (CLAUDE.md rule 6).
 * The CollaborationCache folder is never read, written, deleted or listed: arguments naming it are refused and
 * replies naming it are redacted.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import {
  APPROVAL_CODE, CACHE_CODE, cacheHits, cacheRefusal, checkGuidTriple, gateWrite, parseModelPath, planSaveAsCloud,
  redactCache, syncPlan, type CloudDocFacts,
} from "../fmc/cloud.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function stamp(extra: Record<string, unknown> = {}) {
  return { tool: "fmc_cloud", saved: false, synced: false, published: false, ...extra };
}

export const FMC_CLOUD_DESCRIPTION =
  "Autodesk Docs (ACC / BIM 360) cloud models. Reads: facts (each open document named in documents, or the target " +
  "document: whether it is a cloud model and workshared, region, project and model GUIDs, hub, project and folder ids, " +
  "model URN, version GUID and number of saves, unsaved changes, central path), cloud_path (region US or EMEA with " +
  "project_guid and model_guid to Revit's cloud path, nothing opened) and parse (offline: split cloud, Revit Server, " +
  "local and UNC paths). One result per item. Write: save_as_cloud saves a non-workshared, non-cloud open document " +
  "to an Autodesk Docs folder; it is a dry run unless dry_run is false AND approved_by names the approving person; " +
  "refused on live projects. sync and publish only describe what a person does: this tool never syncs, publishes or " +
  "saves a workshared model. Any argument naming the CollaborationCache folder is refused; that folder is never read.";

const GUID_ITEM = z.object({ region: z.string(), project_guid: z.string(), model_guid: z.string() });

export const FMC_CLOUD_SHAPE = {
  action: z.enum(["facts", "cloud_path", "parse", "save_as_cloud", "sync", "publish"]),
  documents: z.array(z.string()).optional().default([]).describe("facts: open documents (title or path); empty means the target document"),
  paths: z.array(z.string()).optional().default([]).describe("parse: user-visible model paths, e.g. Autodesk Docs://Project/Model.rvt"),
  guids: z.array(GUID_ITEM).optional().default([]).describe("cloud_path: { region: US|EMEA, project_guid, model_guid } items"),
  target: z.string().optional().default("").describe("save_as_cloud, sync, publish: the open document (title or path)"),
  account_id: z.string().optional().default("").describe("save_as_cloud: ACC / BIM 360 account GUID (b. prefix allowed)"),
  project_id: z.string().optional().default("").describe("save_as_cloud: ACC / BIM 360 project GUID (b. prefix allowed)"),
  folder_id: z.string().optional().default("").describe("save_as_cloud: Docs folder URN, urn:adsk.wipprod:fs.folder:co.…"),
  model_name: z.string().optional().default("").describe("save_as_cloud: cloud model name (.rvt added if missing)"),
  approved_by: z.string().optional().default("").describe("Real writes: the name of the person who approved this write"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcCloudArgs = z.infer<z.ZodObject<typeof FMC_CLOUD_SHAPE>>;

export interface CloudIo {
  facts?: (body: Record<string, unknown>) => Promise<unknown>;
  cloudPath?: (body: Record<string, unknown>) => Promise<unknown>;
  saveAs?: (body: Record<string, unknown>) => Promise<unknown>;
  /** Log file folder; defaults to the guard's reports_dir. Tests pass a temp folder. */
  reportDir?: string;
}

function log(dir: string, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function errText(e: unknown) { return e instanceof Error ? e.message : String(e); }

function asFacts(raw: unknown): CloudDocFacts & Record<string, unknown> {
  return raw && typeof raw === "object" ? raw as CloudDocFacts & Record<string, unknown> : {};
}

export async function runFmcCloud(args: FmcCloudArgs, io: CloudIo = {}) {
  const dry = args.dry_run !== false;
  const reportDir = io.reportDir ?? (() => { try { return expandEnv(loadConfig().config.reports_dir); } catch { return ""; } })();
  const hits = cacheHits(args);
  if (hits.length) {
    if (reportDir) log(reportDir, "cloud_" + args.action, dry, "", "refused", CACHE_CODE);
    return reply(stamp(cacheRefusal(hits)), true);
  }
  const readFacts = io.facts ?? ((body) => withRevitConnection((c) => c.sendCommand("fmc_cloud_facts", body, 60000)));
  const readPath = io.cloudPath ?? ((body) => withRevitConnection((c) => c.sendCommand("fmc_cloud_path", body, 60000)));
  const saveAs = io.saveAs ?? ((body) => withRevitConnection((c) => c.sendCommand("fmc_cloud_save_as", body, 600000)));

  try {
    if (args.action === "parse") {
      if (!args.paths.length) return reply(stamp({ refused: true, code: "FMC-CLOUD-ITEMS", message: "parse needs paths" }), true);
      const items = args.paths.map((p) => ({ ...parseModelPath(p), result: parseModelPath(p).problems.length ? "problem" : "ok" }));
      return reply(stamp({ action: "parse", read_only: true, count: items.length, items }));
    }

    if (args.action === "facts") {
      const keys = args.documents.length ? args.documents : [""];
      const items = [];
      for (const key of keys) {
        try {
          const f = redactCache(asFacts(await readFacts(key ? { document: key } : {})));
          items.push({ document: key || String(f.title ?? ""), result: "ok", ...f });
        } catch (e) {
          items.push({ document: key, result: "error", error: errText(e) });
        }
      }
      return reply(stamp({ action: "facts", read_only: true, count: items.length, items }), items.every((i) => i.result === "error"));
    }

    if (args.action === "cloud_path") {
      if (!args.guids.length) return reply(stamp({ refused: true, code: "FMC-CLOUD-ITEMS", message: "cloud_path needs guids items" }), true);
      const items = [];
      for (const g of args.guids) {
        const checked = checkGuidTriple(g);
        if (!checked.ok) { items.push({ ...g, result: "refused", problems: checked.problems }); continue; }
        try {
          const r = redactCache(asFacts(await readPath({ ...checked.value })));
          items.push({ ...checked.value, result: "ok", ...r, parsed: parseModelPath(String(r.user_visible_path ?? "")) });
        } catch (e) {
          items.push({ ...checked.value, result: "error", error: errText(e) });
        }
      }
      return reply(stamp({ action: "cloud_path", read_only: true, count: items.length, items }), items.every((i) => i.result !== "ok"));
    }

    // Writes and write-shaped actions: one target document.
    const target = args.target.trim();
    let facts: CloudDocFacts | null = null;
    try { facts = redactCache(asFacts(await readFacts(target ? { document: target } : {}))); }
    catch (e) { return reply(stamp({ action: args.action, refused: true, code: "FMC-CLOUD-FACTS", message: errText(e), items: [{ document: target, result: "error", error: errText(e) }] }), true); }

    const gate = gateWrite({ dry_run: args.dry_run, approved_by: args.approved_by });

    if (args.action === "sync" || args.action === "publish") {
      const plan = syncPlan(facts, args.action);
      const items = [{ document: facts?.title ?? target, result: gate.mode === "dry_run" ? "dry run: a person does this in Revit" : "refused" }];
      if (gate.mode === "dry_run") return reply(stamp({ action: args.action, dry_run: true, read_only: true, plan, items }));
      const refusal = gate.mode === "refused"
        ? { code: gate.code, message: gate.message }
        : { code: "FMC-CLOUD-RULE6", message: "[FMC-CLOUD-RULE6] Workshared and cloud models are never synchronised or published by a tool (CLAUDE.md rule 6), even with approval. A person does it in Revit. Nothing was changed." };
      if (reportDir) log(reportDir, "cloud_" + args.action, false, String(facts?.title ?? target), "refused", refusal.code);
      return reply(stamp({ action: args.action, dry_run: false, refused: true, ...refusal, plan, items }), true);
    }

    // save_as_cloud
    const plan = planSaveAsCloud(facts, args);
    const doc = String(facts?.title ?? target);
    if (gate.mode === "dry_run") {
      return reply(stamp({ action: "save_as_cloud", dry_run: true, read_only: true, plan,
        items: [{ document: doc, result: plan.ok ? "would save as cloud model" : "would be refused", problems: plan.problems }],
        next: plan.ok ? "To do it: dry_run=false and approved_by=<the approving person's name>" : "Fix the problems first" }));
    }
    if (gate.mode === "refused") {
      if (reportDir) log(reportDir, "cloud_save_as", false, doc, "refused", APPROVAL_CODE);
      return reply(stamp({ action: "save_as_cloud", dry_run: false, refused: true, code: gate.code, message: gate.message, plan,
        items: [{ document: doc, result: "refused" }] }), true);
    }
    if (!plan.ok) {
      if (reportDir) log(reportDir, "cloud_save_as", false, doc, "refused", plan.problems.join("; "));
      return reply(stamp({ action: "save_as_cloud", dry_run: false, refused: true, code: "FMC-CLOUD-PLAN", message: plan.problems.join("; "), plan,
        items: [{ document: doc, result: "refused", problems: plan.problems }] }), true);
    }
    const body = { document: target || doc, account_id: plan.account_guid, project_id: plan.project_guid, folder_id: plan.folder_id,
      model_name: plan.model_name, approved_by: gate.approved_by };
    try {
      const r = redactCache(asFacts(await saveAs(body)));
      if (reportDir) log(reportDir, "cloud_save_as", false, doc, "done", `${plan.model_name} approved by ${gate.approved_by}`);
      return reply(stamp({ action: "save_as_cloud", dry_run: false, saved: true, approved_by: gate.approved_by, plan,
        items: [{ document: doc, result: "saved as cloud model", ...r }] }));
    } catch (e) {
      if (reportDir) log(reportDir, "cloud_save_as", false, doc, "error", errText(e));
      return reply(stamp({ action: "save_as_cloud", dry_run: false, refused: true, code: "FMC-CLOUD-SAVE", message: errText(e), plan,
        items: [{ document: doc, result: "error", error: errText(e) }] }), true);
    }
  } catch (e) {
    return reply(stamp({ action: args.action, refused: true, code: "FMC-CLOUD", message: errText(e) }), true);
  }
}

export function registerFmcCloudTool(server: McpServer) {
  server.tool("fmc_cloud", FMC_CLOUD_DESCRIPTION, FMC_CLOUD_SHAPE, (args) => runFmcCloud(args));
}
