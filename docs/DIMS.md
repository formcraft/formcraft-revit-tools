# Dimension strings (`fmc_dims`)

`action` is `auto`. The tool plans dimension strings along parallel grids and along exterior walls. Openings on those walls sit in the same chain when `targets` includes `openings`. An exterior-wall string skips an interior wall (`FMC-DIMS-NOT-EXTERIOR`) unless `targets` also includes `interior`.

`targets` is `grids`, `walls`, `openings`, `interior`, `rooms`, or a list of those. The default is grids, walls and openings. `interior` chains parallel interior partitions along one line, the same way grids are chained, and those walls are not `FMC-DIMS-NOT-EXTERIOR`. `rooms` places two clear dimensions per room, between the left and right bounding wall faces and between the bottom and top. `chain` true (the default) is one string per run. `chain` false is one string per adjacent pair. `offset_mm` defaults to 600. The dimension line sits past the high end of a grid or partition run, or to the left of a wall's direction. A room string runs through the room.

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

## Interior partitions and room clear size

```json
{
  "action": "auto",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "view": "Level 1",
  "targets": ["interior", "rooms"],
  "chain": true,
  "offset_mm": 600,
  "dry_run": true
}
```

## API limits

- A grid reference is `Curve.Reference` when Revit provides one.
- A wall string uses the two end faces whose normals follow the wall. If those faces have no reference, the string is `FMC-DIMS-NO-REFERENCE`.
- An interior chain and a room clear size use a long face (`wall_side` or `room_side`) whose normal matches the string. A face without a reference is `FMC-DIMS-NO-REFERENCE`.
- Room bounds come from `SpatialElement.GetBoundarySegments` at the finish face. A room with no boundary is `FMC-DIMS-NEED-PAIR`.
- An opening uses `FamilyInstance.GetReferences` (`CenterLeftRight`, then `CenterFrontBack`). One opening is two references. A family with neither is `FMC-DIMS-NO-REFERENCE`.
- `NewDimension` needs a line long enough to see and references that are parallel to it. A refusal rolls that string back and the others continue.
- The model is not saved or synchronised.
