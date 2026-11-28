/**
 * Door, window and room tags on floor plans that sit on issued sheets.
 * A dry run returns the tag point per element. It does not create a tag.
 *
 * A send_code script that counts IndependentTag.Create successes often returns 0 while
 * untagged doors are on the sheet. The causes this planner accounts for:
 * - FilteredElementCollector(document, view) does not return elements that live in a link.
 * - A filter OwnerViewId == view drops every door, window and room: their owner view is InvalidElementId.
 * - The active view is a sheet, a 3D view or a section. The doors belong to the floor plan in the viewport.
 * - IndependentTag.Create does not tag a room. Rooms use NewRoomTag, and a room in a link needs LinkElementId(link, room).
 * - new Reference(element) is refused when the element belongs to a link. Doors and windows use CreateLinkReference.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TAGS_FIX: Record<string, string> = {
  "FMC-DOC-REQUIRED": "fmc_tags needs document, a title or a full path. The active document is not a guess.",
  "FMC-BATCH-LOCKED": "A write needs batch_lease from fmc_batch request.",
  "FMC-TAGS-REFERENCES": "A write needs references.kit, references.standards and references.rulebook.",
  "FMC-TAGS-NOT-PLAN": "That view is not a floor plan. Tags go on the plan a viewport shows, not on the sheet, a 3D view or a section.",
  "FMC-TAGS-NOT-ON-SHEET": "That floor plan is not placed on an issued sheet.",
  "FMC-TAGS-NOT-ISSUED": "That sheet has no issued revision. Tags run on issued sheets.",
  "FMC-TAGS-ALREADY": "This element already has a tag in the view.",
  "FMC-TAGS-NO-TYPE": "No tag type is loaded for that category. Load a door, window or room tag, or pass tag_types by name.",
  "FMC-TAGS-OVERLAP": "Every candidate offset overlaps an existing tag. Nothing was placed on top of one.",
  "FMC-TAGS-UNPLACED": "The room is unplaced or not enclosed, so it has no point to tag.",
  "FMC-TAGS-NO-POINT": "The element has no plan point.",
};

export type TagCategory = "Doors" | "Windows" | "Rooms";

export interface TagElement {
  id: string;
  category: string;
  x?: number;
  y?: number;
  link_id?: string;
  link_name?: string;
  placed?: boolean;
  source?: "host" | "link";
}

export interface TagMark {
  id: string;
  link_id?: string;
}

export interface TagBox {
  id?: string;
  kind?: string;
  host?: string;
  link_id?: string;
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

export interface TagTypeRow {
  category: string;
  id: string;
  name: string;
}

export interface TagDiagnosis {
  doors_in_document?: number;
  doors_in_view?: number;
  doors_in_links?: number;
  doors_owner_view_match?: number;
  windows_in_view?: number;
  windows_in_links?: number;
  rooms_in_view?: number;
  rooms_in_links?: number;
  is_floor_plan?: boolean;
}

export interface TagViewRow {
  id: string;
  name: string;
  view_type?: string;
  is_floor_plan?: boolean;
  sheet_ids?: string[];
  elements?: TagElement[];
  tagged?: TagMark[];
  tags?: TagBox[];
  diagnosis?: TagDiagnosis;
}

export interface TagSheetRow {
  id: string;
  number?: string;
  name?: string;
  issued?: boolean;
  view_ids?: string[];
}

export interface TagSnapshot {
  title?: string;
  path?: string;
  is_central?: boolean;
  sheets?: TagSheetRow[];
  views?: TagViewRow[];
  tag_types?: TagTypeRow[];
}

export interface TagPlacement {
  element: string;
  category: TagCategory;
  link_id: string;
  link_name: string;
  x: number;
  y: number;
  tag_type_id: string;
  tag_type: string;
  kind: "room" | "independent";
  source: "host" | "link";
}

export interface TagSkip {
  element?: string;
  view?: string;
  code: string;
  reason: string;
}

export interface TagViewPlan {
  view: string;
  view_id: string;
  placed: TagPlacement[];
  skipped: TagSkip[];
  why_zero: string[];
}

const CATEGORIES: TagCategory[] = ["Doors", "Windows", "Rooms"];
const TAG_W = 900;
const TAG_H = 450;
const OFFSETS: Array<[number, number]> = [
  [0, 0], [600, 0], [-600, 0], [0, 600], [0, -600],
  [600, 600], [-600, 600], [600, -600], [-600, -600],
  [1200, 0], [-1200, 0], [0, 1200], [0, -1200],
];

const r1 = (n: number) => Math.round(n * 10) / 10;

export function normCategory(value: string): TagCategory | "" {
  const text = value.trim().toLowerCase().replace(/^ost_/, "").replace(/[\s_-]+/g, "");
  if (text === "door" || text === "doors" || text === "doortags") return "Doors";
  if (text === "window" || text === "windows" || text === "windowtags") return "Windows";
  if (text === "room" || text === "rooms" || text === "roomtags") return "Rooms";
  return "";
}

function overlap(a: TagBox, b: TagBox): boolean {
  return a.min_x < b.max_x && a.max_x > b.min_x && a.min_y < b.max_y && a.max_y > b.min_y;
}

function boxAt(x: number, y: number): TagBox {
  return { min_x: x - TAG_W / 2, min_y: y - TAG_H / 2, max_x: x + TAG_W / 2, max_y: y + TAG_H / 2 };
}

/** Why a host-only IndependentTag script reports 0 while untagged doors are visible. */
export function tagsZeroCauses(diagnosis: TagDiagnosis | undefined, placed: number): string[] {
  if (!diagnosis || placed > 0) return [];
  const reasons: string[] = [];
  const doorsView = diagnosis.doors_in_view ?? 0;
  const doorsLink = diagnosis.doors_in_links ?? 0;
  const doorsDoc = diagnosis.doors_in_document ?? 0;
  const owner = diagnosis.doors_owner_view_match ?? 0;
  if (diagnosis.is_floor_plan === false) {
    reasons.push("The view is not a floor plan. A sheet, a 3D view or a section does not own the doors. Tag the floor plan the viewport shows.");
  }
  if (doorsLink > 0 && doorsView === 0) {
    reasons.push("FilteredElementCollector(document, view) does not return elements in a link. These doors are in a linked document. Tag them with Reference.CreateLinkReference. A room in a link uses NewRoomTag(new LinkElementId(link, room), uv, view).");
  }
  if (doorsDoc > 0 && owner === 0) {
    reasons.push("Doors, windows and rooms have OwnerViewId InvalidElementId. A filter OwnerViewId == view returns 0. Use the view collector for host elements. Do not filter model elements by owner view.");
  }
  if ((diagnosis.rooms_in_view ?? 0) + (diagnosis.rooms_in_links ?? 0) > 0) {
    reasons.push("IndependentTag.Create does not tag a room. Use Document.Create.NewRoomTag. A linked room needs LinkElementId(linkInstanceId, roomId), not a host-only id.");
  }
  if (doorsView === 0 && doorsLink === 0 && doorsDoc > 0 && diagnosis.is_floor_plan !== false) {
    reasons.push("The model has doors, and this floor plan's view collector returned none. The view phase, a filter, the crop, or a hidden category is hiding them.");
  }
  return reasons;
}

function issuedIds(sheets: TagSheetRow[]): Set<string> {
  return new Set(sheets.filter((sheet) => sheet.issued === true).map((sheet) => sheet.id));
}

function sheetByKey(sheets: TagSheetRow[], key: string): TagSheetRow | undefined {
  const name = key.trim().toLowerCase();
  return sheets.find((sheet) => sheet.id.toLowerCase() === name || (sheet.number ?? "").toLowerCase() === name || (sheet.name ?? "").toLowerCase() === name);
}

export function chooseViews(snapshot: TagSnapshot, request: "all_sheets" | string[]): { views: TagViewRow[]; skipped: TagSkip[] } {
  const sheets = snapshot.sheets ?? [];
  const views = snapshot.views ?? [];
  const issued = issuedIds(sheets);
  const skipped: TagSkip[] = [];
  const chosen: TagViewRow[] = [];
  const seen = new Set<string>();
  const take = (view: TagViewRow, sheetOk: boolean) => {
    if (seen.has(view.id)) return;
    seen.add(view.id);
    if (view.is_floor_plan === false) {
      skipped.push({ view: view.name, code: "FMC-TAGS-NOT-PLAN", reason: TAGS_FIX["FMC-TAGS-NOT-PLAN"] });
      return;
    }
    if (!sheetOk) {
      const onSheet = (view.sheet_ids ?? []).length > 0;
      skipped.push({
        view: view.name,
        code: onSheet ? "FMC-TAGS-NOT-ISSUED" : "FMC-TAGS-NOT-ON-SHEET",
        reason: TAGS_FIX[onSheet ? "FMC-TAGS-NOT-ISSUED" : "FMC-TAGS-NOT-ON-SHEET"],
      });
      return;
    }
    chosen.push(view);
  };
  if (request === "all_sheets") {
    for (const view of views) take(view, (view.sheet_ids ?? []).some((id) => issued.has(id)));
    return { views: chosen, skipped };
  }
  for (const key of request) {
    const sheet = sheetByKey(sheets, key);
    if (sheet) {
      if (sheet.issued !== true) {
        skipped.push({ view: sheet.number || sheet.name || key, code: "FMC-TAGS-NOT-ISSUED", reason: TAGS_FIX["FMC-TAGS-NOT-ISSUED"] });
        continue;
      }
      const ids = new Set(sheet.view_ids ?? []);
      const hits = views.filter((view) => ids.has(view.id) || (view.sheet_ids ?? []).includes(sheet.id));
      if (!hits.length) skipped.push({ view: key, code: "FMC-TAGS-NOT-ON-SHEET", reason: TAGS_FIX["FMC-TAGS-NOT-ON-SHEET"] });
      for (const view of hits) take(view, true);
      continue;
    }
    const name = key.trim().toLowerCase();
    const view = views.find((row) => row.id.toLowerCase() === name || row.name.toLowerCase() === name);
    if (!view) {
      skipped.push({ view: key, code: "FMC-TAGS-NOT-ON-SHEET", reason: TAGS_FIX["FMC-TAGS-NOT-ON-SHEET"] });
      continue;
    }
    take(view, (view.sheet_ids ?? []).some((id) => issued.has(id)));
  }
  return { views: chosen, skipped };
}

function typeFor(types: TagTypeRow[], category: TagCategory, wanted: string | undefined): TagTypeRow | null {
  const rows = types.filter((row) => normCategory(row.category) === category);
  if (wanted && wanted.trim() && wanted.trim().toLowerCase() !== "first") {
    const name = wanted.trim().toLowerCase();
    return rows.find((row) => row.name.toLowerCase() === name || row.id === wanted.trim()) ?? null;
  }
  return [...rows].sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
}

function taggedKey(id: string, linkId: string | undefined): string {
  return `${linkId ?? ""}:${id}`;
}

function freePoint(x: number, y: number, occupied: TagBox[]): { x: number; y: number; moved: boolean } | null {
  for (let i = 0; i < OFFSETS.length; i++) {
    const px = x + OFFSETS[i][0];
    const py = y + OFFSETS[i][1];
    const box = boxAt(px, py);
    if (occupied.some((have) => overlap(have, box))) continue;
    return { x: r1(px), y: r1(py), moved: i > 0 };
  }
  return null;
}

export function planTags(snapshot: TagSnapshot, args: {
  views: "all_sheets" | string[];
  categories: string[];
  tag_types?: Partial<Record<TagCategory, string>>;
}): { views: TagViewPlan[]; skipped: TagSkip[]; placed: number; why_zero: string[] } {
  const wanted = (args.categories.length ? args.categories : CATEGORIES).map(normCategory).filter((row): row is TagCategory => !!row);
  const categories = wanted.length ? wanted : [...CATEGORIES];
  const chosen = chooseViews(snapshot, args.views);
  const plans: TagViewPlan[] = [];
  const why = new Set<string>();
  for (const view of chosen.views) {
    const have = new Set((view.tagged ?? []).map((mark) => taggedKey(mark.id, mark.link_id)));
    const occupied: TagBox[] = [...(view.tags ?? [])];
    const placed: TagPlacement[] = [];
    const skipped: TagSkip[] = [];
    for (const element of view.elements ?? []) {
      const category = normCategory(element.category);
      if (!category || !categories.includes(category)) continue;
      if (category === "Rooms" && element.placed === false) {
        skipped.push({ element: element.id, view: view.name, code: "FMC-TAGS-UNPLACED", reason: TAGS_FIX["FMC-TAGS-UNPLACED"] });
        continue;
      }
      if (have.has(taggedKey(element.id, element.link_id))) {
        skipped.push({ element: element.id, view: view.name, code: "FMC-TAGS-ALREADY", reason: TAGS_FIX["FMC-TAGS-ALREADY"] });
        continue;
      }
      if (typeof element.x !== "number" || typeof element.y !== "number") {
        skipped.push({ element: element.id, view: view.name, code: "FMC-TAGS-NO-POINT", reason: TAGS_FIX["FMC-TAGS-NO-POINT"] });
        continue;
      }
      const type = typeFor(snapshot.tag_types ?? [], category, args.tag_types?.[category]);
      if (!type) {
        skipped.push({ element: element.id, view: view.name, code: "FMC-TAGS-NO-TYPE", reason: TAGS_FIX["FMC-TAGS-NO-TYPE"] });
        continue;
      }
      const spot = freePoint(element.x, element.y, occupied);
      if (!spot) {
        skipped.push({ element: element.id, view: view.name, code: "FMC-TAGS-OVERLAP", reason: TAGS_FIX["FMC-TAGS-OVERLAP"] });
        continue;
      }
      occupied.push(boxAt(spot.x, spot.y));
      placed.push({
        element: element.id,
        category,
        link_id: element.link_id ?? "",
        link_name: element.link_name ?? "",
        x: spot.x,
        y: spot.y,
        tag_type_id: type.id,
        tag_type: type.name,
        kind: category === "Rooms" ? "room" : "independent",
        source: element.source === "link" || element.link_id ? "link" : "host",
      });
    }
    const untagged = (view.elements ?? []).filter((element) => {
      const category = normCategory(element.category);
      return !!category && categories.includes(category) && !have.has(taggedKey(element.id, element.link_id));
    });
    const causes = placed.length === 0 && untagged.length > 0 ? tagsZeroCauses(view.diagnosis, 0) : [];
    for (const line of causes) why.add(line);
    plans.push({ view: view.name, view_id: view.id, placed, skipped, why_zero: causes });
  }
  const placed = plans.reduce((n, view) => n + view.placed.length, 0);
  return { views: plans, skipped: chosen.skipped, placed, why_zero: [...why] };
}

export function referenceProblems(refs: { kit?: string[]; standards?: string[]; rulebook?: string[] } | undefined): string | null {
  if (!refs) return TAGS_FIX["FMC-TAGS-REFERENCES"];
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) return TAGS_FIX["FMC-TAGS-REFERENCES"];
  }
  return null;
}

export function tagsDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_TAGS_DIR ?? "").trim()) return env.FMC_TAGS_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(os.tmpdir(), "FormcraftLocal");
  return path.join(local, "Formcraft", "tags");
}

export function writeTagsReport(env: NodeJS.ProcessEnv, body: unknown, dir = tagsDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `tags-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}
