# fmc_fam_2d (FE-03)

2D in a family. `items`:

- `masking_region` (Revit 2024+) and `filled_region` (`region_type` by name): `{ name, view: plan|front|right|annotation, points }`, a closed outline in the view's plane, mm.
- `detail_lines`: `{ name, view, points, closed, line_style }`.
- `symbolic_lines`: fmc_doc's own op (detail levels, views).

Not built: model_line, model_text, detail-level visibility on regions.

## Safety

- Dry run by default (`dry_run: true`): without `session` or `template` you get `planned_ops` only; with one, fmc_doc runs the batch and rolls it back.
- Only family documents: the ops run in an fmc_doc session (a background family opened from a `.rft` in the template roots or a staging `.rfa`).
- `save_path` (real run only) must be an `.rfa` inside `family_staging_root` that passes the fmc_doc save rules.
- An existing file is refused unless `overwrite: true`. Then the file, its `.000N` backups and its `.build.json` are moved to `_Archive\<yyyyMMdd-HHmmss>_<name>` (archivePlan, as in fmc_file archive) before fmc_doc save writes the new one. Nothing is deleted.
- Loading into a project still goes through the F134 family approval gate; these tools never load or bind.

