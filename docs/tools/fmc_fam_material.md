# fmc_fam_material (B15)

Materials in a family, kit materials only (`07_Materials\FMC_Materials.json`), sent as one fmc_doc apply. `items`:

- `add_material` `{ name, param? }`: fmc_doc's own. It brings an FMC_ material in from the kit.
- `material_param` `{ name, solid, instance? }` (planner shorthand): adds a Material family parameter (group Materials) and ties the solid's Material to it with set_material_param.
- `material_set` `{ name, element_ids? | targets? | param?, material, detach? }`:
  - With `param`, the Material parameter is set to the material in every family type.
  - Otherwise each target solid's own Material is set. A solid whose Material follows a parameter is left alone (with a warning) unless `detach: true`.
- `material_paint` `{ name: <solid>/<face>, solid, face: top|bottom|left|right|front|back, material }`: paints the largest flat face pointing that way.
- `material_purge` `{ name, delete: false, keep? }`: lists materials nothing uses (solids, painted faces, subcategories, Material parameter values in any type). It deletes them only with `delete: true`.

Texture check: each texture of a kit material brought in must be inside the kit's materials folder (otherwise refused) and on disk (otherwise a warning, and the material is made without that map).

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
