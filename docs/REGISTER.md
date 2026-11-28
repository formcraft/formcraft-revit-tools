# Drawing register (`fmc_register`)

`fmc_register` filters a sheet-list schedule so parked sheets drop out of the drawing list. `schedule` is `G100` or the schedule's name. A missing schedule is created with `ViewSchedule.CreateSheetList`.

The status parameter is a sheet parameter whose name contains "browser", otherwise `FMC_Sheet_Status`. The filter is `NotEqual` `PARKED` and `NotEqual` `Parked`. Fields are sheet number, sheet name, current revision and that status parameter.

`dry_run` defaults to true and lists fields to add, filters to add, and the sheets that would drop. Apply is `fmc_register_apply`, one transaction. It needs `batch_lease` and `references.kit`, `references.standards` and `references.rulebook`. A missing status parameter is `FMC-REGISTER-STATUS`. The tool does not create the parameter.

## Example

```json
{
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "schedule": "G100",
  "dry_run": true
}
```

## API limits

- `ScheduleDefinition.AddField` and `ScheduleFilter` with `ScheduleFilterType.NotEqual` are the Revit 2025 calls. There is no API to rebuild a browser organization.
- Sheet number, name and current revision are `SHEET_NUMBER`, `SHEET_NAME` and `SHEET_CURRENT_REVISION`.
- A status value of `Parked` with different capitalisation is excluded by the second filter. Other words are kept.
