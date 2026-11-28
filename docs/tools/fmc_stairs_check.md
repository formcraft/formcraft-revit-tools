# fmc_stairs_check

Read-only stair, ramp and handrail compliance check. There is no dry run and no transaction: nothing is created, nothing is set, nothing is rolled back, no view is made and nothing is saved.

The add-in reads stairs (actual riser height and tread depth, runs, landings, associated railings), ramps (Maximum Incline, rise) and railings in the host and in loaded links. The server compares them with kit values in the standards bank (`FMC_Standards_Building.json`).

Every element gets a result row, and every check on it is one of:

| status | meaning |
|---|---|
| `pass` | measured is inside the required value and the number is a kit value with a clause |
| `fail` | measured is outside the required value (0.5 mm tolerance on lengths) |
| `not_applicable` | the tool cannot measure it, or the element has no such part. The `note` says why |
| `provisional` | measured is inside the number, but the number is a labelled default, or the measurement is approximate, so it cannot PASS |

Each check shows `measured`, `required` (and `required_max` for a range), the bank `key`, the `clause`, and whether the rule `can_pass`. The element status is fail if any check fails, otherwise provisional if any is provisional, otherwise pass. The overall `status` is FAIL, PROVISIONAL, PASS or NO_ELEMENTS.

## Checks and their bank keys

| check | applies to | bank key |
|---|---|---|
| `riser_height` (max) | stair | `stairs.riser_max` (uses by `use`) |
| `going` (min) | stair | `stairs.going_min` (uses by `use`) |
| `two_r_plus_g` (range) | stair | `stairs.two_r_plus_g_mm` **not in the bank: PROVISIONAL default 550 to 700 mm** |
| `run_width` (min, narrowest run) | stair by component | `stairs.width_min` (uses by `use`) |
| `risers_per_flight` (max, longest run) | stair by component | `stairs.risers_per_flight_max` (uses by `use`) |
| `landing_depth` (min of the landing's two sides, at least the stair width) | each landing | `stairs.landing_depth` |
| `handrail_count` | stair, ramp | `stairs.handrail_min_count` **not in the bank: PROVISIONAL default 1**; ramp: `accessibility.ramp` handrails "both sides" = 2 |
| `handrail_height` (range) | handrail on a stair or ramp, and each railing | `stairs.handrail_height` range (850 to 1000) |
| `guard_height` (min, railings hosted on a stair) | railing | `guards.stair_and_landing` |
| `headroom` | stair | `stairs.headroom`. **Not measured here:** `not_applicable`, run `fmc_headroom` |
| `ramp_gradient` (1:N, N at least) | ramp | `accessibility.ramp_gradient_max` |
| `ramp_rise` (max) | ramp | `accessibility.ramp` `rise_max_combined_mm` |
| `ramp_width` | ramp | `accessibility.ramp` `width_min_mm`. Revit stores no width on a sketched ramp: `not_applicable` |

`accessible: true` adds `riser_height_accessible` (`accessibility.stair` `riser_max_mm`), `landing_length_accessible` (`landing_length_min_mm`), both-sides handrails, and the `accessibility.handrail` height range.

A bank entry can pass when its status is empty, `draft` or `approved` and it has a `clause` or `note`. A `provisional` or `proposed` entry, or one with no text, cannot. A missing key uses the labelled default above (or no number at all), and cannot PASS. `overrides` set a number for one call; they do not make a missing key able to PASS. The reply lists every rule in `rules` and the ones that need confirming in `needs_confirmation`.

## What the numbers mean

- Riser and going are Revit's actual values for the stair. 2R+G is 2 x riser + going.
- A stair that is not by component has no runs or landings. Its run width, risers per flight and landings are `not_applicable`.
- A landing that is a four-line rectangle gives its two side lengths. Any other shape uses the bounding box and is marked `approximate`, so it cannot PASS.
- Ramp gradient is the ramp's Maximum Incline (1/x), the limit Revit enforces. Ramp rise is the bounding-box height less the thickness, so it is approximate and cannot PASS.
- Handrail height is the railing type's primary handrail height; guard height is its top rail height, both plus the instance height offset. Railings not hosted on a stair or ramp get `not_applicable` for the stair guard height, because the kit height depends on the use of the edge.
- A duplicate element id in one read is an error (`FMC-STAIRS-DUPLICATE`).

## Arguments

`document` is required; the active document is not a guess (`FMC-DOC-REQUIRED`). `kinds` is `stair`, `ramp`, `railing` (empty is all). `levels` limits by level name. `sources` is `host`, `link`, or both. `use` picks a use class from the bank's `uses` tables. `accessible` adds the accessible checks. `overrides` names: riser_max_mm, going_min_mm, two_r_plus_g_min_mm, two_r_plus_g_max_mm, width_min_mm, risers_per_flight_max, landing_depth_min_mm, stair_handrail_min_count, handrail_height_min_mm, handrail_height_max_mm, guard_height_min_mm, ramp_gradient_inv_min, ramp_rise_max_mm, ramp_handrail_min_count. `element_limit` caps the rows in the reply; the JSON file under `%LOCALAPPDATA%\Formcraft\stairs_check` always holds all of them.

```json
{
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "kinds": ["stair", "ramp"],
  "use": "residential",
  "accessible": false
}
```

Bank shape for the keys that are still missing:

```json
{
  "stairs.two_r_plus_g_mm": { "value": 550, "value_max": 700, "unit": "mm", "status": "provisional", "clause": "", "note": "Range for 2 x riser + going." },
  "stairs.handrail_min_count": { "value": 1, "unit": "count", "status": "provisional", "clause": "", "note": "Handrails or guards a stair must have." },
  "ramps.handrail_min_count": { "value": 1, "unit": "count", "status": "provisional", "clause": "", "note": "Handrails or guards a ramp must have." }
}
```