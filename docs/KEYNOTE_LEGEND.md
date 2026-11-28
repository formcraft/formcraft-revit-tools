# Keynote legend (`fmc_keynote_legend`)

`fmc_keynote_legend` creates one keynote legend, filters it by sheet, and places it on each sheet. `sheets` is a list of sheet numbers or names. With `sheets` omitted, `role` (default `plan`) selects the sheets. A sheet whose title block or sheet parameter `FMC_Sheet_Role` is empty is `plan` when a floor plan is placed on it.

`filter_by_sheet` defaults to true. If `IsValidCategoryForFilterBySheet` is false the transaction is rolled back and the code is `FMC-KEYNOTE-LEGEND-FILTER`. Nothing unfiltered is kept.

The point is a title-block parameter when one is set: `FMC_Legend_Zone` or `Legend Zone` as text `x,y` in millimetres, or `FMC_Legend_X` and `FMC_Legend_Y` as length parameters (Revit stores those in feet). Without a parameter the point is the kit zone, inset from the lower right of the title block. The kit file is `03_Master_Data/FMC_KeynoteLegend.json`. The sample at `server/data/FMC_KeynoteLegend.json` is `PROVISIONAL` and cannot PASS. A sheet with no parameter and no title-block outline is `FMC-KEYNOTE-LEGEND-ZONE`.

`dry_run` defaults to true. A real write is `fmc_keynote_legend_apply`, one transaction. It needs `batch_lease` plus `references.kit`, `references.standards` and `references.rulebook`. The answer is the legend id and the viewport id (`ScheduleSheetInstance`) on each sheet. The full JSON is under `%LOCALAPPDATA%\Formcraft\keynote-legend`. There are no pictures.

`keynote_legend` and `place_schedule` inside `modify_model` are not keynote tags. A `for_each` of either runs on the add-in. A `for_each` that places a keynote tag is still refused, because `select` would not see each pass.

## Plan sheets

```json
{
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "role": "plan",
  "filter_by_sheet": true,
  "dry_run": true
}
```

## API limits

- Revit 2025 creates the legend with `ViewSchedule.CreateKeynoteLegend`. There is no separate legend element.
- `ScheduleSheetInstance.Create` places it. The id of that instance is the viewport id in the answer.
- A sheet that already shows this legend is `FMC-KEYNOTE-LEGEND-ALREADY` and is not placed again.
- The model is not saved or synchronised.
