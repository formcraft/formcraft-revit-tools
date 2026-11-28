# fmc_generate_bind

One call makes a door or window family for a legend schedule: geometry, front and back legend geometry, and the eleven
Sinko-style shared parameters bound, with one legend-schedule row per type. It sits beside `fmc_family` (data-shell
families from the specs), `fmc_recipe` (families from a recipe) and `new_family` (an empty family from a template),
and it builds through the `fmc_recipe` pipeline: the call becomes an `fmc-recipe/0.1` recipe, so the background build,
flex, staging save and Gate A are the same as every other recipe.

## What it makes

- **Template**: `Metric Door.rft` (category Doors) or `Metric Window.rft` (Windows).
- **Geometry**, every face locked to a labelled reference plane so each type flexes: jambs and head on the `Frame`
  subcategory (plus a sill rail for a window), a leaf on `Panel` (door) or a glass pane on `Glass` (window). Parameters
  `Frame Width`, `Frame Depth`, `Leaf Thickness` (door), `Frame Material`, `Panel Material` / `Glass Material`.
- **Legend geometry**: the opening indication as symbolic lines in the elevation plane, drawn twice: on
  `Legend Front` at the exterior face and on `Legend Back` at the interior face (dashed, `line_pattern: Dash`). Every
  end sits on two planes (`Frame L In`, `Frame R In`, `Opening Mid V`, `Opening Mid H`, `Head Inner`, `Sill Inner` or
  `Door Floor`), so the lines follow Width and Height. Operations: door `hinged_left`, `hinged_right`; window
  `casement_left`, `casement_right`, `top_hung`, `bottom_hung`, `sliding`, `fixed` (no lines).
  A legend component set to Elevation: Front shows the exterior; Elevation: Back shows the interior, where Revit mirrors
  the lines so the hinge stays on its true side. Hide `Legend Back` in the front legend view and `Legend Front` in the
  back one.
- **The eleven parameters** (`server/src/fmc/sinkoparams.ts`), bound as type parameters (a legend shows types, never
  instance values). Names only live in that file; the GUID and data type are read from the kit
  `FMC_SharedParameters.txt` by name, and a name missing from the kit is `FMC-PARAM-NOT-IN-KIT`:
  `FMC_Frame_Spec`, `FMC_Glazing_Spec`, `FMC_Ironmongery_Set`, `FMC_Finish_Primary`, `FMC_Fire_Resistance_Min`,
  `FMC_Acoustic_Rating_Rw`, `FMC_Vent_Type`, `FMC_Fanlight_Height_mm`, `FMC_Mosquito_Mesh`, `FMC_Glazed_Area_m2`,
  `FMC_Openable_Area_m2`. The two area columns are type formulas from the geometry (window glazed area
  `(Width - 2 * Frame Width) * (Height - 2 * Frame Width)`, openable the same times 0 for fixed and 0.5 for sliding;
  door openable `(Width - 2 * Frame Width) * (Height - Frame Width)`); a value for them is refused.
- **Types**: one per `types` entry (`width_mm`, `height_mm`, optional `name`, `type_mark`, `keynote`, `values`).
  Type names default to `WWWWxHHHH`, type marks to `D01…` / `W01…`. `values` sets the parameter columns for every type,
  a type's own `values` win; each value is checked against the kit data type.

## Dry run first

`dry_run` defaults to true and writes nothing: no Revit call, no file, no log row. It returns `staging_path`,
`types`, `shared_parameters` (name, GUID, data type, formula), `legend_geometry`, `legend_schedule_rows`,
`legend_place`, the full `recipe`, `build_blockers` and `plan_id`.

A build is the same call with `dry_run: false`, `confirm: true` and the `plan_id` the dry run returned. Any change to
the inputs changes the plan_id, so the build is the plan a person saw (`FMC-GB-DRY-RUN-FIRST` otherwise). The family is
saved to `<family_staging_root>\A\<family>.rfa` with its recipe beside it and Gate A runs; an existing staged family
needs `overwrite: true`. It never loads the family into a project and never touches an open model. Release to
`04_Families` stays a person's act in the pane.

## After the build

`legend_place` lists what follows once a person has loaded the family into a project: two legend views from a seed
(`fmc_legend create_view`), `fmc_legend place` with `types: [{ id, category, view: "front" }]` and the same with
`view: "back"` (LEGEND_COMPONENT_VIEW -7 and -6), and a door or window schedule by type with the fields
`Type Mark, Width, Height` and the eleven, sorted by Type Mark.

```json
{
  "kind": "door",
  "operation": "hinged_left",
  "description": "Flush Hardwood",
  "types": [
    { "width_mm": 900, "height_mm": 2100, "type_mark": "D01", "keynote": "D.FLU_00" },
    { "width_mm": 800, "height_mm": 2100, "type_mark": "D02", "keynote": "D.FLU_00", "values": { "FMC_Fire_Resistance_Min": 30 } }
  ],
  "values": { "FMC_Frame_Spec": "Hardwood, clear lacquer", "FMC_Ironmongery_Set": "J.HRD_01", "FMC_Mosquito_Mesh": false },
  "dry_run": true
}
```
