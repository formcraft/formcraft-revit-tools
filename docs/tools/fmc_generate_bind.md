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
saved to `<family_staging_root>\A\<family>.rfa` with its recipe beside it and Gate A runs. It never loads the family
into a project and never touches an open model. Release to `04_Families` stays a person's act in the pane.

`confirm` and `plan_id` are integrity checks (the build is the plan the dry run showed), not an approval. The plan_id
covers the recipe, the target path, the staging root, the kit file (size and mtime), the tool version and `overwrite`,
so run the dry run with the same arguments as the build.

The eleven parameters are provisional (owner not signed off): the dry run says so (`parameter_set`) and Gate A adds a
`Sinko-style parameter set` line (Not checked) for a family that carries all eleven.

## First build and overwrite (F134, FINAL APPROVED 2026-11-28)

- **First build**: nothing is staged under the name. The dry run, `confirm` and `plan_id` are enough. No approval, no
  `_Archive`. `overwrite: true` on a missing file changes nothing.
- **Overwrite**: the staged `.rfa` exists. Without `overwrite: true` the build is `FMC-GB-EXISTS`. With it, the build
  needs a single-use `family_overwrite` approval bound to the target path, the staged file's sha256 (size and mtime
  recorded) and the plan (the recipe hash), valid 30 minutes. The first call answers `waiting_for_approval` with
  `approval_id` and `expires_at` and writes nothing; a person approves it in the pane (`family_overwrite_approve`), then
  the same call with `approval_id` runs. Then, in this order: the `.rfa`, its `.000N` backups, `<family>.recipe.json`
  and `<family>.gate.json` are copied to `<staging>\A\_Archive\<yyyyMMdd-HHmmss>_<name>` and checked (size, sha256),
  the approval is marked used, the originals leave staging, and the build runs. The reply lists `archived`.
- **Testing mode** (`ai_modeller.mode` testing with `auto_approve` true) may issue and approve the record itself; that
  skips only the person's click. The binding, single use and archive stay. `auto_approve` in any other mode does nothing.
- Refusals (`FMC-GB-APPROVAL`): an unknown, used, rejected or expired approval; another path; the staged file changed
  since the approval; another plan. A failed archive (`FMC-GB-ARCHIVE`) builds nothing, leaves the staged files as they
  were and keeps the approval unused for a retry.
- The gate is in `fmc_recipe` build and batch, so a direct `fmc_recipe` overwrite and a batch rebuild of a staged family
  (`approval_ids` per family) meet the same rules. A dry run never writes, archives or consumes an approval; when the
  target exists it says a real overwrite would move the old files to `_Archive`. A refused build never replaces
  `<reports>\Recipes\<family>.recipe.json`.
- **protected_roots** refuses only a path inside a named originals folder in `fmc_guard.json` (an empty list refuses
  nothing; the folder is not named yet). The forbidden projects are A-0001 and HEBERT HOSTELS as whole words, in the
  path and its real path; `forbidden_projects` in the guard file may add names. A-00012 is not blocked.
- The approval records live in `%APPDATA%\Formcraft\approvals\family_overwrite.json`; only the pane sets a status.

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
