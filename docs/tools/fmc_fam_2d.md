# fmc_fam_2d (FE-03)

2D in a family. `items`:

- `masking_region` (Revit 2024+) and `filled_region` (`region_type` by name): `{ name, view: plan|front|right|annotation, points }`, a closed outline in the view's plane, mm.
- `detail_lines`: `{ name, view, points, closed, line_style }`.
- `symbolic_lines`: fmc_doc's own op (`coarse`, `medium`, `fine`; the view is its plane).
- `model_lines`: `{ name, plane: plan|front|right, at, points, closed, subcategory }`, model curves on a sketch plane.
- `model_text`: `{ name, text, plane, at, point, depth_mm, align, type_name, subcategory }` (3D families only).
- `model_lines` and `model_text` take `coarse`, `medium`, `fine`, `plan_rcp`, `front_back` and `left_right` (FamilyElementVisibility, Model). At least one detail level stays on.
- `add_subcategory`: line subcategories, checked against FAM-044 (black or dark grey, the rule's pens) like fmc_doc apply.

Visibility flags on `filled_region`, `masking_region` and `detail_lines` are refused: they show only in their own view, and the Revit API has no detail-level setting for them.

```json
{ "session": "S1", "items": [
  { "op": "add_subcategory", "name": "Plan Outline", "line_weight_projection": 3 },
  { "op": "model_lines", "name": "Plan outline", "plane": "plan", "points": [[0,0],[600,0],[600,400],[0,400]], "closed": true, "subcategory": "Plan Outline", "fine": false },
  { "op": "masking_region", "name": "Mask", "view": "plan", "points": [[0,0],[600,0],[600,400],[0,400]] },
  { "op": "model_text", "name": "Badge", "text": "FMC", "plane": "front", "point": [50, 300], "depth_mm": 3, "coarse": false } ] }
```

## Safety

- Dry run by default (`dry_run: true`): without `session` or `template` you get `planned_ops` only; with one, fmc_doc runs the batch and rolls it back.
- Only family documents: the ops run in an fmc_doc session (a background family opened from a `.rft` in the template roots or a staging `.rfa`).
- `save_path` (real run only) must be an `.rfa` inside `family_staging_root` that passes the fmc_doc save rules.
- An existing file is refused unless `overwrite: true`. Then the file, its `.000N` backups and its `.build.json` are moved to `_Archive\<yyyyMMdd-HHmmss>_<name>` (archivePlan, as in fmc_file archive) before fmc_doc save writes the new one. Nothing is deleted.
- Loading into a project still goes through the F134 family approval gate; these tools never load or bind.

