import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardConfig, checkWritePath, csvLine, expandEnv } from "./policy.js";
import { AIUSE_FILES, AiModellerConfig, AiRulebook, AiState, batchKey, parseConfig, pickAiRulebook, projectFolderOf } from "./aiuse.js";

const win = path.win32;

/** %APPDATA%\Formcraft: the AI modeller's state, queue and Stop switch live beside fmc_guard.json, on this PC. */
export function formcraftDir(env: NodeJS.ProcessEnv = process.env): string {
  return win.join(env.APPDATA || win.join(os.homedir(), "AppData", "Roaming"), "Formcraft");
}

/**
 * The AI-modeller rulebook (F-041): FMC_Rulebook_AIUse.json, else the kit's FMC_Rulebook_ClaudeUse.json (see
 * AIUSE_FILES). `file` is the full path of the file read (or, when none is usable, the first one found); `section` says
 * where in it the AI-modeller section was.
 */
export function loadRulebook(cfg: GuardConfig): { book: AiRulebook | null; file: string; section: string; problems: string[] } {
  const dir = expandEnv(cfg.rulebooks_dir);
  const present: Array<{ name: string; raw: string }> = [];
  for (const name of AIUSE_FILES) {
    const p = win.join(dir, name);
    try { if (fs.existsSync(p)) present.push({ name, raw: fs.readFileSync(p, "utf8") }); }
    catch (e) { return { book: null, file: p, section: "", problems: [`${name}: ${e instanceof Error ? e.message : String(e)}`] }; }
  }
  const r = pickAiRulebook(present);
  return { book: r.book, file: r.file ? win.join(dir, r.file) : win.join(dir, AIUSE_FILES[0]), section: r.section,
    problems: r.problems.length ? [...r.problems.map((p) => `${p} (a kit change request)`)] : [] };
}

/** The ai_modeller section of fmc_guard.json, with Stop AI from the pane's switch file too. */
export function loadAiConfig(cfg: GuardConfig, env: NodeJS.ProcessEnv = process.env): AiModellerConfig | null {
  const ai = parseConfig((cfg as unknown as { ai_modeller?: unknown }).ai_modeller);
  if (ai && fs.existsSync(win.join(formcraftDir(env), "ai_stop"))) ai.stop = true;
  return ai;
}

const stateFile = (env: NodeJS.ProcessEnv) => win.join(formcraftDir(env), "ai_state.json");
export function loadState(env: NodeJS.ProcessEnv = process.env): AiState {
  try { const s = JSON.parse(fs.readFileSync(stateFile(env), "utf8")); if (s && typeof s.day === "string" && s.models) return s; } catch { /* first run */ }
  return { day: "", models: {} };
}
export function saveState(s: AiState, env: NodeJS.ProcessEnv = process.env) {
  fs.mkdirSync(formcraftDir(env), { recursive: true });
  fs.writeFileSync(stateFile(env), JSON.stringify(s, null, 2));
}

/** One batch waiting for (or given) a person's approval: %APPDATA%\Formcraft\ai_queue\<key>.json. */
export interface QueueItem {
  id: string; command: string; model: string; path: string; group: string; elements: number; summary: string;
  created: string; status: "pending" | "approved" | "rejected" | "used"; by?: string; at?: string;
  /** Owner 26 Oct: an approved batch runs from the pane; its outcome, for the person and the AI. */
  result?: "done" | "failed"; detail?: string; ran_at?: string;
}

/** One queue item with its parameters (what the batch sends to Revit). */
export function readItem(id: string, env: NodeJS.ProcessEnv = process.env): (QueueItem & { params?: unknown }) | null {
  try { return JSON.parse(fs.readFileSync(queueFile(id.replace(/[^0-9a-f]/gi, ""), env), "utf8")); } catch { return null; }
}

/** Records how an approved batch went when the pane ran it. */
export function setResult(id: string, result: "done" | "failed", detail: string, env: NodeJS.ProcessEnv = process.env, now = new Date()) {
  const file = queueFile(id.replace(/[^0-9a-f]/gi, ""), env);
  try {
    const item = JSON.parse(fs.readFileSync(file, "utf8"));
    item.result = result; item.detail = detail.slice(0, 500); item.ran_at = now.toISOString();
    fs.writeFileSync(file, JSON.stringify(item, null, 2));
  } catch { /* the log still has the run */ }
}
export const queueDir = (env: NodeJS.ProcessEnv = process.env) => win.join(formcraftDir(env), "ai_queue");
const queueFile = (id: string, env: NodeJS.ProcessEnv) => win.join(queueDir(env), id + ".json");

export function readQueue(env: NodeJS.ProcessEnv = process.env): QueueItem[] {
  try {
    return fs.readdirSync(queueDir(env)).filter((f) => f.endsWith(".json"))
      .map((f) => { try { return JSON.parse(fs.readFileSync(win.join(queueDir(env), f), "utf8")) as QueueItem; } catch { return null; } })
      .filter((x): x is QueueItem => !!x).sort((a, b) => b.created.localeCompare(a.created));
  } catch { return []; }
}

/** Queues a batch for approval (once: the same batch keeps its id). */
export function enqueue(command: string, params: unknown, docPath: string, model: string, group: string, elements: number,
  env: NodeJS.ProcessEnv = process.env, now = new Date()): QueueItem {
  const id = batchKey(command, params, docPath);
  const file = queueFile(id, env);
  try { const old = JSON.parse(fs.readFileSync(file, "utf8")) as QueueItem; if (old.status === "pending" || old.status === "approved") return old; } catch { /* new */ }
  const item: QueueItem = { id, command, model, path: docPath, group, elements, summary: summarise(command, params), created: now.toISOString(), status: "pending" };
  fs.mkdirSync(queueDir(env), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...item, params }, null, 2));
  return item;
}

/** An approved, unused approval for exactly this batch. */
export function approvalFor(command: string, params: unknown, docPath: string, env: NodeJS.ProcessEnv = process.env): QueueItem | null {
  try {
    const item = JSON.parse(fs.readFileSync(queueFile(batchKey(command, params, docPath), env), "utf8")) as QueueItem;
    return item.status === "approved" ? item : null;
  } catch { return null; }
}

/** Marks an item; used by the pane (approve, reject) and after a run (used). Never offered as an MCP tool. */
export function setStatus(id: string, status: QueueItem["status"], by: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): QueueItem | null {
  const file = queueFile(id.replace(/[^0-9a-f]/gi, ""), env);
  try {
    const item = JSON.parse(fs.readFileSync(file, "utf8"));
    item.status = status; item.by = by; item.at = now.toISOString();
    fs.writeFileSync(file, JSON.stringify(item, null, 2));
    return item;
  } catch { return null; }
}

function summarise(command: string, params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>;
  const lists = Object.entries(p).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${(v as unknown[]).length} ${k}`);
  return `${command}${lists.length ? ": " + lists.join(", ") : ""}`;
}

/** One line per AI batch (v2 "Log"): when, model, group, elements, level, approver, result. Never ranks people (14.5). */
export function logBatch(cfg: GuardConfig, row: { model: string; path: string; command: string; group: string; level: string; elements: number;
  approved_by: string; result: string; detail: string }, now = new Date()) {
  try {
    const project = projectFolderOf(row.path);
    const inQa = project ? win.join(project, "06_QA") : "";
    // The project's 06_QA where the guard allows it (rule 2), otherwise the plugin's own reports folder.
    const dir = inQa && checkWritePath(win.join(inQa, "FMC_AI_Modeller_Log.csv"), cfg, { checkName: false }).ok ? inQa : expandEnv(cfg.reports_dir);
    const file = win.join(dir, "FMC_AI_Modeller_Log.csv");
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "model", "command", "group", "level", "elements", "approved_by", "result", "detail"]));
    fs.appendFileSync(file, csvLine([now.toISOString(), row.model, row.command, row.group, row.level, row.elements, row.approved_by, row.result, row.detail]));
  } catch { /* logging never blocks the work */ }
}
