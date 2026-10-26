/**
 * Family line graphics (owner 26 Oct, rule FAM-044): families drew in near-white lines on pen 1, so plans, elevations
 * and legends looked half-toned. Lines are black or dark grey; colour belongs to materials. Pens (TPL-021's set):
 * outlines and the Coarse envelope pen 3 (0.18 mm), detail edges pen 2 (0.13 mm), cut pen 4 (0.25 mm), and pen 1 only
 * for door swings, clearance zones, hidden parts and indications (their colour kept, darkened so it reads). The add-in applies the
 * same rule when it makes a subcategory (FmcFamilyGraphics.cs).
 */
export type Role = "outline" | "detail" | "light";
export interface SubcategoryOp { op: "add_subcategory"; name: string; color?: number[]; line_weight_projection?: number; line_weight_cut?: number; keep_graphics?: boolean; [k: string]: unknown }

export const PENS: Record<Role, { projection: number; cut: number }> = {
  outline: { projection: 3, cut: 4 }, detail: { projection: 2, cut: 4 }, light: { projection: 1, cut: 1 },
};
/** Above this lightness (0 black, 1 white) a line colour reads as half-tone on white paper. */
export const MAX_LIGHTNESS = 0.45;

export function role(name: string): Role {
  const n = name.toLowerCase();
  if (/envelope|outline|silhouette/.test(n)) return "outline";
  if (/clearance|hidden|swing|zone|approach|operation|light path|indicat|reference|void|service space/.test(n)) return "light";
  return "detail";
}

export const lightness = (c: number[]) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;

/** A colour darkened, keeping its hue, until it reads on white. */
export function darken(c: number[], to = MAX_LIGHTNESS): number[] {
  const l = lightness(c);
  if (l <= to) return c;
  const k = to / l;
  return c.map((v) => Math.floor(v * k));
}

/** The subcategory as FAM-044 wants it (keep_graphics true leaves a deliberate exception alone). */
export function fixSubcategory<T extends SubcategoryOp>(o: T): T & { color?: number[]; line_weight_projection?: number; line_weight_cut?: number } {
  if (o.keep_graphics) return o;
  const r = role(o.name);
  const pens = PENS[r];
  const color = r === "light" ? darken(o.color ?? [80, 80, 80]) : [0, 0, 0];
  return { ...o, color, line_weight_projection: pens.projection, line_weight_cut: pens.cut };
}

/** What a recipe's subcategory gets wrong, for fmc_recipe check. */
export function graphicsProblems(o: SubcategoryOp, at: string): string[] {
  if (o.keep_graphics) return [];
  const p: string[] = [];
  const r = role(o.name);
  if (o.color && o.color.length === 3 && lightness(o.color) > MAX_LIGHTNESS)
    p.push(`${at}: subcategory "${o.name}" has a pale line colour [${o.color.join(", ")}]: it draws half-toned in plans, elevations and legends. Lines are black or dark grey (FAM-044); put the colour on the material`);
  if (r !== "light" && (o.line_weight_projection ?? 1) < PENS[r].projection)
    p.push(`${at}: subcategory "${o.name}" is on pen ${o.line_weight_projection ?? 1}: ${r === "outline" ? "outlines" : "parts"} use pen ${PENS[r].projection} (FAM-044); pen 1 is for clearances and hidden parts`);
  return p;
}
