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
  "FMC-TAGS-KIT-TYPE-MISSING": "The kit names a tag type for this view scale, and that type is not loaded. Load it from the kit. Nothing falls back to another type.",
  "FMC-TAGS-TOO-MANY-VIEWS": "More views than max_views. Split the call, or raise max_views.",
  "FMC-TAGS-DUPLICATE": "The same element is listed twice for this view. It is tagged once.",
  "FMC-TAGS-OUT-OF-CROP": "Every free spot for this tag is outside the view crop.",
  "FMC-TAGS-BLANK": "The tag shows no text. The tagged parameter (Mark, Type Mark, Number or Name) is empty.",
  "FMC-TAGS-MISSING": "The element has no tag in this view.",
  "FMC-TAGS-SCALE-RULES": "The tag scale rules file could not be read. Fix it, or pass scale_rules_file.",
};

/** Which views a bulk call reaches. issued_sheets is the old rule and the default. */
export type TagScope = "issued_sheets" | "any_sheet" | "any_plan";

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
  /** Plan box of the element itself, mm. Optional: used to keep a tag off the element it does not tag. */
  min_x?: number;
  min_y?: number;
  max_x?: number;
  max_y?: number;
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
  /** The text the tag shows, as Revit reports it (TagText). Empty or "?" is a blank tag. */
  text?: string;
  /** The element the tag reads, when known. */
  element?: string;
  category?: string;
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
  /** View scale denominator: 100 is 1:100. Missing means 100. */
  scale?: number;
  /** Crop region in plan, mm. A tag is kept inside it when given. */
  crop?: { min_x: number; min_y: number; max_x: number; max_y: number };
  /** Other annotation boxes (text, dimensions, keynotes) a new tag must not sit on. */
  obstacles?: TagBox[];
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
  /** True when the tag was shifted off its element point to clear another box. */
  moved: boolean;
  offset_mm: [number, number];
  /** Where the tag type came from: the tag_types argument, the kit's scale rule, or the first loaded type. */
  type_source: "argument" | "kit_scale" | "first";
  scale: number;
}

/** One row per element in scope: nothing is skipped without a row. */
export interface TagItem {
  element: string;
  link_id: string;
  category: TagCategory;
  status: "planned" | "skipped";
  code?: string;
  reason?: string;
  tag_type?: string;
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
  scale: number;
  placed: TagPlacement[];
  skipped: TagSkip[];
  items: TagItem[];
  why_zero: string[];
}

/** Kit rule: a tag type per category for a range of view scales. Kit data, never code (CLAUDE.md rule 7). */
export interface TagScaleRule {
  category: string;
  /** Inclusive scale denominators. A rule with neither covers every scale. */
  min_scale?: number;
  max_scale?: number;
  tag_type: string;
}

export interface TagScaleRules {
  schema?: string;
  status?: string;
  rules?: TagScaleRule[];
  /** Tag box on paper, mm, per category: [width, height]. Times the scale gives the model box. */
  paper_box_mm?: Partial<Record<TagCategory, [number, number]>>;
}

export interface LoadedScaleRules {
  rules: TagScaleRules | null;
  path: string;
  source: "file" | "kit" | "none";
  provisional: boolean;
}

const CATEGORIES: TagCategory[] = ["Doors", "Windows", "Rooms"];
/** Tag box on paper (mm) when the kit gives none: 9 x 4.5 mm, 900 x 450 at 1:100 as before. */
const PAPER_W = 9;
const PAPER_H = 4.5;
const BASE_SCALE = 100;
/** Candidate shifts at 1:100, nearest first. Scaled by the view scale. The first 13 are the old list. */
const OFFSETS: Array<[number, number]> = [
  [0, 0], [600, 0], [-600, 0], [0, 600], [0, -600],
  [600, 600], [-600, 600], [600, -600], [-600, -600],
  [1200, 0], [-1200, 0], [0, 1200], [0, -1200],
  [1200, 600], [-1200, 600], [1200, -600], [-1200, -600],
  [1800, 0], [-1800, 0], [0, 1800], [0, -1800],
  [1800, 1200], [-1800, 1200], [1800, -1200], [-1800, -1200],
];
export const MAX_VIEWS_DEFAULT = 200;

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

export function viewScale(view: { scale?: number }): number {
  const s = Number(view.scale);
  return Number.isFinite(s) && s > 0 ? s : BASE_SCALE;
}

/** Model-space tag size (mm) for a category at a view scale. Paper size from the kit, else 9 x 4.5 mm. */
export function tagSize(scale: number, category: TagCategory, rules?: TagScaleRules | null): [number, number] {
  const paper = rules?.paper_box_mm?.[category];
  const w = Array.isArray(paper) && paper[0] > 0 ? paper[0] : PAPER_W;
  const h = Array.isArray(paper) && paper[1] > 0 ? paper[1] : PAPER_H;
  return [w * scale, h * scale];
}

function boxAt(x: number, y: number, size: [number, number] = [PAPER_W * BASE_SCALE, PAPER_H * BASE_SCALE]): TagBox {
  return { min_x: x - size[0] / 2, min_y: y - size[1] / 2, max_x: x + size[0] / 2, max_y: y + size[1] / 2 };
}

/** The kit's tag type for a category at a scale, or null when no rule covers it. */
export function kitTypeForScale(rules: TagScaleRules | null | undefined, category: TagCategory, scale: number): string | null {
  for (const rule of rules?.rules ?? []) {
    if (normCategory(rule.category) !== category || !rule.tag_type?.trim()) continue;
    if (typeof rule.min_scale === "number" && scale < rule.min_scale) continue;
    if (typeof rule.max_scale === "number" && scale > rule.max_scale) continue;
    return rule.tag_type.trim();
  }
  return null;
}

/** True when a tag shows nothing: no text, only spaces, or Revit's "?" for an empty label. */
export function isBlankTagText(text: string | undefined | null): boolean {
  if (text == null) return false;
  const t = String(text).replace(/\s+/g, "");
  return t === "" || /^\?+$/.test(t);
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

export function chooseViews(snapshot: TagSnapshot, request: "all_sheets" | string[], scope: TagScope = "issued_sheets", maxViews = MAX_VIEWS_DEFAULT): { views: TagViewRow[]; skipped: TagSkip[] } {
  const sheets = snapshot.sheets ?? [];
  const views = snapshot.views ?? [];
  const issued = issuedIds(sheets);
  const skipped: TagSkip[] = [];
  const chosen: TagViewRow[] = [];
  const seen = new Set<string>();
  const onAnySheet = (view: TagViewRow) => (view.sheet_ids ?? []).length > 0;
  const sheetRule = (view: TagViewRow, issuedOk: boolean) =>
    scope === "any_plan" ? true : scope === "any_sheet" ? onAnySheet(view) : issuedOk;
  const take = (view: TagViewRow, issuedOk: boolean) => {
    if (seen.has(view.id)) return;
    seen.add(view.id);
    const sheetOk = sheetRule(view, issuedOk);
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
    if (chosen.length >= maxViews) {
      skipped.push({ view: view.name, code: "FMC-TAGS-TOO-MANY-VIEWS", reason: TAGS_FIX["FMC-TAGS-TOO-MANY-VIEWS"] });
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
      if (sheet.issued !== true && scope === "issued_sheets") {
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

function insideCrop(box: TagBox, crop: TagViewRow["crop"]): boolean {
  if (!crop) return true;
  return box.min_x >= crop.min_x && box.max_x <= crop.max_x && box.min_y >= crop.min_y && box.max_y <= crop.max_y;
}

/**
 * The nearest free spot for a tag: candidate shifts scaled by the view scale, tried nearest first. A spot is free when
 * its box overlaps no existing tag, no tag placed earlier in this call, no obstacle, and stays inside the crop.
 */
export function freePoint(
  x: number,
  y: number,
  occupied: TagBox[],
  opts: { scale?: number; size?: [number, number]; crop?: TagViewRow["crop"] } = {},
): { x: number; y: number; moved: boolean; offset: [number, number]; box: TagBox } | { blocked: "overlap" | "crop" } {
  const k = (opts.scale ?? BASE_SCALE) / BASE_SCALE;
  let cropOnly = true;
  for (let i = 0; i < OFFSETS.length; i++) {
    const dx = OFFSETS[i][0] * k;
    const dy = OFFSETS[i][1] * k;
    const px = r1(x + dx);
    const py = r1(y + dy);
    const box = boxAt(px, py, opts.size);
    const inCrop = insideCrop(box, opts.crop);
    const clear = !occupied.some((have) => overlap(have, box));
    if (clear && inCrop) return { x: px, y: py, moved: i > 0, offset: [r1(dx), r1(dy)], box };
    if (!clear) cropOnly = false;
  }
  return { blocked: cropOnly && opts.crop ? "crop" : "overlap" };
}

function elementBox(element: TagElement): TagBox | null {
  if ([element.min_x, element.min_y, element.max_x, element.max_y].every((n) => typeof n === "number")) {
    return { id: element.id, min_x: element.min_x!, min_y: element.min_y!, max_x: element.max_x!, max_y: element.max_y! };
  }
  return null;
}

export interface PlanTagsArgs {
  views: "all_sheets" | string[];
  categories: string[];
  tag_types?: Partial<Record<TagCategory, string>>;
  scope?: TagScope;
  max_views?: number;
  scale_rules?: TagScaleRules | null;
  /** Keep tags off the boxes of other elements in the view (default true when the read gives element boxes). */
  avoid_elements?: boolean;
}

function wantedCategories(list: string[]): TagCategory[] {
  const wanted = (list.length ? list : CATEGORIES).map(normCategory).filter((row): row is TagCategory => !!row);
  return wanted.length ? wanted : [...CATEGORIES];
}

export function planTags(snapshot: TagSnapshot, args: PlanTagsArgs): { views: TagViewPlan[]; skipped: TagSkip[]; placed: number; why_zero: string[]; items: number } {
  const categories = wantedCategories(args.categories);
  const chosen = chooseViews(snapshot, args.views, args.scope ?? "issued_sheets", args.max_views ?? MAX_VIEWS_DEFAULT);
  const plans: TagViewPlan[] = [];
  const why = new Set<string>();
  const avoid = args.avoid_elements !== false;
  for (const view of chosen.views) {
    const scale = viewScale(view);
    const have = new Set((view.tagged ?? []).map((mark) => taggedKey(mark.id, mark.link_id)));
    const occupied: TagBox[] = [...(view.tags ?? []), ...(view.obstacles ?? [])];
    const placed: TagPlacement[] = [];
    const skipped: TagSkip[] = [];
    const items: TagItem[] = [];
    const listed = new Set<string>();
    const inScope = (view.elements ?? []).filter((element) => {
      const category = normCategory(element.category);
      return !!category && categories.includes(category);
    });
    const boxes = avoid ? inScope.map(elementBox) : [];
    inScope.forEach((element, index) => {
      const category = normCategory(element.category) as TagCategory;
      const key = taggedKey(element.id, element.link_id);
      const skip = (code: string) => {
        skipped.push({ element: element.id, view: view.name, code, reason: TAGS_FIX[code] });
        items.push({ element: element.id, link_id: element.link_id ?? "", category, status: "skipped", code, reason: TAGS_FIX[code] });
      };
      if (listed.has(key)) return skip("FMC-TAGS-DUPLICATE");
      listed.add(key);
      if (category === "Rooms" && element.placed === false) return skip("FMC-TAGS-UNPLACED");
      if (have.has(key)) return skip("FMC-TAGS-ALREADY");
      if (typeof element.x !== "number" || typeof element.y !== "number") return skip("FMC-TAGS-NO-POINT");
      const explicit = args.tag_types?.[category];
      const kitName = explicit && explicit.trim() ? null : kitTypeForScale(args.scale_rules, category, scale);
      const type = typeFor(snapshot.tag_types ?? [], category, explicit && explicit.trim() ? explicit : kitName ?? undefined);
      if (!type) return skip(kitName ? "FMC-TAGS-KIT-TYPE-MISSING" : "FMC-TAGS-NO-TYPE");
      const size = tagSize(scale, category, args.scale_rules);
      const others = boxes.filter((box, i): box is TagBox => !!box && i !== index);
      const spot = freePoint(element.x, element.y, [...occupied, ...others], { scale, size, crop: view.crop });
      if ("blocked" in spot) return skip(spot.blocked === "crop" ? "FMC-TAGS-OUT-OF-CROP" : "FMC-TAGS-OVERLAP");
      occupied.push(spot.box);
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
        moved: spot.moved,
        offset_mm: spot.offset,
        type_source: explicit && explicit.trim() ? "argument" : kitName ? "kit_scale" : "first",
        scale,
      });
      items.push({ element: element.id, link_id: element.link_id ?? "", category, status: "planned", tag_type: type.name });
    });
    const untagged = inScope.filter((element) => !have.has(taggedKey(element.id, element.link_id)));
    const causes = placed.length === 0 && untagged.length > 0 ? tagsZeroCauses(view.diagnosis, 0) : [];
    for (const line of causes) why.add(line);
    plans.push({ view: view.name, view_id: view.id, scale, placed, skipped, items, why_zero: causes });
  }
  const placed = plans.reduce((n, view) => n + view.placed.length, 0);
  const items = plans.reduce((n, view) => n + view.items.length, 0);
  return { views: plans, skipped: chosen.skipped, placed, why_zero: [...why], items };
}

export interface TagAuditView {
  view: string;
  view_id: string;
  scale: number;
  missing: Array<{ element: string; link_id: string; category: TagCategory; code: "FMC-TAGS-MISSING" }>;
  blank: Array<{ tag_id: string; kind: string; element: string; category: string; text: string; code: "FMC-TAGS-BLANK" }>;
  tagged: number;
  unplaced_rooms: string[];
}

/** Read-only audit: every element in scope with no tag, and every tag that shows no text. */
export function auditTags(snapshot: TagSnapshot, args: Omit<PlanTagsArgs, "tag_types" | "scale_rules" | "avoid_elements">): {
  views: TagAuditView[]; skipped: TagSkip[]; missing: number; blank: number; tagged: number;
} {
  const categories = wantedCategories(args.categories);
  const chosen = chooseViews(snapshot, args.views, args.scope ?? "issued_sheets", args.max_views ?? MAX_VIEWS_DEFAULT);
  const rows: TagAuditView[] = [];
  for (const view of chosen.views) {
    const have = new Set((view.tagged ?? []).map((mark) => taggedKey(mark.id, mark.link_id)));
    const seen = new Set<string>();
    const missing: TagAuditView["missing"] = [];
    const unplaced: string[] = [];
    let tagged = 0;
    for (const element of view.elements ?? []) {
      const category = normCategory(element.category);
      if (!category || !categories.includes(category)) continue;
      const key = taggedKey(element.id, element.link_id);
      if (seen.has(key)) continue;
      seen.add(key);
      if (have.has(key)) { tagged++; continue; }
      if (category === "Rooms" && element.placed === false) { unplaced.push(element.id); continue; }
      missing.push({ element: element.id, link_id: element.link_id ?? "", category, code: "FMC-TAGS-MISSING" });
    }
    const blank: TagAuditView["blank"] = [];
    for (const tag of view.tags ?? []) {
      const category = normCategory(tag.category ?? (tag.kind === "room" ? "Rooms" : ""));
      if (category && !categories.includes(category)) continue;
      if (!isBlankTagText(tag.text)) continue;
      blank.push({ tag_id: tag.id ?? "", kind: tag.kind ?? "", element: tag.element ?? "", category: category || (tag.category ?? ""), text: tag.text ?? "", code: "FMC-TAGS-BLANK" });
    }
    rows.push({ view: view.name, view_id: view.id, scale: viewScale(view), missing, blank, tagged, unplaced_rooms: unplaced });
  }
  return {
    views: rows,
    skipped: chosen.skipped,
    missing: rows.reduce((n, row) => n + row.missing.length, 0),
    blank: rows.reduce((n, row) => n + row.blank.length, 0),
    tagged: rows.reduce((n, row) => n + row.tagged, 0),
  };
}

/**
 * Kit rules file: the named file (scale_rules_file or FMC_TAG_SCALE_FILE), then <kit>/03_Master_Data/FMC_TagScale.json.
 * There is no built-in sample: tag types are kit data (CLAUDE.md rule 7). With no file the first loaded type is used
 * and the reply says source none, which is a kit change request.
 */
export function loadTagScaleRules(opts: { file?: string; kitRoot?: string; env?: NodeJS.ProcessEnv; read?: (file: string) => string }): LoadedScaleRules {
  const read = opts.read ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const named = (opts.file || opts.env?.FMC_TAG_SCALE_FILE || "").trim();
  const kit = (opts.kitRoot ?? "").replace(/[\\/]+$/, "");
  const winKit = /^[A-Za-z]:[\\/]|^\\\\/.test(kit) || (kit.includes("\\") && !kit.includes("/"));
  const kitFile = kit ? (winKit ? path.win32 : path).join(kit, "03_Master_Data", "FMC_TagScale.json") : "";
  const candidates: Array<{ file: string; source: LoadedScaleRules["source"] }> = [];
  if (named) candidates.push({ file: named, source: "file" });
  if (kitFile) candidates.push({ file: kitFile, source: "kit" });
  for (const item of candidates) {
    let raw: string;
    try { raw = read(item.file); } catch {
      if (item.source === "file") throw new Error(`[FMC-TAGS-SCALE-RULES] ${TAGS_FIX["FMC-TAGS-SCALE-RULES"]} (${item.file})`);
      continue;
    }
    let rules: TagScaleRules;
    try { rules = JSON.parse(raw.replace(/^\uFEFF/, "")) as TagScaleRules; } catch {
      throw new Error(`[FMC-TAGS-SCALE-RULES] ${TAGS_FIX["FMC-TAGS-SCALE-RULES"]} (${item.file})`);
    }
    if (!rules || typeof rules !== "object" || (rules.rules != null && !Array.isArray(rules.rules))) {
      throw new Error(`[FMC-TAGS-SCALE-RULES] ${TAGS_FIX["FMC-TAGS-SCALE-RULES"]} (${item.file})`);
    }
    const provisional = item.source !== "kit" || String(rules.status ?? "").toUpperCase() === "PROVISIONAL";
    return { rules, path: item.file, source: item.source, provisional };
  }
  return { rules: null, path: "", source: "none", provisional: false };
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
