/**
 * Workshare owners (gap 5, Builder 9). Pure: who owns or borrows what, who can edit it, and which planned operations
 * another person's ownership would block. Read-only (Rule 6): nothing here relinquishes, synchronises or checks anything out.
 *
 * Reuses workshare.ts (WorksetFact, the workset facts from fmc_workshare_facts) and coordination.ts (CurrencyRow, the rows
 * of the read-only fmc_elem_currency, and the id and skip rules fmc_trace and the edit tools already use).
 */
import { WorksetFact } from "./workshare.js";
import { CurrencyRow, EDITING_REQUESTS, NOT_CURRENT, OWNED_BY_OTHER, namedElementIds } from "./coordination.js";

export const WORKSET_OWNED_BY_OTHER = "FMC-WORKSET-OWNED-BY-OTHER";

export interface OwnersFacts { workshared: boolean; user: string; model: string; central: string; worksets: WorksetFact[] }

export function normalizeOwnersFacts(raw: unknown): OwnersFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const worksets = Array.isArray(r.worksets)
    ? (r.worksets as unknown[]).filter((w) => w && typeof w === "object").map((w) => {
        const x = w as Record<string, unknown>;
        return {
          id: Number(x.id ?? 0) || 0, name: String(x.name ?? ""), owner: String(x.owner ?? ""), open: x.open !== false,
          editable: !!x.editable, default_visible: x.default_visible !== false,
        };
      })
    : [];
  return { workshared: !!r.workshared, user: String(r.user ?? ""), model: String(r.model ?? ""), central: String(r.central ?? ""), worksets };
}

export function normalizeCurrency(raw: unknown): CurrencyRow[] | null {
  if (!raw || typeof raw !== "object") return null;
  const els = (raw as Record<string, unknown>).elements;
  if (!Array.isArray(els)) return null;
  return (els as unknown[]).filter((e) => e && typeof e === "object").map((e) => {
    const x = e as Record<string, unknown>;
    return { id: String(x.id ?? ""), owner: String(x.owner ?? ""), checkout: String(x.checkout ?? ""), updates: String(x.updates ?? "") };
  });
}

const same = (a: string, b: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// Worksets: who owns what
// ---------------------------------------------------------------------------------------------------------------

export type CanEdit = "yes" | "by_borrowing" | "no";

export interface WorksetRow {
  id: number;
  name: string;
  owner: string;
  state: "yours" | "others" | "unowned";
  open: boolean;
  /** yes: you own it. by_borrowing: nobody owns it; each edit borrows the element, if no one holds it. no: someone else owns it. */
  can_edit: CanEdit;
  note: string;
}

export function worksetRows(facts: OwnersFacts): WorksetRow[] {
  return facts.worksets.map((w) => {
    const state: WorksetRow["state"] = !w.owner ? "unowned" : same(w.owner, facts.user) ? "yours" : "others";
    const can: CanEdit = state === "yours" ? "yes" : state === "others" ? "no" : "by_borrowing";
    const notes: string[] = [];
    if (state === "others") notes.push(`Owned by ${w.owner}: only they can relinquish it (Collaborate > Relinquish All Mine), or a person can grant an editing request in Revit`);
    if (state === "unowned") notes.push("Nobody owns it: an edit borrows only the elements it changes");
    if (!w.open) notes.push("Closed in this model: its elements are not loaded");
    return { id: w.id, name: w.name, owner: w.owner, state, open: w.open, can_edit: can, note: notes.join(". ") };
  });
}

export interface OwnerSummary { owner: string; you: boolean; worksets: string[]; elements_checked: number }

/** One row per person who owns a workset. Element counts are only those the caller asked about (no model-wide scan). */
export function ownerSummary(facts: OwnersFacts, elements: ElementRow[]): OwnerSummary[] {
  const by = new Map<string, OwnerSummary>();
  const row = (owner: string) => {
    const cur = by.get(owner.toLowerCase());
    if (cur) return cur;
    const made: OwnerSummary = { owner, you: same(owner, facts.user), worksets: [], elements_checked: 0 };
    by.set(owner.toLowerCase(), made);
    return made;
  };
  for (const w of facts.worksets) if (w.owner) row(w.owner).worksets.push(w.name);
  for (const e of elements) if (e.owner && (e.checkout === "OwnedByOtherUser" || e.checkout === "OwnedByCurrentUser")) row(e.owner).elements_checked++;
  return [...by.values()].map((o) => ({ ...o, worksets: o.worksets.sort() })).sort((a, b) => a.owner.localeCompare(b.owner));
}

// ---------------------------------------------------------------------------------------------------------------
// Elements: can this user edit it
// ---------------------------------------------------------------------------------------------------------------

export type ElementCode = typeof OWNED_BY_OTHER | typeof NOT_CURRENT | typeof WORKSET_OWNED_BY_OTHER | "";

export interface ElementRow {
  id: string;
  /** true: an edit may go ahead. false: it would be skipped. null: not known (Revit gave no row for it). */
  can_edit: boolean | null;
  basis: "not_workshared" | "owned_by_you" | "will_borrow" | "owned_by_other" | "not_current" | "workset_owned_by_other" | "unknown";
  code: ElementCode;
  owner: string;
  checkout: string;
  updates: string;
  workset: string;
  workset_known: boolean;
  note: string;
}

export interface ElementInput {
  facts: OwnersFacts;
  rows: CurrencyRow[] | null;
  /** element id -> workset name, when the caller knows it. fmc_elem_currency does not return worksets. */
  element_worksets: Record<string, string>;
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, "");

export function elementRows(ids: string[], inp: ElementInput): ElementRow[] {
  const byId = new Map((inp.rows ?? []).map((r) => [String(r.id), r]));
  const worksets = new Map(inp.facts.worksets.map((w) => [w.name.toLowerCase(), w]));
  const seen = new Set<string>();
  const out: ElementRow[] = [];
  for (const raw of ids) {
    const id = String(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const wsName = inp.element_worksets[id] ?? "";
    const ws = wsName ? worksets.get(wsName.toLowerCase()) : undefined;
    const base = { id, workset: wsName, workset_known: !!ws };
    if (!inp.facts.workshared) {
      out.push({ ...base, can_edit: true, basis: "not_workshared", code: "", owner: "", checkout: "", updates: "", note: "The model is not workshared: no ownership applies" });
      continue;
    }
    const row = byId.get(id);
    if (!row) {
      out.push({ ...base, can_edit: null, basis: "unknown", code: "", owner: "", checkout: "", updates: "",
        note: inp.rows ? "Revit returned no row for this id" : "Element ownership could not be read (see gaps)" });
      continue;
    }
    const checkout = norm(row.checkout);
    const updates = norm(row.updates);
    const common = { ...base, owner: row.owner ?? "", checkout: row.checkout ?? "", updates: row.updates ?? "" };
    if (checkout === "ownedbyotheruser") {
      out.push({ ...common, can_edit: false, basis: "owned_by_other", code: OWNED_BY_OTHER,
        note: `${row.owner || "Another user"} has it checked out. They must sync and relinquish it` });
    } else if (updates === "updatedincentral" || updates === "deletedincentral") {
      out.push({ ...common, can_edit: false, basis: "not_current", code: NOT_CURRENT,
        note: updates === "deletedincentral" ? "Deleted in central: a person reloads latest" : "Changed in central since your last reload: a person reloads latest first" });
    } else if (ws && ws.owner && !same(ws.owner, inp.facts.user)) {
      out.push({ ...common, can_edit: false, basis: "workset_owned_by_other", code: WORKSET_OWNED_BY_OTHER,
        note: `Its workset ${ws.name} is owned by ${ws.owner}` });
    } else if (checkout === "ownedbycurrentuser") {
      out.push({ ...common, can_edit: true, basis: "owned_by_you", code: "", note: "You already have it checked out" });
    } else {
      out.push({ ...common, can_edit: true, basis: "will_borrow", code: "",
        note: ws ? "Nobody holds it: an edit would borrow it" : "Nobody holds it, but its workset is not known, so a workset owned by someone else is not ruled out" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Planned operations
// ---------------------------------------------------------------------------------------------------------------

export type PlannedOp = Record<string, unknown>;

const WORKSET_KEYS = new Set(["workset", "workset_name", "worksetName", "worksets", "workset_names"]);

/** Workset names an op names (params.workset, workset_name, worksets[]). */
export function opWorksets(params: unknown, out: string[] = []): string[] {
  if (Array.isArray(params)) { for (const p of params) opWorksets(p, out); return out; }
  if (!params || typeof params !== "object") return out;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (WORKSET_KEYS.has(k)) {
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" && x.trim()) out.push(x.trim());
    } else opWorksets(v, out);
  }
  return out;
}

/** What an op targets: its explicit element_ids / worksets, plus the ids and worksets inside params (or the op itself). */
export function opTargets(op: PlannedOp): { label: string; ids: string[]; worksets: string[] } {
  const { id: _opId, label, tool, action, element_ids, params, ...rest } = op as Record<string, unknown>;
  const body = params && typeof params === "object" ? params : rest;
  const explicit = Array.isArray(element_ids) ? (element_ids as unknown[]).map(String).filter((s) => s.trim()) : [];
  const ids = [...new Set([...explicit, ...namedElementIds(body)])];
  const names = [...new Set([...opWorksets(body), ...(Array.isArray((op as Record<string, unknown>).worksets) ? ((op as Record<string, unknown>).worksets as unknown[]).map(String) : [])])];
  const text = typeof label === "string" && label.trim() ? label.trim() : [tool, action].filter((x) => typeof x === "string" && x).join(" ");
  return { label: text, ids, worksets: names };
}

export interface OpVerdict {
  index: number;
  label: string;
  verdict: "clear" | "partly_blocked" | "blocked" | "unknown" | "no_targets";
  element_count: number;
  would_run_for: string[];
  would_skip: { id: string; code: ElementCode; owner: string }[];
  unknown: string[];
  blocked_worksets: { name: string; owner: string }[];
  needs_person: boolean;
  next: string;
}

export function checkOps(ops: PlannedOp[], inp: ElementInput): OpVerdict[] {
  const worksets = new Map(inp.facts.worksets.map((w) => [w.name.toLowerCase(), w]));
  return ops.map((op, i) => {
    const t = opTargets(op);
    const els = elementRows(t.ids, inp);
    const skip = els.filter((e) => e.can_edit === false);
    const unknown = els.filter((e) => e.can_edit === null).map((e) => e.id);
    const run = els.filter((e) => e.can_edit === true).map((e) => e.id);
    const blockedWs = inp.facts.workshared
      ? t.worksets.flatMap((n) => {
          const w = worksets.get(n.toLowerCase());
          return w && w.owner && !same(w.owner, inp.facts.user) ? [{ name: w.name, owner: w.owner }] : [];
        })
      : [];
    const targets = els.length + t.worksets.length;
    let verdict: OpVerdict["verdict"];
    if (targets === 0) verdict = "no_targets";
    else if (blockedWs.length && !run.length && !unknown.length) verdict = "blocked";
    else if (els.length > 0 && skip.length === els.length) verdict = "blocked";
    else if (skip.length || blockedWs.length) verdict = "partly_blocked";
    else if (unknown.length) verdict = "unknown";
    else verdict = "clear";
    const owners = [...new Set([...skip.map((s) => s.owner).filter(Boolean), ...blockedWs.map((b) => b.owner)])];
    const stale = skip.some((s) => s.code === NOT_CURRENT);
    const next = verdict === "clear" || verdict === "no_targets" ? ""
      : verdict === "unknown" ? "Ownership could not be read for some elements; the edit tools still check each one and skip any held by someone else"
      : [owners.length ? `Ask ${owners.join(", ")} to sync and relinquish (Relinquish All Mine), or wait` : "", stale ? "a person reloads latest in Revit" : "", "this tool never relinquishes, syncs or checks out"]
          .filter(Boolean).join("; ");
    return {
      index: i + 1, label: t.label || `op ${i + 1}`, verdict, element_count: els.length, would_run_for: run,
      would_skip: skip.map((s) => ({ id: s.id, code: s.code, owner: s.owner })), unknown, blocked_worksets: blockedWs,
      needs_person: verdict === "blocked" || verdict === "partly_blocked", next,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

export interface OwnersReport {
  read_only: true;
  never: string[];
  model: string;
  workshared: boolean;
  user: string;
  worksets: WorksetRow[];
  owners: OwnerSummary[];
  elements: ElementRow[];
  planned_ops: OpVerdict[];
  summary: { worksets_yours: number; worksets_others: number; worksets_unowned: number; elements_blocked: number; elements_unknown: number; ops_blocked: number; ops_partly_blocked: number };
  editing_requests: typeof EDITING_REQUESTS;
  gaps: string[];
}

export const NEVER = ["relinquish", "synchronise", "checkout", "save", "grant an editing request"];

export function buildOwnersReport(facts: OwnersFacts, rows: CurrencyRow[] | null, ids: string[], ops: PlannedOp[], elementWorksets: Record<string, string>,
  extra: { currencyError?: string; truncated?: number } = {}): OwnersReport {
  const inp: ElementInput = { facts, rows, element_worksets: elementWorksets };
  const wsRows = facts.workshared ? worksetRows(facts) : [];
  const elements = elementRows(ids, inp);
  const verdicts = checkOps(ops, inp);
  const gaps: string[] = [];
  if (!facts.workshared) gaps.push("The open model is not workshared: no worksets or owners to report");
  if (facts.workshared && ids.length && !rows) gaps.push(`Element ownership could not be read${extra.currencyError ? ` (${extra.currencyError})` : ""}: this add-in may not have fmc_elem_currency. Workset ownership above still holds`);
  if (facts.workshared && elements.some((e) => !e.workset_known)) {
    gaps.push("fmc_elem_currency does not return an element's workset, so an element nobody holds is reported as will_borrow unless element_worksets names its workset. Pass element_worksets (id to workset name) to rule out a workset owned by someone else");
  }
  gaps.push("There is no model-wide list of borrowed elements: Revit reports ownership one element at a time, so only the ids you name are checked (a model-wide scan would need a new add-in handler)");
  gaps.push("Workset owners are as of your last sync or Reload Latest; a person reloads latest to refresh them");
  gaps.push(EDITING_REQUESTS.reason);
  if (extra.truncated) gaps.push(`${extra.truncated} element id(s) over the limit were not checked`);
  return {
    read_only: true, never: NEVER, model: facts.model, workshared: facts.workshared, user: facts.user,
    worksets: wsRows, owners: facts.workshared ? ownerSummary(facts, elements) : [], elements, planned_ops: verdicts,
    summary: {
      worksets_yours: wsRows.filter((w) => w.state === "yours").length,
      worksets_others: wsRows.filter((w) => w.state === "others").length,
      worksets_unowned: wsRows.filter((w) => w.state === "unowned").length,
      elements_blocked: elements.filter((e) => e.can_edit === false).length,
      elements_unknown: elements.filter((e) => e.can_edit === null).length,
      ops_blocked: verdicts.filter((v) => v.verdict === "blocked").length,
      ops_partly_blocked: verdicts.filter((v) => v.verdict === "partly_blocked").length,
    },
    editing_requests: EDITING_REQUESTS, gaps,
  };
}
