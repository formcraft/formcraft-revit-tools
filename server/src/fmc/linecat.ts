/**
 * Which categories create_line_based_element may make, and for whom.
 *
 * The tool takes a `category` string, but the add-in lets the type's own category win when a typeId is given, and any
 * other category falls to a generic family-instance path. So an AI session could make structural framing (beams) through
 * it, although create_structural_framing_system is admin-only (aiuse.ts NEVER) and the AI gate checked no category here
 * (create_point_based_element has one: PLACEABLE). The rule, enforced in the tool, the AI gate and the add-in:
 *  - LINE_ALLOWED (walls, ducts: the two the add-in builds with Wall.Create and Duct.Create) are open to everyone;
 *  - LINE_STRUCTURE (framing, columns, foundations, trusses: the structure group) are admin only, like
 *    create_structural_framing_system: FMC-LINE-CATEGORY-ADMIN for an AI session;
 *  - anything else, including a name that isn't an OST_ category and a number the add-in would parse as one, is
 *    FMC-LINE-CATEGORY-UNKNOWN for everyone.
 * Admin = the admin's full-access switch (ai_modeller.access = "full", with General on for the model), or the pane.
 */
import type { AiModellerConfig } from "./aiuse.js";

export const LINE_CATEGORY_ADMIN = "FMC-LINE-CATEGORY-ADMIN";
export const LINE_CATEGORY_UNKNOWN = "FMC-LINE-CATEGORY-UNKNOWN";

export const LINE_ALLOWED = ["OST_Walls", "OST_DuctCurves"] as const;
export const LINE_STRUCTURE = ["OST_StructuralFraming", "OST_StructuralFramingSystem", "OST_StructuralColumns", "OST_StructuralFoundation", "OST_StructuralTruss"] as const;

export interface LineRefusal { code: string; category: string; message: string }

/**
 * The add-in parses the category with Enum.TryParse(category.Replace(".", ""), ignoreCase), so "ost.structuralframing" is
 * the framing category, and so is a number. Only an OST_ name is a category here; the canonical spelling when it is one we
 * list, else the cleaned name.
 */
export function normaliseCategory(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.replace(/\./g, "").trim() : "";
  if (!/^OST_[A-Za-z0-9_]+$/i.test(text)) return null;
  return [...LINE_ALLOWED, ...LINE_STRUCTURE].find((c) => c.toLowerCase() === text.toLowerCase()) ?? text;
}

export function lineCategoryRefusal(raw: unknown, admin: boolean): LineRefusal | null {
  const category = normaliseCategory(raw);
  const shown = typeof raw === "string" ? raw : String(raw);
  if (!category || !([...LINE_ALLOWED, ...LINE_STRUCTURE] as string[]).includes(category))
    return {
      code: LINE_CATEGORY_UNKNOWN, category: category ?? shown,
      message: `[${LINE_CATEGORY_UNKNOWN}] create_line_based_element makes ${LINE_ALLOWED.join(" and ")} only${admin ? ` (and, for an admin, ${LINE_STRUCTURE.join(", ")})` : ""}; "${shown}" is not one of them.`,
    };
  if ((LINE_STRUCTURE as readonly string[]).includes(category) && !admin)
    return {
      code: LINE_CATEGORY_ADMIN, category,
      message: `[${LINE_CATEGORY_ADMIN}] ${category} is structure: only an admin can make it (create_structural_framing_system is admin-only for the same reason). AI may make ${LINE_ALLOWED.join(" and ")} here.`,
    };
  return null;
}

/** The type categories Revit reported for the batch's typeIds (fmc_type_facts), by type id. */
export type ResolvedTypes = ReadonlyMap<number, { found: boolean; category: string }>;

/** Type ids of a batch that name a type (-1 and 0 mean "the default"). */
export function lineTypeIds(items: ReadonlyArray<{ typeId?: unknown }>): number[] {
  return [...new Set(items.map((d) => d?.typeId).filter((t): t is number => typeof t === "number" && t !== -1 && t !== 0))];
}

/**
 * The first refusal for a batch, or null. Each item's claimed category is checked, and so is the category of its type when
 * Revit found the type: the type's category is what the add-in builds, whatever the item says. A type Revit did not find
 * falls back to the claimed category in the add-in, so the claim decides.
 */
export function lineBatchRefusal(items: ReadonlyArray<{ category?: unknown; typeId?: unknown }>, admin: boolean, resolved?: ResolvedTypes): LineRefusal | null {
  for (const item of items) {
    const claimed = lineCategoryRefusal(item?.category, admin);
    if (claimed) return claimed;
    const id = item?.typeId;
    if (typeof id === "number" && id !== -1 && id !== 0) {
      const type = resolved?.get(id);
      if (type?.found) {
        const actual = lineCategoryRefusal(type.category, admin);
        if (actual) return { ...actual, message: `${actual.message} (type ${id} is a ${type.category || "type with no category"}, whatever category the item names)` };
      }
    }
  }
  return null;
}

/** An admin session: the full-access switch, or the pane (a person at Revit). Never an AI session by default. */
export function adminSession(ai: Pick<AiModellerConfig, "access"> | null | undefined, startedBy: string): boolean {
  return ai?.access === "full" || startedBy === "pane";
}
