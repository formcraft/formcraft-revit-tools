# fmc_fam_dim (B15)

Dimensions in a family, sent as one fmc_doc apply. `items`:

- `add_dimension` `{ name, between: [plane, plane], label }` and `add_eq_dimension` `{ name, planes }`: fmc_doc's own (linear, EQ).
- `dim_add_angular` `{ name, refs: [plane, plane], label?: Angle parameter, view?, radius?, side_a?, side_b? }`: the two planes must cross in the view. The arc is centred where they cross (radius 300 mm by default). side_a and side_b are 1 or -1 and pick which way each arm goes.
- `dim_add_radial` `{ name, ref, label?: Length parameter, view?, arc_index?, leader?, diameter? }`: `ref` is a named solid (a circular edge) or line set (an arc). `dim_add_diameter` is the same with `diameter: true` (a planner shorthand).
- `dim_unlock` `{ name, id | refs | label }`: unlocks the matching dimensions. The apply's detail lists the planes that then float (no other locked or labelled dimension holds them).

Each op answers create, update or skip, so a second run changes nothing.

Not built: arc-length, reporting dimensions, a constraint audit.

## Safety

- Dry run by default (`dry_run: true`): without `session` or `template` you get `planned_ops` only; with one, the tool sends one fmc_doc apply and fmc_doc rolls it back.
- Only family documents: the ops run in an fmc_doc session (a background family opened from a `.rft` in the template roots or a staging `.rfa`).
- `save_path` (real run only) must be an `.rfa` inside `family_staging_root` that passes the fmc_doc save rules.
- An existing file is refused unless `overwrite: true`. Then the file, its `.000N` backups and its `.build.json` are moved to `_Archive\<yyyyMMdd-HHmmss>_<name>` (archivePlan) before fmc_doc save writes the new one (fmc_doc save itself never overwrites).
- These tools never load into or bind in a project.
- Not run in Revit yet (B15, offline tests only).

## Where

- Op names: `B15` in `server/src/fmc/ops_b15.ts` and `FmcDocFamB15.Op` in `commandset/Services/Fmc/FmcDocFamB15.cs` (a test checks the two match). Renaming an op is one line on each side.
- Every op keeps `name` (its identity in the batch). What it acts on: `element_ids` (element ids in the family document) when given, else `targets` (op names), else its own `name`.
