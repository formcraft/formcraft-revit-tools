/** fmc_casework's argument schema (zod), shared by the tool and its action modules. */
import { z } from "zod";
import { STANDARD_FIELDS } from "./casework.js";

const OPENING = z.object({ kind: z.enum(["window", "door"]), offset: z.number(), width: z.number().positive() });
const FIXED = z.object({
  kind: z.enum(["sink", "cooker", "fridge", "dishwasher", "washer", "appliance"]),
  offset: z.number(), width: z.number().positive(),
  hood: z.boolean().optional().describe("cooker: a hood above (a gap in the wall units)"),
  tall: z.boolean().optional().describe("rises above the worktop (fridge is tall unless false)"),
  fronts: z.string().optional(),
});
const WALL = z.object({
  name: z.string(), length: z.number().positive(),
  corner: z.enum(["start", "end"]).optional().describe("this wall holds the corner unit at this end"),
  after_corner: z.enum(["start", "end"]).optional().describe("the next wall's corner unit returns along this end"),
  openings: z.array(OPENING).optional(),
  fixed: z.array(FIXED).optional(),
  tall: z.object({ at: z.enum(["start", "end"]), width: z.number().positive(), fronts: z.string().optional() }).optional(),
  start: z.array(z.number()).length(2).optional().describe("place: where the wall's room-side face starts in the model, mm (room gives it)"),
  end: z.array(z.number()).length(2).optional().describe("place: where it ends; the units stand on the left of start → end"),
  side: z.enum(["left", "right"]).optional().describe("place: the room's side of start → end, when it isn't the left"),
  wall_id: z.number().optional(),
});
const RUN = z.object({
  walls: z.array(WALL).min(1),
  modules: z.array(z.number().positive()).min(1).describe("unit widths the fill may use, mm"),
  wall_modules: z.array(z.number().positive()).optional(),
  corner_width: z.number().positive().optional(),
  fronts: z.record(z.string(), z.string()).optional().describe("by mark: door, 2door, <n>drawer, none"),
  drawer_heights: z.record(z.string(), z.array(z.number().positive())).optional(),
  mark_prefix: z.object({ base: z.string().optional(), wall: z.string().optional() }).optional(),
});
const UNIT = z.object({
  mark: z.string(), kind: z.enum(["corner", "base", "sink", "tall", "wall", "gap"]), width: z.number().positive(),
  wall: z.string().optional().default(""), offset: z.number().optional().default(0), fronts: z.string().optional().default(""),
  layer: z.enum(["base", "wall"]).optional(), drawer_heights: z.array(z.number().positive()).optional(),
});

export const FMC_CASEWORK_SHAPE = {
  action: z.enum(["units", "parts", "nest", "cutlist", "hardware", "summary", "pack", "room", "check", "place", "shop_drawings", "remove"]),
  run: RUN.optional().describe("The run to lay out (or give units)"),
  units: z.array(UNIT).optional().describe("A unit list instead of a run (the unit editor's)"),
  standards: z.record(z.string(), z.unknown()).optional()
    .describe(`Workshop standards over the kit's (mm and counts): ${STANDARD_FIELDS.join(", ")}; optional edge_band, worktop (kit material names)`),
  board: z.string().optional().default("").describe("nest: only this board material"),
  sheet: z.number().int().positive().optional().describe("nest: only this sheet number"),
  project_folder: z.string().optional().default("").describe("pack: the project folder (the files go to 01_WIP\\_Casework)"),
  project_code: z.string().optional().default("").describe("pack: the project code (Manual 4.1)"),
  label: z.string().optional().default("").describe("pack, place, shop_drawings: what this is, e.g. K-01 Kitchen; the file names come from it, and a re-run replaces what the same label placed"),
  room: z.string().optional().default("").describe("room, check (and place's dry run): the room's number or name in the active model"),
  level: z.string().optional().default("").describe("place: the level the units stand on"),
  family: z.string().optional().default("FMC_I_Casework_KitchenUnit").describe("place: the kit's unit family (FMC_I_Casework_*, from FMC_Family_Register.csv)"),
  type_for: z.record(z.string(), z.string()).optional().describe("place: your choice of register type for a unit kind the family has no type for, e.g. {\"sink\": \"Base\"}"),
  wall_unit_bottom: z.number().positive().optional().describe("place: underside of the wall units above the level, mm (a design input)"),
  sheets: z.array(z.string()).optional().default([]).describe("shop_drawings: the register's joinery sheets to use, e.g. [\"I-4001\"]"),
  run_id: z.string().optional().default("")
    .describe("Instead of sending the run, unit list and standards again: the run_id of an earlier reply (its saved inputs are used; what you send overrides them)"),
  modules: z.array(z.number().positive()).optional()
    .describe("Unit widths over the run's modules, mm; e.g. with run_id from room, whose run has none yet"),
  fresh_room: z.boolean().optional().default(false)
    .describe("check, place: read the room from Revit again even when the run named in run_id read it in the last 10 minutes"),
  confirm: z.boolean().optional().default(false)
    .describe("pack, shop_drawings, remove: needed with dry_run=false, after the person has seen the dry run"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcCaseworkArgs = z.infer<z.ZodObject<typeof FMC_CASEWORK_SHAPE>>;
