/**
 * Mark & Review tickets (docs/PLAN_MARK_REVIEW.md, R1). A ticket is a review item (MAN 10.5: one owner, a lead
 * discipline, a due date, closed only after the raiser's check) with a place in the model, a thread of typed or spoken
 * notes, pictures, and who fixes it: the AI modeller, a person, a discipline, or anyone. Marking never changes the model.
 * Pure: the register in, the register out.
 */
import { Note, Priority, Register, ReviewItem, Where, defaultDue, nextId } from "./review.js";

export const AI_OWNER = "AI modeller";

export interface MarkInput {
  to: "ai" | "person" | "discipline" | "anyone";
  /** The person (to: person) or the discipline (to: discipline). */
  assignee?: string;
  title?: string;
  text?: string;
  audio?: string;
  transcript?: string;
  lead?: string;
  disciplines?: string[];
  priority: Priority;
  due?: string;
  raised_by: string;
  model: string;
  where: Where;
  picture?: string;
  source?: ReviewItem["source"];
  links?: ReviewItem["links"];
  guid?: string;
}

export function markProblems(q: MarkInput, today: string): string[] {
  const p: string[] = [];
  if (!(q.text ?? "").trim() && !(q.audio ?? "").trim()) p.push("Say what is wrong: a note or a voice note");
  if (!q.where.unique_ids.length && !(q.where.linked ?? []).length && !q.where.point_mm) p.push("Mark something: an element, or a point in the model");
  if (q.to === "person" && !(q.assignee ?? "").trim()) p.push("Name the person it is for");
  if (q.to === "discipline" && !(q.assignee ?? "").trim()) p.push("Name the discipline it is for");
  if (q.due && !/^\d{4}-\d{2}-\d{2}$/.test(q.due)) p.push(`Due "${q.due}" must be a date like 2026-10-20`);
  else if (q.due && q.due < today) p.push(`Due ${q.due} is in the past`);
  return p;
}

/** A short title from the note when none is given. */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "Voice note";
  const first = t.split(/(?<=[.!?])\s/)[0];
  return first.length <= 70 ? first : first.slice(0, 67).trimEnd() + "…";
}

/** A new ticket. The lead discipline owns the fix (MAN 10.5); the owner is the AI, the person, or the raiser until taken. */
export function mark(reg: Register, q: MarkInput, now: Date): ReviewItem {
  const at = now.toISOString();
  const lead = (q.lead || (q.to === "discipline" ? q.assignee : "") || "BIM").trim().toUpperCase();
  const disciplines = [...new Set([lead, ...(q.disciplines ?? [])].map((d) => d.trim().toUpperCase()).filter(Boolean))];
  const owner = q.to === "ai" ? AI_OWNER : q.to === "person" ? q.assignee!.trim() : q.to === "discipline" ? `${q.assignee!.trim().toUpperCase()} lead` : q.raised_by;
  const text = (q.text ?? "").trim() || (q.transcript ?? "").trim();
  const note: Note = { at, by: q.raised_by, text, ...(q.audio ? { audio: q.audio } : {}), ...(q.transcript ? { transcript: q.transcript } : {}) };
  const due = q.due || defaultDue(q.priority, now);
  const item: ReviewItem = {
    id: nextId(reg), title: (q.title ?? "").trim() || titleFrom(text), description: text, disciplines, lead, owner, priority: q.priority,
    due, status: "Open", raised_by: q.raised_by, raised_at: at, model: q.model, view: q.where.view ?? "", element_ids: [],
    answers: [], solution: "", sheet: "",
    history: [{ at, by: q.raised_by, what: `Marked for ${q.to === "ai" ? "the AI modeller" : q.to === "anyone" ? "anyone" : owner}; due ${due}` }],
    to: q.to, where: q.where, notes: [note], pictures: q.picture ? { raised: q.picture } : {}, source: q.source ?? "mark",
    ...(q.links ? { links: q.links } : {}), ...(q.guid ? { guid: q.guid } : {}),
  };
  reg.items.push(item);
  return item;
}

/** A reply in the thread, typed or spoken. A closed ticket takes no replies: reopen it first. */
export function comment(i: ReviewItem, n: Omit<Note, "at">, now: Date) {
  if (i.status === "Closed") throw new Error(`${i.id} is closed: reopen it first`);
  if (!n.text.trim() && !n.audio) throw new Error("A reply needs words or a voice note");
  i.notes = [...(i.notes ?? []), { ...n, text: n.text.trim(), at: now.toISOString() }];
  i.history.push({ at: now.toISOString(), by: n.by, what: n.audio ? "Replied with a voice note" : "Replied" });
}

/** Someone takes a ticket (or the AI starts on it): In progress, and a ticket for anyone gets its owner. */
export function take(i: ReviewItem, by: string, now: Date) {
  if (i.status === "Closed" || i.status === "Resolved") throw new Error(`${i.id} is ${i.status}`);
  if (i.to === "anyone") { i.owner = by; i.to = "person"; }
  if (i.to === "ai" && by !== AI_OWNER) throw new Error(`${i.id} is for the AI modeller: hand it to a person first`);
  i.status = "In progress";
  i.history.push({ at: now.toISOString(), by, what: `Taken by ${by}` });
}

const RANK: Record<Priority, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

/**
 * The fix queue: open tickets for the AI (who: "ai"), for a person, or for a discipline, most urgent first (priority,
 * then due date, then age). The AI reads this list; each entry carries everything the fix needs.
 */
export function queue(reg: Register, who: { ai?: boolean; person?: string; discipline?: string }): ReviewItem[] {
  return reg.items.filter((i) => i.to && (i.status === "Open" || i.status === "In progress") && (
    (who.ai && i.to === "ai") ||
    (who.person && (i.owner.toLowerCase() === who.person.toLowerCase() || i.to === "anyone")) ||
    (who.discipline && i.disciplines.includes(who.discipline.toUpperCase()))))
    .sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.due.localeCompare(b.due) || a.raised_at.localeCompare(b.raised_at));
}

/** BCF topics into the register: a known topic (same GUID) gets its new comments and status; a new one becomes a ticket. */
export function applyBcf(reg: Register, topics: Array<{
  guid: string; title: string; status: ReviewItem["status"]; priority: string; author: string; created: string; assigned: string;
  due: string; description: string; labels: string[]; type: string; comments: Array<{ at: string; by: string; text: string }>; where: Where;
}>, now: Date, picture: (guid: string, id: string) => string | undefined): { added: string[]; updated: string[] } {
  const added: string[] = [], updated: string[] = [];
  const pri = (p: string): Priority => (["Critical", "High", "Medium", "Low"].find((x) => x.toLowerCase() === p.trim().toLowerCase()) as Priority) ?? "Medium";
  for (const t of topics) {
    const known = reg.items.find((i) => i.guid === t.guid);
    if (known) {
      const seen = new Set((known.notes ?? []).map((n) => `${n.at}|${n.by}|${n.text}`));
      const fresh = t.comments.filter((c) => !seen.has(`${c.at}|${c.by}|${c.text}`) && !(known.notes ?? []).some((n) => n.text === c.text && n.by === c.by));
      for (const c of fresh) known.notes = [...(known.notes ?? []), { at: c.at || now.toISOString(), by: c.by || "BCF", text: c.text }];
      if (fresh.length || known.status !== t.status) {
        if (known.status !== t.status) known.history.push({ at: now.toISOString(), by: "BCF", what: `Status ${known.status} → ${t.status} (from BCF)` });
        known.status = t.status;
        updated.push(known.id);
      }
      continue;
    }
    const first = t.comments[0];
    const item = mark(reg, {
      to: /ai modeller/i.test(t.assigned) ? "ai" : t.assigned ? "person" : "anyone", assignee: t.assigned || undefined,
      title: t.title, text: t.description || first?.text || t.title, priority: pri(t.priority),
      due: t.due && t.due >= now.toISOString().slice(0, 10) ? t.due : undefined,
      raised_by: t.author || "BCF", model: "", lead: t.labels[0], disciplines: t.labels,
      where: t.where.unique_ids.length || t.where.camera ? t.where : { ...t.where, point_mm: [0, 0, 0] },
      source: t.type === "Clash" ? "clash" : "bcf", guid: t.guid,
    }, now);
    item.status = t.status;
    item.notes = t.comments.length ? t.comments.map((c) => ({ at: c.at || now.toISOString(), by: c.by || "BCF", text: c.text })) : item.notes;
    const pic = picture(t.guid, item.id);
    if (pic) item.pictures = { raised: pic };
    added.push(item.id);
  }
  return { added, updated };
}

/** A model's discipline from its container name ([Project]-[Originator]-…-[Role]-[Number].rvt, Manual 4.1); BIM otherwise. */
export function roleOfModel(file: string): string {
  const base = (file.split(/[\\/]/).pop() ?? "").replace(/\.(rvt|nwc|nwd|ifc)$/i, "");
  const m = /-([A-Z]{1,2})-\d{4}$/.exec(base);
  return m ? m[1] : "BIM";
}

/** A clash item; fmc and unique_id are filled from the hub's identity map when it knows the element (fmc_navis back). */
export interface ClashItemIn { name: string; category: string; revit_id: string; source: string; fmc?: string; unique_id?: string }

export interface ClashIn {
  name: string; status: string; distance_mm: number; center_mm?: number[];
  item1: ClashItemIn;
  item2: ClashItemIn;
}

const linkItem = (x: ClashItemIn) => ({ model: x.source, id: x.revit_id, category: x.category, ...(x.fmc ? { fmc: x.fmc } : {}), ...(x.unique_id ? { unique_id: x.unique_id } : {}) });

/**
 * Navisworks clashes into the register (R5): one ticket per New or Active clash, for the disciplines whose models
 * clash (the lead: the first model's; within one model, that model's), at the clash point, with both elements' Revit ids
 * and models; deeper clashes come first (High past 50 mm, else Medium). A clash already ticketed (same test and name) is
 * left as it is.
 */
export function clashTickets(reg: Register, test: string, rows: ClashIn[], by: string, now: Date): { added: string[]; skipped: number } {
  const known = new Set(reg.items.filter((i) => i.links?.clash).map((i) => `${i.links!.clash!.test}|${i.links!.clash!.name}`));
  const added: string[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (!/^(new|active)$/i.test(r.status)) { skipped++; continue; }
    if (known.has(`${test}|${r.name}`)) { skipped++; continue; }
    const a = roleOfModel(r.item1.source), b = roleOfModel(r.item2.source);
    const depth = Math.abs(Math.min(0, r.distance_mm ?? 0));
    const item = mark(reg, {
      to: "discipline", assignee: a, lead: a, disciplines: [a, b],
      title: `${test} · ${r.name}: ${r.item1.category || "element"} × ${r.item2.category || "element"}`,
      text: `Clash ${r.name} in ${test}: ${r.item1.category} ${r.item1.revit_id} (${r.item1.source.split(/[\\/]/).pop()}) × ${r.item2.category} ${r.item2.revit_id} (${r.item2.source.split(/[\\/]/).pop()}), ${depth} mm deep.`,
      priority: depth > 50 ? "High" : "Medium", raised_by: by, model: r.item1.source,
      where: { unique_ids: [], ...(r.center_mm ? { point_mm: r.center_mm } : { point_mm: [0, 0, 0] }) },
      source: "clash",
      links: { clash: { test, name: r.name, distance_mm: r.distance_mm, items: [linkItem(r.item1), linkItem(r.item2)] } },
    }, now);
    added.push(item.id);
  }
  return { added, skipped };
}
