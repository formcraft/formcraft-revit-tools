/**
 * fmc_directshape: which Revit categories a DirectShape may take. The tool never makes a DirectShape in a wall,
 * floor, door, column or any other category that a real family or system type should own. The universe below is the
 * most the guard file may enable; the default is Generic Models and Mass.
 */
import type { GuardConfig } from "./policy.js";

/** Every shape this tool makes carries these, so list and remove find only its own work. */
export const DS_APPLICATION_ID = "Formcraft.fmc_directshape";
export const DS_DATA_PREFIX = "fmc_directshape|";

export interface DsCategory {
  name: string;
  /** Revit BuiltInCategory name. */
  bic: string;
  aliases: string[];
}

export const DS_UNIVERSE: readonly DsCategory[] = [
  { name: "Generic Models", bic: "OST_GenericModel", aliases: ["generic", "generic model", "genericmodel", "genericmodels"] },
  { name: "Mass", bic: "OST_Mass", aliases: ["masses", "massing"] },
  { name: "Entourage", bic: "OST_Entourage", aliases: [] },
  { name: "Site", bic: "OST_Site", aliases: [] },
  { name: "Parking", bic: "OST_Parking", aliases: [] },
  { name: "Planting", bic: "OST_Planting", aliases: ["plants"] },
  { name: "Furniture", bic: "OST_Furniture", aliases: [] },
  { name: "Specialty Equipment", bic: "OST_SpecialityEquipment", aliases: ["speciality equipment"] },
  { name: "Casework", bic: "OST_Casework", aliases: [] },
  { name: "Mechanical Equipment", bic: "OST_MechanicalEquipment", aliases: [] },
  { name: "Electrical Equipment", bic: "OST_ElectricalEquipment", aliases: [] },
  { name: "Plumbing Fixtures", bic: "OST_PlumbingFixtures", aliases: [] },
];

export const DS_DEFAULT_WHITELIST: readonly string[] = ["Generic Models", "Mass"];

const key = (text: string) => text.trim().toLowerCase().replace(/[\s_-]+/g, " ");

function inUniverse(text: string): DsCategory | undefined {
  const k = key(text);
  if (!k) return undefined;
  return DS_UNIVERSE.find((c) => key(c.name) === k || c.bic.toLowerCase() === text.trim().toLowerCase() || c.aliases.some((a) => key(a) === k));
}

export interface Whitelist {
  allowed: DsCategory[];
  source: "default" | "config";
  /** Names in the config that are not DirectShape categories this tool supports. They are ignored. */
  ignored: string[];
  problem?: string;
}

/** The guard file's directshape_categories, or the safe default. A bad list never widens the default. */
export function resolveWhitelist(config?: Pick<GuardConfig, "directshape_categories">): Whitelist {
  const fallback = (extra: Partial<Whitelist> = {}): Whitelist => ({
    allowed: DS_DEFAULT_WHITELIST.map((n) => inUniverse(n)!), source: "default", ignored: [], ...extra,
  });
  const raw = config?.directshape_categories;
  if (raw === undefined) return fallback();
  if (!Array.isArray(raw) || raw.length === 0) return fallback({ problem: "directshape_categories must be a non-empty list of category names. The default is used." });
  const allowed: DsCategory[] = [];
  const ignored: string[] = [];
  for (const item of raw) {
    const found = typeof item === "string" ? inUniverse(item) : undefined;
    if (!found) ignored.push(String(item));
    else if (!allowed.includes(found)) allowed.push(found);
  }
  if (!allowed.length) return fallback({ ignored, problem: "directshape_categories names no category this tool supports. The default is used." });
  return { allowed, source: "config", ignored };
}

export type CategoryCheck = { ok: true; category: DsCategory } | { ok: false; code: "FMC-DS-CATEGORY"; message: string };

/** The whitelist check. An empty name means the first whitelisted category. Anything else is refused with the list. */
export function checkCategory(requested: string, list: Whitelist): CategoryCheck {
  const names = list.allowed.map((c) => c.name).join(", ");
  const text = requested.trim();
  if (!text) return { ok: true, category: list.allowed[0] };
  const found = inUniverse(text);
  if (!found) return { ok: false, code: "FMC-DS-CATEGORY", message: `[FMC-DS-CATEGORY] "${text}" is not a category fmc_directshape can make a DirectShape in. Allowed here: ${names}.` };
  if (!list.allowed.includes(found)) return { ok: false, code: "FMC-DS-CATEGORY", message: `[FMC-DS-CATEGORY] ${found.name} is not on this PC's DirectShape whitelist (directshape_categories in the guard file). Allowed here: ${names}.` };
  return { ok: true, category: found };
}
