import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { jobMaxMs } from "../utils/SocketClient.js";
import { GuardConfig, configPath, loadConfig } from "../fmc/policy.js";
import { COMMAND_GROUPS, LEVELS, Level, NEVER, USER_LINE, aiVerdict, generalState, modelParts, projectCode, projectKey } from "../fmc/aiuse.js";
import { formcraftDir, loadAiConfig, loadRulebook, loadState, readItem, readQueue, setResult, setStatus } from "../fmc/aiuse_io.js";
import { readUsage, summariseUsage } from "../fmc/usage.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_AI_DESCRIPTION =
  "The AI-assisted modeller (Manual Part 18 change request, docs/AI_ASSISTED_MODELLER.md). status: whether AI may " +
    "change the model, and why: the firm and project switch, the involvement band, each operation group's level " +
    "(Off, Suggest, Fix with approval, Auto in WIP), the limits and today's use. queue: batches waiting for the " +
    "author's approval. stop: Stop AI, refusing every AI change until a person resumes it in the pane. Approving a " +
    "batch, resuming and changing the settings are done by a person in the pane, never through this tool. The General " +
    "AI switch (On, Off, Stopped) is the one setting users see: status says its state for the open model's project. " +
    "An approved batch runs from the pane when the person approves it: check queue (status, result) before sending a " +
    "batch again. usage: facts about every tool call by build (calls, median time, failures), for your own experience " +
    "report; write that report yourself, from what you experienced: this tool gives facts, not the report. " +
    "wait (owner 26 Oct): after a batch is queued for approval, call wait with its id instead of ending your turn; it " +
    "holds until the person approves or rejects (no tokens are spent while it holds). If it says still waiting, call it " +
    "again. When it says done, go straight on with the next batch of your plan: don't end your turn while work remains " +
    "and the switch is On. With access full (status says), every tool is yours like a person's, each batch approved: " +
    "never tell the person to do something themselves when a tool can do it; where no tool covers it and allow_code is " +
    "on, propose a send_code_to_revit batch (the person sees the code before approving); otherwise say which tool is " +
    "missing so it can be built.";

export const FMC_AI_SHAPE = {
  action: z.enum(["status", "queue", "stop", "usage", "wait"]),
  id: z.string().optional().describe("wait: the batch id from the queue message"),
  timeout_s: z.number().int().min(1).max(55).optional().default(50).describe("wait: how long to hold, at most 55 s; call again while it says waiting"),
  since: z.string().optional().describe("usage: from this time (ISO); default: everything recorded"),
};

export type FmcAiArgs = z.infer<z.ZodObject<typeof FMC_AI_SHAPE>>;

/** The policy for the document a call works on, one line per group. */
export function policySummary(config: GuardConfig, active: any) {
  const { book, file, section, problems } = loadRulebook(config);
  const ai = loadAiConfig(config);
  const state = loadState();
  const groups = book ? Object.entries(book.groups).map(([id, g]) => {
    const command = Object.entries(COMMAND_GROUPS).find(([, gr]) => gr === id)?.[0];
    const v = command && active ? aiVerdict({ command, doc: active, elements: 1, approved: true }, config, book, ai, state) : null;
    return { group: id, name: g.name, auto_allowed: g.auto_allowed, level: ai?.levels[id] ?? "Suggest",
      tools: Object.entries(COMMAND_GROUPS).filter(([, gr]) => gr === id).map(([c]) => c),
      allowed_now: v?.ok ?? false, why: v ? (v.ok ? "allowed" : v.reasons[0]) : command ? "no document" : "no tool in this group yet" };
  }) : [];
  const { project, role } = active?.title ? modelParts(active.title) : { project: "", role: "" };
  const p = ai?.projects?.[project] ?? {};
  const state3 = active?.title ? generalState(ai, active.title, active.path ?? "") : ai?.stop ? "Stopped" : "Off";
  // Testing mode keys a non-compliant model by its project folder or file name; strict mode needs the FMC project code.
  const key = active?.title ? projectKey(active.title, active.path ?? "", ai?.mode) : "";
  return {
    // The one setting users see (owner 26 Oct): the plain state and line for the open model's project.
    general: {
      state: state3, project: key || null, mode: ai?.mode ?? "strict", access: ai?.access ?? "general", allow_code: ai?.allow_code ?? false, auto_approve: ai?.mode === "testing" && ai?.auto_approve === true, compliant: !active?.title || !!projectCode(active.title), section: ai ? "present" : "missing (the AI switch creates it)",
      rulebook_general: !!book?.general, covers: book?.general?.groups ?? [],
      line: state3 === "On" ? "AI is on for this project: every change waits for your approval." : state3 === "Stopped" ? USER_LINE.stopped
        : active?.title && !key ? USER_LINE.notCompliant : USER_LINE.off,
    },
    on: !!ai && !!book && !ai.stop && (p.on ?? ai.on), stop: ai?.stop ?? false,
    rulebook: book ? file : null, rulebook_read: file ? `${win.basename(file)}${section ? ` (${section})` : " (no AI-modeller section)"}` : null,
    rulebook_problems: problems,
    guard_section: ai ? "present" : "missing: AI-assisted modelling is Off",
    model: active?.title ?? null, project, role,
    involvement: p.involvement ?? ai?.involvement ?? book?.default_involvement ?? 0,
    limits: book?.limits ?? null, today: state.models[(active?.path ?? "").toLowerCase()] ?? null,
    groups, never: NEVER,
  };
}

export async function runFmcAi(args: FmcAiArgs) {
  const { config } = loadConfig();
  try {
    if (args.action === "stop") {
      fs.mkdirSync(formcraftDir(), { recursive: true });
      fs.writeFileSync(win.join(formcraftDir(), "ai_stop"), new Date().toISOString());
      return reply({ stopped: true, next: "Every AI change is refused until a person resumes it in the pane (Admin › AI involvement)" });
    }
    if (args.action === "queue") return reply({ queue: withEstimates(readQueue().slice(0, 50)) });
    if (args.action === "usage") return reply(summariseUsage(readUsage(), args.since));
    if (args.action === "wait") return reply(await waitFor(String(args.id ?? ""), args.timeout_s ?? 50));
    const doc = await activeDocument((ms) => withRevitConnection((c) => c.sendRaw("fmc_document_info", {}, ms)));
    return reply({ ...policySummary(config, doc.active), document_source: doc.source });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

/**
 * The open document for status (owner 26 Oct: status took 30 s, and after a restart said "no document" and Off). A short
 * ask, a few tries while Revit is still opening the model, then the last document seen (kept on every good answer).
 */
export async function activeDocument(ask: (timeoutMs: number) => Promise<any>, tries = 4, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  file = win.join(formcraftDir(), "last_document.json")): Promise<{ active: any; source: string }> {
  for (let i = 0; i < tries; i++) {
    try {
      const active = (await ask(6000))?.active ?? null;
      if (active?.title) {
        try { fs.writeFileSync(file, JSON.stringify({ active, at: new Date().toISOString() })); } catch { /* status still answers */ }
        return { active, source: "revit" };
      }
    } catch { /* Revit busy or starting */ }
    if (i + 1 < tries) await sleep(2000);
  }
  try {
    const last = JSON.parse(fs.readFileSync(file, "utf8"));
    if (last?.active?.title) return { active: last.active, source: `last seen ${last.at}: Revit didn't answer now (busy or still opening the model)` };
  } catch { /* none kept */ }
  return { active: null, source: "none: no model is open in Revit, or Revit didn't answer" };
}

/**
 * Holds until a queued batch is decided (owner 26 Oct: the AI stayed idle after approvals). Approve runs the batch from
 * the pane, so "done" means the change is in the model and the AI should continue with its plan.
 */
export async function waitFor(id: string, timeoutS: number, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now()) {
  if (!id) return { error: "Give the batch id (from the queue message)" };
  const until = now() + Math.max(1, Math.min(55, timeoutS)) * 1000;
  const started = now();
  for (;;) {
    const item = readItem(id);
    if (!item) return { error: `No batch ${id} in the queue` };
    const waited_s = Math.round((now() - started) / 1000);
    if (item.status === "rejected") return { id, status: "rejected", waited_s, next: "The person rejected it: ask what to change, or move on to the next batch of your plan." };
    if (item.result === "done") return { id, status: "done", detail: item.detail, waited_s, next: "Done in the model: go straight on with the next batch of your plan." };
    if (item.result === "failed") return { id, status: "failed", detail: item.detail, waited_s, next: "Approved, but it didn't run: fix the cause and queue it again, or tell the person why." };
    if (item.result === "running") return { id, status: "running", detail: item.detail, waited_s, next: "Revit is still placing it: check fmc_job status with the job id in detail, then go on." };
    if (now() >= until) return { id, status: item.status === "approved" ? "running" : "waiting", waited_s, next: "Still waiting: call wait again (no tokens are spent while it holds)." };
    await sleep(1000);
  }
}

/** Owner 26 Oct: each waiting batch gets an estimate from past runs of the same command (median time per element). */
export function withEstimates<T extends { command: string; elements: number }>(items: T[]): Array<T & { estimate_s?: number }> {
  const lines = readUsage().filter((l) => l.ok);
  return items.map((it) => {
    const past = lines.filter((l) => l.tool === it.command || l.action === it.command).map((l) => l.ms);
    if (!past.length) return it;
    const s = [...past].sort((a, b) => a - b)[Math.floor(past.length / 2)];
    return { ...it, estimate_s: Math.max(1, Math.round((s / 1000) * Math.max(1, it.elements / 10))) };
  });
}

export function registerFmcAiTool(server: McpServer) {
  server.tool("fmc_ai", FMC_AI_DESCRIPTION, FMC_AI_SHAPE, (args) => runFmcAi(args));
}

/**
 * The pane's own commands (CLI only, never MCP tools): a person approves or rejects a batch, resumes after Stop AI,
 * and the BIM Manager sets the switch, involvement and levels. `by` is the Windows user the pane runs as.
 */
export async function paneAi(command: string, input: Record<string, unknown>, by: string) {
  const id = String(input.id ?? "");
  switch (command) {
    case "ai_approve": {
      // Owner 26 Oct: Approve runs the batch now, through the same gate (approval, limits, Stop AI); no AI needed.
      const item = readItem(id);
      if (!setStatus(id, "approved", by) || !item) return { error: `No batch ${id} in the queue` };
      try {
        // The long-job route (owner 26 Oct): a batch Revit is still placing is waited for on its heartbeats, not 10 s.
        const answer = await withRevitConnection((c) => c.sendCommand(item.command, item.params ?? {}, jobMaxMs(), { ceilingMs: jobMaxMs() }));
        // The AI asked for the new element ids from wait (owner 26 Oct): Revit's answer, kept short.
        setResult(id, "done", `${item.summary} · ${item.model} · ${JSON.stringify(answer ?? {}).slice(0, 4000)}`);
        return { approved: true, ran: true, result: "done", message: `Approved and done: ${item.summary} (${item.elements} elements) in ${item.model}.` };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Still running in Revit is not a failure: the answer lands in the late-results file (fmc_job result).
        if ((e as any)?.code === "FMC-JOB-RUNNING") {
          setResult(id, "running", msg);
          return { approved: true, ran: true, result: "running", message: `Approved; Revit is still placing it: ${item.summary}. Check fmc_job status for the result.` };
        }
        setResult(id, "failed", msg);
        return { approved: true, ran: false, result: "failed", message: `Approved, but it didn't run: ${msg}` };
      }
    }
    case "ai_reject": return setStatus(id, "rejected", by) ?? { error: `No batch ${id} in the queue` };
    case "ai_resume": {
      try { fs.unlinkSync(win.join(formcraftDir(), "ai_stop")); } catch { /* wasn't stopped */ }
      return { resumed: true, by };
    }
    case "ai_general": {
      // The General AI switch (owner 26 Oct): any user, per project. Creates the ai_modeller section with safe defaults
      // (everything off) the first time it is used. Stop AI still overrides it; admins keep Advanced (ai_config).
      if (typeof input.on !== "boolean") return { error: "Give on: true or false" };
      const project = typeof input.project === "string" && input.project ? input.project
        : typeof input.document === "string" ? projectCode(input.document) : "";
      if (!project) return { error: USER_LINE.notCompliant };
      const file = configPath();
      let raw: any = {};
      try { raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { return { error: `Can't read ${file}: the AI switch needs the guard file` }; }
      const created = !(raw.ai_modeller && typeof raw.ai_modeller === "object");
      const cur = created ? { on: false, stop: false, levels: {}, projects: {} } : raw.ai_modeller;
      cur.projects ??= {};
      cur.projects[project] = { ...(cur.projects[project] ?? {}), general: input.on };
      cur.changed = { by, at: new Date().toISOString(), what: `General AI switch ${input.on ? "On" : "Off"} for ${project}` };
      raw.ai_modeller = cur;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
      const stopped = fs.existsSync(win.join(formcraftDir(), "ai_stop")) || cur.stop === true;
      return { saved: true, created_section: created, project, state: stopped ? "Stopped" : input.on ? "On" : "Off",
        line: stopped ? USER_LINE.stopped : input.on ? "AI is on for this project: every change waits for your approval." : USER_LINE.off };
    }
    case "ai_config": {
      // The BIM Manager's settings into fmc_guard.json's ai_modeller section; everything else in the file is kept.
      const file = configPath();
      let raw: any = {};
      try { raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return { error: `Can't read ${file}: AI settings need the guard file` }; }
      const cur = raw.ai_modeller && typeof raw.ai_modeller === "object" ? raw.ai_modeller : { on: false, levels: {}, projects: {} };
      if (typeof input.on === "boolean") cur.on = input.on;
      if (typeof input.involvement === "number") cur.involvement = Math.max(0, Math.min(100, Math.round(input.involvement)));
      if (input.levels && typeof input.levels === "object")
        for (const [g, l] of Object.entries(input.levels as Record<string, unknown>)) if (LEVELS.includes(l as Level)) (cur.levels ??= {})[g] = l;
      if (typeof input.stop === "boolean") cur.stop = input.stop;
      if (input.access === "full" || input.access === "general") cur.access = input.access;
      if (typeof input.allow_code === "boolean") cur.allow_code = input.allow_code;
      if (typeof input.auto_approve === "boolean") cur.auto_approve = input.auto_approve;
      cur.changed = { by, at: new Date().toISOString() };
      raw.ai_modeller = cur;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
      return { saved: true, ai_modeller: cur };
    }
  }
  return { error: `Unknown command ${command}` };
}
