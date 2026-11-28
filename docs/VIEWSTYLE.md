# View graphics (`fmc_viewstyle`)

Three actions read a spec and plan the graphics. The kit file is `03_Master_Data/FMC_ViewStyle.json`, beside the family specs. When that file is missing, the sample shipped at `server/data/FMC_ViewStyle.json` is used. The sample colours are `PROVISIONAL` and cannot PASS.

`templates` creates a view template with `CreateViewTemplate` from `from_view`, then can assign it. An existing name is `FMC-VIEWSTYLE-NAME-TAKEN` and is not replaced.

`filters` creates a parameter filter and, when `apply_to` names views, sets the colour override. Colours in the sample are provisional.

`room_fill` fills rooms by `Department` or `Name` and can place a colour-fill legend. Revit 2025 has no `ColorFillScheme.Create`. The apply duplicates an existing Rooms scheme.

`dry_run` defaults to true. A real write is `fmc_viewstyle_apply`, one transaction, one subtransaction per template, filter or scheme. It needs `batch_lease` plus `references.kit`, `references.standards` and `references.rulebook`. The full JSON is under `%LOCALAPPDATA%\Formcraft\viewstyle`. There are no pictures.

## Room colour by department

```json
{
  "action": "room_fill",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "dry_run": true
}
```

## A template from Level 1

```json
{
  "action": "templates",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "dry_run": true
}
```

## API limits

- There is no API to create a view template except from an existing view. A spec row without `from_view` is `FMC-VIEWSTYLE-NO-VIEW`.
- Revit 2025 has no `ColorFillScheme.Create`. The documented route is `ColorFillScheme.Duplicate(name)` from an existing scheme of category Rooms, then the `ParameterDefinition` setter (Revit 2022 and later) to `ROOM_DEPARTMENT` or `ROOM_NAME`. Setting the parameter clears the entries. `ColorFillSchemeEntry` is added per value, `View.SetColorFillSchemeId` assigns the scheme, and `ColorFillLegend.Create` places the legend. A model with no Rooms scheme is `FMC-VIEWSTYLE-NO-SCHEME`. `IsValidParameterDefinitionId` false, or a setter exception, is `FMC-VIEWSTYLE-SCHEME-PARAM` and that subtransaction is rolled back.
- A view template that owns the filters will refuse an override on the view. The filter is still created. The view is skipped with the Revit message.
- Provisional colours are reported as `PROVISIONAL` and `can_pass` is false.
