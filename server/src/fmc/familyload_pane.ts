/**
 * BSF-3: the pane's (a person's) side of a family overwrite: list, approve, reject. Called from cli.ts only (the pane
 * runs it as the signed-in Windows user); never an MCP tool, so the model can't approve its own overwrite.
 */
import { readFamilyOverwrites, setFamilyOverwriteStatus, type FamilyLoadDeps } from "./familyload.js";

export function paneFamilyLoad(command: string, input: Record<string, unknown>, user: string, d: FamilyLoadDeps = {}): Record<string, unknown> {
  try {
    if (command === "family_load_list") {
      const now = Date.now();
      const all = readFamilyOverwrites(d);
      return { records: all.filter((r) => input.all === true || (r.status === "pending" && Date.parse(r.expires_at) > now)) };
    }
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (!id) return { error: "id is needed" };
    if (!user.trim()) return { error: "the pane's Windows user is unknown: a person's name is needed to approve" };
    const rec = setFamilyOverwriteStatus(id, command === "family_load_approve" ? "approved" : "rejected", user, d);
    return { id: rec.id, status: rec.status, by: rec.approved_by, archive: rec.archive, family: rec.family, project: rec.project };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
