/**
 * GAP-26 fmc_groups: group audit and an explode plan. Pure.
 *
 * Audit (from fmc_groups_audit, read-only): unused group types, nested structure (depth), text in groups and
 * mirrored instances. Revit has no "mirrored" flag on a group, so it is inferred: an instance whose count of mirrored
 * member family instances differs from most instances of its type is "likely" mirrored; with no family instances it is
 * "unknown". The explode plan says what ungrouping would do; it never runs here (a person's approval is not wired yet).
 */
import crypto from "node:crypto";

export interface GroupTypeRow { id: string; name: string; kind: string }
export interface GroupInstanceRow {
  id: string; type_id: string; members: number; member_family_instances: number; mirrored_members: number;
  nested_group_ids: string[]; text_notes: number; attached_parent_id: string; checkout: string; owner: string; workset: string;
}
export interface GroupsRead { types: GroupTypeRow[]; instances: GroupInstanceRow[] }

/** At most this many instances in one explode batch (gap analysis: at most 50 ops per batch). */
export const EXPLODE_MAX = 50;
/** Rows listed per finding; the count is always the full count. */
export const LIST_CAP = 50;

export const GROUPS_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "[FMC-DOC-REQUIRED] fmc_groups needs document: the title or full path of the open model. It never uses the active document.",
  "FMC-GROUPS-IDS": "[FMC-GROUPS-IDS] explode needs ids: the group instances to ungroup (from audit).",
  "FMC-GROUPS-TOO-MANY": `[FMC-GROUPS-TOO-MANY] At most ${EXPLODE_MAX} groups per batch. Split the list.`,
  "FMC-GROUPS-APPROVAL": "[FMC-GROUPS-APPROVAL] Exploding groups needs a person's approval, and no approval route that always asks a person " +
    "(even with auto-approve and on library files) is wired for it yet. Nothing was changed. Show the dry run to the person; " +
    "they can ungroup in Revit. The approval route is with Builder 1.",
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export function asGroupsRead(raw: unknown): GroupsRead {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const types = (Array.isArray(body.types) ? body.types : []).flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const r = t as Record<string, unknown>;
    return [{ id: str(r.id), name: str(r.name), kind: str(r.kind) || "model" }];
  });
  const instances = (Array.isArray(body.instances) ? body.instances : []).flatMap((t) => {
    if (!t || typeof t !== "object") return [];
    const r = t as Record<string, unknown>;
    return [{
      id: str(r.id), type_id: str(r.type_id), members: num(r.members), member_family_instances: num(r.member_family_instances),
      mirrored_members: num(r.mirrored_members), nested_group_ids: Array.isArray(r.nested_group_ids) ? r.nested_group_ids.map(str) : [],
      text_notes: num(r.text_notes), attached_parent_id: str(r.attached_parent_id), checkout: str(r.checkout), owner: str(r.owner), workset: str(r.workset),
    }];
  });
  return { types, instances };
}

function cap<T>(rows: T[]) { return { count: rows.length, rows: rows.slice(0, LIST_CAP), truncated: rows.length > LIST_CAP }; }

/** Nesting depth per type: 1 for a group with no nested groups. A cycle (should not happen in Revit) stops at the repeat. */
export function nestingDepth(read: GroupsRead): Map<string, number> {
  const typeOf = new Map(read.instances.map((i) => [i.id, i.type_id]));
  const children = new Map<string, Set<string>>();
  for (const i of read.instances) {
    const set = children.get(i.type_id) ?? new Set<string>();
    for (const n of i.nested_group_ids) { const t = typeOf.get(n); if (t) set.add(t); }
    children.set(i.type_id, set);
  }
  const memo = new Map<string, number>();
  const depth = (t: string, seen: Set<string>): number => {
    if (memo.has(t)) return memo.get(t)!;
    if (seen.has(t)) return 1;
    seen.add(t);
    let d = 1;
    for (const c of children.get(t) ?? []) d = Math.max(d, 1 + depth(c, seen));
    seen.delete(t);
    memo.set(t, d);
    return d;
  };
  for (const t of children.keys()) depth(t, new Set());
  return memo;
}

/** The mirrored guess per instance: likely, no or unknown. */
export function mirroredGuess(read: GroupsRead): Map<string, "likely" | "no" | "unknown"> {
  const out = new Map<string, "likely" | "no" | "unknown">();
  const byType = new Map<string, GroupInstanceRow[]>();
  for (const i of read.instances) byType.set(i.type_id, [...(byType.get(i.type_id) ?? []), i]);
  for (const rows of byType.values()) {
    const counts = new Map<number, number>();
    for (const r of rows) if (r.member_family_instances > 0) counts.set(r.mirrored_members, (counts.get(r.mirrored_members) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    // A tie (e.g. one plain and one mirrored copy) can't say which is the original: unknown.
    const modal = ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
    for (const r of rows) {
      if (r.member_family_instances <= 0) out.set(r.id, "unknown");
      else if (modal === null) out.set(r.id, r.mirrored_members > 0 ? "unknown" : "no");
      else out.set(r.id, r.mirrored_members === modal ? "no" : "likely");
    }
  }
  return out;
}

export function auditGroups(read: GroupsRead) {
  const name = new Map(read.types.map((t) => [t.id, t]));
  const used = new Map<string, number>();
  for (const i of read.instances) used.set(i.type_id, (used.get(i.type_id) ?? 0) + 1);
  const unused = read.types.filter((t) => !used.get(t.id)).map((t) => ({ type_id: t.id, name: t.name, kind: t.kind }));
  const depth = nestingDepth(read);
  const nested = read.types.filter((t) => (depth.get(t.id) ?? 1) > 1)
    .map((t) => ({ type_id: t.id, name: t.name, kind: t.kind, depth: depth.get(t.id) ?? 1 }))
    .sort((a, b) => b.depth - a.depth || a.name.localeCompare(b.name));
  const textTypes = new Map<string, number>();
  for (const i of read.instances) if (i.text_notes > 0) textTypes.set(i.type_id, Math.max(textTypes.get(i.type_id) ?? 0, i.text_notes));
  const text = [...textTypes.entries()].map(([id, n]) => ({ type_id: id, name: name.get(id)?.name ?? "", kind: name.get(id)?.kind ?? "", text_notes: n }));
  const guess = mirroredGuess(read);
  const mirrored = read.instances.filter((i) => guess.get(i.id) === "likely")
    .map((i) => ({ id: i.id, type_id: i.type_id, name: name.get(i.type_id)?.name ?? "", mirrored_members: i.mirrored_members, member_family_instances: i.member_family_instances }));
  const unknown = read.instances.filter((i) => guess.get(i.id) === "unknown").length;
  return {
    totals: { types: read.types.length, instances: read.instances.length,
      model_types: read.types.filter((t) => t.kind === "model").length, detail_types: read.types.filter((t) => t.kind !== "model").length },
    unused_types: cap(unused),
    nested: cap(nested),
    text_in_groups: cap(text),
    mirrored: { ...cap(mirrored), inferred: true, unknown_instances: unknown,
      note: "Revit has no mirrored flag on a group: inferred from member family instances against most instances of the type." },
  };
}

export interface ExplodeRow {
  id: string; type_id: string; name: string; members: number; nested_groups_stay: number; attached_detail_groups: number;
  type_left_unused: boolean; blocked?: string;
}

/** What ungrouping these instances would do. Never run here. */
export function planExplode(read: GroupsRead, ids: string[], document: string) {
  const name = new Map(read.types.map((t) => [t.id, t.name]));
  const byId = new Map(read.instances.map((i) => [i.id, i]));
  const wanted = [...new Set(ids.map((x) => x.trim()).filter(Boolean))];
  const left = new Map<string, number>();
  for (const i of read.instances) left.set(i.type_id, (left.get(i.type_id) ?? 0) + 1);
  const notFound: string[] = [];
  const rows: ExplodeRow[] = [];
  for (const id of wanted) {
    const i = byId.get(id);
    if (!i) { notFound.push(id); continue; }
    const blocked = i.attached_parent_id ? "an attached detail group: it follows its model group"
      : i.checkout === "OwnedByOtherUser" ? `owned by ${i.owner || "another user"}` : undefined;
    if (!blocked) left.set(i.type_id, (left.get(i.type_id) ?? 1) - 1);
    rows.push({ id, type_id: i.type_id, name: name.get(i.type_id) ?? "", members: i.members, nested_groups_stay: i.nested_group_ids.length,
      attached_detail_groups: read.instances.filter((a) => a.attached_parent_id === id).length, type_left_unused: false, ...(blocked ? { blocked } : {}) });
  }
  for (const r of rows) r.type_left_unused = !r.blocked && (left.get(r.type_id) ?? 0) <= 0;
  const runnable = rows.filter((r) => !r.blocked);
  const plan_hash = crypto.createHash("sha256")
    .update(JSON.stringify({ document: document.trim().toLowerCase(), ids: runnable.map((r) => r.id).sort() })).digest("hex").slice(0, 16);
  return {
    rows, not_found: notFound, runnable: runnable.length, blocked: rows.length - runnable.length,
    members_released: runnable.reduce((s, r) => s + r.members, 0), plan_hash,
    notes: [
      "Ungrouping keeps the members; nested groups inside stay groups.",
      "Group types are kept even when no instance is left (type_left_unused); purging them is a separate, approved step.",
      "What Revit does with attached detail groups of an ungrouped model group is checked in the live test, not assumed here.",
    ],
  };
}
