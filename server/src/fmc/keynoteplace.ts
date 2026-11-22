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
}

export interface KeynoteHostRow {
  id: string;
  category?: string;
  view_id?: string;
  name?: string;
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

export function planKeynotes(doc: KeynoteDoc, args: {
  by: KeyBy;
  views: "all_plans" | string[];
  categories: string[];
  seedPath: string;
  seedExists: boolean;
}): { seed: SeedPlan; views: ViewPlan[]; code?: string } {
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
  for (const view of chosen.found) {
    const inView = hosts.filter((host) => (host.view_id ?? "") === view.id && catOk(host, args.categories));
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
      for (const host of inView) {
        if (already.has(String(host.id))) {
          skipped.push({ host: String(host.id), view: view.name, code: "FMC-KEYNOTE-ALREADY", reason: "This host already has a linked keynote of this type in the view." });
          continue;
        }
        placed.push({
          host: String(host.id),
          category: host.category ?? "",
          seed_id: seed.id,
          route: seed.route,
        });
      }
    }
    views.push({ view: view.name, view_id: view.id, placed, skipped });
  }
  return { seed, views, ...(seed.code ? { code: seed.code } : {}) };
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
