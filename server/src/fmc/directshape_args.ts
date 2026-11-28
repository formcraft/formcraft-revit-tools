/** fmc_directshape: arguments and the text the AI reads. The solid spec is in directshape_spec.ts. */
import { z } from "zod";

export const FMC_DIRECTSHAPE_DESCRIPTION =
  "DirectShape volumes for clearances, survey solids and IFC proxies (gap proposal 25). Makes a DirectShape from a box or a straight extrusion of a flat polygon, " +
  "only in a whitelisted category (default Generic Models and Mass; directshape_categories in the guard file adds from a fixed list; anything else is FMC-DS-CATEGORY). " +
  "Actions: limits (whitelist, caps, no Revit); create; list (the shapes this tool made); remove (only shapes this tool made). " +
  "Units are mm and degrees. A box: kind box, origin_mm [x,y,z] (centre of the bottom face), size_mm [dx,dy,dz]. An extrusion: kind extrusion, origin_mm, profile_mm [[x,y],...] (relative to origin_mm, no crossing sides), height_mm. " +
  "rotation_deg turns it about the vertical. Many shapes (at most 50): shapes [{name, category, purpose clearance|survey|ifc_proxy|other, mark, level, kind..., or parts [...]}]. " +
  "category empty is the first whitelisted one. level adds that level's elevation to Z. " +
  "create, list and remove need document (an open project model; a family, a central model, HEBERT HOSTELS and protected paths are refused). " +
  "dry_run defaults to true: create reports what would be made with a plan_hash and a run_id; remove lists what would go. " +
  "A real create or remove needs dry_run false, confirm true (after a person said yes to the dry run) and batch_lease from fmc_batch request for that document. " +
  "plan_hash from the dry run is checked when given. One transaction, nothing saved or synced. " +
  "Every shape carries ApplicationId Formcraft.fmc_directshape and ApplicationDataId fmc_directshape|<run_id>|<n>, so list and remove find only this tool's work and never another user's, pinned or other DirectShapes. " +
  "remove needs ids, of_run (a run_id from create) or all true. Example: action create, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, kind box, name Door swing clearance, purpose clearance, origin_mm [1000,2000,0], size_mm [900,900,2100], dry_run true.";

const part = z.object({
  kind: z.string().optional(),
  origin_mm: z.array(z.number()).optional(),
  size_mm: z.array(z.number()).optional(),
  profile_mm: z.array(z.array(z.number())).optional(),
  height_mm: z.number().optional(),
  rotation_deg: z.number().optional(),
});

const shape = part.extend({
  name: z.string().optional(),
  category: z.string().optional(),
  purpose: z.string().optional(),
  mark: z.string().optional(),
  level: z.string().optional(),
  parts: z.array(part).optional(),
});

export const FMC_DIRECTSHAPE_SHAPE = {
  action: z.enum(["limits", "create", "list", "remove"]),
  document: z.string().optional().default(""),
  // one shape, given directly
  kind: z.string().optional().describe("box or extrusion"),
  name: z.string().optional(),
  category: z.string().optional().describe("Whitelisted category name. Empty: the first one (Generic Models)"),
  purpose: z.string().optional().describe("clearance, survey, ifc_proxy or other"),
  mark: z.string().optional(),
  level: z.string().optional().describe("A level name; its elevation is added to Z"),
  origin_mm: z.array(z.number()).optional(),
  size_mm: z.array(z.number()).optional(),
  profile_mm: z.array(z.array(z.number())).optional(),
  height_mm: z.number().optional(),
  rotation_deg: z.number().optional(),
  // or many
  shapes: z.array(shape).optional().default([]).describe("At most 50 shapes, each with kind or parts"),
  // list and remove
  of_run: z.string().optional().default("").describe("A run_id from create"),
  ids: z.array(z.union([z.string(), z.number()])).optional().default([]).describe("Element ids; only this tool's shapes are touched"),
  all: z.boolean().optional().default(false).describe("remove: every shape this tool made in the document"),
  sample_limit: z.number().int().min(1).max(200).optional().default(50),
  plan_hash: z.string().optional().default("").describe("From the dry run. A real create is refused when the spec changed"),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("A real create or remove: true only once a person said yes to the dry run"),
  batch_lease: z.string().optional().default(""),
};

export type FmcDirectshapeArgs = z.infer<z.ZodObject<typeof FMC_DIRECTSHAPE_SHAPE>>;
