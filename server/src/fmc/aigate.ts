import fs from "node:fs";
import { DocInfo, GuardConfig } from "./policy.js";
import { NEVER, PLACEABLE, USER_LINE, aiVerdict, batchSize, generalState, recordBatch } from "./aiuse.js";
import { Names, elementNames, explain, namesWanted } from "./explain.js";
import { approvalFor, claimApproval, enqueue, loadAiConfig, loadRulebook, loadState, logBatch, saveState, setResult, setStatus } from "./aiuse_io.js";

/**
 * The live-model lock's one new case (AI-assisted modeller, Phase A). Called only after the lock has refused a
 * model-changing command on a project model: if every AI gate passes, the command runs and the batch is counted and
 * logged; otherwise the lock's refusal stands, with the AI gate's reason added. A batch at "Fix with approval" goes to
 * the approval queue and runs only after the model's author approves it in the pane.
 */
/** `user` is the plain line a person sees instead of the lock's wording (owner 26 Oct); `reason` is the detail. */
export interface Gate { ok: boolean; reason: string; user?: string; run?: <T>(exec: () => Promise<T>) => Promise<T> }

export async function aiGate(command: string, params: any, active: (DocInfo & { isLocal?: boolean }) | null | undefined, cfg: GuardConfig,
  send: (command: string, params: object) => Promise<any>, env: NodeJS.ProcessEnv = process.env): Promise<Gate> {
  if (!active) return { ok: false, reason: "" };
  const { book } = loadRulebook(cfg);
  const ai = loadAiConfig(cfg, env);
  // Not set up yet (no ai_modeller section): the person sees the plain line, never the lock's wording.
  if (!ai) return { ok: false, reason: "", user: NEVER[command] ? USER_LINE.admin(NEVER[command]) : USER_LINE.off };
  // Read-only code (owner 26 Oct): its transaction is always rolled back, so it needs no approval, only the code switch.
  const dryRun = command === "fmc_model_edit" && params?.dry_run === true;
  if ((command === "send_code_to_revit" && params?.transactionMode === "read_only") || dryRun) {
    if (ai.stop) return { ok: false, reason: "", user: USER_LINE.stopped };
    if (!dryRun && ai.allow_code !== true) return { ok: false, reason: "", user: USER_LINE.admin("running code: the admin's 'AI may run code' switch is off") };
    if (generalState(ai, active.title, active.path) !== "On") return { ok: false, reason: "", user: USER_LINE.off };
    return { ok: true, reason: "", run: <T>(exec: () => Promise<T>) => exec() };
  }
  const elements = batchSize(params);
  const approval = approvalFor(command, params, active.path, env);
  // Auto-approve (owner 26 Oct): testing mode only; the batch runs now and is still listed in Approvals.
  // Sync and relinquish change the central model for everyone: a person approves those even with auto-approve.
  const shared = command === "fmc_revit_file" && ["sync", "relinquish"].includes(String(params?.action));
  const auto = !approval && !shared && ai.mode === "testing" && ai.auto_approve === true;
  const v = aiVerdict({ command, doc: active, elements, approved: !!approval || auto }, cfg, book, ai, loadState(env));
  if (!v.ok) {
    let reason = `AI-assisted modeller: ${v.reasons[0]}.`;
    if (v.needs_approval) {
      const item = enqueue(command, params, active.path, active.title, v.group ?? "", elements, env, new Date(), await describe(command, params, send));
      reason += ` It is waiting in the approval queue as ${item.id}: call fmc_ai wait with id ${item.id} (don't end your turn); ` +
        "approving runs it, then go on with your next batch.";
      return { ok: false, reason, user: `${USER_LINE.approve} (batch ${item.id}; AI: call fmc_ai wait with id ${item.id}, then go on with your next batch)` };
    }
    return { ok: false, reason, user: v.user };
  }

  // Placing elements: Revit says each type's category first, so AI never places structure or anything outside the list.
  if (command === "create_point_based_element") {
    const ids = ((params?.data ?? []) as Array<{ typeId?: number }>).map((d) => d?.typeId);
    if (!ids.length || ids.some((x) => typeof x !== "number")) return { ok: false, reason: "AI-assisted modeller: every element to place needs its typeId, so its category can be checked." };
    const facts = await send("fmc_type_facts", { ids });
    const types = (facts?.types ?? []) as Array<{ id: number; category: string; found: boolean }>;
    const bad = ids.filter((id) => { const t = types.find((x) => x.id === id); return !t?.found || !PLACEABLE.includes(t.category); });
    if (bad.length) return { ok: false, reason: `AI-assisted modeller: type ${bad.join(", ")} isn't a door, window, fixture, furniture, casework, equipment or generic model: AI may only place those.` };
  }

  const row = { model: active.title, path: active.path, command, group: v.group ?? "", level: v.level ?? "", elements, approved_by: approval?.by ?? "" };
  return {
    ok: true, reason: "",
    run: async <T>(exec: () => Promise<T>): Promise<T> => {
      // One run per approval: claimed before Revit runs, so a timeout never leaves it open for a replay.
      if (approval && !claimApproval(approval.id, env))
        throw new Error(`Batch ${approval.id} has already run once for its approval: check the model (fmc_job status), then queue a new batch if more is needed.`);
      const autoItem = auto ? enqueue(command, params, active.path, active.title, v.group ?? "", elements, env, new Date(), await describe(command, params, send)) : null;
      if (autoItem) setStatus(autoItem.id, "used", "auto-approved (testing)", env);
      try {
        const r = await exec();
        await autoSave(active, ai, send, r);
        if (autoItem) setResult(autoItem.id, "done", `${autoItem.summary} · ${JSON.stringify(r ?? {}).slice(0, 4000)}`, env);
        if (book) saveState(recordBatch(loadState(env), active.path, elements, false, book), env);
        logBatch(cfg, { ...row, result: "done", detail: v.band ?? "" });
        return r;
      } catch (e) {
        // F-030: a batch still running past the answer limit has not failed; count it, log it with its job id.
        if ((e as { code?: string })?.code === "FMC-JOB-RUNNING") {
          if (book) saveState(recordBatch(loadState(env), active.path, elements, false, book), env);
          logBatch(cfg, { ...row, result: "running", detail: `job ${(e as { job?: string }).job ?? ""}` });
          if (autoItem) setResult(autoItem.id, "running", e instanceof Error ? e.message : String(e), env);
          throw e;
        }
        if (autoItem) setResult(autoItem.id, "failed", e instanceof Error ? e.message : String(e), env);
        if (book) saveState(recordBatch(loadState(env), active.path, elements, true, book), env);
        logBatch(cfg, { ...row, result: "failed", detail: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
  };
}

/** The approval's plain lines, with type and element names from Revit (best effort: ids when Revit can't say). */
async function describe(command: string, params: object, send: (command: string, params: object) => Promise<any>): Promise<string[]> {
  const want = namesWanted(params);
  const names: Names = { types: {}, elements: {} };
  try {
    if (want.typeIds.length) for (const t of (await send("fmc_type_facts", { ids: want.typeIds }))?.types ?? []) if (t?.name) names.types[String(t.id)] = t.name;
  } catch { /* ids instead */ }
  try {
    if (want.elementIds.length) names.elements = elementNames((await send("fmc_element_geometry", { ids: want.elementIds }))?.elements ?? []);
  } catch { /* ids instead */ }
  return explain(command, params, names);
}

/**
 * When a model was last saved: the file's own time on disk, so it counts across processes and sessions (owner 27 Oct:
 * the old clock started with each server process, so scripts and fresh sessions never reached it and an afternoon's
 * frame was lost when Revit crashed). null when the file can't be read (never saved): save now.
 */
export function savedAtOnDisk(file: string): number | null {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

/**
 * Owner 26 Oct: an afternoon of AI work existed only in an open Revit. After a change, the model saves itself when its
 * file on disk is older than auto_save_minutes (testing default 10; 0 off). Never a workshared model (the person syncs
 * those), never a model in the background. A failed save is reported on the result (auto_save_failed), never hidden.
 */
export async function autoSave(active: DocInfo & { isActive?: boolean }, ai: { mode?: string; auto_save_minutes?: number },
  send: (command: string, params: object) => Promise<any>, result: unknown, now = Date.now(), savedAt: (file: string) => number | null = savedAtOnDisk): Promise<boolean> {
  const minutes = ai.auto_save_minutes ?? (ai.mode === "testing" ? 10 : 0);
  if (!(minutes > 0) || active.isWorkshared || active.isActive === false || !active.path) return false;
  const last = savedAt(active.path);
  if (last !== null && now - last < minutes * 60_000) return false;
  const out = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  try {
    await send("fmc_revit_file", { action: "save" });
    if (out) out.auto_saved = new Date(now).toISOString();
    return true;
  } catch (e) {
    if (out) out.auto_save_failed = `the model didn't save itself: ${e instanceof Error ? e.message : String(e)}; save it (revit_file save)`;
    return false;
  }
}
