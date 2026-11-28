# fmc_params

The project parameter manager. Canonical id: **GAP-11**. (The features.json id F161 is provisional and will be renumbered at merge.) Co-owned with Kit Loader on the kit shared-parameter GUID rule. Pass `document` (a title or a full path); the active document is never used.

## Actions

- `audit` (read-only): compares the project's parameter bindings with the kit shared parameter file. The file is read as UTF-8 or UTF-16 (a BOM decides). Findings: `FMC-PARAM-GUID-MISMATCH` (shared parameter with the kit's name but another GUID), `FMC-PARAM-NOT-IN-KIT`, `FMC-PARAM-NAME-CLASH` (a non-shared project parameter with a kit name), `FMC-PARAM-TYPE-DIFFERS`, `FMC-PARAM-RENAMED`, and the kit parameters that are not bound. `names` narrows it. Lists are capped at 200.
- `bind`: binds kit shared parameters (`names`) to `categories` (built-in names such as `OST_Walls`) as `instance` or `type`, in properties `group` (default `data`). The GUID on the plan and in Revit is only the one read from the kit shared parameter file. A new GUID or a new `ExternalDefinition` is never created. A name already in the project with another GUID (or a non-shared project parameter of that kit name), or a binding kind change, is refused. Categories are added to an existing binding, never removed. Revit is pointed at the kit file only for the call (`FmcSharedParams.Use`) and back at the person's file afterwards. The kit file is never edited.
- `copy`: `from` parameter into `to` parameter on elements given by `ids` or by one category (`categories[0]`). The same storage type, or anything into text. An empty source leaves the target alone unless `overwrite_empty`. Read-only targets and other users' elements are refused.
- `fill_csv`: `csv_path` is a `.csv` file (at most 8 MB) with an `Id` (or `ElementId`) column and one column per parameter name. Whole numbers and yes/no go into integer parameters. Length and other unit parameters are read in the parameter's display units by Revit (`SetValueString`), so `2100` means what the field would show. A blank cell is left alone. Duplicate and unknown ids are refused per row.

At most 5000 elements or rows, 100 parameters per bind.

## Dry run and apply

`bind`, `copy` and `fill_csv` are dry runs by default and return a preview (first 300 rows in the reply, all in the report under `%LOCALAPPDATA%\Formcraft\params`) and `plan_hash`. A real change needs `dry_run: false`, that `plan_hash`, and `batch_lease`. The call reads the model again, plans again, and refuses `FMC-PARAM-PLAN-CHANGED` when the hash differs. One transaction: any failure, including a value Revit cannot parse, rolls everything back. The project is not saved or synced.

## Safeguards

`fmc_params_apply` is in `WRITE_COMMANDS` (live-model lock, AI gate, batch lease). Refused: HEBERT HOSTELS, a central model, a file under a Centrals folder, a protected path, a family file.

```json
{ "action": "bind", "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", "names": ["Status"], "categories": ["OST_Walls"], "binding": "instance", "dry_run": true }
```

Design decisions for Emlyn: all-or-nothing apply (no partial fills); a blank CSV cell never clears a value; an existing binding can only gain categories.
