# fmc_electrical

Electrical enrich and sizing in the plugin (F79, plan step E3). Read-only: it never changes a model and writes no files.

Everything is a **draft for the engineer to check and sign**. The engineer's name is left empty. Formcraft never picks a demand factor, power factor, cable table, derating or voltage-drop limit (rule 5); a missing input makes the row TBC.

## Actions

- `kit_request`: the 16 `FMC_E_*` parameters FormCraft Electrical 0.1 writes that the kit lacks, as a kit change request with every value marked **assumed** (rule 7). Pass `shared_parameter_file` so parameters already in the kit are left out.
- `enrich`: `devices` (`id`, `va` or `watts` with `power_factor`, `phases`, `voltage_v`, `load_class`) become load parameters. Only parameters in the kit file are written; the rest come back as `skipped`.
- `size`: `circuits` plus `inputs` (`cable_table`, `breaker_ratings_a`, `vd_limit_percent`, `derating`, `demand_factor`) give a draft breaker, cable and voltage drop, or the TBC list.

`enrich` and `size` return a CSV (ElementId column plus one column per parameter) that `fmc_params` fill can apply after a person approves it. Writing into a model stays in `fmc_params` (dry run, plan hash, lease).

## Waiting on
The kit adding the 16 parameters (kit change request; names here are assumed). Design notes are in the F79 tracker row.