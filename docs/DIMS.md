# Dimension strings (`fmc_dims`)

`action` is `auto`. The tool plans dimension strings along parallel grids and along exterior walls. Openings on those walls sit in the same chain when `targets` includes `openings`. Interior walls are skipped (`FMC-DIMS-NOT-EXTERIOR`).

`targets` is `grids`, `walls`, `openings`, or a list of those. The default is all three. `chain` true (the default) is one string per run. `chain` false is one string per adjacent pair. `offset_mm` defaults to 600. The dimension line sits past the high end of a grid run, or to the left of a wall's direction.

`dry_run` defaults to true and returns the references and the line. It does not create a dimension. A real write is `fmc_dims_apply`, one transaction, one subtransaction per string. It needs `batch_lease` plus `references.kit`, `references.standards` and `references.rulebook`. A string that cannot get two references is `FMC-DIMS-NO-REFERENCE` or `FMC-DIMS-NEED-PAIR` and is not created. The full JSON is under `%LOCALAPPDATA%\Formcraft\dims`. There are no pictures.

## Grids and exterior walls

```json
{
  "action": "auto",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "view": "Level 1",
  "targets": ["grids", "walls"],
  "chain": true,
  "offset_mm": 600,
  "dry_run": true
}
```

## API limits

- A grid reference is `Curve.Reference` when Revit provides one.
- A wall string uses the two end faces whose normals follow the wall. If those faces have no reference, the string is `FMC-DIMS-NO-REFERENCE`.
- An opening uses `FamilyInstance.GetReferences` (`CenterLeftRight`, then `CenterFrontBack`). One opening is two references. A family with neither is `FMC-DIMS-NO-REFERENCE`.
- `NewDimension` needs a line long enough to see and references that are parallel to it. A refusal rolls that string back and the others continue.
- The model is not saved or synchronised.
