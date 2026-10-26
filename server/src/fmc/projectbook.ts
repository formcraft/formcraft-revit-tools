/**
 * The project book (docs/PROJECT_BOOK.md, owner 26 Oct 2026): one file per project, 01_WIP\FMC_Project_Book.json beside
 * the manifest, that keeps the team and roles, decisions, notes and ideas, progress, threads and checklist ticks, so
 * nothing about a project is forgotten and every person and AI reads the same state first.
 *
 * Keyed for one-step lookups (members by name, decisions D1…, notes N1…, threads T1…, ticks by role|stage|item).
 * People may do everything; agents (AI) add notes, ideas, progress, threads, reports and ticks, may propose a decision,
 * and never change roles, decide or review. An agent assists a named person and never takes a role ranked above theirs.
 * Pure: the caller loads and saves (projectbook_io.ts).
 */
export const BOOK_SCHEMA = "fmc-projectbook/1";

export type ActorKind = "person" | "agent";
export interface Actor { name: string; kind: ActorKind }
export interface Member { name: string; kind: ActorKind; role: string; assists?: string; added: string; by: string }
export interface Decision { id: string; text: string; status: "proposed" | "decided"; by: string; at: string; decided_by?: string }
export interface Note { id: string; kind: "note" | "idea" | "progress" | "report"; text: string; by: string; at: string; thread?: string }
export interface Thread { id: string; title: string; by: string; started: string; ended?: string; report?: string }
export type TickState = "ticked" | "submitted" | "approved" | "returned";
export interface Tick { role: string; stage: string; item: string; state: TickState; by: string; at: string; evidence?: string; review?: { by: string; at: string; comment: string } }

export interface ProjectBook {
  schema: string;
  project: string;
  created: string;
  stage: string;
  manifest: string;
  team: Record<string, Member>;
  decisions: Record<string, Decision>;
  notes: Record<string, Note>;
  threads: Record<string, Thread>;
  ticks: Record<string, Tick>;
  next: { D: number; N: number; T: number };
}

/** Role playbooks (kit FMC_Roles.json, schema fmc-roles/0.1). */
export interface RoleItem { id: string; title: string; rules: string[] }
export interface Role { rank: number; reviewer: string; duties?: string; checklists: Record<string, RoleItem[]> }
export interface Roles { roles: Record<string, Role> }

/** The kit's rule check types a script runs (fmc_qa); the rest need a person (human_gate, other). */
export const AUTO_CHECKS = new Set(["naming_regex", "value_in_list", "count_min", "parameter_present"]);

export function newBook(manifest: { project: string; stage?: string }, manifestPath: string, by: string, now = new Date()): ProjectBook {
  return { schema: BOOK_SCHEMA, project: manifest.project, created: now.toISOString(), stage: manifest.stage ?? "", manifest: manifestPath,
    team: {}, decisions: {}, notes: {}, threads: {}, ticks: {}, next: { D: 1, N: 1, T: 1 } };
}

export function parseBook(raw: string): { book: ProjectBook | null; problem?: string } {
  try {
    const o = JSON.parse(raw.replace(/^﻿/, ""));
    if (o?.schema !== BOOK_SCHEMA) return { book: null, problem: `Not a project book (schema ${String(o?.schema)})` };
    for (const k of ["team", "decisions", "notes", "threads", "ticks"]) o[k] ??= {};
    o.next ??= { D: 1, N: 1, T: 1 };
    return { book: o as ProjectBook };
  } catch (e) {
    return { book: null, problem: `Not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export type Edit =
  | { action: "note" | "idea" | "progress" | "report"; text: string; thread?: string }
  | { action: "propose"; text: string }
  | { action: "decide"; text?: string; id?: string }
  | { action: "thread_start"; title: string }
  | { action: "thread_end"; id: string; report: string }
  | { action: "set_member"; name: string; kind: ActorKind; role: string; assists?: string }
  | { action: "remove_member"; name: string }
  | { action: "set_stage"; stage: string }
  | { action: "tick"; role: string; stage: string; item: string; evidence?: string }
  | { action: "submit"; role: string; stage: string }
  | { action: "review"; role: string; stage: string; item: string; approve: boolean; comment?: string };

/** Who may make an edit: people anything; agents never roles, decisions or reviews. */
const PEOPLE_ONLY = new Set(["decide", "set_member", "remove_member", "set_stage", "review"]);

export interface EditResult { ok: boolean; book: ProjectBook; reason?: string; id?: string; journal?: Record<string, unknown> }

/** Applies one edit; returns a new book (the input is not changed) and the journal line to append. */
export function applyEdit(book: ProjectBook, edit: Edit, actor: Actor, roles: Roles | null, now = new Date()): EditResult {
  const b: ProjectBook = JSON.parse(JSON.stringify(book));
  const at = now.toISOString();
  const no = (reason: string): EditResult => ({ ok: false, book, reason });
  if (actor.kind === "agent" && PEOPLE_ONLY.has(edit.action)) return no(`Only a person can ${edit.action.replace("_", " ")}: roles, decisions and reviews stay with people`);
  const done = (id: string | undefined, detail: Record<string, unknown>): EditResult =>
    ({ ok: true, book: b, id, journal: { at, by: actor.name, kind: actor.kind, action: edit.action, id, ...detail } });

  switch (edit.action) {
    case "note": case "idea": case "progress": case "report": {
      if (!edit.text?.trim()) return no("Give the text");
      if (edit.thread && !b.threads[edit.thread]) return no(`No thread ${edit.thread}`);
      const id = `N${b.next.N++}`;
      b.notes[id] = { id, kind: edit.action, text: edit.text.trim(), by: actor.name, at, ...(edit.thread ? { thread: edit.thread } : {}) };
      return done(id, { text: edit.text.trim(), thread: edit.thread });
    }
    case "propose": {
      if (!edit.text?.trim()) return no("Give the decision to propose");
      const id = `D${b.next.D++}`;
      b.decisions[id] = { id, text: edit.text.trim(), status: "proposed", by: actor.name, at };
      return done(id, { text: edit.text.trim() });
    }
    case "decide": {
      if (edit.id) {
        const d = b.decisions[edit.id];
        if (!d) return no(`No decision ${edit.id}`);
        d.status = "decided"; d.decided_by = actor.name;
        return done(d.id, { text: d.text });
      }
      if (!edit.text?.trim()) return no("Give the decision, or the id of a proposed one");
      const id = `D${b.next.D++}`;
      b.decisions[id] = { id, text: edit.text.trim(), status: "decided", by: actor.name, at, decided_by: actor.name };
      return done(id, { text: edit.text.trim() });
    }
    case "thread_start": {
      if (!edit.title?.trim()) return no("Give the thread a title");
      const id = `T${b.next.T++}`;
      b.threads[id] = { id, title: edit.title.trim(), by: actor.name, started: at };
      return done(id, { title: edit.title.trim() });
    }
    case "thread_end": {
      const t = b.threads[edit.id];
      if (!t) return no(`No thread ${edit.id}`);
      if (t.ended) return no(`${edit.id} already ended`);
      t.ended = at; t.report = edit.report?.trim() ?? "";
      return done(t.id, { report: t.report });
    }
    case "set_member": {
      if (!edit.name?.trim() || !edit.role?.trim()) return no("Give the name and the role");
      if (roles && !roles.roles[edit.role]) return no(`${edit.role} isn't a role in the kit (FMC_Roles.json)`);
      if (edit.kind === "agent") {
        const person = edit.assists ? b.team[edit.assists] : undefined;
        if (!person || person.kind !== "person") return no("An agent assists a person on the team: give assists = their name");
        const rank = (r: string) => roles?.roles[r]?.rank ?? 0;
        if (roles && rank(edit.role) > rank(person.role)) return no(`An agent can't take ${edit.role}: it ranks above ${person.name}'s role (${person.role})`);
      }
      b.team[edit.name] = { name: edit.name, kind: edit.kind, role: edit.role, ...(edit.assists ? { assists: edit.assists } : {}), added: at, by: actor.name };
      return done(edit.name, { role: edit.role, member_kind: edit.kind, assists: edit.assists });
    }
    case "remove_member": {
      if (!b.team[edit.name]) return no(`${edit.name} isn't on the team`);
      delete b.team[edit.name];
      for (const m of Object.values(b.team)) if (m.assists === edit.name) delete b.team[m.name]; // their agents go too
      return done(edit.name, {});
    }
    case "set_stage": {
      if (!edit.stage?.trim()) return no("Give the stage");
      b.stage = edit.stage.trim();
      return done(undefined, { stage: b.stage });
    }
    case "tick": {
      const item = itemOf(roles, edit.role, edit.stage, edit.item);
      if (!item) return no(`${edit.item} isn't on the ${edit.role} ${edit.stage} checklist`);
      const k = tickKey(edit.role, edit.stage, edit.item);
      const cur = b.ticks[k];
      if (cur && (cur.state === "submitted" || cur.state === "approved")) return no(`${edit.item} is ${cur.state}: it changes only through review`);
      b.ticks[k] = { role: edit.role, stage: edit.stage, item: edit.item, state: "ticked", by: actor.name, at, ...(edit.evidence ? { evidence: edit.evidence } : {}) };
      return done(k, { evidence: edit.evidence });
    }
    case "submit": {
      const list = roles?.roles[edit.role]?.checklists[edit.stage] ?? [];
      if (!list.length) return no(`No ${edit.role} checklist for ${edit.stage}`);
      const ticked = list.filter((i) => b.ticks[tickKey(edit.role, edit.stage, i.id)]?.state === "ticked");
      if (!ticked.length) return no("Nothing ticked to submit");
      for (const i of ticked) b.ticks[tickKey(edit.role, edit.stage, i.id)].state = "submitted";
      return done(`${edit.role}|${edit.stage}`, { items: ticked.map((i) => i.id), reviewer: roles?.roles[edit.role]?.reviewer });
    }
    case "review": {
      const k = tickKey(edit.role, edit.stage, edit.item);
      const t = b.ticks[k];
      if (!t || t.state !== "submitted") return no(`${edit.item} isn't waiting for review`);
      if (t.by === actor.name) return no("A person doesn't review their own tick");
      t.state = edit.approve ? "approved" : "returned";
      t.review = { by: actor.name, at, comment: edit.comment ?? "" };
      return done(k, { approve: edit.approve, comment: edit.comment });
    }
  }
}

export const tickKey = (role: string, stage: string, item: string) => `${role}|${stage}|${item}`;
const itemOf = (roles: Roles | null, role: string, stage: string, item: string) => roles?.roles[role]?.checklists[stage]?.find((i) => i.id === item);

export interface ChecklistLine { id: string; title: string; kind: "auto" | "person"; state: string; rules: string[]; by?: string; evidence?: string; review?: string }

/**
 * The checklist for a role and stage. An item whose rules are all script-checked takes its state from the latest QA
 * run (Pass, Fail, or "Run QA"); the others take the person's tick (open, ticked, submitted, approved, returned).
 */
export function checklist(book: ProjectBook, roles: Roles | null, role: string, stage: string,
  ruleTypes: Record<string, string>, qaFailing: string[] | null): ChecklistLine[] {
  const list = roles?.roles[role]?.checklists[stage] ?? [];
  return list.map((i) => {
    const auto = i.rules.length > 0 && i.rules.every((r) => AUTO_CHECKS.has(ruleTypes[r] ?? ""));
    const t = book.ticks[tickKey(role, stage, i.id)];
    if (auto) {
      const state = qaFailing === null ? "Run QA" : i.rules.some((r) => qaFailing.includes(r)) ? "Fail" : "Pass";
      return { id: i.id, title: i.title, kind: "auto" as const, state, rules: i.rules };
    }
    return { id: i.id, title: i.title, kind: "person" as const, state: t?.state ?? "open", rules: i.rules, by: t?.by, evidence: t?.evidence,
      review: t?.review ? `${t.review.by}: ${t.review.comment}` : undefined };
  });
}

/** Done = Pass (auto) or approved (person). The project's progress needs nobody to write a report. */
export function progressOf(lines: ChecklistLine[]): { done: number; total: number; waiting_review: number } {
  return { done: lines.filter((l) => l.state === "Pass" || l.state === "approved").length, total: lines.length,
    waiting_review: lines.filter((l) => l.state === "submitted").length };
}

/** One-step lookup: an id (D3, N12, T2, a member's name, role|stage|item) or words in the text. */
export function findInBook(book: ProjectBook, q: string): Array<{ key: string; kind: string; text: string }> {
  const s = q.trim();
  const hit = (key: string, kind: string, text: string) => ({ key, kind, text });
  const exact = book.decisions[s] ? hit(s, "decision", book.decisions[s].text) : book.notes[s] ? hit(s, book.notes[s].kind, book.notes[s].text)
    : book.threads[s] ? hit(s, "thread", book.threads[s].title) : book.team[s] ? hit(s, "member", `${book.team[s].role}${book.team[s].assists ? " · assists " + book.team[s].assists : ""}`)
    : book.ticks[s] ? hit(s, "tick", book.ticks[s].state) : null;
  if (exact) return [exact];
  const w = s.toLowerCase().split(/\s+/).filter((x) => x.length > 2);
  if (!w.length) return [];
  const all = [
    ...Object.values(book.decisions).map((d) => hit(d.id, "decision", d.text)),
    ...Object.values(book.notes).map((n) => hit(n.id, n.kind, n.text)),
    ...Object.values(book.threads).map((t) => hit(t.id, "thread", `${t.title} ${t.report ?? ""}`)),
    ...Object.values(book.team).map((m) => hit(m.name, "member", `${m.name} ${m.role}`)),
  ];
  return all.filter((x) => w.every((t) => x.text.toLowerCase().includes(t) || x.key.toLowerCase().includes(t))).slice(0, 20);
}

/** A short summary for the AI context on connect and the pane header. */
export function summary(book: ProjectBook) {
  const open = Object.values(book.decisions).filter((d) => d.status === "proposed").length;
  return { project: book.project, stage: book.stage, team: Object.values(book.team).map((m) => `${m.name} (${m.role}${m.kind === "agent" ? ", agent" : ""})`),
    decisions: Object.keys(book.decisions).length, proposed_decisions: open, notes: Object.keys(book.notes).length,
    open_threads: Object.values(book.threads).filter((t) => !t.ended).map((t) => `${t.id} ${t.title}`),
    waiting_review: Object.values(book.ticks).filter((t) => t.state === "submitted").length };
}
