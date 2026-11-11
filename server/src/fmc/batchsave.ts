/**
 * Between batches, while the lease is still held: the same auto-save the AI gate already runs.
 * A failure is returned so the batch line can mark the batch failed. A skip (not due, workshared,
 * copy, protected original) is not a failure.
 */
import { autoSave } from "./aigate.js";
import { loadAiConfig } from "./aiuse_io.js";
import { loadConfig, type DocInfo } from "./policy.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

export interface SaveOutcome { ran: boolean; ok: boolean; detail: string }

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
  const saved = await autoSave(active, ai, (command, params) => withRevitConnection((client) => client.sendCommand(command, { ...params, document: ctx.document })), result);
  if (typeof result.auto_save_failed === "string") return { ran: true, ok: false, detail: result.auto_save_failed };
  if (!saved) return { ran: false, ok: true, detail: "Existing auto-save left this document alone (not due, workshared, in the background, a verification copy, or a protected original)." };
  return { ran: true, ok: true, detail: `Saved by the existing auto-save. Batch ${ctx.label}.` };
}
