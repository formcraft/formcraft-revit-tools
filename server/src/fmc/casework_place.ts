/**
 * Casework in the model (CW2, docs/PLAN_CASEWORK.md). Pure: no Revit. The Revit commands only carry these plans out.
 *
 *   room reading (fmc_casework_room)  → a run's walls with their place in the model, and the services points
 *   units + walls + kit               → placement plan for fmc_casework_place (FMC_I_Casework_* unit families)
 *   units + walls + services          → coordination checks that flag, never decide (rule 5)
 *   units + sheet register + rulebook → shop-drawing views laid out on A3 sheets for fmc_casework_pack
 *
 * Families, types, parameters, sheets, scales, title blocks and view templates all come from the kit's own files
 * (FMC_Family_Register.csv, FMC_Master_Data.json, FMC_Sheet_Register.csv, FMC_Rulebook_Sheets.json, the material
 * library's keynotes). What the kit lacks comes back as a kit change request; nothing is filled in (rule 7).
 */
//
// Split for the hub's 300-line rule; every name stays importable from here:
//   casework_place_plan.ts  family and placement   casework_room.ts  room reading and checks   casework_shop.ts  shop sheets

export * from "./casework_place_plan.js";
export * from "./casework_room.js";
export * from "./casework_shop.js";
