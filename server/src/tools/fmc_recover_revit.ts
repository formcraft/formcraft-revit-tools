import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instancesFolder, probePort } from "../fmc/connect.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchBoard } from "../fmc/batchline.js";
import { applyRecovery, buildRecoveryPlan, HEBERT_ROLES } from "../fmc/recover.js";
import { liveActions, liveInput } from "../fmc/recover-live.js";

export const FMC_RECOVER_DESCRIPTION =
  "Recover crashed or hung Revit. plan (the default) is read-only: it names each open document's title and path, whether it is " +
  "workshared, the last sync and last save it can see, and the risk that unsaved work may be lost. It never closes a responsive, " +
  "healthy instance. apply needs the confirm token from plan, and force_unsaved=true when unsaved or unsynced changes were found. " +
  "Apply closes only crashed or hung instances (graceful close, then kill), starts Revit 2025, and reopens the documents that were " +
  "open, or recovery.documents in fmc_guard.json. Put the five HEBERT HOSTELS models there (architecture, structural, electrical, " +
  "plumbing, site). Workshared files are opened as a new local by Revit. Originals on D: are not written. " +
  "Needs the add-in: plugin heartbeat, the leased port, fmc_document_info, and re-registering the instance. " +
  "scripts/fmc-recover-revit.ps1 runs the same plan when this server is down.";

const shape = {
  action: z.enum(["plan", "apply"]).optional().default("plan"),
  confirm: z.string().optional().describe("apply: the confirm token returned by plan"),
  force_unsaved: z.boolean().optional().describe("apply: required when plan found unsaved or unsynced changes"),
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export async function runRecoverRevit(args: { action?: "plan" | "apply"; confirm?: string; force_unsaved?: boolean }) {
  const input = await liveInput(instancesFolder());
  const plan = buildRecoveryPlan(input);
  liveActions.log(`[FMC-RECOVER] plan confirm issued for close [${plan.would_close.join(",") || "none"}]; unsaved=${plan.unsaved}`);
  if ((args.action ?? "plan") === "plan") return reply({ ...plan, hebert_roles: HEBERT_ROLES });
  const result = await applyRecovery(plan, args, {
    ...liveActions,
    verify: async (doc) => {
      let port: number | undefined;
      for (let p = 8080; p <= 8089; p++) {
        if ((await probePort("127.0.0.1", p, 300)) === "ok") { port = p; break; }
      }
      if (!port) return { ok: false, detail: "No plugin port is leased (8080-8089). The add-in has not connected. Needs the add-in." };
      try {
        const info = await withRevitConnection((client) => client.sendCommand("fmc_document_info", { document: doc.path })) as { active?: { title?: string; path?: string } };
        const title = info?.active?.title ?? "";
        const got = info?.active?.path ?? "";
        const match = title.toLowerCase() === doc.title.toLowerCase() || got.replace(/\//g, "\\").toLowerCase() === doc.path.replace(/\//g, "\\").toLowerCase();
        return { ok: match, title, path: got, port, detail: match ? `open on port ${port}: ${title} ${got}` : `port ${port} is leased but the document is ${title} ${got}, not ${doc.title} ${doc.path}` };
      } catch (error) {
        return { ok: false, port, detail: `Port ${port} is leased but fmc_document_info failed (${error instanceof Error ? error.message : error}). Needs the add-in.` };
      }
    },
    requeue: () => batchBoard().requeueForRecovery(),
    resume: () => batchBoard().resumeAfterRecovery(),
  });
  return reply(result, !result.ok);
}

export function registerFmcRecoverRevitTool(server: McpServer) {
  server.tool("fmc_recover_revit", FMC_RECOVER_DESCRIPTION, shape, (args) => runRecoverRevit(args));
}
