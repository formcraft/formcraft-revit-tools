/**
 * A sample recipe tree (T0): one ICU bay. The room's inputs (width, depth, structure height) reach every child: the
 * ceiling is designed for the room by fmc_ceiling; the families come from the 14-family sample's recipes. T1 builds it.
 */
import type { Tree } from "./tree.js";

const STAGING = "D:\\Fomcraft\\FMC_BIM_27\\FMC_Kit_v2.2\\FMC_Kit_v2.2\\04_Families\\_Staging\\_Batch";

export const ICU_BAY_SAMPLE: Tree = {
  schema: "fmc-tree/0.1",
  project: "SAMPLE",
  root: {
    id: "Hospital", kind: "project", name: "Sample hospital",
    children: [{
      id: "L2", kind: "level", inputs: { level: "L2", structure_height: 3300 },
      children: [{
        id: "ICU", kind: "department", name: "Intensive care",
        children: [{
          id: "ICU-Bay-01", kind: "room", name: "ICU bay", inputs: { width: 4200, depth: 5000, beds: 1 },
          children: [
            { id: "ICU-Bay-01.Ceiling", kind: "assembly", name: "Ceiling (tray with bulkhead)",
              make: { tool: "fmc_ceiling", args: { action: "designs",
                room: { name: "ICU bay", width_mm: "${var.width}", depth_mm: "${var.depth}", structure_height_mm: "${var.structure_height}", structure: "slab" },
                brief: { styles: ["tray", "bulkhead"] } } } },
            { id: "ICU-Bay-01.Bed", kind: "family", name: "ICU bed (LOD 400 + Render)",
              make: { tool: "fmc_recipe", args: { action: "batch", recipe_files: [`${STAGING}\\FMC_I_MedEq_Bed_ICU_Electric_Detailed_LOD400.json`] } } },
            { id: "ICU-Bay-01.Light", kind: "family", name: "Operating light with its light path",
              make: { tool: "fmc_recipe", args: { action: "batch", recipe_files: [`${STAGING}\\batch_DET_LOD400.json`] } } },
            { id: "ICU-Bay-01.Door", kind: "family", name: "Hygienic door with Open",
              make: { tool: "fmc_recipe", args: { action: "batch", recipe_files: [`${STAGING}\\batch_QS03_SAMPLE_LOD400.json`] } } },
          ],
        }],
      }],
    }],
  },
};
