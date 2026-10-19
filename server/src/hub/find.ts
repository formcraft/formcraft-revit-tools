/**
 * One search and one log across the apps (docs/PLAN_ENGINEERING_HUB.md, X3): "where is D-12 and what touches it".
 * A search starts from what a person types (a mark, a room number, a name, a Formcraft id, a Revit UniqueId or element
 * id) and gathers "needles": the Formcraft ids, UniqueIds and element ids that name the same element. Every source is
 * then matched against the needles: the identity map, review tickets, recipe tree nodes, exchange packages, Navisworks
 * clash results, and the file log. Pure apart from reading the files it is pointed at; the tool asks the apps.
 */
import fs from "node:fs";
import path from "node:path";
import type { IdentityEntry, IdentityMap, PackageManifest } from "./exchange.js";
import type { Register, ReviewItem } from "../fmc/review.js";
import type { Tree, TreeNode } from "../tree/tree.js";
import type { ClashRow } from "../fmc/navis.js";

const win = path.win32;

export interface Needles { text: string; fmc: string[]; unique_ids: string[]; element_ids: string[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The needle as a whole word: D-12 is found in "fix D-12 base", not in "D-123"; 4120 is not found in 41208. */
export function wordRe(needle: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9])${esc(needle)}($|[^A-Za-z0-9])`, "i");
}
const eq = (a: unknown, b: string) => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
const isNum = (s: string) => /^\d+$/.test(s);

/** Every needle that can appear in free text (a log line, a package file), each as a whole word. */
export function needleList(n: Needles): string[] {
  return [...new Set([n.text, ...n.fmc, ...n.unique_ids, ...n.element_ids].map((s) => s.trim()).filter((s) => s.length >= 2))];
}
export function mentions(text: string, n: Needles): string | null {
  for (const s of needleList(n)) if (wordRe(s).test(text)) return s;
  return null;
}

// ---- the identity map --------------------------------------------------------------------------------------------

/** The map's elements named by the query: their Formcraft id, their name, or any app's id for them. */
export function identityMatches(map: IdentityMap, query: string): IdentityEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return Object.values(map.entries).filter((e) => e.fmc.toLowerCase() === q || (e.name ?? "").toLowerCase() === q ||
    Object.values(e.apps).some((a) => a?.id.toLowerCase() === q));
}

/** The needles for a query: the text itself, plus every id the identity map and the Revit search found for it. */
export function needlesFor(query: string, entries: IdentityEntry[], revitFound: Array<{ unique_id?: string; element_id?: unknown }> = []): Needles {
  const fmc = new Set<string>(), uids = new Set<string>(), eids = new Set<string>();
  for (const e of entries) {
    fmc.add(e.fmc);
    const r = e.apps.revit?.id;
    if (r) (isNum(r) ? eids : uids).add(r);
  }
  for (const f of revitFound) {
    if (f.unique_id) uids.add(String(f.unique_id));
    if (f.element_id !== undefined && f.element_id !== null && String(f.element_id)) eids.add(String(f.element_id));
  }
  const q = query.trim();
  if (/^FMC-/i.test(q)) fmc.add(q);
  else if (isNum(q)) eids.add(q);
  return { text: q, fmc: [...fmc], unique_ids: [...uids], element_ids: [...eids] };
}

// ---- review tickets ----------------------------------------------------------------------------------------------

export interface TicketHit { id: string; title: string; status: string; priority: string; source: string; why: string }

/** Why a ticket concerns the needles, or null: its elements, its clash items, its recipe node, or its words. */
export function ticketWhy(i: ReviewItem, n: Needles): string | null {
  const eids = new Set(n.element_ids), uids = new Set(n.unique_ids);
  if ((i.element_ids ?? []).some((x) => eids.has(String(x)))) return "its elements";
  if ((i.where?.unique_ids ?? []).some((u) => uids.has(u)) || (i.where?.linked ?? []).some((l) => uids.has(l.unique_id))) return "its elements";
  if ((i.links?.clash?.items ?? []).some((c) => eids.has(String(c.id)))) return "its clash";
  if (eq(i.links?.recipe_node, n.text) || eq(i.links?.family, n.text)) return "its recipe node";
  if (n.text && (wordRe(n.text).test(i.title ?? "") || wordRe(n.text).test(i.description ?? ""))) return "its title or description";
  return null;
}

export function matchTickets(reg: Register | null, n: Needles): TicketHit[] {
  const out: TicketHit[] = [];
  for (const i of reg?.items ?? []) {
    const why = ticketWhy(i, n);
    if (why) out.push({ id: i.id, title: i.title, status: i.status, priority: i.priority, source: i.source ?? "mark", why });
  }
  return out;
}

// ---- the recipe tree ---------------------------------------------------------------------------------------------

export interface TreeHit { id: string; kind: string; name: string; path: string[]; why: string }

/** A string anywhere in a node's inputs or tool arguments equal to the query (a room number, a mark), a few levels deep. */
function valueHit(v: unknown, q: string, depth = 0): string | null {
  if (depth > 4 || v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return eq(String(v), q) ? String(v) : null;
  if (Array.isArray(v)) { for (const x of v) { const h = valueHit(x, q, depth + 1); if (h) return h; } return null; }
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { const h = valueHit(x, q, depth + 1); if (h) return `${k} = ${h}`; }
  }
  return null;
}

/** Tree nodes named by the query: their id, their name, or one of their values; FMC:<node> marks find their node. */
export function matchTree(tree: Tree | null, query: string): TreeHit[] {
  const q = query.trim().replace(/^FMC:/i, "");
  if (!tree || !q) return [];
  const out: TreeHit[] = [];
  const walk = (node: TreeNode, trail: string[]) => {
    const path = [...trail, node.id];
    let why: string | null = null;
    if (eq(node.id, q)) why = "its id";
    else if (eq(node.name, q) || (node.name && wordRe(q).test(node.name))) why = "its name";
    else { const v = valueHit(node.inputs, q) ?? valueHit(node.make?.args, q); if (v) why = v; }
    if (why) out.push({ id: node.id, kind: node.kind, name: node.name ?? "", path, why });
    for (const c of node.children ?? []) walk(c, path);
  };
  walk(tree.root, []);
  return out;
}

// ---- exchange packages -------------------------------------------------------------------------------------------

export interface PackageHit { id: string; from: string; to: string; what: string; created: string; why: string }

/**
 * Packages that name the needles: in their manifest, or in a file of theirs under 1 MB (an identity list, a bar map, a
 * search-set file). Larger files (models, renders) are not read.
 */
export function matchPackages(root: string, manifests: PackageManifest[], n: Needles, maxBytes = 1024 * 1024): PackageHit[] {
  const out: PackageHit[] = [];
  for (const m of manifests) {
    let why: string | null = null;
    const inManifest = mentions(JSON.stringify(m), n);
    if (inManifest) why = `the manifest names ${inManifest}`;
    for (const f of why ? [] : m.files ?? []) {
      if (f.bytes > maxBytes || !/\.(json|csv|txt|xml|md)$/i.test(f.name)) continue;
      try {
        const hit = mentions(fs.readFileSync(win.join(root, "Packages", m.id, f.name), "utf8"), n);
        if (hit) { why = `${f.name} names ${hit}`; break; }
      } catch { /* a file moved: verify says so */ }
    }
    if (why) out.push({ id: m.id, from: String(m.from), to: String(m.to), what: m.what, created: m.created, why });
  }
  return out;
}

// ---- Navisworks clashes ------------------------------------------------------------------------------------------

export interface ClashHit { test: string; name: string; status: string; distance_mm: number; other: { category: string; revit_id: string; source: string; name: string } }

/** The clashes one of whose items is a needle element (by its Revit id) or carries the query as its name. */
export function matchClashes(test: string, rows: ClashRow[], n: Needles): ClashHit[] {
  const eids = new Set(n.element_ids);
  const isIt = (i: ClashRow["item1"]) => !!i && (eids.has(String(i.revit_id)) || eq(i.name, n.text));
  const out: ClashHit[] = [];
  for (const r of rows) {
    const a = isIt(r.item1), b = isIt(r.item2);
    if (!a && !b) continue;
    const other = a ? r.item2 : r.item1;
    out.push({ test, name: r.name, status: r.status, distance_mm: r.distance_mm,
      other: { category: other?.category ?? "", revit_id: String(other?.revit_id ?? ""), source: win.basename(other?.source ?? ""), name: other?.name ?? "" } });
  }
  return out;
}

// ---- one log -----------------------------------------------------------------------------------------------------

export interface LogLine { at: string; source: "file log" | "exchange" | "review" | "identity"; what: string; detail?: string }

/** The file log's rows (timestamp, action, dry_run, target, result, detail) that name a needle. */
export function fileLogLines(rows: string[][], n: Needles): LogLine[] {
  const out: LogLine[] = [];
  for (const r of rows.slice(1)) {
    const [at = "", action = "", dry = "", target = "", result = "", detail = ""] = r;
    if (!mentions(`${target} ${detail}`, n)) continue;
    out.push({ at, source: "file log", what: `${action}${dry === "true" ? " (dry run)" : ""}: ${result}`, detail: [target, detail].filter(Boolean).join(" · ") });
  }
  return out;
}

export function packageLines(hits: PackageHit[]): LogLine[] {
  return hits.map((h) => ({ at: h.created, source: "exchange" as const, what: `${h.from} → ${h.to}: ${h.what}`, detail: `${h.id} (${h.why})` }));
}

/** A matched ticket's whole story: raised, every history line, every answer. Who did it is the register's own record. */
export function ticketLines(reg: Register | null, n: Needles): LogLine[] {
  const out: LogLine[] = [];
  for (const i of reg?.items ?? []) {
    if (!ticketWhy(i, n)) continue;
    out.push({ at: i.raised_at, source: "review", what: `${i.id} raised: ${i.title}`, detail: `${i.priority}, ${i.disciplines.join(", ")}` });
    for (const h of i.history ?? []) out.push({ at: h.at, source: "review", what: `${i.id}: ${h.what}` });
    for (const a of i.answers ?? []) out.push({ at: a.at, source: "review", what: `${i.id} answered by ${a.discipline} (${a.status})`, detail: a.text.slice(0, 200) });
  }
  return out;
}

export function identityLines(entries: IdentityEntry[]): LogLine[] {
  return entries.flatMap((e) => Object.entries(e.apps).map(([app, ref]) => ({
    at: ref!.at, source: "identity" as const, what: `${e.fmc}${e.name ? ` (${e.name})` : ""} linked in ${app}`, detail: `${ref!.id}${ref!.file ? ` · ${win.basename(ref!.file)}` : ""}` })));
}

/** One timeline, newest first; lines without a readable time go last. */
export function mergeTimeline(lines: LogLine[], limit: number): { total: number; lines: LogLine[] } {
  const t = (s: string) => { const v = Date.parse(s); return Number.isFinite(v) ? v : -Infinity; };
  const sorted = [...lines].sort((a, b) => t(b.at) - t(a.at));
  return { total: sorted.length, lines: sorted.slice(0, limit) };
}
