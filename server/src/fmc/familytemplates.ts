/**
 * F47 (plan B3, docs/PLAN_ASSET_BUILDER.md): FMC family templates (.rft) built from
 * Revit's metric .rft files, with the kit's identity parameters and type-naming
 * convention ready. Family recipes that started on a metric template can be
 * rebuilt on the matching FMC .rft with those setup ops removed.
 *
 * Built templates are staged at <family_staging_root>\_FamilyTemplates\*.rft
 * (inside the existing staging write root). The plan's sibling path
 * 04_Families\_FamilyTemplates\_Staging\ is not used, so write_roots does not
 * need to grow. Saving an .rft still needs an allowed write folder and, if the
 * file exists, overwrite: true. Live SaveAs to .rft is confirmed in Revit.
 */
import path from "node:path";
import type { Recipe } from "./recipes.js";

const win = path.win32;

/** Identity parameters already used across B2 family recipes; GUIDs from the kit dictionary. */
export const IDENTITY_PARAMS = [
  { op: "add_shared_param" as const, name: "FMC_Keynote_Code", guid: "2d089b32-0589-516b-8952-9f6afad95971", group: "IdentityData" },
  { op: "add_shared_param" as const, name: "FMC_Geometry_Stage", guid: "27c3be4d-9757-51ba-aa96-6c7a3a061025" },
  { op: "add_shared_param" as const, name: "IfcExportAs", guid: "bae7a5f9-3ec7-57e3-ba6b-bcd858fd95f7" },
];

/** Door subcategories that every current door recipe adds before any geometry. */
const DOOR_SUBCATEGORIES = [
  { op: "add_subcategory" as const, name: "Frame", line_weight_projection: 2, line_weight_cut: 4, color: [0, 0, 0] },
  { op: "add_subcategory" as const, name: "Panel", line_weight_projection: 2, line_weight_cut: 4, color: [0, 0, 0] },
  { op: "add_subcategory" as const, name: "Plan Swing", line_weight_projection: 1, color: [0, 0, 0], line_weight_cut: 1 },
  { op: "add_subcategory" as const, name: "Elevation Swing", line_weight_projection: 1, color: [0, 0, 0], line_weight_cut: 1 },
  { op: "add_subcategory" as const, name: "Clearance", line_weight_projection: 1, color: [80, 80, 80], line_weight_cut: 1 },
];

export interface TypeNaming {
  pattern: string;
  about: string;
}

export interface FamilyTemplateSpec {
  family: string;
  source_template: string;
  category?: string;
  type_naming: TypeNaming;
  extra_ops?: Array<Record<string, unknown>>;
}

const SIZE_NAMING: TypeNaming = {
  pattern: "WWWWxHHHH",
  about: "Type names are width × height in mm, zero-padded to four digits, as in 0900x2100.",
};

const REGISTER_NAMING: TypeNaming = {
  pattern: "register",
  about: "The template adds no type. Type names come from the family recipe or the register.",
};

/**
 * The FMC templates named in plan B3, each from the metric .rft the repo already
 * uses (Lighting Fixture uses the ceiling-based metric file already referenced
 * in the tree; Plumbing Fixture uses Revit's standard metric name).
 */
export const FAMILY_TEMPLATES: FamilyTemplateSpec[] = [
  { family: "FMC_GenericModel", source_template: "Metric Generic Model.rft", type_naming: REGISTER_NAMING },
  { family: "FMC_GenericModel_FaceBased", source_template: "Metric Generic Model face based.rft", type_naming: REGISTER_NAMING },
  { family: "FMC_ElectricalFixture_FaceBased", source_template: "Metric Electrical Fixture face based.rft",
    category: "OST_ElectricalFixtures", type_naming: REGISTER_NAMING },
  { family: "FMC_LightingFixture", source_template: "Metric Lighting Fixture ceiling based.rft",
    category: "OST_LightingFixtures", type_naming: REGISTER_NAMING },
  { family: "FMC_PlumbingFixture", source_template: "Metric Plumbing Fixture.rft",
    category: "OST_PlumbingFixtures", type_naming: REGISTER_NAMING },
  { family: "FMC_MechanicalEquipment", source_template: "Metric Mechanical Equipment.rft",
    category: "OST_MechanicalEquipment", type_naming: REGISTER_NAMING },
  { family: "FMC_Door", source_template: "Metric Door.rft", category: "OST_Doors",
    type_naming: SIZE_NAMING, extra_ops: DOOR_SUBCATEGORIES },
  { family: "FMC_Window", source_template: "Metric Window.rft", category: "OST_Windows",
    type_naming: SIZE_NAMING },
];

const BY_FAMILY = new Map(FAMILY_TEMPLATES.map((s) => [s.family, s]));
const BY_SOURCE = new Map(FAMILY_TEMPLATES.map((s) => [s.source_template.toLowerCase(), s]));
const BY_OUTPUT = new Map(FAMILY_TEMPLATES.map((s) => [s.family.toLowerCase() + ".rft", s]));

export function specOf(family: string): FamilyTemplateSpec | undefined {
  return BY_FAMILY.get(family);
}

export function specForSource(metricTemplate: string): FamilyTemplateSpec | undefined {
  return BY_SOURCE.get(win.basename(metricTemplate).toLowerCase());
}

/** The metric .rft an FMC template was built from, so plane tables can follow it. */
export function sourceTemplateOf(templateBasename: string): string | undefined {
  const key = win.basename(templateBasename).toLowerCase();
  return BY_OUTPUT.get(key)?.source_template;
}

export function isFamilyTemplateRecipe(recipe: { kind?: string }): boolean {
  return recipe.kind === "family_template";
}

/** <family_staging_root>\_FamilyTemplates\<family>.rft */
export function familyTemplateStagingPath(stagingRoot: string, family: string): string {
  return win.join(stagingRoot, "_FamilyTemplates", family + ".rft");
}

export function recipeStagingPath(stagingRoot: string, recipe: { kind?: string; family: string }, familyStaging: (root: string, family: string) => string): string {
  return isFamilyTemplateRecipe(recipe) ? familyTemplateStagingPath(stagingRoot, recipe.family) : familyStaging(stagingRoot, recipe.family);
}

/**
 * An .rft may be saved only under a _FamilyTemplates folder inside an allowed
 * write root, with an FMC_*.rft name. Does not widen write_roots.
 */
export function isFamilyTemplateSavePath(target: string): boolean {
  const t = win.normalize(target.trim());
  const ext = win.extname(t).toLowerCase();
  if (ext !== ".rft") return false;
  const base = win.basename(t);
  if (!/^FMC_[A-Za-z0-9]+(_[A-Za-z0-9]+)*\.rft$/i.test(base)) return false;
  const segs = t.split(/[\\/]/).map((s) => s.toLowerCase());
  return segs.includes("_familytemplates");
}

export function familyTemplateOps(spec: FamilyTemplateSpec): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];
  if (spec.category) ops.push({ op: "set_category", name: spec.category });
  ops.push(...IDENTITY_PARAMS);
  if (spec.extra_ops) ops.push(...spec.extra_ops);
  return ops;
}

export function familyTemplateRecipe(spec: FamilyTemplateSpec): Recipe {
  const bits = [
    `FMC family template (B3) from ${spec.source_template}.`,
    "Identity shared parameters FMC_Keynote_Code, FMC_Geometry_Stage and IfcExportAs are already bound.",
    `Type naming: ${spec.type_naming.about}`,
  ];
  if (spec.extra_ops?.length) bits.push("Standard subcategories are already present.");
  return {
    schema: "fmc-recipe/0.1",
    kind: "family_template",
    family: spec.family,
    template: spec.source_template,
    about: bits.join(" "),
    ops: familyTemplateOps(spec) as Recipe["ops"],
    values: {},
    checks: {},
  };
}

export function allFamilyTemplateRecipes(): Recipe[] {
  return FAMILY_TEMPLATES.map(familyTemplateRecipe);
}

/** Setup ops a template may absorb so a family recipe can drop them. */
export function setupKey(op: Record<string, unknown>): string | null {
  const kind = String(op.op ?? "");
  if (kind === "set_category") return `set_category:${String(op.name ?? "")}`;
  if (kind === "add_shared_param") {
    const guid = String(op.guid ?? "").toLowerCase();
    return `add_shared_param:${guid}:${String(op.name ?? "")}`;
  }
  if (kind === "add_subcategory") return `add_subcategory:${String(op.name ?? "")}`;
  return null;
}

/**
 * Rebuild a B2 family recipe onto the matching FMC .rft: point template at the
 * FMC file and drop setup ops the template already applied. Geometry and
 * family-specific parameters stay. The remaining ops plus the template ops
 * cover the original setup, and the leftover ops stay in their original order.
 */
export function rebaseOnFamilyTemplate(
  familyRecipe: Recipe,
  templateRecipe: Recipe,
): { recipe: Recipe; removed: number; problems: string[] } {
  const problems: string[] = [];
  if (!isFamilyTemplateRecipe(templateRecipe)) problems.push(`${templateRecipe.family} is not a family_template recipe`);
  const source = win.basename(templateRecipe.template).toLowerCase();
  const current = win.basename(familyRecipe.template).toLowerCase();
  const already = (templateRecipe.family + ".rft").toLowerCase();
  if (current !== source && current !== already) {
    problems.push(`Family recipe template ${familyRecipe.template} does not match ${templateRecipe.template} or ${templateRecipe.family}.rft`);
  }
  const have = new Set(templateRecipe.ops.map((o) => setupKey(o as Record<string, unknown>)).filter((k): k is string => !!k));
  const kept: Recipe["ops"] = [];
  let removed = 0;
  for (const op of familyRecipe.ops) {
    const key = setupKey(op as Record<string, unknown>);
    if (key && have.has(key)) { removed += 1; continue; }
    kept.push(op);
  }
  if (!kept.length) problems.push("Rebasing would leave the family recipe with no ops");
  if (problems.length) return { recipe: familyRecipe, removed: 0, problems };
  return {
    recipe: {
      ...familyRecipe,
      template: templateRecipe.family + ".rft",
      about: [familyRecipe.about, `Rebuilt on ${templateRecipe.family}.rft (B3); ${removed} setup op(s) now come from the template.`].filter(Boolean).join(" "),
      ops: kept,
    },
    removed,
    problems: [],
  };
}
