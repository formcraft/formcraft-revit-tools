# fmc_fam_template (FE-01)

Family templates (`.rft`). Project templates (`.rte`) stay with fmc_template.

- `list`: read-only list of the `.rft` files in `template_roots` and `family_template_dir`, with `formcraft: true` for the kit's own (named `FMC_*`).
- `audit`: read-only check of one template (in the template roots, exists, `.rft`, named `FMC_*`).
- `create`: opens a new family from `template` and applies `set_category`, `skeleton` (Width/Depth/Height planes with labelled dimensions, optional mounting) and kit shared parameters by name.

```json
{ "action": "create", "template": "Z:\\00_Standards\\06_Templates\\FMC_Furniture.rft", "category": "Furniture",
  "width": { "param": "Width", "mm": 600 }, "depth": { "param": "Depth", "mm": 400 }, "height": { "param": "Height", "mm": 750 },
  "shared_params": ["FMC_Mark"], "dry_run": true }
```

## Safety

- Dry run by default (`dry_run: true`): without `session` or `template` you get `planned_ops` only; with one, fmc_doc runs the batch and rolls it back.
- Only family documents: the ops run in an fmc_doc session (a background family opened from a `.rft` in the template roots or a staging `.rfa`).
- `save_path` (real run only) must be an `.rfa` inside `family_staging_root` that passes the fmc_doc save rules.
- An existing file is refused unless `overwrite: true`. Then the file, its `.000N` backups and its `.build.json` are moved to `_Archive\<yyyyMMdd-HHmmss>_<name>` (archivePlan, as in fmc_file archive) before fmc_doc save writes the new one. Nothing is deleted.
- Loading into a project still goes through the F134 family approval gate; these tools never load or bind.

