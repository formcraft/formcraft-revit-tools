# fmc_family_params

Parameters and labels on a family that is already loaded in the project. The kit family file is not opened for edit and is never saved. `EditFamily` is followed by `LoadFamily` back into the project with overwrite, then `Close(false)`.

`list` returns parameters for `family`, or the loaded titleblock names when `family` is omitted.

`add` adds `name` with `type`, `group` and `binding` (`instance` or `type`). `shared` defaults to true. The definition is the kit shared parameter file, matched by name and GUID. A name that is not in that file is `FMC-PARAM-NOT-IN-KIT`, a kit change. No shared definition is created. A type that does not match the file is `FMC-PARAM-TYPE`.

`label` is refused with `FMC-NO-API-LABEL`: Revit 2025 has no API to create a label in a family (`FamilyItemFactory.NewLabel` does not exist), so the label is placed by hand once in the kit title block. The call still checks that the parameter is on the family (`FMC-PARAM-MISSING`) and returns the plan for reference. `origin_mm` is kept for a future Revit API. Revit does not publish which parameter an existing label is bound to, so `has_label` is true only when the visible text equals the parameter name.

`bind` binds a kit shared parameter to project categories such as `OST_Sheets`.

`dry_run` defaults to true. A real change is `fmc_family_params_apply`. It needs `batch_lease` and `references.kit`, `references.standards` and `references.rulebook`.

Pass `document`. The active document is not a guess. HEBERT HOSTELS, a central, a protected path and a document that is itself a kit family are refused. The project is not saved or synced.

The architecture titleblock has no Status label until one is placed by hand (`FMC-NO-API-LABEL`); `add` and `bind` can still add and bind the parameter. The family name is the one loaded in the project. `Status` has to be in `FMC_SharedParameters.txt`.

```json
{
  "action": "add",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "family": "FMC_A_Titleblock_A1",
  "name": "Status",
  "type": "text",
  "group": "identity",
  "shared": true,
  "binding": "instance",
  "dry_run": true
}
```

```json
{
  "action": "label",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "family": "FMC_A_Titleblock_A1",
  "name": "Status",
  "origin_mm": [10, 10],
  "dry_run": true
}
```

```json
{
  "action": "bind",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "name": "Status",
  "categories": ["OST_Sheets"],
  "binding": "instance",
  "dry_run": true
}
```
