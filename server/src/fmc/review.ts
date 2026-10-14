/**
 * The review register (board manage/PaneReview, U20). Pure.
 *
 *   MAN 10.5  every item has one owner and a due date; the lead discipline owns the fix; Critical 3 working days,
 *             High 1 week by default; resolved by the solver, closed only after the raiser's check
 * The register is the project's file (01_WIP\_Reviews\FMC_Review_Register.json), so it works on any model, live ones
 * too: raising an item never changes the model. Revision clouds and prints come next, behind the live-model lock.
 */
export const PRIORITIES = ["Critical", "High", "Medium", "Low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type ItemStatus = "Open" | "In progress" | "Resolved" | "Closed";

export interface Answer { discipline: string; by: string; text: string; status: "Done" | "Open"; at: string }
export interface HistoryLine { at: string; by: string; what: string }
export interface ReviewItem {
  id: string; title: string; description: string; disciplines: string[]; lead: string; owner: string; priority: Priority;
  due: string; status: ItemStatus; raised_by: string; raised_at: string; model: string; view: string; element_ids: number[];
  answers: Answer[]; solution: string; history: HistoryLine[];
}
export interface Register { project: string; items: ReviewItem[] }

const DAY = 86400000;

/** Default due date for a priority (MAN 10.5): Critical 3 working days, High 1 week, Medium 2 weeks, Low 4 weeks. */
export function defaultDue(priority: Priority, today: Date): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (priority === "Critical") {
    let added = 0;
    while (added < 3) { d.setTime(d.getTime() + DAY); const w = d.getUTCDay(); if (w !== 0 && w !== 6) added++; }
  } else d.setTime(d.getTime() + DAY * (priority === "High" ? 7 : priority === "Medium" ? 14 : 28));
  return d.toISOString().slice(0, 10);
}

export function nextId(reg: Register): string {
  const n = reg.items.reduce((m, i) => Math.max(m, Number(/-ISS-(\d+)$/.exec(i.id)?.[1] ?? 0)), 0) + 1;
  return `${reg.project || "PROJ"}-ISS-${String(n).padStart(4, "0")}`;
}

export function overdue(i: ReviewItem, today: string): boolean {
  return (i.status === "Open" || i.status === "In progress") && !!i.due && i.due < today;
}

export interface RaiseInput {
  title: string; description: string; disciplines: string[]; lead: string; owner: string; priority: Priority; due?: string;
  raised_by: string; model: string; view: string; element_ids: number[];
}

export function raiseProblems(q: RaiseInput, today: string): string[] {
  const p: string[] = [];
  if (!q.title.trim()) p.push("Give the item a title");
  if (!q.description.trim()) p.push("Say what you see and what must change");
  if (!q.lead.trim()) p.push("Pick the lead discipline: it owns the fix (MAN 10.5)");
  if (!q.owner.trim()) p.push("Name one owner (MAN 10.5)");
  if (q.due && !/^\d{4}-\d{2}-\d{2}$/.test(q.due)) p.push(`Due "${q.due}" must be a date like 2026-10-20`);
  else if (q.due && q.due < today) p.push(`Due ${q.due} is in the past`);
  return p;
}

export function raise(reg: Register, q: RaiseInput, now: Date): ReviewItem {
  const at = now.toISOString();
  const disciplines = [...new Set([q.lead, ...q.disciplines].map((d) => d.trim().toUpperCase()).filter(Boolean))];
  const item: ReviewItem = {
    id: nextId(reg), title: q.title.trim(), description: q.description.trim(), disciplines, lead: q.lead.trim().toUpperCase(),
    owner: q.owner.trim(), priority: q.priority, due: q.due || defaultDue(q.priority, now), status: "Open",
    raised_by: q.raised_by, raised_at: at, model: q.model, view: q.view, element_ids: q.element_ids.slice(0, 200),
    answers: [], solution: "", history: [{ at, by: q.raised_by, what: `Raised for ${disciplines.join(", ")}; owner ${q.owner.trim()}, due ${q.due || defaultDue(q.priority, now)}` }],
  };
  reg.items.push(item);
  return item;
}

export function find(reg: Register, id: string): ReviewItem {
  const i = reg.items.find((x) => x.id.toLowerCase() === id.trim().toLowerCase());
  if (!i) throw new Error(`No review item ${id}`);
  return i;
}

/** A discipline answers; the item moves to In progress. */
export function answer(i: ReviewItem, discipline: string, by: string, text: string, done: boolean, now: Date) {
  if (i.status === "Closed") throw new Error(`${i.id} is closed: reopen it first`);
  const d = discipline.trim().toUpperCase();
  if (!i.disciplines.includes(d)) throw new Error(`${d} isn't asked on ${i.id} (${i.disciplines.join(", ")})`);
  const at = now.toISOString();
  i.answers = i.answers.filter((a) => a.discipline !== d).concat({ discipline: d, by, text: text.trim(), status: done ? "Done" : "Open", at });
  if (i.status === "Open") i.status = "In progress";
  i.history.push({ at, by, what: `${d} answered${done ? " (done)" : ""}` });
}

/** The solver marks it done: Resolved, waiting for the raiser's check. Every asked discipline must have answered. */
export function solve(i: ReviewItem, by: string, solution: string, now: Date) {
  if (i.status === "Closed") throw new Error(`${i.id} is closed`);
  if (!solution.trim()) throw new Error("Say what you changed: the solution is required");
  const missing = i.disciplines.filter((d) => !i.answers.some((a) => a.discipline === d));
  if (missing.length) throw new Error(`Waiting for ${missing.join(", ")} to answer first`);
  i.solution = solution.trim();
  i.status = "Resolved";
  i.history.push({ at: now.toISOString(), by, what: "Marked done; waiting for the raiser's check" });
}

/** The raiser's check: accept closes it, reopen sends it back with a reason (MAN 10.5). */
export function verdict(i: ReviewItem, by: string, accept: boolean, comment: string, now: Date) {
  if (i.status !== "Resolved") throw new Error(`${i.id} isn't waiting for a check (it is ${i.status})`);
  if (!accept && !comment.trim()) throw new Error("Say why you reopen it");
  i.status = accept ? "Closed" : "In progress";
  i.history.push({ at: now.toISOString(), by, what: accept ? "Accepted and closed" : `Reopened: ${comment.trim()}` });
}

export type Filter = "All" | "My discipline" | "Overdue" | "Closed" | "Open";

export function filterItems(reg: Register, filter: Filter, myDisciplines: string[], today: string): ReviewItem[] {
  const mine = new Set(myDisciplines.map((d) => d.toUpperCase()));
  const items = reg.items.filter((i) => {
    switch (filter) {
      case "My discipline": return i.status !== "Closed" && i.disciplines.some((d) => mine.has(d));
      case "Overdue": return overdue(i, today);
      case "Closed": return i.status === "Closed";
      case "Open": return i.status !== "Closed";
      default: return true;
    }
  });
  const rank: Record<ItemStatus, number> = { Open: 0, "In progress": 1, Resolved: 2, Closed: 3 };
  return items.sort((a, b) => rank[a.status] - rank[b.status] || a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
}

/** The line the register shows (Overdue replaces Open / In progress once the due date passes). */
export function shownStatus(i: ReviewItem, today: string): string { return overdue(i, today) ? "Overdue" : i.status; }
