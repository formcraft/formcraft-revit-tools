# fmc_fam_annotation (FE-05)

Tag (`tag_category`, e.g. `Door Tags`), `annotation` (Generic Annotations), `title_block` (Title Blocks), `detail_component` (Detail Items) and `keynote_tag` (Keynote Tags) families.

- `label_params` are checked against the kit dictionary. In annotation and title block families they are added as shared parameters; for tags they are listed only, because a tag reads the tagged element.
- `draw`: `detail_lines`, `filled_region`, `masking_region`, `text_note` (default view `annotation`, the family's drawing view) and `symbolic_lines`.
- `label_plan` says which label a person places where. The API cannot place labels.

- `keynote_tag`: category Keynote Tags. Labels are Revit's keynote parameters only (`Key Value`, `Keynote Text`, `Keynote Number`; default `Key Value`); the keynote table is the kit's and is set in the project.
- `repeating_detail` (detail_component only): `{ layout: fixed_distance|fixed_number|maximum_spacing|fill_available, spacing_mm, number, inside, rotation }`. Spacing belongs to the project's Repeating Detail type, not the family, so the tool returns `repeat_plan`: the type's values (REPEATING_DETAIL_ELEMENT, _LAYOUT, _SPACING, _NUMBER, _INSIDE, _ROTATION) for a person to set after the family is loaded through the F134 gate. Nothing is set in a project.

```json
{ "template": "C:\\ProgramData\\Autodesk\\RVT 2025\\Family Templates\\English\\Metric Detail Item.rft", "kind": "detail_component",
  "family_name": "FMC_D_Blocking_50x50", "repeating_detail": { "layout": "fixed_distance", "spacing_mm": 600 },
  "draw": [ { "op": "detail_lines", "name": "Block", "view": "plan", "points": [[0,0],[50,0],[50,50],[0,50]], "closed": true } ] }
```

Still a person step: placing labels. The tag category is checked by name (ends in Tags).

## Safety

- Dry run by default (`dry_run: true`): without `session` or `template` you get `planned_ops` only; with one, fmc_doc runs the batch and rolls it back.
- Only family documents: the ops run in an fmc_doc session (a background family opened from a `.rft` in the template roots or a staging `.rfa`).
- `save_path` (real run only) must be an `.rfa` inside `family_staging_root` that passes the fmc_doc save rules.
- An existing file is refused unless `overwrite: true`. Then the file, its `.000N` backups and its `.build.json` are moved to `_Archive\<yyyyMMdd-HHmmss>_<name>` (archivePlan, as in fmc_file archive) before fmc_doc save writes the new one. Nothing is deleted.
- Loading into a project still goes through the F134 family approval gate; these tools never load or bind.

