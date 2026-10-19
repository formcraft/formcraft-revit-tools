/**
 * Ceiling standard: the numbers the engine works with, taken from the kit. Rule 7: kit data comes from the kit. The kit
 * (v2.2, 15 Oct) has no ceiling set-out values yet, so each missing value falls back to the reference example the owner
 * approved (scratchpad famres/cl_room.py and cl_boards.py, the numbers on the CL_* boards) and is listed as a kit change
 * request in every answer, until 03_Master_Data\FMC_Ceiling_Standard.json (proposed) sets it.
 */
import { Keynote } from "../library.js";

export interface CeilingStandard {
  main_channel_cc_mm: number;
  furring_cc_mm: number;
  hanger_grid_mm: number;
  min_void_mm: number;
  min_board_piece_mm: number;
  end_joint_stagger_mm: number;
  board_waste: number;
  screws_per_m2: number;
  joint_tape_factor: number;
  hanger_tie_tolerance_mm: number;
  fan_min_blade_height_mm: number;
  fan_centre_tolerance_mm: number;
  detector_wall_clearance_mm: number;
  detector_grille_clearance_mm: number;
  lumens_per_downlight: number;
  cove_lumens_per_m: number;
  utilisation_factor: number;
  maintenance_factor: number;
  sheet_length_mm: number;
  sheet_width_mm: number;
  /** No fallback: the kit sets it per room use, or the headroom check says it can't tell. */
  min_ceiling_height_mm: number | null;
}

type Key = keyof CeilingStandard;

/** Fallbacks and where each comes from. */
export const FALLBACKS: Record<Exclude<Key, "min_ceiling_height_mm">, { value: number; from: string }> = {
  main_channel_cc_mm: { value: 1200, from: "cl_room.py MAIN_CC" },
  furring_cc_mm: { value: 450, from: "cl_room.py FURR_CC" },
  hanger_grid_mm: { value: 1200, from: "cl_room.py HANG_CC" },
  min_void_mm: { value: 150, from: "CL_Pane check: 150 mm for mains and hangers under the ties" },
  min_board_piece_mm: { value: 300, from: "cl_boards.py: no sliver under 300" },
  end_joint_stagger_mm: { value: 1200, from: "cl_boards.py: end joints staggered 1200" },
  board_waste: { value: 0.10, from: "cl_room.py: 10 % board waste (FMC_Master_Data waste for the board keynote is empty)" },
  screws_per_m2: { value: 25, from: "cl_room.py: about 25 screws per m²" },
  joint_tape_factor: { value: 0.55, from: "cl_room.py: tapered joint metres = sheets used × (long + short edge) × 0.55" },
  hanger_tie_tolerance_mm: { value: 50, from: "engine: a hanger within 50 mm of a tie centre line lands on it" },
  fan_min_blade_height_mm: { value: 2300, from: "engine: blades at least 2.3 m above the floor (IEC 60335-2-80 practice)" },
  fan_centre_tolerance_mm: { value: 150, from: "engine: a fan within 150 mm of its tray or coffer centre is centred" },
  detector_wall_clearance_mm: { value: 500, from: "engine: detectors 500 mm from walls and ceiling steps (BS 5839 practice)" },
  detector_grille_clearance_mm: { value: 1000, from: "engine: detectors 1 m from AC supply grilles (BS 5839 practice)" },
  lumens_per_downlight: { value: 800, from: "cl_room.py lux_estimate (indicative, CA-E-03)" },
  cove_lumens_per_m: { value: 900, from: "cl_room.py lux_estimate (indicative, CA-E-03)" },
  utilisation_factor: { value: 0.45, from: "cl_room.py lux_estimate (indicative, CA-E-03)" },
  maintenance_factor: { value: 0.8, from: "cl_room.py lux_estimate (indicative, CA-E-03)" },
  sheet_length_mm: { value: 2400, from: "cl_room.py BOARD" },
  sheet_width_mm: { value: 1200, from: "cl_room.py BOARD" },
};

export const KIT_STANDARD_FILE = "03_Master_Data\\FMC_Ceiling_Standard.json";

export interface ResolvedStandard {
  std: CeilingStandard;
  sources: Record<Key, string>;
  kit_change_requests: string[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** Sheet size from a material description, e.g. "9 mm gypsum board 1200 x 2400 for ceilings". */
export function sheetSizeOf(description: string): [number, number] | null {
  const m = /(\d{3,4})\s*[x×]\s*(\d{3,4})/.exec(description);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a >= 300 && b >= 300 ? [Math.max(a, b), Math.min(a, b)] : null;
}

/**
 * kit: the parsed FMC_Ceiling_Standard.json ({values:{…}} or flat keys) or null; boardWaste: FMC_Master_Data's waste for
 * the board keynote (null when empty); boardDescription: the board material's description from the library.
 */
export function resolveStandard(kit: unknown, boardWaste: number | null, boardDescription: string | null): ResolvedStandard {
  const src = (kit && typeof kit === "object" ? ((kit as any).values ?? kit) : {}) as Record<string, unknown>;
  const std = {} as CeilingStandard;
  const sources = {} as Record<Key, string>;
  const missing: string[] = [];
  const size = boardDescription ? sheetSizeOf(boardDescription) : null;
  for (const key of Object.keys(FALLBACKS) as Array<keyof typeof FALLBACKS>) {
    const fromKit = num(src[key]);
    if (fromKit !== null) { std[key] = fromKit; sources[key] = "kit"; continue; }
    if (key === "board_waste" && boardWaste !== null) { std[key] = boardWaste > 1 ? boardWaste / 100 : boardWaste; sources[key] = "kit (FMC_Master_Data waste)"; continue; }
    if ((key === "sheet_length_mm" || key === "sheet_width_mm") && size) {
      std[key] = key === "sheet_length_mm" ? size[0] : size[1]; sources[key] = "kit (material library description)"; continue;
    }
    std[key] = FALLBACKS[key].value;
    sources[key] = `fallback: ${FALLBACKS[key].from}`;
    missing.push(`${key} = ${FALLBACKS[key].value}`);
  }
  const minH = num(src.min_ceiling_height_mm);
  std.min_ceiling_height_mm = minH;
  sources.min_ceiling_height_mm = minH === null ? "missing" : "kit";
  const kcr: string[] = [];
  if (missing.length)
    kcr.push(`${KIT_STANDARD_FILE} (proposed): set ${missing.join(", ")}; the engine uses these reference values until the kit has them`);
  if (minH === null) kcr.push(`${KIT_STANDARD_FILE} (proposed): minimum ceiling height per room use (min_ceiling_height_mm); headroom isn't checked until it is set`);
  return { std, sources, kit_change_requests: kcr };
}

// ---------- the kit's material library and keynotes ----------

export interface LibPrice { ugx: string; unit: string; date: string; source: string; status: string }
export interface LibMaterial { name: string; keynote: string; class: string; description: string; price: LibPrice | null }

export function parseLibrary(json: any): LibMaterial[] {
  const list = Array.isArray(json) ? json : Array.isArray(json?.materials) ? json.materials : [];
  return list.filter((m: any) => m && typeof m.name === "string").map((m: any) => ({
    name: m.name, keynote: String(m.keynote ?? ""), class: String(m.class ?? ""), description: String(m.description ?? ""),
    price: m.price && typeof m.price === "object" && m.price.ugx != null
      ? { ugx: String(m.price.ugx), unit: String(m.price.unit ?? ""), date: String(m.price.date ?? ""), source: String(m.price.source ?? ""), status: String(m.price.status ?? "") }
      : null,
  }));
}

export interface CeilingKit {
  materials: LibMaterial[];
  keynotes: Keynote[];
  /** FMC_Master_Data.json codes (for the board's waste) */
  codes: Record<string, any>;
  standard: unknown;
  problems: string[];
  /** CL4: family names in 03_Master_Data\FMC_Family_Register.csv (null when it couldn't be read) */
  families?: Set<string> | null;
  /** CL4: the interiors RCP sheet in 03_Master_Data\FMC_Sheet_Register.csv (the row placed with VT_I_RCP) */
  rcp_sheet?: { number: string; name: string; scale: string } | null;
}

export function emptyKit(problems: string[] = []): CeilingKit {
  return { materials: [], keynotes: [], codes: {}, standard: null, problems };
}
