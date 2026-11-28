# Grids, levels, dimensions and point placement: dry run, base point, duplicates, per item

Tool research 3, 4, 5 and 7 (`create_dimensions`, `create_grid`, `create_level`, `create_point_based_element`) found no
dry run, model coordinates only, silent renames and silent skips. These tools now follow the Formcraft pattern: server
check, dry run, one Revit handler.

- **Dry run.** `create_grid`, `create_level` and `create_dimensions` take `dry_run`, default true. The dry run reads the
  model once with `fmc_datum_read` (no transaction: base point, grid and level names, the named views, instances of the
  named types), plans on the server (`server/src/fmc/datum.ts`) and returns one row per input in `items`. Nothing is
  written. `create_point_based_element` keeps writing by default (its AI gate approves each batch); `dry_run: true`
  checks it the same way.
- **Project base point.** Coordinates and elevations are measured from the project base point (`relative_to`, default
  `project_base_point`), and the server moves them by the base point's internal position before the add-in gets them.
  `internal_origin` sends them as given (the old behaviour). The move is a translation: project coordinates share the
  internal axes; the angle to true north turns shared coordinates, not these. Survey-point placement is not offered.
  The reply gives `origin_internal_mm`. Levels are read and checked by `ProjectElevation` (internal); a level Revit
  makes more than 1 mm from the asked height is reported `FMC-LEVEL-ELEVATION-DRIFT`.
- **Duplicates are errors.** A grid name that exists or repeats is `FMC-GRID-DUPLICATE` (`on_duplicate: rename` keeps
  the old A to A1 rule, reported per grid). A level name that exists or repeats is `FMC-LEVEL-DUPLICATE`
  (`on_duplicate: reuse` keeps the existing level, reported), and a level within 1 mm of another level's height is
  `FMC-LEVEL-SAME-ELEVATION`. A repeated dimension is `FMC-DIM-DUPLICATE`. An instance of the same type within 10 mm
  of the point, or a repeated item, is `FMC-PLACE-DUPLICATE`. Any error refuses the whole write (`FMC-DATUM-BLOCKED`);
  the add-in checks names again before it writes.
- **Per item.** After a write each input has one row: `created` (with `id`), `reused`, `failed` with a code, or
  `unknown` when the add-in did not report it (an older add-in, a timeout). The add-in's answer carries `Items`
  (`commandset/Models/Common/AIItemsResult.cs`). Dimensions no longer commit an empty transaction when no references
  were found (`FMC-DIM-NO-REFS`), and one failure no longer loses the ids made before it. Placement rolls back a null
  instance (`FMC-PLACE-NOT-CREATED`), refuses a `hostWallId` that is not a wall (`FMC-PLACE-HOST`), and reports a
  missing type or level (`FMC-PLACE-NO-TYPE`, `FMC-PLACE-NO-LEVEL`).
- **Other checks.** `create_dimensions` needs `viewId` (`FMC-DIM-VIEW-REQUIRED`) of a view that takes dimensions
  (`FMC-DIM-VIEW-TYPE`), a line longer than 1 mm (`FMC-DIM-ZERO`), and two or more `elementIds` or none
  (`FMC-DIM-REFS`). Caps per call: 200 grid lines, 100 levels, 50 dimensions, 200 placements.

Grid labels, duplicate names and blank tag text exist on both sides: `commandset/Services/Fmc/FmcPlacementCore.cs` and
`server/src/fmc/datum.ts`. Both run `server/src/fmc/fixtures/placement_cases.json` (`tests/placementcore`, no Revit,
and `server/src/fmc/datum.test.ts`).

An add-in without `fmc_datum_read` makes these tools refuse with `FMC-DATUM-READ`: install the server and add-in together.
