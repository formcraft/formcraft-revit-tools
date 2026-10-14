/**
 * Workshare (board manage/PaneWorkshare, U20). Pure.
 *
 *   MAN 4.6   workset names [Role]_[Content], e.g. A_Facade; Z_ for shared content (Z_Grids_Levels, Z_Links_<Role>)
 *   MAN 9.10  the standard set: Z_Grids_Levels, Z_Links_<Role> for each linked role, <Role>_Shell, _Interior, _Site
 *   Rule 6    workshared models are never saved or synchronised by a tool: the pane prepares the sync, a person syncs
 */
import { ROLE_CODES } from "./policy.js";

export interface WorksetFact { id: number; name: string; owner: string; open: boolean; editable: boolean; default_visible: boolean }

export function worksetNameProblems(name: string): string[] {
  const n = name.trim();
  if (!n) return ["Name the workset"];
  const m = /^([A-Z]{1,2})_([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)$/.exec(n);
  if (!m) return [`${n} doesn't follow [Role]_[Content], e.g. A_Facade (MAN 4.6)`];
  if (!ROLE_CODES.includes(m[1])) return [`${m[1]} isn't a role code`];
  return [];
}

/** The standard set for a model of this role, linking these roles (MAN 9.10). */
export function standardSet(role: string, linkedRoles: string[]): string[] {
  const r = role.toUpperCase();
  const links = [...new Set(linkedRoles.map((x) => x.toUpperCase()).filter((x) => x && x !== r))].sort();
  const own = r === "Z" ? [] : [`${r}_Shell`, `${r}_Interior`, `${r}_Site`];
  return ["Z_Grids_Levels", ...links.map((x) => `Z_Links_${x}`), ...own];
}

export function missingFromSet(existing: string[], set: string[]): string[] {
  const have = new Set(existing.map((e) => e.toLowerCase()));
  return set.filter((s) => !have.has(s.toLowerCase()));
}

/** Revit's default names (Workset1, Shared Levels and Grids) are renamed into the standard, not kept. */
export function auditWorksets(worksets: WorksetFact[]): Array<{ name: string; problem: string }> {
  return worksets.map((w) => ({ name: w.name, problem: worksetNameProblems(w.name)[0] ?? "" }));
}

export interface SyncMessageInput { project: string; role: string; revision: string; worked: string[]; raised: string[]; what: string; who: string }

/** Fixed format: project | role | revision | Worked: items | New: items | what | who. */
export function syncMessage(m: SyncMessageInput): string {
  const parts = [m.project || "PROJ", m.role || "?", m.revision || "No revision"];
  if (m.worked.length) parts.push("Worked: " + m.worked.join(", "));
  if (m.raised.length) parts.push("New: " + m.raised.join(", "));
  parts.push(m.what.trim().replace(/\s*\|\s*/g, " / "), m.who || "?");
  return parts.join(" | ");
}

export interface Preflight { check: string; state: "Pass" | "Warn" | "Fail" | "N/A"; detail: string }

export function preflight(f: { workshared: boolean; central: string; central_reachable: boolean | null; cloud: boolean; warnings: number;
  last_warnings: number | null; mine: string[] }): Preflight[] {
  if (!f.workshared) return [{ check: "Workshared", state: "N/A", detail: "This model isn't workshared: there is nothing to sync" }];
  const added = f.last_warnings === null ? null : f.warnings - f.last_warnings;
  return [
    { check: "Central model reachable", state: f.cloud ? "N/A" : f.central_reachable ? "Pass" : "Fail",
      detail: f.cloud ? "Cloud model: Revit checks it" : f.central_reachable ? "OK" : `Not reachable: ${f.central || "no central path"}` },
    { check: "Warnings added since your last check", state: added === null ? "N/A" : added > 0 ? "Warn" : "Pass",
      detail: added === null ? `${f.warnings} warnings (first check)` : added > 0 ? `+${added} (${f.warnings} now)` : `${f.warnings}, none added` },
    { check: "Worksets you're editing", state: f.mine.length ? "Warn" : "Pass", detail: f.mine.length ? `${f.mine.join(", ")}: relinquish after syncing` : "None" },
  ];
}
