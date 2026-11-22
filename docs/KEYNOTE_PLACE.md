# Keynote placement (`fmc_keynote_place`)

`keynote_clone` copies one linked tag, and the copy stays in the seed's view. The API cannot create the keynote tag-to-keynote link. A tag made with `IndependentTag.Create` keeps an empty TagText. That result is `FMC-NO-API-KEYNOTE-LINK`, and nothing blank is kept.

`fmc_keynote_place` finds a seed without a person in the view. It searches every view for a linked keynote tag of the requested type (`by` is `element`, `material` or `user`). If none exists, it opens the kit seed model `02_Keynotes\Seeds\FMC_Keynote_Seed.rvt` (one placed keynote tag per type) and copies that tag with `CopyElements`. The seed is then copied into every target plan with the view-to-view `CopyElements` overload, and each copy's host reference is replaced with `RemoveReferences` and `AddReferences`. A copy that does not keep TagText is rolled back.

`dry_run` defaults to true. A real write is `fmc_keynote_place_apply`, one transaction, one subtransaction per host. It needs `batch_lease` plus `references.kit`, `references.standards` and `references.rulebook`. The active document is never a guess. A central model, a protected path, and HEBERT HOSTELS are refused. The full JSON is under `%LOCALAPPDATA%\Formcraft\keynote`. There are no pictures.

With `categories` omitted, the read looks at walls, doors, windows, floors, ceilings and rooms.

## Place element keynotes on every plan

```json
{
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "views": "all_plans",
  "categories": ["Walls", "Doors"],
  "by": "element",
  "dry_run": true
}
```

`views` may be a list of plan names instead of `all_plans`. A view that is not a plan is `FMC-KEYNOTE-VIEW`. A plan with nothing to tag is `FMC-KEYNOTE-NO-HOST`. A host that already has a linked tag of this type is skipped.

Applying the same plan:

```json
{
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "views": "all_plans",
  "categories": ["Walls", "Doors"],
  "by": "element",
  "dry_run": false,
  "batch_lease": "lease-from-fmc_batch",
  "references": {
    "kit": ["FMC-BIM-MAN-001"],
    "standards": ["FMC-BIM-STD-002"],
    "rulebook": ["FMC_Rulebook_AIUse"]
  }
}
```

## API limits

- `IndependentTag.Create` does not link a keynote. TagText and Keynote Text stay empty. Key Source cannot be set. The code is `FMC-NO-API-KEYNOTE-LINK`.
- View-to-view `CopyElements` keeps the link only when the seed was already linked. A refused copy is `FMC-KEYNOTE-COPY-REFUSED`.
- `AddReferences` may refuse a material keynote, because a material tag wants a face reference. That host is `FMC-KEYNOTE-RETARGET-REFUSED`.
- The kit file has to be a real Revit model with one linked tag of each type. A missing file is `FMC-KEYNOTE-SEED-MISSING`. A file that will not open, or that has no linked tag of this type, is `FMC-KEYNOTE-SEED-LOAD`.
- Copying a view-specific tag between documents is not the view overload. The document overload is tried. If Revit refuses it, the code is `FMC-KEYNOTE-COPY-REFUSED` and nothing is kept.
- The seed model is closed without saving. The project is not saved or synchronised.
