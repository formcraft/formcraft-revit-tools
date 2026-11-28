/**
 * fmc_fam_hosting plan (pure, no Revit). Revit fixes a family's host (wall, floor, ceiling, roof, face) when the family
 * is made from its template, and no API call changes it afterwards; so a face-based conversion is always the rebuild
 * path, never faked. What the API can change in place: Work Plane-Based (and Always Vertical) on an unhosted family, and
 * reference points made adaptive in a conceptual mass or adaptive family.
 */
import path from "node:path";

export type HostTarget = "face_based" | "work_plane_based" | "adaptive";
export const HOST_TARGETS: HostTarget[] = ["face_based", "work_plane_based", "adaptive"];

export interface HostingRead {
  family?: string;
  category?: string;
  path?: string;
  placement?: string;
  hosting?: string;
  work_plane_based?: boolean | null;
  work_plane_based_settable?: boolean;
  always_vertical?: boolean | null;
  is_adaptive?: boolean;
  is_conceptual_mass?: boolean;
  adaptive_points?: number;
  reference_points?: Array<{ id: number; adaptive?: boolean }>;
  instance_parameters?: string[];
  solids?: number;
  voids?: number;
}

export const REBUILD_TEMPLATES: Record<HostTarget, string> = {
  face_based: "Metric Generic Model face based.rft",
  work_plane_based: "Metric Generic Model.rft",
  adaptive: "Metric Generic Model Adaptive.rft",
};

export interface HostPlan {
  target: HostTarget;
  current: { hosting: string; placement: string; work_plane_based: boolean | null; is_adaptive: boolean };
  nothing_to_do: boolean;
  in_place: boolean;
  why: string;
  apply?: { action: "work_plane_based"; always_vertical?: boolean } | { action: "make_adaptive"; points: number[] };
  rebuild?: RebuildPlan;
}

export interface RebuildPlan {
  template: string;
  template_found: boolean | null;
  source: string;
  new_name: string;
  steps: Array<{ tool: string; args: Record<string, unknown>; why: string }>;
  limits: string[];
  blocked: string[];
}

const NON_HOSTABLE = /adaptive|curve|view|twolevel|pattern/i;

export function rebuildPlan(target: HostTarget, read: HostingRead, templateDir: string, exists: (f: string) => boolean): RebuildPlan {
  const template = path.win32.join(templateDir, REBUILD_TEMPLATES[target]);
  const found = templateDir ? exists(template) : null;
  const source = read.path ?? "";
  const family = read.family || (source ? path.win32.basename(source, ".rfa") : "Family");
  const suffix = target === "face_based" ? "_FaceBased" : target === "adaptive" ? "_Adaptive" : "_WorkPlane";
  const new_name = `${family}${suffix}.rfa`;
  const blocked: string[] = [];
  if (!source) blocked.push("The source family has no file: save it to staging first (fmc_doc save), so the rebuild can load it");
  if (found === false) blocked.push(`The template ${template} isn't on this PC: install it or name another face-based/adaptive template in the template roots`);
  const params = read.instance_parameters ?? [];
  const steps: RebuildPlan["steps"] = [
    { tool: "fmc_doc", args: { action: "open", template }, why: `a new ${target.replace(/_/g, " ")} family from its template` },
    { tool: "fmc_doc", args: { action: "apply", ops: [{ op: "set_category", name: read.category ?? "" }], dry_run: true }, why: "the same category as the source" },
    { tool: "fmc_doc", args: { action: "apply", ops: [{ op: "load_family", name: family, path: source }], dry_run: true }, why: "the source family nested in the new host" },
    { tool: "fmc_doc", args: { action: "apply", ops: [{ op: "place_nested", name: `${family}_nested`, family, type: "<a type of the source>", at: [0, 0, 0] }], dry_run: true },
      why: target === "face_based" ? "placed on the template's host face at the origin" : "placed at the origin" },
  ];
  if (params.length)
    steps.push({ tool: "fmc_fam_nested", args: { action: "associate", nested: `${family}_nested`, associate: Object.fromEntries(params.map((p) => [p, p])) },
      why: "the source's instance parameters driven from the new family (add them first with fmc_doc add_family_param)" });
  steps.push({ tool: "fmc_doc", args: { action: "save", path: `<staging>\\${new_name}` }, why: "saved under a new name in staging; the source file is never overwritten" });
  const limits = [
    "The source's geometry comes in as a nested family: its voids don't cut the host element (rebuild voids in the new family, Cut with Voids When Loaded)",
    "Type parameters of the nested family are driven per type by hand or with fmc_fam_nested associate (a <Family Type> parameter swaps the whole type)",
  ];
  if (target === "adaptive") limits.unshift("A nested family doesn't follow adaptive points: rebuild the form from the adaptive points (reference points made adaptive, then forms through them); the nested copy only keeps the look");
  if ((read.voids ?? 0) > 0) limits.push(`The source has ${read.voids} void(s), which won't cut a host through the nested copy`);
  return { template, template_found: found, source, new_name, steps, limits, blocked };
}

export function planHosting(target: HostTarget, read: HostingRead, opts: { templateDir: string; exists: (f: string) => boolean; points?: number[]; always_vertical?: boolean }): HostPlan {
  const hosting = (read.hosting ?? "none").toLowerCase();
  const placement = read.placement ?? "";
  const current = { hosting, placement, work_plane_based: read.work_plane_based ?? null, is_adaptive: !!read.is_adaptive };
  const base = { target, current, nothing_to_do: false, in_place: false };
  const rebuild = (why: string): HostPlan => ({ ...base, why, rebuild: rebuildPlan(target, read, opts.templateDir, opts.exists) });
  if (target === "face_based") {
    if (hosting === "face") return { ...base, nothing_to_do: true, why: "The family is already face-based" };
    return rebuild(`The family is ${hosting === "none" ? "unhosted" : `${hosting}-hosted`} (${placement || "placement unknown"}). Revit sets a family's host from its template and the API can't change it in place, so a face-based version is a rebuild: a new family from the face-based template with this one nested in it`);
  }
  if (target === "work_plane_based") {
    if (read.work_plane_based === true && (opts.always_vertical === undefined || read.always_vertical === opts.always_vertical))
      return { ...base, nothing_to_do: true, why: "The family is already work plane-based" };
    if (hosting !== "none") return rebuild(`A ${hosting}-hosted family can't be work plane-based (Revit greys it out); the rebuild path makes an unhosted family with this one nested`);
    if (NON_HOSTABLE.test(placement)) return rebuild(`A ${placement} family has no Work Plane-Based setting`);
    if (read.work_plane_based_settable === false) return rebuild("Revit shows Work Plane-Based as read-only on this family");
    return { ...base, in_place: true, why: "Work Plane-Based is a family parameter on an unhosted family: set in place, one transaction",
      apply: { action: "work_plane_based", ...(opts.always_vertical !== undefined ? { always_vertical: opts.always_vertical } : {}) } };
  }
  // adaptive
  const free = (read.reference_points ?? []).filter((p) => !p.adaptive).map((p) => p.id);
  const want = opts.points?.length ? opts.points : free;
  const unknown = (opts.points ?? []).filter((id) => !(read.reference_points ?? []).some((p) => p.id === id));
  if (read.is_adaptive && !opts.points?.length) return { ...base, nothing_to_do: true, why: `The family is already adaptive (${read.adaptive_points ?? 0} adaptive point(s))` };
  if (read.is_adaptive || read.is_conceptual_mass) {
    if (unknown.length) return { ...base, why: `No reference point ${unknown.join(", ")} in the family; read lists them` };
    if (!want.length) return { ...base, why: "The family has no reference points to make adaptive: add reference points first (Create › Draw › Point Element), then convert" };
    return { ...base, in_place: true, why: `The API makes reference points adaptive (placement points) in a ${read.is_adaptive ? "adaptive" : "conceptual mass"} family`,
      apply: { action: "make_adaptive", points: want } };
  }
  return rebuild(`A ${read.category ?? "family"} made from a ${placement || "standard"} template can't hold adaptive points; only conceptual mass and adaptive families can, so adaptive is a rebuild from the adaptive template`);
}
