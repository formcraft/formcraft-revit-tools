# True north and project north (`fmc_north`)

`fmc_coord` keeps the coordination record and is the tool that may move a survey point. `fmc_north` only reports that geometry, rotates plan crops or an existing scope box, and turns sheet north arrows. It does not call `SetProjectPosition` and it does not acquire coordinates.

`audit` and `compare` are read-only. `align_views` and `north_arrows` dry-run unless `dry_run` is false. A real write is `fmc_north_apply`, one transaction, and needs `batch_lease` plus `references.kit`, `references.standards` and `references.rulebook`. The active document is never a guess. A central model, a protected path, and HEBERT HOSTELS are refused. The reply is a summary. The full JSON is under `%LOCALAPPDATA%\Formcraft\north`. There are no pictures.

Angles are degrees. `ProjectPosition.Angle` is the radians value, counterclockwise from project north to true north, the same reading `fmc_links` and `fmc_coord` publish. A provisional tolerance (`0.01` deg and `1` mm when `north.tol_*` and `coord.tol_*` are missing) cannot PASS.

## Audit one model

```json
{
  "action": "audit",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER"
}
```

The reply names the site, the angle, shared east/north/elevation, the survey point and the project base point, each view's Project North or True North setting, and each grid set's dominant angle.

## Compare A, E and P

```json
{
  "action": "compare",
  "documents": [
    "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
    "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
    "F26901-FMC-ZZ-ZZ-M3-P-0001_USER"
  ]
}
```

Omit `documents` to use every open model whose file name role is A, E, P or S. Loaded links are compared with `RevitLinkInstance.GetTotalTransform` against shared coordinates. A miss is `FMC-NORTH-ANGLE-MISMATCH` or `FMC-NORTH-SURVEY-MISMATCH`. An unloaded link is `FMC-NORTH-LINK-UNLOADED`.

## Square the BQ plans in A-0002

```json
{
  "action": "align_views",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "grid_set": "BQ",
  "mode": "crop",
  "dry_run": true
}
```

With `views` omitted, plan views whose names contain `BQ` are the set. `grid_set` `BQ` matches `BQ1` and `BQ-A`. It does not match `BQA`. `mode` `scope_box` also needs `scope_box`. Applying it:

```json
{
  "action": "align_views",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "grid_set": "BQ",
  "mode": "crop",
  "dry_run": false,
  "batch_lease": "lease-from-fmc_batch",
  "references": {
    "kit": ["FMC-BIM-MAN-001"],
    "standards": ["FMC-BIM-STD-002"],
    "rulebook": ["FMC_Rulebook_AIUse"]
  }
}
```

## North arrows

```json
{
  "action": "north_arrows",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "sheets": ["A-101"],
  "family": "FMC_North Arrow",
  "type_name": "True North",
  "dry_run": true
}
```

The arrow rotation is the project angle minus the crop basis, plus `arrow_zero_deg` when the family does not point up the sheet at rotation 0. Viewports that have no matching sheet instance are returned with `FMC-NORTH-ARROW-UNMATCHED`.

## API limits

- There is no public crop-region class. The element is taken from the view's dependents, then a collector on the view, category `OST_CropBoundary`, then a type name containing Crop. If none of those exist the view is `FMC-NORTH-CROP-NOT-FOUND`.
- A dry run does not turn the crop on. Apply turns `CropBoxActive` on inside the one transaction when the element is missing.
- Assigning a scope box sets the view crop to the scope box extents. Rotating a scope box turns every view that uses it.
- `Viewport.GetBoxCenter` can move when a crop that is not square rotates. The centre is put back with `SetBoxCenter` when Revit allows it, and the shift is still reported.
- A north arrow inside the model view is left alone. The crop already turns it. The symbol has to be on the sheet.
- `shared_basis_x_deg` is measured one foot along project X. `angle_deg` is the API angle. They can differ by a constant and still agree between files.
- An unloaded link has no `GetLinkDocument`.
