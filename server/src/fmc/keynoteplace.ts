/**
 * Keynote placement plan. Revit cannot create the keynote tag-to-keynote link
 * (FMC-NO-API-KEYNOTE-LINK). A linked tag is copied, then its host reference is retargeted.
 * The seed is an existing linked tag in any view, or one tag copied from the kit seed model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const KEYNOTE_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_keynote_place needs document, a title or a full path. The active document is not a guess.",
  "FMC-BATCH-LOCKED": "A write needs batch_lease from fmc_batch request.",
  "FMC-KEYNOTE-REFERENCES": "A write needs references.kit, references.standards and references.rulebook.",
  "FMC-KEYNOTE-SEED-MISSING": "No linked keynote tag of this type is in the model, and the kit seed model is not on disk.",
  "FMC-KEYNOTE-SEED-LOAD": "The kit seed model did not open, or it has no linked keynote tag of this type.",
  "FMC-KEYNOTE-COPY-REFUSED": "CopyElements from the seed view into the target view was refused.",
  "FMC-KEYNOTE-RETARGET-REFUSED": "The copied tag could not be pointed at the host in that view.",
  "FMC-NO-API-KEYNOTE-LINK": "The copy did not keep a keynote link (TagText empty). Nothing blank was kept.",
  "FMC-KEYNOTE-NO-HOST": "That view has no element of the requested categories to tag.",
  "FMC-KEYNOTE-VIEW": "That view is not an open plan, or the name was not found.",
  "FMC-KEYNOTE-BY": "by is element, material or user.",
  "FMC-KEYNOTE-ONE-PER-KEY": "Another element closer to the middle of this keynote value already carries the tag in this view.",
  "FMC-KEYNOTE-OVERLAP": "The tag head overlaps an existing tag at every candidate offset.",
};

export type KeyBy = "element" | "material" | "user";

export interface KeynoteTagRow {
  id: string;
  view_id?: string;
  view?: string;
  host?: string;
  key?: string;
  key_source?: string;
  tag_type?: string;
  linked?: boolean;
  min_x?: number;
  min_y?: number;
  max_x?: number;
  max_y?: number;
}

export interface KeynoteHostRow {
  id: string;
  category?: string;
  view_id?: string;
  name?: string;
  key?: string;
  x?: number;
  y?: number;
  nx?: number;
  ny?: number;
  half_mm?: number;
}

export interface KeynoteViewRow {
  id: string;
  name: string;
  view_type?: string;
  is_plan?: boolean;
}

export interface KeynoteDoc {
  title: string;
  path?: string;
  is_central?: boolean;
  views?: KeynoteViewRow[];
  tags?: KeynoteTagRow[];
  hosts?: KeynoteHostRow[];
}

export interface KeynoteSnapshot {
  documents?: KeynoteDoc[];
  resolved_document?: { title?: string; path?: string };
  refused?: boolean;
  code?: string;
  message?: string;
}

export interface PlacementRow {
  host: string;
  category: string;
  seed_id?: string;
  route: "document" | "kit";
  leader?: boolean;
  head_mm?: [number, number];
  moved?: boolean;
}

export interface SkipRow {
  host?: string;
  view?: string;
  code: string;
  reason: string;
}

export interface ViewPlan {
  view: string;
  view_id: string;
  placed: PlacementRow[];
  skipped: SkipRow[];
}

export interface SeedPlan {
  route: "document" | "kit";
  id?: string;
  view?: string;
  view_id?: string;
  key_source?: string;
  tag_type?: string;
  path?: string;
  exists?: boolean;
  code?: string;
  reason?: string;
}

const SOURCE: Record<KeyBy, string> = { element: "element", material: "material", user: "user" };

export function sourceMatches(by: KeyBy, source: string | undefined, tagType?: string): boolean {
  const want = SOURCE[by];
  const text = `${source ?? ""} ${tagType ?? ""}`.toLowerCase();
  if (text.includes(want)) return true;
  return false;
}

function linked(tag: KeynoteTagRow): boolean {
  if (tag.linked === false) return false;
  if (tag.linked === true) return true;
  return (tag.key ?? "").trim().length > 0;
}

/** A linked tag of this key source, in any view. The lowest id wins when several match. */
export function pickSeed(tags: KeynoteTagRow[], by: KeyBy): KeynoteTagRow | null {
  const rows = tags.filter((tag) => linked(tag) && sourceMatches(by, tag.key_source, tag.tag_type) && String(tag.id ?? "").trim());
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return rows[0] ?? null;
}

export function keynoteSeedPath(kitRoot: string): string {
  const base = kitRoot.replace(/[\\/]+$/, "");
  return path.win32.join(base, "02_Keynotes", "Seeds", "FMC_Keynote_Seed.rvt");
}

function normCat(value: string): string {
  return value.trim().toLowerCase().replace(/^ost_/, "").replace(/[\s_-]+/g, "");
}

function catOk(host: KeynoteHostRow, categories: string[]): boolean {
  if (!categories.length) return true;
  const have = normCat(host.category ?? "");
  return categories.some((c) => normCat(c) === have);
}

function isPlan(view: KeynoteViewRow): boolean {
  if (view.is_plan === true) return true;
  if (view.is_plan === false) return false;
  return /plan/i.test(view.view_type ?? "");
}

export function targetViews(views: KeynoteViewRow[], request: "all_plans" | string[]): { found: KeynoteViewRow[]; missing: string[] } {
  const plans = views.filter(isPlan);
  if (request === "all_plans") return { found: plans, missing: [] };
  const found: KeynoteViewRow[] = [];
  const missing: string[] = [];
  for (const name of request) {
    const key = name.trim().toLowerCase();
    const hit = views.find((view) => view.id.toLowerCase() === key || view.name.toLowerCase() === key);
    if (!hit) missing.push(name);
    else if (!isPlan(hit)) missing.push(name);
    else found.push(hit);
  }
  return { found, missing };
}

/** Fallback tag box when no linked tag in the model has a box (the kit seed route before the copy). */
const TAG_W = 900;
const TAG_H = 450;

export interface TagSize { width: number; height: number; source: "seed" | "model" | "default" }

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Research 53: the real tag box. The seed tag's own box first, then the median of linked tags of this type, then 900 x 450. */
export function tagSize(tags: KeynoteTagRow[], by: KeyBy, seed: KeynoteTagRow | null): TagSize {
  const own = seed ? tagBox(seed) : null;
  if (own && own.max_x > own.min_x && own.max_y > own.min_y) return { width: r1(own.max_x - own.min_x), height: r1(own.max_y - own.min_y), source: "seed" };
  const boxes = tags.filter((tag) => linked(tag) && sourceMatches(by, tag.key_source, tag.tag_type)).map(tagBox).filter((box): box is Box => !!box && box.max_x > box.min_x && box.max_y > box.min_y);
  if (boxes.length) return { width: r1(median(boxes.map((b) => b.max_x - b.min_x))), height: r1(median(boxes.map((b) => b.max_y - b.min_y))), source: "model" };
  return { width: TAG_W, height: TAG_H, source: "default" };
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
const HEAD_OFFSETS: Array<[number, number]> = [
  [0, 0], [600, 0], [-600, 0], [0, 600], [0, -600],
  [600, 600], [-600, 600], [600, -600], [-600, -600],
  [1200, 0], [-1200, 0],
];

interface Box { min_x: number; min_y: number; max_x: number; max_y: number }

function boxesOverlap(a: Box, b: Box): boolean {
  return a.min_x < b.max_x && a.max_x > b.min_x && a.min_y < b.max_y && a.max_y > b.min_y;
}

function tagBox(row: KeynoteTagRow): Box | null {
  if ([row.min_x, row.min_y, row.max_x, row.max_y].some((n) => typeof n !== "number")) return null;
  return { min_x: row.min_x as number, min_y: row.min_y as number, max_x: row.max_x as number, max_y: row.max_y as number };
}

/** One host per non-empty keynote value: the one nearest the group's centre. Empty keys stay, one each. */
export function keepCentral(hosts: KeynoteHostRow[], onePerKey: boolean): { kept: KeynoteHostRow[]; dropped: KeynoteHostRow[] } {
  if (!onePerKey) return { kept: hosts, dropped: [] };
  const groups = new Map<string, KeynoteHostRow[]>();
  const kept: KeynoteHostRow[] = [];
  for (const host of hosts) {
    const key = (host.key ?? "").trim();
    if (!key) { kept.push(host); continue; }
    const list = groups.get(key) ?? [];
    list.push(host);
    groups.set(key, list);
  }
  const dropped: KeynoteHostRow[] = [];
  for (const list of groups.values()) {
    const cx = list.reduce((n, host) => n + (host.x ?? 0), 0) / list.length;
    const cy = list.reduce((n, host) => n + (host.y ?? 0), 0) / list.length;
    const ordered = [...list].sort((a, b) => {
      const da = ((a.x ?? 0) - cx) ** 2 + ((a.y ?? 0) - cy) ** 2;
      const db = ((b.x ?? 0) - cx) ** 2 + ((b.y ?? 0) - cy) ** 2;
      return da - db || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });
    kept.push(ordered[0]);
    dropped.push(...ordered.slice(1));
  }
  return { kept, dropped };
}

function headFor(host: KeynoteHostRow, leader: boolean, offset: number, occupied: Box[], size: TagSize = { width: TAG_W, height: TAG_H, source: "default" }): { leader: boolean; head?: [number, number]; moved: boolean; box?: Box } | null {
  const hasPoint = typeof host.x === "number" && typeof host.y === "number";
  if (!hasPoint) return { leader: false, moved: false };
  let bx = host.x as number;
  let by = host.y as number;
  let withLeader = false;
  if (leader) {
    const nx = host.nx ?? 0;
    const ny = host.ny ?? 0;
    const len = Math.hypot(nx, ny);
    if (len > 1e-6) {
      const dist = (host.half_mm ?? 0) + offset;
      bx += (nx / len) * dist;
      by += (ny / len) * dist;
      withLeader = true;
    }
  }
  if (!occupied.length && !withLeader) return { leader: false, moved: false };
  for (let i = 0; i < HEAD_OFFSETS.length; i++) {
    const x = bx + HEAD_OFFSETS[i][0];
    const y = by + HEAD_OFFSETS[i][1];
    const box = { min_x: x - size.width / 2, min_y: y - size.height / 2, max_x: x + size.width / 2, max_y: y + size.height / 2 };
    if (occupied.some((have) => boxesOverlap(have, box))) continue;
    const head: [number, number] = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    const moved = i > 0;
    return { leader: withLeader, head: withLeader || moved ? head : undefined, moved, box };
  }
  return null;
}

export function planKeynotes(doc: KeynoteDoc, args: {
  by: KeyBy;
  views: "all_plans" | string[];
  categories: string[];
  seedPath: string;
  seedExists: boolean;
  one_per_key?: boolean;
  leader?: boolean;
  offset_mm?: number;
}): { seed: SeedPlan; views: ViewPlan[]; code?: string; tag_size: TagSize; counts: { hosts: number; placed: number; skipped: number; one_per_key: number; collision_moved: number; collision_blocked: number } } {
  const seedTag = pickSeed(doc.tags ?? [], args.by);
  const seed: SeedPlan = seedTag
    ? {
      route: "document",
      id: String(seedTag.id),
      view: seedTag.view ?? "",
      view_id: seedTag.view_id ?? "",
      key_source: seedTag.key_source ?? args.by,
      tag_type: seedTag.tag_type ?? "",
    }
    : {
      route: "kit",
      path: args.seedPath,
      exists: args.seedExists,
      ...(args.seedExists ? {} : { code: "FMC-KEYNOTE-SEED-MISSING", reason: KEYNOTE_FIX["FMC-KEYNOTE-SEED-MISSING"] }),
    };
  const size = tagSize(doc.tags ?? [], args.by, seedTag);
  const chosen = targetViews(doc.views ?? [], args.views);
  const views: ViewPlan[] = [];
  for (const name of chosen.missing) {
    views.push({
      view: name,
      view_id: "",
      placed: [],
      skipped: [{ view: name, code: "FMC-KEYNOTE-VIEW", reason: KEYNOTE_FIX["FMC-KEYNOTE-VIEW"] }],
    });
  }
  const hosts = doc.hosts ?? [];
  const counts = { hosts: 0, placed: 0, skipped: 0, one_per_key: 0, collision_moved: 0, collision_blocked: 0 };
  const leader = args.leader === true;
  const offset = args.offset_mm ?? 600;
  for (const view of chosen.found) {
    const inView = hosts.filter((host) => (host.view_id ?? "") === view.id && catOk(host, args.categories));
    counts.hosts += inView.length;
    const skipped: SkipRow[] = [];
    const placed: PlacementRow[] = [];
    if (seed.code) {
      skipped.push({ view: view.name, code: seed.code, reason: seed.reason ?? KEYNOTE_FIX[seed.code] });
    } else if (!inView.length) {
      skipped.push({ view: view.name, code: "FMC-KEYNOTE-NO-HOST", reason: KEYNOTE_FIX["FMC-KEYNOTE-NO-HOST"] });
    } else {
      const already = new Set((doc.tags ?? [])
        .filter((tag) => (tag.view_id ?? "") === view.id && linked(tag) && sourceMatches(args.by, tag.key_source, tag.tag_type))
        .map((tag) => String(tag.host ?? "")));
      const open: KeynoteHostRow[] = [];
      for (const host of inView) {
        if (already.has(String(host.id))) {
          skipped.push({ host: String(host.id), view: view.name, code: "FMC-KEYNOTE-ALREADY", reason: "This host already has a linked keynote of this type in the view." });
          continue;
        }
        open.push(host);
      }
      const reduced = keepCentral(open, args.one_per_key === true);
      counts.one_per_key += reduced.dropped.length;
      for (const host of reduced.dropped) {
        skipped.push({ host: String(host.id), view: view.name, code: "FMC-KEYNOTE-ONE-PER-KEY", reason: KEYNOTE_FIX["FMC-KEYNOTE-ONE-PER-KEY"] });
      }
      const occupied: Box[] = (doc.tags ?? [])
        .filter((tag) => (tag.view_id ?? "") === view.id)
        .map(tagBox)
        .filter((box): box is Box => !!box);
      for (const host of reduced.kept) {
        const spot = headFor(host, leader, offset, occupied, size);
        if (!spot) {
          counts.collision_blocked += 1;
          skipped.push({ host: String(host.id), view: view.name, code: "FMC-KEYNOTE-OVERLAP", reason: KEYNOTE_FIX["FMC-KEYNOTE-OVERLAP"] });
          continue;
        }
        if (spot.moved) counts.collision_moved += 1;
        if (spot.box) occupied.push(spot.box);
        placed.push({
          host: String(host.id),
          category: host.category ?? "",
          seed_id: seed.id,
          route: seed.route,
          leader: spot.leader,
          ...(spot.head ? { head_mm: spot.head } : {}),
          ...(spot.moved ? { moved: true } : {}),
        });
      }
    }
    counts.placed += placed.length;
    counts.skipped += skipped.length;
    views.push({ view: view.name, view_id: view.id, placed, skipped });
  }
  counts.skipped += chosen.missing.length;
  return { seed, views, counts, tag_size: size, ...(seed.code ? { code: seed.code } : {}) };
}

export function referenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return KEYNOTE_FIX["FMC-KEYNOTE-REFERENCES"];
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) return KEYNOTE_FIX["FMC-KEYNOTE-REFERENCES"];
  }
  return null;
}

export function keynoteDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_KEYNOTE_DIR ?? "").trim()) return env.FMC_KEYNOTE_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(os.tmpdir(), "FormcraftLocal");
  return path.join(local, "Formcraft", "keynote");
}

export function writeKeynoteReport(env: NodeJS.ProcessEnv, body: unknown, dir = keynoteDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `keynote-place-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

export function normalizeKeynote(raw: unknown): KeynoteSnapshot {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (body.refused === true || typeof body.code === "string" && body.documents == null) {
    return { refused: true, code: String(body.code ?? "FMC-KEYNOTE"), message: String(body.message ?? body.reason ?? "The read was refused.") };
  }
  const documents = Array.isArray(body.documents) ? body.documents as KeynoteDoc[] : [];
  if (!documents.length && (body.title || body.views || body.tags)) return { documents: [body as unknown as KeynoteDoc] };
  return { documents, resolved_document: body.resolved_document as KeynoteSnapshot["resolved_document"] };
}
