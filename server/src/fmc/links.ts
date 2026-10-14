/**
 * Links (board manage/PaneLinks, U20). Pure.
 *
 *   MAN 7.4  models are linked from 02_Shared only
 *   MAN 8.5  positioning is always Auto – By Shared Coordinates
 *   MAN 4.6  links sit on the workset Z_Links_<Role>
 * Links are pinned, attached as overlay so they don't nest, and use relative paths so the project can move.
 */
import path from "node:path";

const win = path.win32;

export interface LinkFact {
  id: number; name: string; path: string; path_type: string; attachment: string; loaded: boolean; pinned: boolean; workset: string;
}

export interface LinkAudit { id: number; model: string; problems: string[]; state: "OK" | "Fix" }

/** Role from a container name: [Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number]. */
export function roleOf(file: string): string {
  const parts = win.basename(file).replace(/\.rvt$/i, "").split("-");
  return parts.length >= 7 ? parts[5].toUpperCase() : "";
}

export function inShared(p: string): boolean {
  return p.split(/[\\/]+/).some((s) => s.toLowerCase() === "02_shared");
}

export function auditLinks(links: LinkFact[], workshared: boolean, worksets: string[]): LinkAudit[] {
  return links.map((l) => {
    const problems: string[] = [];
    if (!l.pinned) problems.push("not pinned");
    if (!l.loaded) problems.push("not loaded");
    if (l.path && !inShared(l.path)) problems.push("not from 02_Shared");
    if (l.path_type && l.path_type !== "Relative") problems.push(`${l.path_type.toLowerCase()} path`);
    if (l.attachment === "Attachment") problems.push("attachment (use overlay)");
    if (workshared) {
      const want = `Z_Links_${roleOf(l.name) || "<Role>"}`;
      if (l.workset !== want) problems.push(worksets.includes(want) ? `on ${l.workset || "?"}, not ${want}` : `workset ${want} missing`);
    }
    return { id: l.id, model: l.name, problems, state: problems.length ? "Fix" : "OK" };
  });
}

export interface Candidate { path: string; name: string; role: string; linked: boolean; own: boolean }

/** Models in the Link-from folder: which are linked already, and which is this model itself. */
export function candidates(files: string[], links: LinkFact[], currentModel: string): Candidate[] {
  const linked = new Set(links.map((l) => win.basename(l.path || l.name).toLowerCase()));
  return files
    .filter((f) => /\.rvt$/i.test(f) && !/\.\d{4}\.rvt$/i.test(f))
    .map((f) => {
      const name = win.basename(f);
      return { path: f, name, role: roleOf(name), linked: linked.has(name.toLowerCase()), own: name.toLowerCase() === currentModel.toLowerCase() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Why a model can't be linked from here (empty when it can). */
export function linkProblems(file: string, currentModel: string): string[] {
  const out: string[] = [];
  if (!win.isAbsolute(file)) out.push(`${file}: path must be absolute`);
  if (!/\.rvt$/i.test(file)) out.push(`${file}: only .rvt models are linked`);
  if (!inShared(file)) out.push(`${win.basename(file)}: links come from 02_Shared only (MAN 7.4)`);
  if (win.basename(file).toLowerCase() === currentModel.toLowerCase()) out.push(`${win.basename(file)}: a model can't link itself`);
  return out;
}
