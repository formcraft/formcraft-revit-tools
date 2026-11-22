/**
 * The no-AI runner (Run-FmcBatch.mjs) lives outside this repo. A library step is:
 * {"tool":"library","id":"...","arguments":{...},"background":true}
 * --preview-only is dry_run. References are filled from the manifest. revit_version, workshared_safe
 * and target_doc_rules are checked before apply. background submits and polls; it does not block in a tight loop.
 */
import type { DocFacts, ScriptManifest } from "./scriptlib.js";
import { applyProblems } from "./scriptlib.js";

export interface LibraryStep {
  tool: "library";
  id: string;
  arguments?: Record<string, unknown>;
  background?: boolean;
}

export interface PreparedLibraryStep {
  tool: "fmc_library";
  action: "run" | "submit";
  id: string;
  arguments: Record<string, unknown>;
  dry_run: boolean;
  mode: "preview" | "apply" | "offline";
  background: boolean;
  problems: string[];
}

export interface PrepareOptions {
  previewOnly?: boolean;
  revitVersion?: string;
  document?: DocFacts;
}

function fillReferences(args: Record<string, unknown>, manifest: ScriptManifest): Record<string, unknown> {
  const given = args.references && typeof args.references === "object" && !Array.isArray(args.references)
    ? args.references as Record<string, unknown> : {};
  const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);
  return {
    ...args,
    references: {
      kit: text(given.kit, manifest.references.kit),
      standards: text(given.standards, manifest.references.standards),
      rulebook: text(given.rulebook, manifest.references.rulebook),
    },
  };
}

/** Build the fmc_library call. previewOnly forces a dry run. Apply is refused when the manifest checks fail. */
export function prepareLibraryStep(step: LibraryStep, manifest: ScriptManifest, opts: PrepareOptions = {}): PreparedLibraryStep {
  const args = fillReferences({ ...(step.arguments ?? {}) }, manifest);
  const asked = typeof args.mode === "string" ? args.mode : "";
  const preview = opts.previewOnly === true || args.dry_run === true || asked === "preview";
  const mode: PreparedLibraryStep["mode"] = preview ? "preview" : asked === "offline" ? "offline" : "apply";
  const dry_run = mode !== "apply";
  const problems = mode === "apply" ? applyProblems(manifest, { revitVersion: opts.revitVersion, document: opts.document }) : [];
  return {
    tool: "fmc_library",
    action: step.background === true ? "submit" : "run",
    id: step.id,
    arguments: { ...args, dry_run, mode },
    dry_run,
    mode,
    background: step.background === true,
    problems,
  };
}

/** First wait 5 s, then 10, 15, 20, 25, and 30 s after that. */
export function pollDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(30_000, 5_000 * (n + 1));
}

const SETTLED = new Set(["finished", "failed", "cancelled", "interrupted"]);

export interface PollStatus {
  state: string;
  result_ref?: string;
  error?: string;
}

/**
 * Poll a background library job. The wait starts at 5 s and backs off to 30 s.
 * Each settled job writes its result_ref into the runner log.
 */
export async function pollBackgroundJob(opts: {
  job_id: string;
  status: (jobId: string) => Promise<PollStatus> | PollStatus;
  sleep: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  maxPolls?: number;
}): Promise<PollStatus> {
  const max = opts.maxPolls ?? 10_000;
  for (let attempt = 0; attempt < max; attempt++) {
    const row = await opts.status(opts.job_id);
    if (SETTLED.has(row.state)) {
      const ref = row.result_ref ? ` result_ref ${row.result_ref}` : "";
      opts.log?.(`job ${opts.job_id} ${row.state}${ref}`);
      return row;
    }
    const wait = pollDelayMs(attempt);
    opts.log?.(`job ${opts.job_id} ${row.state}; wait ${wait} ms`);
    await opts.sleep(wait);
  }
  return { state: "running", error: `Stopped polling ${opts.job_id} after ${max} waits. It was not failed.` };
}

/**
 * Wait while Revit is not idle. A not-idle answer is a wait, not a failure.
 * Cancel stops the wait. The delay matches the batch poll.
 */
export async function waitWhileBusy(opts: {
  isIdle: () => boolean;
  cancelled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  heartbeat?: () => void;
  maxWaits?: number;
}): Promise<"idle" | "cancelled"> {
  let attempt = 0;
  const max = opts.maxWaits ?? 10_000;
  while (!opts.isIdle()) {
    if (opts.cancelled()) return "cancelled";
    if (attempt >= max) return "idle";
    const wait = pollDelayMs(attempt);
    opts.log?.(`[FMC-REVIT-NOT-IDLE] Revit is not idle. Waiting ${wait} ms. Not a failure.`);
    opts.heartbeat?.();
    await opts.sleep(wait);
    attempt += 1;
    if (opts.cancelled()) return "cancelled";
  }
  return "idle";
}
