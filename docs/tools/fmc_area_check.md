# fmc_area_check: GFA, plot coverage, plot ratio, setbacks and parking against planning values

`fmc_area_check` computes and checks the area figures of a project model against planning values. It is read only: no
transaction, nothing is created or changed in the model, and nothing is written to disk.

## No planning number is built in

The tool holds **no** planning value. The limits come from a **planning-values file**, found in this order:

1. the `values_file` argument (a `.json` path);
2. the environment variable `FMC_PLANNING_VALUES_FILE`;
3. `FMC_Planning_Values.json` in the kit's master-data folder, next to `FMC_Standards_Building.json`.

A limit that is not in the file is reported as **`no limit configured`** (result `unknown`), never a default and never a
pass. A limit the file has but that you have not chosen is **`no limit selected`** (also `unknown`, with the candidate
rules listed). The computed value is still returned. If the file is absent, every limit is "no limit configured" and the
reply says where it looked (`planning_values.where_looked`) and which values are needed (`needed_values`,
`values_missing`). If a file is found and read but yields no usable entry, the reply says so and lists why
(`planning_values.problems`, and a note): that is a file problem, not "no limit configured".

### Where the repo was searched (cf71214)

The repo has **no** Uganda or KCCA numeric limit for plot coverage, plot ratio, setbacks or parking. It names the topics
(`scripts/project/review_checklists.json`: "Plot coverage and floor area ratio", "Setbacks and building lines",
"Parking", "KCCA development control", with no numbers) and the calculation method (`CA-Z-01`: coverage = footprint /
site area, plot ratio = GFA / site area, in `server/src/fmc/fixtures/calc_kit_tabs.json`). The only numbers nearby are the
generic proposals in `docs/kit-proposals/FMC_Standards_Building.json` (`site.boundary_setback` 3000 mm, "check the
planning permit"; parking bay 2500 x 5000 mm and aisle 6000 mm, which are dimensions, not requirements). That file is
a proposal with no approval status and no clause, so this tool does not use it as a limit.

### Values file schema (`fmc.planning_values/1`)

The entries live in a top-level `values` object **or** a top-level `keys` object (an alias; the file Standards Bot
produces uses `keys`). Every entry with a value is kept, whatever its key is called: the tool has no key whitelist.

```json
{
  "schema": "fmc.planning_values/1",
  "zone": "<optional: the zone these values are for>",
  "notice": "free text shown in every reply",
  "application_notes": ["copied into every reply, e.g. which rule applies where"],
  "keys": {
    "plot_coverage.max.<rule>": { "value": 0, "unit": "percent of plot area", "source": "<document>", "edition": "<edition>",
        "clause": "<clause>", "zone_or_use": "<where it applies>", "status": "approved",
        "legal_character": "binding_regulation | guideline | legacy_regulation", "quote": "<the words of the clause>" },
    "parking.<use>.<rule>": { "value": 0, "unit": "spaces per dwelling unit", "source": "...", "clause": "...", "status": "approved" }
  }
}
```

(The zeros are placeholders for the shape; none is a real value.) Optional `bank_key`, `basis` and notes are kept or
ignored. Non-numeric values (text, a range `[3, 5]`, a table) are kept and **shown as text, never judged**. A negative
number, an entry that is not an object, or one with no value is dropped and listed under `planning_values.problems`.
If the file has a `zone` and you pass a different `zone`, none of its values are used.

**Choosing the limit.** The tool never chooses between zones or uses. Pass `limits`, mapping each check
(`plot_coverage`, `plot_ratio`, `setback_front`, `setback_side`, `setback_rear`, `parking`) to the **exact key** in the file:

```json
"limits": { "plot_coverage": "plot_coverage.max.<rule>", "parking": "parking.<use>.<rule>" }
```

A check with no selection uses the legacy exact key if the file has one (`plot_coverage.max_pct`, `plot_ratio.max`,
`setback.front_min_m`, `setback.side_min_m`, `setback.rear_min_m`; for parking, `parking.<use>`). Otherwise it is
`no limit selected` and `evidence.candidates` lists each rule that could apply: `key`, `value`, `unit`, `zone_or_use`,
`legal_character`, `status`, `judges_when` (`yes`, `allow_draft` or `never`). Setback candidates are the keys under
`setback.front.`, `setback.side.` and `setback.rear.`, plot coverage under `plot_coverage.`, plot ratio under
`plot_ratio.`, and parking under `parking.<use>.` for the `use` you pass.

**Status rules (strict).**

| status | judges? |
|---|---|
| `approved`, with a source and a clause | yes |
| `draft`, with a source and a clause | **only** with `allow_draft: true`; the reason starts "DRAFT, not approved: indicative", the check has `indicative: true`, and the reply notes it |
| `unbanked` (not stored in the kit bank), `provisional`, blank or any other | never: `unknown`, with the reason |

The default for `allow_draft` is the constant `DEFAULT_ALLOW_DRAFT` in `server/src/fmc/areacheck.ts`, set to `false`. If
the practice prefers draft-with-clause judging, flip that one line to `true`; the tool reply shows the effective value
(`planning_values.allow_draft`) and the default (`allow_draft_default`). Passing `allow_draft` never selects a limit.

**What travels with a limit.** Each judged or listed limit carries `legal_character`, `zone_or_use`, `edition` and
`quote`, and the file's `application_notes` are copied into the reply. A `binding_regulation` limit says so; a
`guideline` is labelled "guideline (not statutory)" (for example the NPPSG 2011 ratios). A rule whose `zone_or_use` says it
applies "only in any area where no provision has been made under the Physical Planning Act" (the NBC 2019 30% coverage
cap) carries that caveat in the check's assumptions: the tool cannot know whether such a provision exists.

**Parking basis.** An explicit `basis` wins; otherwise it comes from the unit text: "per unit" / "per dwelling unit" is
`per_dwelling_unit` (needs `units` or the model's count), "spaces per plot" is `per_plot` (the value is the spaces required
for the plot). A unit that says neither is not judged ("does not say what the spaces are counted per"); neither is a
text rule such as "1 space per 40 square metres" (shown, not computed).

## Call

| field | |
|---|---|
| `document` | title or full path; omit for the active document (never opened in the background) |
| `area_scheme`, `source` | the area scheme for GFA (default: the only scheme, else "Gross Building"); `source` auto, areas, rooms or floors |
| `footprint_level`, `footprint_area_m2` | the level whose area is the footprint (default: the lowest level with data); or the area itself |
| `plot_area_m2`, `plot_area_name`, `property_line_ids` | the plot: an input, a named Area, else the Property Line(s) |
| `front_segments`, `side_segments`, `rear_segments` | property-line segment numbers (see `setback_overall`) |
| `use`, `units`, `parking_provided` | parking use, dwelling units, and spaces provided (default: Parking elements in the model) |
| `limits` | check name to the exact file key to judge against; without it the tool lists candidates and does not judge |
| `allow_draft` | `true` lets `draft` values judge, labelled "DRAFT, not approved: indicative" (default `DEFAULT_ALLOW_DRAFT`, `false`) |
| `zone`, `values_file` | see above |

## What it checks

| check | value | limit key |
|---|---|---|
| `gfa` | GFA m2 by level and total; says which source was used and why | none (it feeds the others) |
| `plot_area` | m2, from input, named area or property line | none |
| `plot_coverage` | footprint / plot area, % | `limits.plot_coverage`, else `plot_coverage.max_pct` (max) |
| `plot_ratio` | GFA / plot area | `limits.plot_ratio`, else `plot_ratio.max` (max) |
| `setback_front`, `setback_side`, `setback_rear` | the smallest distance, in m, from the footprint outline to those boundary segments | `limits.setback_<x>`, else `setback.<x>_min_m` (min) |
| `setback_overall` | the nearest boundary and the distance to every segment | none |
| `parking` | spaces provided (Parking-category elements, or `parking_provided`) | `limits.parking`, else `parking.<use>` (required, rounded up) |

GFA source order: **Areas** in the chosen scheme, then **Rooms** (net area: understates GFA), then **Floors** (any floor
element). The reply states the source used, why, and the totals of the others. Areas and rooms that are not placed or not
enclosed have no area and are listed as skipped.

Setbacks: segments are numbered `n` in the order the property-line curves were read. Pass `front_segments` (and
`side_segments`, `rear_segments`) from the first reply. Only when `front_segments` is a single segment of a four-sided,
straight-line plot are rear (the opposite side) and sides (the other two) **inferred**, and the check says so. Otherwise a
boundary that is not identified is `unknown`.

Each check returns `value`, `unit`, `limit` (value, unit, source, clause, status), `limit_status`
(`ok`, `no_limit_configured`, `no_limit_selected`, `not_usable`, `not_numeric`, `no_value`), `result` (`pass`, `fail`, `unknown`), `reason`, `evidence`
(element ids, the source used) and `assumptions`.

## Assumptions to know

- The footprint is the area on one level, not a roof or site plan; overhangs and covered balconies are not added.
- Distances are in plan, to the property-line curve; curved lines are measured as straight pieces.
- Plot area from a property line is the enclosed area in plan, not a titled or surveyed area.
- Every Parking element is one space.
- Design options and phases are not separated.
