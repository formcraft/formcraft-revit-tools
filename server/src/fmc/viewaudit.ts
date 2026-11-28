/**
 * fmc_view_audit: views and view templates. The report comes first: views with no template, template parameters
 * that are not controlled (View.GetNonControlledTemplateParameterIds), unused templates and filters, views not on
 * sheets, and the view range, discipline, detail level, crop, scope box and link override state.
 * Fixes run in one batch, only after a dry run and with confirm plus the dry run's plan_hash. Nothing is deleted here.
 */
import { sameName } from "./gapcommon.js";

export interface AuditView {
  id: string;
  name: string;
  view_type: string;
  template_capable?: boolean;
  template?: string;
  template_id?: string;
  on_sheet?: boolean;
  sheet?: string;
  discipline?: string;
  detail_level?: string;
  crop_active?: boolean | null;
  crop_visible?: boolean | null;
  scope_box?: string;
  view_range?: Record<string, { level: string; offset_mm: number }>;
  link_overrides?: Array<{ link: string; mode: string }>;
  filters?: string[];
}

export interface AuditTemplate { id: string; name: string; view_type: string; users: number; controlled: number; non_controlled: string[]; filters?: string[] }
export interface AuditFilter { id: string; name: string; kind?: string; used_by: number }
export interface ViewAuditRead { title?: string; path?: string; is_central?: boolean; views: AuditView[]; templates: AuditTemplate[]; filters: AuditFilter[]; scope_boxes?: Array<{ id: string; name: string }>; capped?: boolean; link_overrides_supported?: boolean }

export const DETAIL_LEVELS = ["Coarse", "Medium", "Fine"] as const;
export const DISCIPLINES = ["Architectural", "Structural", "Mechanical", "Electrical", "Plumbing", "Coordination"] as const;

export type ViewFix =
  | { op: "assign_template"; view: string; template: string }
  | { op: "control_template_params"; template: string; parameters?: string[] }
  | { op: "set_detail_level"; view: string; level: typeof DETAIL_LEVELS[number] }
  | { op: "set_discipline"; view: string; discipline: typeof DISCIPLINES[number] }
  | { op: "set_crop"; view: string; crop_active?: boolean; crop_visible?: boolean }
  | { op: "set_scope_box"; view: string; scope_box: string };

export interface PlannedFix { op: string; view_id?: string; view?: string; template_id?: string; template?: string; value?: unknown; parameters?: string[]; before?: unknown }
export interface SkippedFix { op: string; target: string; code: string; message: string }

const NOT_ON_SHEET_IGNORED = new Set(["DrawingSheet", "ProjectBrowser", "SystemBrowser", "Internal", "Undefined"]);

function cap<T>(list: T[], limit: number) { return { total: list.length, items: list.slice(0, limit) }; }

export function auditViews(read: ViewAuditRead, limit = 200) {
  const views = read.views ?? [];
  const templates = read.templates ?? [];
  const filters = read.filters ?? [];
  const noTemplate = views.filter((v) => v.template_capable !== false && v.view_type !== "DrawingSheet" && !(v.template_id && v.template_id !== "-1") && !v.template);
  const nonControlled = templates.filter((t) => t.non_controlled.length > 0).map((t) => ({ template: t.name, view_type: t.view_type, users: t.users, parameters: t.non_controlled }));
  const unusedTemplates = templates.filter((t) => t.users === 0).map((t) => ({ template: t.name, view_type: t.view_type }));
  const unusedFilters = filters.filter((f) => f.used_by === 0).map((f) => ({ filter: f.name, kind: f.kind ?? "" }));
  const notOnSheets = views.filter((v) => !NOT_ON_SHEET_IGNORED.has(v.view_type) && v.on_sheet === false).map((v) => ({ view: v.name, view_type: v.view_type }));
  const tally = (key: (v: AuditView) => string) => views.reduce<Record<string, number>>((acc, v) => { const k = key(v) || "(none)"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  const graphical = views.filter((v) => !["DrawingSheet", "Schedule", "Legend", "DraftingView", "ProjectBrowser", "SystemBrowser", "Internal", "Undefined", "Report"].includes(v.view_type));
  const viewRanges = views.filter((v) => v.view_range).map((v) => ({ view: v.name, template: v.template ?? "", ...v.view_range }));
  const cropOff = graphical.filter((v) => v.crop_active === false && v.view_type !== "ThreeD").map((v) => ({ view: v.name, view_type: v.view_type }));
  const cropShown = graphical.filter((v) => v.crop_visible === true).map((v) => ({ view: v.name, view_type: v.view_type }));
  const scopeBoxes = views.filter((v) => v.scope_box).map((v) => ({ view: v.name, scope_box: v.scope_box }));
  const linkOverrides = views.filter((v) => (v.link_overrides ?? []).some((o) => !/^ByHostView$/i.test(o.mode))).map((v) => ({ view: v.name, overrides: v.link_overrides }));
  return {
    counts: {
      views: views.length, templates: templates.length, filters: filters.length,
      views_without_template: noTemplate.length, templates_with_non_controlled: nonControlled.length,
      unused_templates: unusedTemplates.length, unused_filters: unusedFilters.length, views_not_on_sheets: notOnSheets.length,
      crop_off: cropOff.length, crop_visible: cropShown.length, with_scope_box: scopeBoxes.length, with_link_overrides: linkOverrides.length,
    },
    views_without_template: cap(noTemplate.map((v) => ({ view: v.name, view_type: v.view_type })), limit),
    non_controlled_template_parameters: cap(nonControlled, limit),
    unused_templates: cap(unusedTemplates, limit),
    unused_filters: cap(unusedFilters, limit),
    views_not_on_sheets: cap(notOnSheets, limit),
    state: {
      discipline: tally((v) => v.discipline ?? ""),
      detail_level: tally((v) => v.detail_level ?? ""),
      view_range: cap(viewRanges, limit),
      crop_off: cap(cropOff, limit),
      crop_visible: cap(cropShown, limit),
      scope_box: cap(scopeBoxes, limit),
      link_overrides: cap(linkOverrides, limit),
      link_overrides_supported: read.link_overrides_supported !== false,
    },
  };
}

function one<T extends { name: string }>(list: T[], name: string): { hit?: T; code?: string } {
  const hits = list.filter((x) => sameName(x.name, name));
  if (hits.length === 1) return { hit: hits[0] };
  return { code: hits.length ? "FMC-VIEWAUDIT-AMBIGUOUS" : "FMC-VIEWAUDIT-NOT-FOUND" };
}

export function planFixes(read: ViewAuditRead, fixes: ViewFix[]): { ops: PlannedFix[]; skipped: SkippedFix[]; warnings: SkippedFix[] } {
  const ops: PlannedFix[] = [];
  const skipped: SkippedFix[] = [];
  const warnings: SkippedFix[] = [];
  const views = read.views ?? [];
  const templates = read.templates ?? [];
  const skip = (op: string, target: string, code: string, message: string) => skipped.push({ op, target, code, message });
  for (const fix of fixes) {
    if (fix.op === "control_template_params") {
      const t = one(templates, fix.template);
      if (!t.hit) { skip(fix.op, fix.template, t.code!, `Template ${fix.template}: ${t.code === "FMC-VIEWAUDIT-AMBIGUOUS" ? "more than one has this name" : "not found"}.`); continue; }
      const wanted = (fix.parameters ?? []).map((p) => p.trim()).filter(Boolean);
      const unknown = wanted.filter((p) => !t.hit!.non_controlled.some((n) => sameName(n, p)));
      if (unknown.length) skip(fix.op, fix.template, "FMC-VIEWAUDIT-PARAM", `Not a non-controlled parameter of ${t.hit.name}: ${unknown.join(", ")}.`);
      const control = wanted.length ? t.hit.non_controlled.filter((n) => wanted.some((p) => sameName(n, p))) : [...t.hit.non_controlled];
      if (!control.length) { if (!unknown.length) skip(fix.op, fix.template, "FMC-VIEWAUDIT-NOTHING", `${t.hit.name} already controls every parameter.`); continue; }
      ops.push({ op: fix.op, template_id: t.hit.id, template: t.hit.name, parameters: control, before: t.hit.non_controlled });
      continue;
    }
    const v = one(views, fix.view);
    if (!v.hit) { skip(fix.op, fix.view, v.code!, `View ${fix.view}: ${v.code === "FMC-VIEWAUDIT-AMBIGUOUS" ? "more than one has this name" : "not found"}.`); continue; }
    const view = v.hit;
    const base = { op: fix.op, view_id: view.id, view: view.name };
    if (fix.op === "assign_template") {
      const t = one(templates, fix.template);
      if (!t.hit) { skip(fix.op, fix.view, t.code!, `Template ${fix.template}: not found or not unique.`); continue; }
      if (view.template_capable === false) { skip(fix.op, view.name, "FMC-VIEWAUDIT-TEMPLATE-TYPE", `${view.view_type} views do not take a view template.`); continue; }
      if (t.hit.view_type !== view.view_type) { skip(fix.op, view.name, "FMC-VIEWAUDIT-TEMPLATE-TYPE", `${t.hit.name} is a ${t.hit.view_type} template; ${view.name} is ${view.view_type}.`); continue; }
      if (view.template_id === t.hit.id) { skip(fix.op, view.name, "FMC-VIEWAUDIT-NOTHING", `${view.name} already uses ${t.hit.name}.`); continue; }
      ops.push({ ...base, template_id: t.hit.id, template: t.hit.name, before: view.template ?? "" });
    } else if (fix.op === "set_detail_level") {
      if (view.detail_level === fix.level) { skip(fix.op, view.name, "FMC-VIEWAUDIT-NOTHING", `Already ${fix.level}.`); continue; }
      ops.push({ ...base, value: fix.level, before: view.detail_level ?? "" });
    } else if (fix.op === "set_discipline") {
      if (view.discipline === fix.discipline) { skip(fix.op, view.name, "FMC-VIEWAUDIT-NOTHING", `Already ${fix.discipline}.`); continue; }
      ops.push({ ...base, value: fix.discipline, before: view.discipline ?? "" });
    } else if (fix.op === "set_crop") {
      if (fix.crop_active == null && fix.crop_visible == null) { skip(fix.op, view.name, "FMC-VIEWAUDIT-NOTHING", "Give crop_active or crop_visible."); continue; }
      ops.push({ ...base, value: { crop_active: fix.crop_active ?? null, crop_visible: fix.crop_visible ?? null }, before: { crop_active: view.crop_active ?? null, crop_visible: view.crop_visible ?? null } });
    } else if (fix.op === "set_scope_box") {
      const name = fix.scope_box.trim();
      let id = "-1";
      if (name) {
        const box = one(read.scope_boxes ?? [], name);
        if (!box.hit) { skip(fix.op, view.name, box.code!, `Scope box ${name}: not found or not unique.`); continue; }
        id = box.hit.id;
      }
      ops.push({ ...base, value: { scope_box_id: id, scope_box: name }, before: view.scope_box ?? "" });
    }
    if (view.template && fix.op !== "assign_template") {
      warnings.push({ op: fix.op, target: view.name, code: "FMC-VIEWAUDIT-TEMPLATE-CONTROLS", message: `${view.name} uses ${view.template}. If the template controls this setting, Revit refuses the change and it is reported as failed.` });
    }
  }
  return { ops, skipped, warnings };
}
