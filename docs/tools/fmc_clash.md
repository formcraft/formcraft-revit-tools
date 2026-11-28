# fmc_clash

Read-only. Category pairs are walked in chunks. Only element ids are kept for the whole category. Bounding boxes exist for the two live chunks. An exact solid intersection runs only for a box hit, and only when `exact` is true. Hits are appended to a JSONL file under `%LOCALAPPDATA%\Formcraft\clash`. The reply includes the peak working set of the Revit process when it can be read.

```json
{
  "action": "scan",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "pairs": [
    { "a": "OST_Walls", "b": "OST_DuctCurves" },
    { "a": "OST_Walls", "b": "OST_PipeCurves" }
  ],
  "chunk": 250,
  "tolerance_mm": 0,
  "exact": false,
  "include_links": true,
  "max_hits": 5000
}
```

A category name that is not a built-in category is `FMC-CLASH-CATEGORY` and that pair is skipped. No pictures.

An empty `pairs` list uses the default set. That set includes the usual walls, floors, structure, pipes, ducts, conduit and cable tray, and also `OST_PlumbingEquipment`, `OST_Site`, `OST_GenericModel` and `OST_SpecialityEquipment`. This holds for a scan against a cache too; the reply says `pairs_default: true`.

Report names carry a short document tag and milliseconds (`clash-<doc>-YYYYMMDD-HHMMSS-fff.jsonl`, UTC), with `-2`, `-3` added if a name is still taken, so two scans in the same second no longer share a file. `max_hits_per_pair` stops one pair after that many hits and moves on, and the reply has `pairs_done` of `pairs_total` and `capped_pairs`. `id_docs` gives each sampled id with its document (`host`, a link title, or `cache`). All lengths are millimetres (`units: "mm"`).

`read_report` returns a page of a JSONL report: `report` (default the newest `clash-*.jsonl` in the local clash folder), `offset`, `limit` (up to 500), and optional `group_by` (`element`, `pair` or `status`) counts for that page. Only `.jsonl` files in the local clash folder or the temp folder are read.

Every hit has `status`: `hard`, `cleared_by_opening`, `join`, `hosted` or `clearance`. A wall or floor hit whose overlap sits inside an opening (a door, window, or other hosted void) is `cleared_by_opening`. Elements joined by an MEP connector are `join`. A device whose host is the clashing wall is `hosted`. `centreline: true` tests a pipe, duct, conduit or tray centreline plus its radius or half-width; a box-only touch is `clearance`.

`plugin_readonly/export_bboxes.cs` and `export_openings.cs` are not in this repo. `source: "import:<file>"` reads this millimetre schema and converts it to the cache. Those coordinates are already millimetres and are not scaled. Boxes collected live in Revit are internal feet and are multiplied by 304.8.

```json
{
  "doc": "F26901-FMC-ZZ-ZZ-M3-S-0001",
  "captured_at": "2026-11-22T12:00:00Z",
  "elements": [
    { "id": 10, "category": "OST_StructuralColumns", "bbox_mm": { "min": [0, 0, 0], "max": [400, 400, 3000] } }
  ],
  "openings": [
    { "id": 11, "host_id": 10, "bbox_mm": { "min": [100, 0, 0], "max": [300, 200, 2100] } }
  ]
}
```

Sleeves near a hit:

```json
{
  "action": "sleeves",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "hit_a": 100,
  "hit_b": 200,
  "radius_mm": 300
}
```

The structural model does not have to be open. `link` is a `RevitLinkInstance` in the host. Its boxes are transformed by `GetTotalTransform`, using all eight corners. If that link is unloaded, the reply is `FMC-LINK-NOT-LOADED` and nothing is scanned.

Host `A-0002_USER` against link `S`:

```json
{
  "action": "scan",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "link": "S",
  "pairs": [
    { "a": "OST_Walls", "b": "OST_StructuralColumns" },
    { "a": "OST_Floors", "b": "OST_StructuralFraming" }
  ],
  "chunk": 250,
  "include_links": true
}
```

When `S` is not linked either, export a cache from the structural model while it is open. This does not save the model and does not write on `D:`.

```json
{
  "action": "export_cache",
  "document": "F26901-FMC-ZZ-ZZ-M3-S-0001_USER",
  "categories": ["OST_StructuralColumns", "OST_StructuralFraming", "OST_StructuralFoundation"],
  "meshes": true,
  "mesh_cap": 24
}
```

Host `P-0001_USER` against that cache. The reply includes the cache age and `STALE` when the source file is newer than the cache.

```json
{
  "action": "scan",
  "document": "F26901-FMC-ZZ-ZZ-M3-P-0001_USER",
  "source": "cache:F26901-FMC-ZZ-ZZ-M3-S-0001",
  "pairs": [
    { "a": "OST_PipeCurves", "b": "OST_StructuralFraming" }
  ],
  "chunk": 250
}
```
