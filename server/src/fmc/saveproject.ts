/**
 * The safe project save. revit_file action save does not check the caller's title and path, and it does not refuse a family.
 * This check does both, before fmc_revit_file save runs. The live-model lock and the batch lease still run on that save.
 */
export interface ProjectFile { title?: string; path?: string; isFamily?: boolean }

export type SaveVerdict = { ok: true } | { ok: false; message: string };

function normPath(p: string): string {
  return p.trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function sameProjectPath(a: string, b: string): boolean {
  const left = normPath(a);
  const right = normPath(b);
  return left.length > 0 && left === right;
}

export function projectSaveVerdict(expected: { title: string; path: string }, active: ProjectFile | null | undefined): SaveVerdict {
  const title = expected.title.trim();
  const path = expected.path.trim();
  if (!title || !path) return { ok: false, message: "[FMC-SAVE] title and path are both required. Nothing was saved." };
  if (/\.rfa$/i.test(path)) return { ok: false, message: "[FMC-SAVE] path is a family (.rfa). fmc_save_project saves a project only. Nothing was saved." };
  if (!active || (!active.title && !active.path)) return { ok: false, message: "[FMC-SAVE] That project is not open. Nothing was saved." };
  if (active.isFamily === true || /\.rfa$/i.test(active.path ?? "")) {
    return { ok: false, message: `[FMC-SAVE] ${active.title || active.path} is a family document. fmc_save_project saves a project only. Nothing was saved.` };
  }
  if ((active.title ?? "").trim().toLowerCase() !== title.toLowerCase()) {
    return { ok: false, message: `[FMC-SAVE] Open title is "${active.title ?? ""}", not "${title}". Nothing was saved.` };
  }
  if (!sameProjectPath(active.path ?? "", path)) {
    return { ok: false, message: `[FMC-SAVE] Open path is "${active.path ?? ""}", not "${path}". Nothing was saved.` };
  }
  return { ok: true };
}
