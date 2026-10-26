import fs from "node:fs";
import path from "node:path";
import { GuardConfig, checkWritePath, expandEnv } from "./policy.js";
import { ProjectBook, Roles, parseBook } from "./projectbook.js";

const win = path.win32;

/** The book, its journal and the manifest live in the project's 01_WIP (CLM 2: tools write only in the write roots). */
export function bookPaths(projectFolder: string) {
  const wip = win.join(projectFolder, "01_WIP");
  return { book: win.join(wip, "FMC_Project_Book.json"), journal: win.join(wip, "FMC_Project_Journal.jsonl"), manifest: win.join(wip, "FMC_Project.json") };
}

/** The project folder of a model or of any path inside the project (the folder above 01_WIP), or "". */
export function projectFolderFrom(p: string): string {
  const segs = win.normalize(p).split("\\");
  const i = segs.findIndex((s) => s.toUpperCase() === "01_WIP");
  return i > 0 ? segs.slice(0, i).join("\\") : "";
}

export function loadBook(projectFolder: string): { book: ProjectBook | null; path: string; problem?: string } {
  const p = bookPaths(projectFolder).book;
  if (!fs.existsSync(p)) return { book: null, path: p, problem: "No project book yet" };
  const r = parseBook(fs.readFileSync(p, "utf8"));
  return { book: r.book, path: p, problem: r.problem };
}

/** Saves atomically (a temp file, then a rename) and appends the journal line; refused outside the write roots. */
export function saveBook(cfg: GuardConfig, projectFolder: string, book: ProjectBook, journal: Record<string, unknown> | undefined): { ok: boolean; reason?: string } {
  const { book: p, journal: j } = bookPaths(projectFolder);
  const v = checkWritePath(p, cfg, { checkName: false });
  if (!v.ok) return { ok: false, reason: v.reasons.join(" ") };
  fs.mkdirSync(win.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(book, null, 2));
  fs.renameSync(tmp, p);
  if (journal) fs.appendFileSync(j, JSON.stringify(journal) + "\n");
  return { ok: true };
}

/** The kit's role playbooks: FMC_Roles.json beside the FMC_Rulebook folder (rulebooks_dir). */
export function loadRoles(cfg: GuardConfig): { roles: Roles | null; path: string; problem?: string } {
  const p = win.normalize(win.join(expandEnv(cfg.rulebooks_dir), "..", "FMC_Roles.json"));
  try {
    const o = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
    if (!/^fmc-roles\//.test(String(o?.schema)) || !o.roles) return { roles: null, path: p, problem: "FMC_Roles.json has no roles (schema fmc-roles/0.1)" };
    return { roles: o as Roles, path: p };
  } catch {
    return { roles: null, path: p, problem: "The kit has no FMC_Roles.json yet (a kit change request; the proposal is docs/kit-proposals/FMC_Roles.json)" };
  }
}

/** The rule ids failing in the model's latest QA run (any gate), or null when QA hasn't run on it. */
export function qaFailing(cfg: GuardConfig, model: string): { failing: string[] | null; at?: string } {
  try {
    const h = JSON.parse(fs.readFileSync(win.join(expandEnv(cfg.reports_dir), "FMC_QA_History.json"), "utf8")) as Record<string, Array<{ at: string; failing: string[] }>>;
    const runs = Object.entries(h).filter(([k]) => k.split("|")[0] === model).flatMap(([, r]) => r).sort((a, b) => a.at.localeCompare(b.at));
    const last = runs[runs.length - 1];
    return last ? { failing: last.failing, at: last.at } : { failing: null };
  } catch {
    return { failing: null };
  }
}
