# Sheet layout (`fmc_sheets`)

`compare`, `create` and `rename` are unchanged. They still use the sheet register.

`pair`, `arrange` and `park` lay views out and file sheets away.

`pair` places the named views on one sheet. They are packed in a grid inside the title block drawing area. Margins come from `sheets.margin_left_mm`, `sheets.margin_other_mm` and `sheets.gap_mm`. A missing key is provisional (20 mm, 10 mm and 8 mm) and cannot PASS.

`arrange` reflows the views already on the sheet. `layout` is `grid`, `pair` or `stack`.

`park` sets a sheet parameter to the target, default `Parked`. A parameter whose name is a browser organization is used when the sheet has one. Otherwise the parameter is `FMC_Sheet_Status`. `BrowserOrganization` itself is not written per sheet.

`pack` arranges the viewports already on the sheet (or the named views) inside the FMC_TB_A0 or FMC_TB_A1 drawing area. Title-block parameters `FMC_Drawing_Width` and `FMC_Drawing_Height` win. Otherwise the kit areas are used: A1 is 681 by 574 mm from (20, 10), A0 is 1029 by 821 mm from (20, 10). Each view takes the largest standard scale whose denominator is at least `min_scale` and whose outline, including the title, fits the zone. Titles on one shelf share a baseline. `pair_small` true proposes small views from other sheets when they fit the space that is left. A view that still does not fit is an overflow row in millimetres, and apply is refused.

`dry_run` defaults to true. A real write is `fmc_sheets_layout_apply`, one transaction. It needs `batch_lease` plus `references.kit`, `references.standards` and `references.rulebook`. The full JSON is under `%LOCALAPPDATA%\Formcraft\sheets`. There are no pictures.

## Place two plans

```json
{
  "action": "pair",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "sheet": "A-101",
  "views": ["Level 1", "Level 2"],
  "dry_run": true
}
```

A view already on another sheet is `FMC-SHEETS-VIEW-TAKEN`. A view larger than the drawing area is `FMC-SHEETS-NO-FIT`. A sheet with no title block outline is `FMC-SHEETS-NO-FRAME`.

## Stack the views already on the sheet

```json
{
  "action": "arrange",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "sheet": "A-101",
  "layout": "stack",
  "dry_run": true
}
```

## Pack a sheet

```json
{
  "action": "pack",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "sheet": "A-101",
  "min_scale": 50,
  "pair_small": true,
  "dry_run": true
}
```

## Park a sheet

```json
{
  "action": "park",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "sheets": ["A-901"],
  "target": "Parked",
  "dry_run": true
}
```

When neither a browser parameter nor `FMC_Sheet_Status` can be written, the code is `FMC-SHEETS-PARK-PARAM`.

## API limits

- The drawing area is the title block bounding box when Revit returns one, otherwise the sheet outline, inset by the margins. There is no separate drawing-area element in the API.
- `Viewport.Create` refuses a view that is already on a sheet. The centre is sheet coordinates in millimetres, origin at the lower left.
- A schedule is placed with `ScheduleSheetInstance.Create`.
- Browser organization rules are not a per-sheet write. The sheet parameter is the park.
- `pack` sets `View.Scale` and `Viewport.SetBoxCenter`. A view on another sheet is deleted from that sheet and created on this one only when `from_other_sheet` is set. `Viewport.GetLabelOutline` supplies the title band. There is no separate drawing-area element: the zone is title-block parameters or the FMC_TB_A0 / FMC_TB_A1 kit size.
