# fmc_fam_annotation (FE-05)

Tag (`tag_category`, e.g. `Door Tags`), `annotation` (Generic Annotations), `title_block` (Title Blocks) and `detail_component` (Detail Items) families.

- `label_params` are checked against the kit dictionary. In annotation and title block families they are added as shared parameters; for tags they are listed only, because a tag reads the tagged element.
- `draw`: `detail_lines`, `filled_region`, `masking_region`, `text_note` (default view `annotation`, the family's drawing view) and `symbolic_lines`.
- `label_plan` says which label a person places where. The API cannot place labels.

Not built: keynote tags, repeating detail spacing (set in the project's repeating detail type).

## Safety

- Dry run by default (`dry_run: true`): without `session` or `template` you get `planned_ops` only; with one, fmc_doc runs the batch and rolls it back.
- Only family documents: the ops run in an fmc_doc session (a background family opened from a `.rft` in the template roots or a staging `.rfa`).
- `save_path` (real run only) must be an `.rfa` inside `family_staging_root` that passes the fmc_doc save rules.
- An existing file is refused unless `overwrite: true`. Then the file, its `.000N` backups and its `.build.json` are moved to `_Archive\<yyyyMMdd-HHmmss>_<name>` (archivePlan, as in fmc_file archive) before fmc_doc save writes the new one. Nothing is deleted.
- Loading into a project still goes through the F134 family approval gate; these tools never load or bind.

