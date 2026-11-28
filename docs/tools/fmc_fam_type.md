# fmc_fam_type

Family types in an fmc_doc session. A thin wrapper over the fmc_doc ops in [fmc_fam_ops.md](fmc_fam_ops.md).

| action | fields | op |
|---|---|---|
| list | – | `fmc_doc report` types |
| rename | name, new_name | `type_rename` |
| flex_matrix | params, ranges {low, high, steps 2-6}, types? | `type_flex_matrix` (a read: always rolled back, never saved) |
| delete | name | `type_delete` (**a person approves**; never the last type) |

flex_matrix answers `matrix.types[].runs[]` (param, value, ok, errors), `ok` and `failing` lines such as
`600x2100: Width = 1200 (Constraints are not satisfied)`. Parameters driven by a formula or reporting are listed as skipped. It stops
after 240 s and says so. Length values are mm, Angle degrees.
