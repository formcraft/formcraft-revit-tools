/**
 * fmc_qa run: which document was evaluated, and where the report went.
 *
 * Two silent failures (Testing Bot, full sweep): run gave identical counts for four different models, and project_folder
 * was ignored, the report always landing in the reports folder. The add-in resolves the document named on the call; the server
 * now checks that the facts it got back are that document's (FMC-QA-DOCUMENT-MISMATCH) and says what was evaluated, and a
 * project_folder is either used or refused out loud (FMC-QA-PROJECT-FOLDER-REFUSED) with the reasons, never dropped silently.
 */
import path from "node:path";
import { checkWritePath, expandEnv, type GuardConfig } from "./policy.js";

const win = path.win32;

export const QA_DOCUMENT_MISMATCH = "FMC-QA-DOCUMENT-MISMATCH";
export const QA_PROJECT_FOLDER_REFUSED = "FMC-QA-PROJECT-FOLDER-REFUSED";

const stem = (s: string) => win.basename(s.trim().replace(/[\\/]+$/, "")).replace(/\.rvt$/i, "").toLowerCase();

/** Null when the facts came from the document that was asked for (or none was named: the active one); else the refusal. */
export function qaDocumentMismatch(requested: string | undefined, model: string): { code: string; message: string } | null {
  const want = (requested ?? "").trim();
  if (!want) return null;
  if (stem(want) === stem(model)) return null;
  return { code: QA_DOCUMENT_MISMATCH, message: `[${QA_DOCUMENT_MISMATCH}] fmc_qa run was asked to evaluate "${want}" but Revit answered with the facts of "${model}". Nothing was reported as a result for "${want}".` };
}

/** What the run evaluated, so two runs that look alike can be told apart. */
export function qaEvaluated(facts: { model: string; views: unknown[]; sheets: unknown[]; types: unknown[]; families: unknown[]; links: unknown[]; warnings: number }) {
  return { model: facts.model, views: facts.views.length, sheets: facts.sheets.length, types: facts.types.length, families: facts.families.length, links: facts.links.length, warnings: facts.warnings };
}

export interface QaReportPlace {
  report: string;
  /** What was asked and what happened to it; absent when no project_folder was given. */
  project_folder?: { requested: string; honoured: boolean; code?: string; reasons?: string[] };
  location: string;
}

/** The report goes in <project_folder>\06_QA\Health when the guard allows it; otherwise in the reports folder, and the reply says why. */
export function qaReportPlace(projectFolder: string | undefined, cfg: GuardConfig, name: string): QaReportPlace {
  const fallback = win.join(expandEnv(cfg.reports_dir), "QA", name);
  const asked = (projectFolder ?? "").trim();
  if (!asked) return { report: fallback, location: "reports_dir\\QA (no project_folder given)" };
  const wanted = win.join(expandEnv(asked), "06_QA", "Health", name);
  const verdict = checkWritePath(wanted, cfg, { checkName: false });
  if (verdict.ok) return { report: wanted, project_folder: { requested: asked, honoured: true }, location: "project_folder\\06_QA\\Health" };
  return {
    report: fallback,
    project_folder: { requested: asked, honoured: false, code: QA_PROJECT_FOLDER_REFUSED, reasons: verdict.reasons },
    location: "reports_dir\\QA (project_folder refused, see project_folder.reasons)",
  };
}
