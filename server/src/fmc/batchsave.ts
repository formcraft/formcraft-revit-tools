/**
 * Between batches, while the lease is still held: the same auto-save the AI gate already runs.
 * A failure is returned so the batch line can mark the batch failed. A skip (not due, workshared,
 * copy, protected original) is not a failure.
 */
import { savedAtOnDisk } from "./aigate.js";
import { factsFor } from "./batchsync.js";
import { isDocBusyMessage } from "./docschedule.js";
import { saveBlocked } from "./savepolicy.js";
import { loadAiConfig } from "./aiuse_io.js";
import { loadConfig, type DocInfo } from "./policy.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

export interface SaveOutcome { ran: boolean; ok: boolean; detail: string }

/**
 * Save the local file only. Workshared models are included: doc.Save writes the local, not the central.
 * A family, a detached or linked copy, a protected original, Stop AI and AI off are left alone.
 */
export async function saveLocalNow(
  active: DocInfo & { isActive?: boolean },
  ai: { mode?: string; auto_save_minutes?: number; stop?: boolean; on?: boolean },
  send: (command: string, params: Record<string, unknown>) => Promise<unknown>,
  result: Record<string, unknown>,
  now = Date.now(),
): Promise<boolean> {
  const minutes = ai.auto_save_minutes ?? (ai.mode === "testing" ? 10 : 0);
  const cfg = loadConfig().config;
  const facts = factsFor(active, cfg);
  const blocked = saveBlocked({ title: active.title, path: active.path }, cfg);
  if (blocked) { result.auto_save_skipped = blocked; return false; }
  if (!(minutes > 0) || !active.path || facts.family || facts.detached || facts.linked || facts.readOnly || facts.protected || facts.stopAi || !facts.aiOn) return false;
  const last = savedAtOnDisk(active.path);
  if (last !== null && now - last < minutes * 60_000) return false;
  try {
    await send("fmc_revit_file", { action: "save", document: active.path });
    result.auto_saved = new Date(now).toISOString();
    return true;
  } catch (error) {
    result.auto_save_failed = `the model didn't save itself: ${error instanceof Error ? error.message : String(error)}; save it (revit_file save)`;
    return false;
  }
}

export async function productionSaveStep(ctx: { document: string; label: string }): Promise<SaveOutcome> {
  const ai = loadAiConfig(loadConfig().config);
  if (!ai) return { ran: false, ok: true, detail: "No ai_modeller section in fmc_guard.json, so the existing auto-save does not run." };
  let active: DocInfo | undefined;
  try {
    const info = await withRevitConnection((client) => client.sendCommand("fmc_document_info", { document: ctx.document })) as { active?: DocInfo };
    active = info?.active;
  } catch (error) {
    return { ran: false, ok: true, detail: `The document could not be read, so it was not saved. ${error instanceof Error ? error.message : error}` };
  }
  if (!active) return { ran: false, ok: true, detail: "The document could not be read, so it was not saved." };
  const result: Record<string, unknown> = {};
  const saved = await saveLocalNow(active, ai, (command, params) => withRevitConnection((client) => client.sendCommand(command, { ...params, document: ctx.document })), result);
  if (typeof result.auto_save_skipped === "string") return { ran: false, ok: true, detail: result.auto_save_skipped };
  if (typeof result.auto_save_failed === "string") {
    if (isDocBusyMessage(result.auto_save_failed)) return { ran: false, ok: true, detail: result.auto_save_failed };
    return { ran: true, ok: false, detail: result.auto_save_failed };
  }
  if (!saved) return { ran: false, ok: true, detail: "Autosave left this document alone (not due, a family, a verification copy, a protected original, save_exclude, Stop AI, or AI off)." };
  return { ran: true, ok: true, detail: `Saved by the existing auto-save. Batch ${ctx.label}.` };
}
