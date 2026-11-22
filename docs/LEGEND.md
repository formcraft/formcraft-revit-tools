# Legend views and symbols (`fmc_legend`)

`chain` is unchanged: it builds a role's chain-test project. `seed`, `create_view` and `place` are the legend-view actions.

Revit cannot create a `LegendComponent` or a `ViewLegend`. Both actions copy a seed. There are no free text notes. `seed` is read-only. `create_view` and `place` dry-run unless `dry_run` is false. A real write is `fmc_legend_apply`, one transaction, and needs `batch_lease` plus `references.kit`, `references.standards` and `references.rulebook`. The full JSON is under `%LOCALAPPDATA%\Formcraft\legend`. There are no pictures.

View directions are the integers the kit measured, because there is no public enum: `-7` elevation front, `-6` back, `-9` right, `-10` left, `-4` ceiling plan, `-8` floor plan, `-5` section, `-3` 3D. Doors and windows use elevation front. Walls, floors and roofs use a section. Ceilings use the ceiling plan. Parameters are set in this order: `LEGEND_COMPONENT`, then `LEGEND_COMPONENT_VIEW`, then `LEGEND_COMPONENT_LENGTH` for a wall. Each `Set` return is checked. A rejected component is rolled back in its own `SubTransaction` and the others continue.

## Seed

```json
{
  "action": "seed",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER"
}
```

If the model has no legend component, the reply is `FMC-LEGEND-NO-SEED` and the fix is `place one legend component by hand once`. Pass `source_document` to read a seed from another open model.

## New legend view

```json
{
  "action": "create_view",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "seed_view": "Symbols",
  "name": "LG_A_Doors",
  "duplicate": "duplicate",
  "dry_run": true
}
```

`duplicate` is `duplicate` or `with_detailing`. A copy from another open document uses `ElementTransformUtils.CopyElements`. If Revit refuses, the reply is `FMC-LEGEND-COPY-REFUSED` and nothing is renamed into place. An existing name is `FMC-LEGEND-NAME-TAKEN`. The existing view is not deleted.

## Place types

```json
{
  "action": "place",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "view": "LG_A_Doors",
  "types": [
    { "id": "12345", "category": "door" },
    { "id": "12346", "category": "window" },
    { "id": "12347", "category": "wall" }
  ],
  "columns": 1,
  "spacing_x_mm": 80,
  "spacing_y_mm": 40,
  "origin_x_mm": 15,
  "origin_y_mm": 0,
  "length_mm": 1000,
  "label": "type_mark",
  "dry_run": true
}
```

`label` is `none`, `keynote` or `type_mark`. The tool tries a keynote tag or a type-mark tag. Legend views often refuse tags. When that happens the reply is `FMC-LEGEND-LABEL-UNSUPPORTED` and the type marks are returned so a schedule can name the rows. No `TextNote` is created.

Applying the same plan:

```json
{
  "action": "place",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "view": "LG_A_Doors",
  "types": [
    { "id": "12345", "category": "door" },
    { "id": "12347", "category": "wall" }
  ],
  "label": "none",
  "dry_run": false,
  "batch_lease": "lease-from-fmc_batch",
  "references": {
    "kit": ["FMC-BIM-MAN-001"],
    "standards": ["FMC-BIM-STD-002"],
    "rulebook": ["FMC_Rulebook_AIUse"]
  }
}
```

Paper millimetres are converted to API feet with the legend view's scale: `(mm × scale) / 304.8`.
