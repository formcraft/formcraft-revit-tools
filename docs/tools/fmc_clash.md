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
