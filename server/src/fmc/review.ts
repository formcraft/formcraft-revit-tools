/**
 * The review register (board manage/PaneReview, U20). Pure.
 *
 *   MAN 10.5  every item has one owner and a due date; the lead discipline owns the fix; Critical 3 working days,
 *             High 1 week by default; resolved by the solver, closed only after the raiser's check
 * The register is the project's file (01_WIP\_Reviews\FMC_Review_Register.json), so it works on any model, live ones
 * too: raising an item never changes the model. Revision clouds and prints come next, behind the live-model lock.
 */
import type { Intent } from "./noteparse.js";

export const PRIORITIES =["Critical", "High", "Medium", "Low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type ItemStatus = "Open" | "In progress" | "Resolved" | "Closed";

export interface Answer { discipline: string; by: string; text: string; status: "Done" | "Open"; at: string }
export interface HistoryLine { at: string; by: string; what: string }
export interface ReviewItem {
  id: string; title: string; description: string; disciplines: string[]; lead: string; owner: string; priority: Priority;
  due: string; status: ItemStatus; raised_by: string; raised_at: string; model: string; view: string; element_ids: number[];
  answers: Answer[]; solution: string; history: HistoryLine[];
  /** The sheet the item was raised on (empty for a model view). */
  sheet?: string;
  /** The revision cloud on the drawing, once drawn: its element id, view and revision. */
  cloud?: { id: number; view: string; revision: string };
  // ---- Mark & Review (docs/PLAN_MARK_REVIEW.md, R1): a ticket is a review item with these too; all optional, so the
  // register's older items and its other actions stay as they are
  /** Who fixes it: the AI modeller, a named person, a discipline, or anyone who takes it. */
  to?: "ai" | "person" | "discipline" | "anyone";
  /** Where it is in the model. */
  where?: Where;
  /** The thread: the first note and every reply, typed or spoken. */
  notes?: Note[];
  /** Pictures kept beside the register (paths under 01_WIP\_Reviews\media\<id>\). */
  pictures?: { raised?: string; before?: string; after?: string };
  /** What the ticket came from and what it touches. */
  source?: "mark" | "clash" | "review" | "bcf";
  links?: { recipe_node?: string; recipe_key?: string; clash?: { test: string; name: string; guid?: string; distance_mm?: number; items?: Array<{ model: string; id: string; category: string; fmc?: string; unique_id?: string }> }; family?: string };
  /** The BCF topic's GUID, so a ticket sent out and back is the same ticket. */
  guid?: string;
  /** What the offline parser understood from the note (R3); the latest reply that asks for something replaces it. */
  intent?: Intent[];
}

/** Where a ticket sits: elements (Revit UniqueIds, and in linked models), a point, the view, the camera, a section box. */
export interface Where {
  unique_ids: string[];
  /** IFC GUIDs of the same elements (Revit writes them on export), for BCF readers that match by IFC. */
  ifc_guids?: string[];
  linked?: Array<{ link: string; unique_id: string }>;
  /** A point in the model, mm (project coordinates), for a mark on a place rather than an element. */
  point_mm?: number[];
  view?: string;
  camera?: { eye: number[]; direction: number[]; up: number[]; perspective: boolean; field_of_view?: number; scale?: number };
  section_box?: { min: number[]; max: number[] };
}

/** A note in a ticket's thread: typed, or spoken (the audio file kept, its transcript beside it). */
export interface Note { at: string; by: string; text: string; audio?: string; transcript?: string; transcribed_by?: string }
/** One print of a sheet: for review (open items) or as revised (closed items and their solutions). */
export interface PrintLine { sheet: string; kind: "For review" | "As revised"; at: string; by: string; revision: string; items: string[]; folder: string }
export interface Register { project: string; items: ReviewItem[]; prints?: PrintLine[] }

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
  raised_by: string; model: string; view: string; element_ids: number[]; sheet?: string;
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
    raised_by: q.raised_by, raised_at: at, model: q.model, view: q.view, element_ids: q.element_ids.slice(0, 200), sheet: q.sheet ?? "",
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

/**
 * The items a print of this sheet lists: raised on the sheet (or clouded on it). For review: the ones still open; as
 * revised: the ones solved or closed, with their solutions.
 */
export function printItems(reg: Register, sheet: string, kind: PrintLine["kind"]): ReviewItem[] {
  const on = reg.items.filter((i) => (i.sheet ?? "").toUpperCase() === sheet.toUpperCase() || (i.cloud?.view ?? "").toUpperCase().startsWith(sheet.toUpperCase() + " "));
  return on.filter((i) => kind === "For review" ? i.status === "Open" || i.status === "In progress" : i.status === "Resolved" || i.status === "Closed");
}

/** The list that goes beside the sheet's PDF. */
export function printList(sheet: string, kind: PrintLine["kind"], items: ReviewItem[], when: Date): string {
  const lines = [`# ${sheet} · ${kind === "For review" ? "Print for review" : "Print as revised"} · ${when.toISOString().slice(0, 10)}`, ""];
  if (!items.length) lines.push(kind === "For review" ? "No open items on this sheet." : "No solved items on this sheet yet.");
  for (const i of items) {
    lines.push(`## ${i.id} · ${i.title}`, "", `${i.description}`, "", `Owner ${i.owner} (lead ${i.lead}) · due ${i.due} · ${i.status}`);
    if (kind === "As revised") {
      lines.push("", `Solution: ${i.solution || "(none)"}`);
      for (const a of i.answers) lines.push(`- ${a.discipline}: ${a.text} (${a.by})`);
      const closed = [...i.history].reverse().find((h) => h.what.startsWith("Accepted"));
      if (closed) lines.push(`- Accepted by ${closed.by} on ${closed.at.slice(0, 10)}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

/** The line the register shows (Overdue replaces Open / In progress once the due date passes). */
export function shownStatus(i: ReviewItem, today: string): string { return overdue(i, today) ? "Overdue" : i.status; }
