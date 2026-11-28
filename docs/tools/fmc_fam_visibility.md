# fmc_fam_visibility (B15)

Visibility of a family's elements, sent as one fmc_doc apply. `items`:

- `vis_set` `{ name, element_ids? | targets?, detail_levels?, views?, only_when_cut?, param? }`: works on any solid, model or symbolic line set, or model text.
  - `detail_levels` lists the levels it shows in (coarse, medium, fine); the others go off. A `tier` (all, coarse, coarse_medium, medium_fine, fine) can be given instead.
  - `views` lists plan_rcp, front_back and left_right (model elements only).
  - `param` ties Visible to a Yes/No parameter.
  - On symbolic lines only the detail levels apply, and a warning says so.
- `set_visibility` (solids) and `set_visible_param`: fmc_doc's own.
- `vis_matrix` (read-only, answers skip): every element's levels and views, and a warning with the fix for any detail level nothing shows in. The tool adds one at the end unless `matrix: false`.

The planner also warns when every element the batch sets is off at a detail level.

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
