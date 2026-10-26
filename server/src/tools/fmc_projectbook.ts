import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { loadConfig } from "../fmc/policy.js";
import { Actor, Edit, applyEdit, checklist, findInBook, newBook, progressOf, summary } from "../fmc/projectbook.js";
import { bookPaths, loadBook, loadRoles, projectFolderFrom, qaFailing, saveBook } from "../fmc/projectbook_io.js";
import { readRulebooks } from "./fmc_qa.js";

export const FMC_PROJECTBOOK_DESCRIPTION =
  "The project book (docs/PROJECT_BOOK.md): the project's team and roles, decisions, notes and ideas, progress, " +
  "threads and checklists, in 01_WIP\\FMC_Project_Book.json. Read it first when you start work on a project (get); " +
  "if it's missing, offer to create it (create, dry run first). As you work: note, idea, progress, propose (a decision " +
  "for a person to make); open a thread per task (thread_start) and end it with your report (thread_end: what you did, " +
  "what was slow, a faster way next time). checklist: a role's tasks for a stage (script-checked items pass from the " +
  "latest QA run); tick and submit for review. You act as an agent: roles, decisions and reviews stay with people.";

export const FMC_PROJECTBOOK_SHAPE = {
  action: z.enum(["get", "find", "checklist", "create", "note", "idea", "progress", "report", "propose", "thread_start", "thread_end", "tick", "submit"]),
  project_folder: z.string().optional().describe("The project folder (above 01_WIP); default: the active model's project"),
  q: z.string().optional().describe("find: an id (D3, N12, T2, a name) or words"),
  text: z.string().optional(),
  thread: z.string().optional().describe("A thread id (T1…) for a note"),
  id: z.string().optional().describe("thread_end: the thread id"),
  title: z.string().optional().describe("thread_start: what the task is"),
  report: z.string().optional().describe("thread_end: your task report"),
  role: z.string().optional(), stage: z.string().optional(), item: z.string().optional(), evidence: z.string().optional(),
  dry_run: z.boolean().optional().default(true).describe("create: report what would be made"),
};
export type FmcProjectBookArgs = z.infer<z.ZodObject<typeof FMC_PROJECTBOOK_SHAPE>>;

const reply = (body: object, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError });

async function activeModel(): Promise<{ title: string; path: string } | null> {
  try { const a = (await withRevitConnection((c) => c.sendRaw("fmc_document_info", {})))?.active; return a?.path ? { title: a.title, path: a.path } : null; }
  catch { return null; }
}

/** The project folder from the argument or the active model; and the model's title for the QA state. */
async function where(args: { project_folder?: string }) {
  if (args.project_folder) return { folder: projectFolderFrom(args.project_folder + "\\01_WIP\\x") || args.project_folder, model: "" };
  const m = await activeModel();
  return { folder: m ? projectFolderFrom(m.path) : "", model: m?.title ?? "" };
}

/** Shared by the MCP tool (actor: agent) and the pane's own command (actor: the Windows user, a person). */
export async function runProjectBook(args: Record<string, any>, actor: Actor) {
  const { config } = loadConfig();
  const { folder, model } = await where(args);
  if (!folder) return { error: "No project: open a model inside a project's 01_WIP, or give project_folder" };
  const { roles, problem: rolesProblem } = loadRoles(config);
  const loaded = loadBook(folder);

  if (args.action === "create") {
    if (loaded.book) return { error: `${folder} already has a project book` };
    const mp = bookPaths(folder).manifest;
    let manifest: { project: string; stage?: string };
    try { manifest = JSON.parse(fs.readFileSync(mp, "utf8").replace(/^﻿/, "")); } catch { return { error: `No project manifest at ${mp}: start the project first (fmc_project)` }; }
    const book = newBook(manifest, mp, actor.name);
    if (args.dry_run !== false) return { dry_run: true, would_create: loaded.path, project: book.project, next: "Run again with dry_run=false" };
    const s = saveBook(config, folder, book, { at: book.created, by: actor.name, kind: actor.kind, action: "create" });
    return s.ok ? { created: loaded.path, next: "A person adds the team and roles in the pane (Project book)" } : { error: s.reason };
  }
  if (!loaded.book) return { error: `${loaded.problem ?? "No project book"} at ${loaded.path}: create it (action create, dry run first)` };
  const book = loaded.book;

  if (args.action === "get") return { book: summary(book), path: loaded.path, roles_problem: rolesProblem };
  if (args.action === "find") return { results: findInBook(book, String(args.q ?? "")) };
  if (args.action === "checklist") {
    const role = String(args.role ?? ""), stage = String(args.stage ?? book.stage);
    const types: Record<string, string> = {};
    for (const r of readRulebooks(config.rulebooks_dir).rules as Array<{ id: string; check?: { type?: string } }>) types[r.id] = r.check?.type ?? "";
    const qa = qaFailing(config, model);
    const lines = checklist(book, roles, role, stage, types, qa.failing);
    return { role, stage, lines, progress: progressOf(lines), qa_run: qa.at ?? "none (run Check › QA for the script-checked items)", roles_problem: rolesProblem };
  }

  const edit = toEdit(args);
  if (!edit) return { error: `Unknown action ${args.action}` };
  const r = applyEdit(book, edit, actor, roles);
  if (!r.ok) return { refused: true, reason: r.reason };
  const s = saveBook(config, folder, r.book, r.journal);
  return s.ok ? { done: true, id: r.id } : { error: s.reason };
}

function toEdit(a: Record<string, any>): Edit | null {
  switch (a.action) {
    case "note": case "idea": case "progress": case "report": return { action: a.action, text: a.text ?? "", thread: a.thread };
    case "propose": return { action: "propose", text: a.text ?? "" };
    case "decide": return { action: "decide", text: a.text, id: a.id };
    case "thread_start": return { action: "thread_start", title: a.title ?? "" };
    case "thread_end": return { action: "thread_end", id: a.id ?? "", report: a.report ?? "" };
    case "set_member": return { action: "set_member", name: a.name ?? "", kind: a.kind === "agent" ? "agent" : "person", role: a.role ?? "", assists: a.assists };
    case "remove_member": return { action: "remove_member", name: a.name ?? "" };
    case "set_stage": return { action: "set_stage", stage: a.stage ?? "" };
    case "tick": return { action: "tick", role: a.role ?? "", stage: a.stage ?? "", item: a.item ?? "", evidence: a.evidence };
    case "submit": return { action: "submit", role: a.role ?? "", stage: a.stage ?? "" };
    case "review": return { action: "review", role: a.role ?? "", stage: a.stage ?? "", item: a.item ?? "", approve: a.approve === true, comment: a.comment };
  }
  return null;
}

export async function runFmcProjectBook(args: FmcProjectBookArgs) {
  try {
    const r = await runProjectBook(args, { name: `AI for ${process.env.USERNAME || "the user"}`, kind: "agent" });
    return reply(r, "error" in r || "refused" in r);
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, true);
  }
}

export function registerFmcProjectBookTool(server: McpServer) {
  server.tool("fmc_projectbook", FMC_PROJECTBOOK_DESCRIPTION, FMC_PROJECTBOOK_SHAPE, (args) => runFmcProjectBook(args));
}
