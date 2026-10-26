import { DocInfo, GuardConfig } from "./policy.js";
import { NEVER, PLACEABLE, USER_LINE, aiVerdict, batchSize, recordBatch } from "./aiuse.js";
import { approvalFor, claimApproval, enqueue, loadAiConfig, loadRulebook, loadState, logBatch, saveState } from "./aiuse_io.js";

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
  const elements = batchSize(params);
  const approval = approvalFor(command, params, active.path, env);
  const v = aiVerdict({ command, doc: active, elements, approved: !!approval }, cfg, book, ai, loadState(env));
  if (!v.ok) {
    let reason = `AI-assisted modeller: ${v.reasons[0]}.`;
    if (v.needs_approval) {
      const item = enqueue(command, params, active.path, active.title, v.group ?? "", elements, env);
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
      try {
        const r = await exec();
        if (book) saveState(recordBatch(loadState(env), active.path, elements, false, book), env);
        logBatch(cfg, { ...row, result: "done", detail: v.band ?? "" });
        return r;
      } catch (e) {
        // F-030: a batch still running past the answer limit has not failed; count it, log it with its job id.
        if ((e as { code?: string })?.code === "FMC-JOB-RUNNING") {
          if (book) saveState(recordBatch(loadState(env), active.path, elements, false, book), env);
          logBatch(cfg, { ...row, result: "running", detail: `job ${(e as { job?: string }).job ?? ""}` });
          throw e;
        }
        if (book) saveState(recordBatch(loadState(env), active.path, elements, true, book), env);
        logBatch(cfg, { ...row, result: "failed", detail: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
  };
}
