# fmc_rebar_schedule

Read-only BS 8666 bar bending schedule. There is no dry run and no transaction: nothing is created, no parameter is written and nothing is rolled back.

The add-in reads every Rebar set (and the bars of area and path reinforcement) in the named document: bar mark (`Schedule Mark`, `Bar Mark`, `Rebar Number`, else `Mark`), bar type, diameter, quantity, Revit's bar length, the shape name, the shape dimensions A to F and R, the layout rule and spacing, the host with its cover settings (top, bottom, other) and bounding box, and the extents of every bar centre line in the set.

The server (`server/src/fmc/rebar.ts`, no Revit dependency) builds the schedule:

| Column | From |
| --- | --- |
| Member | Host category, mark and type, e.g. `Structural Framing B1 (RC 300x600)` |
| Bar mark | The bar's schedule mark |
| Type and size | BS 8666 letter (from the bar type name, else `grade_letter`, default `H`) and diameter, e.g. `H12` |
| No. of mbrs, No. of bars in each, Total no. | Sets with the same member, mark, size, shape, dimensions and length are merged |
| Length of each bar | BS 8666:2020 Table 3 shape-code formula when the code and its dimensions are known, else Revit's bar length; rounded up to `round_mm` (25) |
| Shape code, A, B, C, D, E/R | The shape name read as a two-digit code (`M_21`, `21`, `Shape 21`); anything else is 99 |
| Mass | Total number x length x BS 8666 Table 1 unit mass |

When the shape formula and Revit's bar length differ by more than 25 mm the line carries a note. Mass totals are per bar size and overall.

## Checks

- **Cover**: each host cover setting against `min_cover_mm` (the call, else `rebar.min_cover_mm` in the standards bank); and measured cover per face (top, bottom, sides) from the bar centre lines and the host box, less half the bar, against the larger of the host setting and the minimum, with 2 mm tolerance. The measured cover is exact for hosts square to the project axes. A bar that leaves the host (a starter or lap) is not checked on that face.
- **Spacing**: clear spacing (centres less bar size) against max(bar size, aggregate + 5 mm, 20 mm). `aggregate_mm` comes from the call, else `rebar.max_aggregate_mm`; a missing key is a provisional 20 mm and the spacing check cannot PASS.
- **Marks**: one mark used for different sizes, shapes or lengths.

Each failure has the check, a code (`COVER_SETTING_BELOW_MIN`, `COVER_MEASURED_BELOW`, `SPACING_BELOW_MIN`, `MARK_CONFLICT`), the rebar and host ids, the value and the requirement. Checks are reported, not decided: the structural engineer signs off cover and spacing.

The full JSON and a CSV schedule are under `%LOCALAPPDATA%\Formcraft\rebar`. There are no pictures.

```json
{
  "document": "F26901-FMC-ZZ-ZZ-M3-S-0001_USER",
  "host_ids": [],
  "min_cover_mm": 40,
  "aggregate_mm": 20
}
```
