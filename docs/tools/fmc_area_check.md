# fmc_area_check: GFA, plot coverage, plot ratio, setbacks and parking against planning values

`fmc_area_check` computes and checks the area figures of a project model against planning values. It is read only: no
transaction, nothing is created or changed in the model, and nothing is written to disk.

## No planning number is built in

The tool holds **no** planning value. The limits come from a **planning-values file**, found in this order:

1. the `values_file` argument (a `.json` path);
2. the environment variable `FMC_PLANNING_VALUES_FILE`;
3. `FMC_Planning_Values.json` in the kit's master-data folder, next to `FMC_Standards_Building.json`.

A limit that is not in the file is reported as **`no limit configured`** (result `unknown`), never a default and never a
pass. The computed value is still returned. If the file is absent, every limit is "no limit configured" and the reply
says where it looked (`planning_values.where_looked`) and which values are needed (`needed_values`, `values_missing`).

### Where the repo was searched (cf71214)

The repo has **no** Uganda or KCCA numeric limit for plot coverage, plot ratio, setbacks or parking. It names the topics
(`scripts/project/review_checklists.json`: "Plot coverage and floor area ratio", "Setbacks and building lines",
"Parking", "KCCA development control", with no numbers) and the calculation method (`CA-Z-01`: coverage = footprint /
site area, plot ratio = GFA / site area, in `server/src/fmc/fixtures/calc_kit_tabs.json`). The only numbers nearby are the
generic proposals in `docs/kit-proposals/FMC_Standards_Building.json` (`site.boundary_setback` 3000 mm, "check the
planning permit"; parking bay 2500 x 5000 mm and aisle 6000 mm, which are dimensions, not requirements). That file is
a proposal with no approval status and no clause, so this tool does not use it as a limit.

### Values file schema (`fmc.planning_values/1`)

```json
{
  "schema": "fmc.planning_values/1",
  "jurisdiction": "Uganda",
  "authority": "KCCA",
  "zone": "<the zone these values are for>",
  "notice": "free text shown in every reply",
  "values": {
    "plot_coverage.max_pct": { "value": 0, "unit": "%",     "source": "<document>", "clause": "<clause>", "status": "approved" },
    "plot_ratio.max":        { "value": 0, "unit": "ratio", "source": "<document>", "clause": "<clause>", "status": "approved" },
    "setback.front_min_m":   { "value": 0, "unit": "m",     "source": "<document>", "clause": "<clause>", "status": "approved" },
    "setback.side_min_m":    { "value": 0, "unit": "m",     "source": "<document>", "clause": "<clause>", "status": "approved" },
    "setback.rear_min_m":    { "value": 0, "unit": "m",     "source": "<document>", "clause": "<clause>", "status": "approved" },
    "parking.<use>":         { "value": 0, "unit": "spaces", "basis": "per_dwelling_unit | per_100_m2_gfa | per_m2_gfa",
                               "source": "<document>", "clause": "<clause>", "status": "approved" }
  }
}
```

(The zeros are placeholders for the shape; none is a real value.) One `parking.<use>` key per use, for example
`parking.residential`. Unknown keys are listed under `planning_values.problems` and ignored.

**Status rules** (the same as the kit's standards bank): `approved` or `draft` with a **source and a clause** decides
pass or fail. `provisional`, a missing status, or a missing source or clause never passes or fails: the check is
`unknown` and says why. If the file has a `zone` and you pass a different `zone`, none of its values are used.

## Call

| field | |
|---|---|
| `document` | title or full path; omit for the active document (never opened in the background) |
| `area_scheme`, `source` | the area scheme for GFA (default: the only scheme, else "Gross Building"); `source` auto, areas, rooms or floors |
| `footprint_level`, `footprint_area_m2` | the level whose area is the footprint (default: the lowest level with data); or the area itself |
| `plot_area_m2`, `plot_area_name`, `property_line_ids` | the plot: an input, a named Area, else the Property Line(s) |
| `front_segments`, `side_segments`, `rear_segments` | property-line segment numbers (see `setback_overall`) |
| `use`, `units`, `parking_provided` | parking use, dwelling units, and spaces provided (default: Parking elements in the model) |
| `zone`, `values_file` | see above |

## What it checks

| check | value | limit key |
|---|---|---|
| `gfa` | GFA m2 by level and total; says which source was used and why | none (it feeds the others) |
| `plot_area` | m2, from input, named area or property line | none |
| `plot_coverage` | footprint / plot area, % | `plot_coverage.max_pct` (max) |
| `plot_ratio` | GFA / plot area | `plot_ratio.max` (max) |
| `setback_front`, `setback_side`, `setback_rear` | the smallest distance, in m, from the footprint outline to those boundary segments | `setback.<x>_min_m` (min) |
| `setback_overall` | the nearest boundary and the distance to every segment | none |
| `parking` | spaces provided (Parking-category elements, or `parking_provided`) | `parking.<use>` (required, rounded up) |

GFA source order: **Areas** in the chosen scheme, then **Rooms** (net area: understates GFA), then **Floors** (any floor
element). The reply states the source used, why, and the totals of the others. Areas and rooms that are not placed or not
enclosed have no area and are listed as skipped.

Setbacks: segments are numbered `n` in the order the property-line curves were read. Pass `front_segments` (and
`side_segments`, `rear_segments`) from the first reply. Only when `front_segments` is a single segment of a four-sided,
straight-line plot are rear (the opposite side) and sides (the other two) **inferred**, and the check says so. Otherwise a
boundary that is not identified is `unknown`.

Each check returns `value`, `unit`, `limit` (value, unit, source, clause, status), `limit_status`
(`ok`, `no_limit_configured`, `not_usable`, `no_value`), `result` (`pass`, `fail`, `unknown`), `reason`, `evidence`
(element ids, the source used) and `assumptions`.

## Assumptions to know

- The footprint is the area on one level, not a roof or site plan; overhangs and covered balconies are not added.
- Distances are in plan, to the property-line curve; curved lines are measured as straight pieces.
- Plot area from a property line is the enclosed area in plan, not a titled or surveyed area.
- Every Parking element is one space.
- Design options and phases are not separated.
