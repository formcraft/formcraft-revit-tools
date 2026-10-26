import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, configPath, loadConfig } from "../fmc/policy.js";
import { COMMAND_GROUPS, LEVELS, Level, NEVER, USER_LINE, aiVerdict, generalState, modelParts, projectCode, projectKey } from "../fmc/aiuse.js";
import { formcraftDir, loadAiConfig, loadRulebook, loadState, readQueue, setStatus } from "../fmc/aiuse_io.js";

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
    "AI switch (On, Off, Stopped) is the one setting users see: status says its state for the open model's project.";

export const FMC_AI_SHAPE = {
  action: z.enum(["status", "queue", "stop"]),
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
      state: state3, project: key || null, mode: ai?.mode ?? "strict", compliant: !active?.title || !!projectCode(active.title), section: ai ? "present" : "missing (the AI switch creates it)",
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
    if (args.action === "queue") return reply({ queue: readQueue().slice(0, 50) });
    let active: any = null;
    try { active = (await withRevitConnection((c) => c.sendRaw("fmc_document_info", {})))?.active ?? null; } catch { /* the policy still reads */ }
    return reply(policySummary(config, active));
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcAiTool(server: McpServer) {
  server.tool("fmc_ai", FMC_AI_DESCRIPTION, FMC_AI_SHAPE, (args) => runFmcAi(args));
}

/**
 * The pane's own commands (CLI only, never MCP tools): a person approves or rejects a batch, resumes after Stop AI,
 * and the BIM Manager sets the switch, involvement and levels. `by` is the Windows user the pane runs as.
 */
export function paneAi(command: string, input: Record<string, unknown>, by: string) {
  const id = String(input.id ?? "");
  switch (command) {
    case "ai_approve": return setStatus(id, "approved", by) ?? { error: `No batch ${id} in the queue` };
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
      cur.changed = { by, at: new Date().toISOString() };
      raw.ai_modeller = cur;
      fs.writeFileSync(file, JSON.stringify(raw, null, 2));
      return { saved: true, ai_modeller: cur };
    }
  }
  return { error: `Unknown command ${command}` };
}
