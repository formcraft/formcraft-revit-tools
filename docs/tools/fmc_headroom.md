# fmc_headroom

Read-only clear headroom. There is no dry run and no transaction: nothing is created, nothing is rolled back, and no view is made.

The scan covers stairs, corridors and rooms in the host and in loaded links. A corridor is a room whose name or department contains corridor, circulation, hallway, passage or concourse. Clear height is the distance from the walking surface up to the underside of a beam, duct, pipe or soffit (a ceiling, a floor whose underside is above the walking surface, or a generic model named soffit).

When a 3D view already exists, `ReferenceIntersector` casts upward. `FindReferencesInRevitLinks` is on when links are included. Without a 3D view the clearance is from bounding boxes, and the reply says so. A tall element that crosses the floor, such as a riser, is not treated as a soffit by the box method.

`min_clear_mm` is `headroom.min_clear_mm` in the standards bank. A missing key is the provisional 2100 mm and cannot PASS. A draft or approved entry with a clause can. `levels` limits the scan. `sources` is `host`, `link`, or both.

Pass `document`. The active document is not a guess. Each hit has the zone id, the obstacle id, a location in millimetres and `clear_mm`. The full JSON is under `%LOCALAPPDATA%\Formcraft\headroom`. There are no pictures.

A stair run is sampled along its box from the bottom to the top. That is not the nosing line. An unloaded link is listed and not scanned.

```json
{
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "levels": ["Level 1"],
  "sources": ["host", "link"]
}
```

Bank shape, when the key is still missing:

```json
{
  "headroom.min_clear_mm": {
    "value": 2100,
    "unit": "mm",
    "status": "provisional",
    "clause": "",
    "note": "Minimum clear headroom over stairs, corridors and rooms."
  }
}
```

## Status values

- `PASS` / `FAIL`: zones were scanned against an approved or draft bank entry with a clause.
- `PROVISIONAL`: the bank has no usable `headroom.min_clear_mm`, or the call's `min_clear_mm` is below the bank value (`min_clear.below_bank: true`, a what-if). It cannot PASS.
- `NOT_CHECKED` (`[FMC-HEADROOM-NO-ZONES]`): no stair, corridor or room was found, so nothing was measured. `zone_kinds_found` counts the zones by kind.