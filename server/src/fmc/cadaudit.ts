/**
 * GAP-14 fmc_cad_audit: imported versus linked CAD, 3D imports, CAD line styles, CAD inside families and raster
 * images, with a clean-up plan. Read only. The plan is text: nothing is deleted. Deletes go through fmc_wipe
 * (Builder 10, Data & Exports) with the person's approval.
 */

export interface CadInstance {
  id: string;
  name: string;
  type_id?: string;
  is_linked: boolean;
  view_specific: boolean;
  owner_view?: string;
  pinned?: boolean;
  link_path?: string;
  link_status?: string;
  category?: string;
}

export interface CadFamily { name: string; category?: string; imports: number; linked: number; names?: string[]; error?: string }
export interface CadCategory { name: string; subcategories: number; used: boolean }
export interface RasterType { id: string; name: string; path?: string; source?: string; instances: number; views?: string[]; file_found?: boolean | null }

export interface CadRead {
  title?: string;
  path?: string;
  imports: CadInstance[];
  import_categories: CadCategory[];
  families: CadFamily[];
  families_scanned?: number;
  families_skipped?: number;
  images: RasterType[];
}

export interface CleanupStep { priority: "high" | "medium" | "low"; what: string; items: string[]; action: string }

export interface CadAudit {
  status: "CLEAN" | "ACTION";
  counts: Record<string, number>;
  plan: CleanupStep[];
}

const label = (i: CadInstance) => `${i.name} (id ${i.id}${i.owner_view ? `, view ${i.owner_view}` : ""})`;

export function auditCad(read: CadRead): CadAudit {
  const imports = read.imports ?? [];
  const imported = imports.filter((i) => !i.is_linked);
  const linked = imports.filter((i) => i.is_linked);
  const imported3d = imported.filter((i) => !i.view_specific);
  const imported2d = imported.filter((i) => i.view_specific);
  const linkMissing = linked.filter((i) => i.link_status && !/^loaded$/i.test(i.link_status));
  const linkedAllViews = linked.filter((i) => !i.view_specific);
  const unpinned = linked.filter((i) => i.pinned === false && !i.view_specific);
  const famCad = (read.families ?? []).filter((f) => f.imports + f.linked > 0);
  const unusedStyles = (read.import_categories ?? []).filter((c) => !c.used);
  const images = read.images ?? [];
  const imagesUnused = images.filter((t) => t.instances === 0);
  const imagesMissing = images.filter((t) => t.file_found === false && /link/i.test(t.source ?? ""));
  const imagesImported = images.filter((t) => /import/i.test(t.source ?? ""));

  const plan: CleanupStep[] = [];
  if (imported3d.length) plan.push({
    priority: "high", what: "Imported CAD in model space (in every view, 3D)", items: imported3d.map(label),
    action: "Link the source file instead (Insert > Link CAD from the project folder, positioned the same), check the link, then remove each import through fmc_wipe with the person's approval.",
  });
  if (famCad.length) plan.push({
    priority: "high", what: "CAD inside loadable families", items: famCad.map((f) => `${f.name}${f.category ? ` (${f.category})` : ""}: ${f.imports} imported, ${f.linked} linked`),
    action: "Rebuild the geometry natively in the family (fmc_fam_* tools or by hand), reload it into the project, and keep the CAD out of the kit families.",
  });
  if (linkMissing.length) plan.push({
    priority: "high", what: "Linked CAD that is not loaded", items: linkMissing.map((i) => `${label(i)}: ${i.link_status}${i.link_path ? ` (${i.link_path})` : ""}`),
    action: "Reload from the path in Manage Links, or remove the link through fmc_wipe if it is no longer needed.",
  });
  if (imported2d.length) plan.push({
    priority: "medium", what: "Imported CAD in single views", items: imported2d.map(label),
    action: "Link instead with Current view only, or redraw as detail lines in a drafting view; then remove the import through fmc_wipe with approval.",
  });
  if (imagesMissing.length) plan.push({
    priority: "medium", what: "Linked raster images whose file is missing", items: imagesMissing.map((t) => `${t.name}${t.path ? ` (${t.path})` : ""}`),
    action: "Reload the image from its new path (Manage Links > Images), or remove it through fmc_wipe.",
  });
  if (linkedAllViews.length) plan.push({
    priority: "low", what: "Linked CAD visible in every view", items: linkedAllViews.map(label),
    action: "Check whether each one should be Current view only. A site survey in model space is fine; a floor plan background usually is not.",
  });
  if (unpinned.length) plan.push({ priority: "low", what: "Linked CAD in model space that is not pinned", items: unpinned.map(label), action: "Pin it so it cannot move." });
  if (imagesImported.length) plan.push({
    priority: "low", what: "Imported raster images (stored in the model)", items: imagesImported.map((t) => `${t.name}: ${t.instances} placed`),
    action: "Keep logos and title-block images; link large photos or scans instead to keep the model small.",
  });
  if (imagesUnused.length) plan.push({
    priority: "low", what: "Raster image types with no placed instance", items: imagesUnused.map((t) => t.name),
    action: "Purge candidates. Remove through fmc_wipe or Purge Unused with approval.",
  });
  if (unusedStyles.length) plan.push({
    priority: "low", what: "CAD import line styles with no CAD left in the model", items: unusedStyles.map((c) => `${c.name} (${c.subcategories} line styles)`),
    action: "Purge candidates (Object Styles > Imported Objects). They often come from imports that were deleted.",
  });

  return {
    status: plan.length ? "ACTION" : "CLEAN",
    counts: {
      imported: imported.length, imported_3d: imported3d.length, imported_2d: imported2d.length, linked: linked.length,
      linked_not_loaded: linkMissing.length, families_with_cad: famCad.length, families_scanned: read.families_scanned ?? (read.families ?? []).length,
      families_skipped: read.families_skipped ?? 0, import_line_style_categories: (read.import_categories ?? []).length, unused_import_line_style_categories: unusedStyles.length,
      raster_types: images.length, raster_instances: images.reduce((n, t) => n + (t.instances || 0), 0), raster_unused: imagesUnused.length,
    },
    plan,
  };
}
