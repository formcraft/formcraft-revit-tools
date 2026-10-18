/**
 * Saved flows (X0): repeatable work across apps as a file, run from a button, the command line or a schedule, with no
 * AI and no credits. A flow is a list of steps, each a Formcraft tool and its arguments; a step may use an earlier
 * step's answer (${step.<name>.<path>}) or the run's variables (${var.<name>}).
 *
 * A flow run is a dry run unless asked otherwise: every step that has a dry_run argument gets the run's value, so a
 * dry-run flow never writes. A step that fails stops the flow, and the run record says where.
 */
import { z } from "zod";

export const FLOW = z.object({
  name: z.string().min(1).regex(/^[a-z0-9_]+$/, "a flow name is lower case letters, digits and _"),
  description: z.string().optional().default(""),
  /** Variables the run must give (e.g. role, batch_file); a run without one is refused before any step. */
  needs: z.array(z.string()).optional().default([]),
  steps: z.array(z.object({
    name: z.string().min(1).regex(/^[a-z0-9_]+$/),
    tool: z.string().regex(/^fmc_[a-z_]+$/, "a step runs a Formcraft tool (fmc_…)"),
    args: z.record(z.string(), z.any()).optional().default({}),
    /** Skip this step in a dry run (e.g. a gate that needs what the real run built). */
    real_only: z.boolean().optional().default(false),
  })).min(1),
});
export type Flow = z.infer<typeof FLOW>;

/** Tools a flow may not run: itself (no loops), and the pane-only acts that are always a person's. */
export const NOT_IN_FLOWS = new Set(["fmc_flow"]);

export type StepCall = (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; body: any }>;

export interface StepResult { name: string; tool: string; ok: boolean; skipped?: string; body?: any; error?: string; ms: number }
export interface FlowRun { flow: string; dry_run: boolean; ok: boolean; steps: StepResult[]; stopped_at?: string; started: string; ended: string }

function get(obj: any, dotted: string): unknown {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** ${var.x} and ${step.s.path} in a string; a string that is only one reference keeps the value's own type. */
export function fill(value: unknown, vars: Record<string, unknown>, steps: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const ref = (whole: string) => {
      const [kind, ...rest] = whole.split(".");
      const v = kind === "var" ? get(vars, rest.join(".")) : kind === "step" ? get(steps, rest.join(".")) : undefined;
      if (v === undefined) throw new Error(`\${${whole}} has no value`);
      return v;
    };
    const only = /^\$\{([a-z_]+\.[A-Za-z0-9_.]+)\}$/.exec(value);
    if (only) return ref(only[1]);
    return value.replace(/\$\{([a-z_]+\.[A-Za-z0-9_.]+)\}/g, (_, w) => String(ref(w)));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars, steps));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars, steps)]));
  return value;
}

export async function runFlow(flow: Flow, opts: { dryRun: boolean; vars?: Record<string, unknown>; call: StepCall; acceptsDryRun: (tool: string) => boolean }): Promise<FlowRun> {
  const vars = opts.vars ?? {};
  const started = new Date().toISOString();
  const run: FlowRun = { flow: flow.name, dry_run: opts.dryRun, ok: true, steps: [], started, ended: started };
  const missing = flow.needs.filter((n) => vars[n] === undefined || vars[n] === "");
  if (missing.length) {
    run.ok = false;
    run.stopped_at = "before the first step";
    run.steps.push({ name: "needs", tool: "", ok: false, error: `the run needs ${missing.join(", ")}`, ms: 0 });
    run.ended = new Date().toISOString();
    return run;
  }
  const done: Record<string, unknown> = {};
  for (const step of flow.steps) {
    const t0 = Date.now();
    if (NOT_IN_FLOWS.has(step.tool)) {
      run.steps.push({ name: step.name, tool: step.tool, ok: false, error: `${step.tool} can't run inside a flow`, ms: 0 });
      run.ok = false; run.stopped_at = step.name; break;
    }
    if (step.real_only && opts.dryRun) { run.steps.push({ name: step.name, tool: step.tool, ok: true, skipped: "real run only", ms: 0 }); continue; }
    let args: Record<string, unknown>;
    try { args = fill(step.args, vars, done) as Record<string, unknown>; }
    catch (e) {
      run.steps.push({ name: step.name, tool: step.tool, ok: false, error: e instanceof Error ? e.message : String(e), ms: 0 });
      run.ok = false; run.stopped_at = step.name; break;
    }
    if (opts.acceptsDryRun(step.tool)) args = { ...args, dry_run: opts.dryRun };
    try {
      const r = await opts.call(step.tool, args);
      done[step.name] = r.body;
      run.steps.push({ name: step.name, tool: step.tool, ok: r.ok, body: r.body, ms: Date.now() - t0, ...(r.ok ? {} : { error: String(r.body?.error ?? (r.body?.reasons ?? []).join("; ") ?? "failed") }) });
      if (!r.ok) { run.ok = false; run.stopped_at = step.name; break; }
    } catch (e) {
      run.steps.push({ name: step.name, tool: step.tool, ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
      run.ok = false; run.stopped_at = step.name; break;
    }
  }
  run.ended = new Date().toISOString();
  return run;
}

/** Flows that come with Formcraft. A project adds its own as <exchange>\Flows\<name>.flow.json. */
export const BUILTIN_FLOWS: Flow[] = [
  FLOW.parse({
    name: "health", description: "The self-test and the apps: what is installed, running and connected",
    steps: [{ name: "selftest", tool: "fmc_selftest", args: {} }, { name: "apps", tool: "fmc_apps", args: { action: "list" } }],
  }),
  FLOW.parse({
    name: "pack_rebuild", description: "Rebuild a discipline's families from its batch file, then Gate A on what was built",
    needs: ["batch_file"],
    steps: [
      { name: "build", tool: "fmc_recipe", args: { action: "batch", recipe_files: ["${var.batch_file}"] } },
      { name: "gate", tool: "fmc_recipe", args: { action: "batch_gate", batch: "${step.build.batch}" }, real_only: true },
    ],
  }),
  FLOW.parse({
    name: "chain_test", description: "A role's chain-test project: every staged family placed, tagged, scheduled",
    needs: ["role"],
    steps: [{ name: "chain", tool: "fmc_legend", args: { action: "chain", role: "${var.role}" } }],
  }),
  FLOW.parse({
    name: "robot_send", description: "The Revit analytical model to Robot with the engineer's supports and load cases",
    needs: ["supports", "cases", "engineer"],
    steps: [
      { name: "status", tool: "fmc_robot", args: { action: "status" } },
      { name: "send", tool: "fmc_robot", args: { action: "send", supports: "${var.supports}", cases: "${var.cases}", engineer: "${var.engineer}" } },
    ],
  }),
  FLOW.parse({
    name: "robot_results", description: "Robot's forces for a run back into the Revit model's FMC_FEA_ fields",
    needs: ["run"],
    steps: [{ name: "results", tool: "fmc_robot", args: { action: "results", run: "${var.run}" } }],
  }),
];
