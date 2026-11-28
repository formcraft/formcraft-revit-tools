# fmc_fam_category (B15)

A family's category and its parameters, sent as one fmc_doc apply. `category` (optional) becomes a first `category_set`. `items`:

- `category_set` `{ name, category?, subcategory?, element_ids? | targets? }`:
  - `category` sets the family category.
  - `subcategory` is made if it is new. With targets, those solids and lines move onto it.
- `category_flags` `{ name: family, cut_with_voids, can_host_rebar, ifc_export_as, ifc_predefined_type }`.
- `category_sub_rename` `{ name, to }`: Revit has no rename. So a new subcategory takes the old one's line weights, colour, pattern and material, every solid and line moves to it, and the old one is deleted.
- `category_sub_delete` `{ name, reassign_to? }`: a subcategory that solids or lines use is refused, with their names, unless `reassign_to` moves them first.
- `set_family_params` `{ name: family, work_plane_based, always_vertical, shared, room_calculation_point, part_type }`, `add_subcategory` `{ name, line_weight_projection, line_weight_cut, color, material }` (adds one, or updates an existing one's graphics) and `set_subcategory`: fmc_doc's own.

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
