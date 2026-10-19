/**
 * A sample recipe tree (T0, T1): one ICU bay. The room's inputs (width, depth, the level's structure height) reach every
 * child: the room itself (walls, the door and window, the bed on the head wall with its clearance, the operating light on
 * the ceiling) is built by fmc_room; the ceiling is designed for the room by fmc_ceiling; the families come from the
 * 14-family sample's recipes. Wall and ceiling types are the project template's (inputs, so a project sets its own).
 */
import type { Tree } from "./tree.js";

const STAGING = "D:\\Fomcraft\\FMC_BIM_27\\FMC_Kit_v2.2\\FMC_Kit_v2.2\\04_Families\\_Staging\\_Batch";

export const ICU_BAY_SAMPLE: Tree = {
  schema: "fmc-tree/0.1",
  project: "SAMPLE",
  root: {
    id: "Hospital", kind: "project", name: "Sample hospital",
    inputs: { wall_type: "Generic - 200mm", wall_thickness: 200, ceiling_type: "Generic" },
    children: [{
      id: "L2", kind: "level", inputs: { level: "Level 2", structure_height: 3300, ceiling_height: 2900 },
      children: [{
        id: "ICU", kind: "department", name: "Intensive care",
        children: [{
          id: "ICU-Bay-01", kind: "room", name: "ICU bay", inputs: { width: 4200, depth: 5000, origin: [0, 0], number: "L2-ICU-01", skip_walls: [], corridor_wall: "south", head_wall: "north" },
          children: [
            // the families first, so the room finds them loaded
            { id: "ICU-Bay-01.Families", kind: "group", name: "The bay's families",
              children: [
                { id: "ICU-Bay-01.Bed", kind: "family", name: "ICU bed (LOD 400 + Render)",
                  make: { tool: "fmc_recipe", args: { action: "batch", recipe_files: [`${STAGING}\\FMC_I_MedEq_Bed_ICU_Electric_Detailed_LOD400.json`] } } },
                { id: "ICU-Bay-01.Doors", kind: "family", name: "Hygienic door and observation window with Open",
                  make: { tool: "fmc_recipe", args: { action: "batch", recipe_files: [`${STAGING}\\batch_QS03_SAMPLE_LOD400.json`] } } },
                { id: "ICU-Bay-01.Light", kind: "family", name: "Operating light with its light path",
                  make: { tool: "fmc_recipe", args: { action: "batch", recipe_files: [`${STAGING}\\batch_DET_LOD400.json`] } } },
              ] },
            { id: "ICU-Bay-01.Room", kind: "assembly", name: "Walls, openings, bed, light, ceiling, the room",
              make: { tool: "fmc_room", args: { action: "build", room: {
                name: "ICU bay", number: "${var.number}", level: "${var.level}", origin_mm: "${var.origin}",
                width: "${var.width}", depth: "${var.depth}", height: "${var.structure_height}",
                walls: { type: "${var.wall_type}", thickness: "${var.wall_thickness}", skip: "${var.skip_walls}" },
                ceiling: { type: "${var.ceiling_type}", height: "${var.ceiling_height}" },
                openings: [
                  { kind: "door", family: "FMC_A_Door_FlushSingle_Hygienic_Detailed", type: "1026x2100_S", wall: "${var.corridor_wall}", along: 900, width: 1026 },
                  { kind: "window", family: "FMC_A_Window_Observation_Internal_Nurse_Detailed", type: "1200x900_WfixedSWoption", wall: "${var.corridor_wall}", along: 2800, width: 1200, sill: 900 },
                ],
                items: [
                  { id: "Bed", family: "FMC_I_MedEq_Bed_ICU_Electric_Detailed", type: "1020x2200_Standard", at: { wall: "${var.head_wall}", off: 150 }, size: [1020, 2200], clearance: 1200 },
                  { id: "Operating light", family: "FMC_E_LightFixture_OperatingLight_Ceiling_Detailed", type: "700_Single", at: { centre: true, dy: 600 }, host: "ceiling" },
                ],
              } } } },
            { id: "ICU-Bay-01.Ceiling", kind: "assembly", name: "Ceiling design (tray with bulkhead)",
              make: { tool: "fmc_ceiling", args: { action: "designs",
                room: { name: "ICU bay", width_mm: "${var.width}", depth_mm: "${var.depth}", structure_height_mm: "${var.structure_height}", structure: "slab" },
                brief: { styles: ["tray", "bulkhead"] } } } },
          ],
        }],
      }],
    }],
  },
};
