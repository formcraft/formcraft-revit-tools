/**
 * ============================================================================================================
 *  CONFIG: the eleven Sinko-style legend-schedule parameters for fmc_generate_bind.          UNRESOLVED (owner)
 * ============================================================================================================
 * "Sinko-style" is the door and window schedule taught by Kyle Sinko (Successful Archi Student, Revit Advanced,
 * part 6 "Sexy Door and Window Schedules"): a legend view with each type's front and back elevation, and beside it
 * one schedule row per type. Its fields are the built-ins (Type Mark, Width, Height) and a set of shared parameters.
 *
 * No list of exactly eleven Sinko parameters exists in this repo, in D:\Fomcraft or in the kit (searched 28 Nov
 * 2026: repo, kit FMC_Kit_v2.2, docs, kit specs). So the eleven are defined here, in this one file, and every one of
 * them is an existing kit shared parameter (FMC_SharedParameters.txt, groups FMC_06 and FMC_25). Rule 7 still holds:
 * the GUID and data type are never taken from this file, they are read from the kit file by name at run time, and a
 * name missing from the kit is FMC-PARAM-NOT-IN-KIT (a kit change), never invented.
 *
 * To change the set: edit SINKO_PARAMS below (keep eleven, or change SINKO_COUNT and its test on purpose).
 * ============================================================================================================
 */

export type OpeningKind = "door" | "window";

export interface SinkoParam {
  /** Kit shared parameter name (looked up by name in the kit file; the GUID comes from there). */
  name: string;
  /** Column heading in the legend-schedule row. */
  column: string;
  /** Every Sinko parameter is a type parameter: a legend component shows a type, and instance values never reach it. */
  instance: false;
  /** Revit parameter group (fmc_doc GROUPS). */
  group: "Data" | "IdentityData" | "Constraints" | "Dimensions";
  /**
   * Where the value comes from: "value" is set per type from the call (values / types[].values) or left blank;
   * "formula" is a type formula the generator writes from the geometry, so the schedule can't disagree with the model.
   */
  source: "value" | "formula";
  /** The kinds it applies to. Both, unless a kind has no use for it (still bound, so one schedule serves both). */
  kinds: OpeningKind[];
}

export const SINKO_COUNT = 11;

export const SINKO_PARAMS: readonly SinkoParam[] = [
  { name: "FMC_Frame_Spec", column: "Frame", instance: false, group: "Data", source: "value", kinds: ["door", "window"] },
  { name: "FMC_Glazing_Spec", column: "Glazing", instance: false, group: "Data", source: "value", kinds: ["door", "window"] },
  { name: "FMC_Ironmongery_Set", column: "Ironmongery", instance: false, group: "Data", source: "value", kinds: ["door", "window"] },
  { name: "FMC_Finish_Primary", column: "Finish", instance: false, group: "Data", source: "value", kinds: ["door", "window"] },
  { name: "FMC_Fire_Resistance_Min", column: "Fire (min)", instance: false, group: "Data", source: "value", kinds: ["door", "window"] },
  { name: "FMC_Acoustic_Rating_Rw", column: "Acoustic Rw (dB)", instance: false, group: "Data", source: "value", kinds: ["door", "window"] },
  { name: "FMC_Vent_Type", column: "Vent over", instance: false, group: "Data", source: "value", kinds: ["door", "window"] },
  { name: "FMC_Fanlight_Height_mm", column: "Fanlight (mm)", instance: false, group: "Data", source: "value", kinds: ["door", "window"] },
  { name: "FMC_Mosquito_Mesh", column: "Mesh", instance: false, group: "Data", source: "value", kinds: ["door", "window"] },
  { name: "FMC_Glazed_Area_m2", column: "Glazed area (m2)", instance: false, group: "Data", source: "formula", kinds: ["door", "window"] },
  { name: "FMC_Openable_Area_m2", column: "Openable area (m2)", instance: false, group: "Data", source: "formula", kinds: ["door", "window"] },
];

/** The built-in fields that lead every legend-schedule row (not shared parameters; the template or Revit has them). */
export const SINKO_BUILTIN_COLUMNS = ["Type Mark", "Width", "Height"] as const;
