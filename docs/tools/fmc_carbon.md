# fmc_carbon (GAP-24)

Read-only embodied carbon by material and by assembly (category and type) for Revit 2025. Nothing in the model changes.

**Quantities.** The command set reads `Element.GetMaterialIds(false)`, `GetMaterialVolume` and `GetMaterialArea` for walls, floors, roofs, ceilings, columns, framing, foundations, stairs, railings, ramps, doors, windows, curtain panels and mullions, and generic models (or the `categories` you pass). Volumes are in m³. Rebar, MEP and elements with no material volume are not counted; the reply lists the elements with no volume by category under `unmeasured`.

**Factors.** Revit 2025 has no embodied-carbon API (`EmbodiedCarbonAsset` arrives in 2027). Factors come from the kit file `07_Materials/FMC_CarbonFactors.json`, beside `FMC_Materials.json`, or a file passed as `factors`. **No factor is built into the tool and none is invented.** Family Kit Loader is the co-owner who supplies and approves the factor file.

```json
{
  "status": "draft | approved",
  "source": "what the set is based on, with version",
  "date": "YYYY-MM-DD",
  "factors": [
    { "material": "<kit material name>", "kgco2e_per_m3": "<number>", "stage": "A1-A3", "source": "<EPD or database and version>", "status": "draft | approved" },
    { "material": "<material class>", "match": "class", "kgco2e_per_kg": "<number>", "density_kg_m3": "<number, optional>", "source": "...", "status": "..." }
  ]
}
```

A factor needs exactly one positive `kgco2e_per_m3` or `kgco2e_per_kg`, and a `source`; anything else is listed under `factors.problems` and not used. A per-kg factor uses its own `density_kg_m3`, or the kit material's `physical.density_kg_m3`; with neither, the material is unfactored. A name match wins over a class match.

**Status.**

| Status | Meaning |
| --- | --- |
| `NO_FACTORS` | No factor file, or no usable factor. Totals are null. |
| `PARTIAL` | Some materials with volume have no factor (listed under `unfactored`). |
| `PROVISIONAL` | Every material is factored, but the file or a factor is not `approved`. |
| `COMPLETE` | Every material is factored from an approved file with approved factors. Only this can pass. |

```json
{ "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER" }
```

Needs: the kit factor file from Family Kit Loader, and a live Revit 2025 check of the volumes.
