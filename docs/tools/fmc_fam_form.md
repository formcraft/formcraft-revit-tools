# fmc_fam_form (FE-02)

Forms through fmc_doc ops. `forms` takes `extrusion`, `void_extrusion`, `sweep`, `void_sweep`, `revolution`, `blend` and `array` (fmc_doc's own arguments), plus:

- `swept_blend` / `void_swept_blend` (new fmc_doc ops): `path` `[[x,y,z],[x,y,z]]` mm, `bottom` and `top` closed profiles `[u, v]` mm square to the path, optional `subcategory`.
- `loft`: `{ name, sections: [{ z, outline }], subcategory }`, drawn as one `blend` per pair of sections (`<name> 1`, `<name> 2`, ...).

```json
{ "session": "S1", "forms": [
  { "op": "loft", "name": "Shade", "sections": [{ "z": 0, "outline": [[0,0],[300,0],[300,300],[0,300]] }, { "z": 200, "outline": [[50,50],[250,50],[250,250],[50,250]] }] },
  { "op": "swept_blend", "name": "Neck", "path": [[150,150,200],[150,150,400]], "bottom": [[-20,-20],[20,-20],[20,20],[-20,20]], "top": [[-10,-10],[10,-10],[10,10],[-10,10]] } ] }
```

Not built: edit_profile, edit_path, set_depth, align_to_plane, cut/uncut, array_radial, delete, void loft.

## Safety

- Dry run by default (`dry_run: true`): without `session` or `template` you get `planned_ops` only; with one, fmc_doc runs the batch and rolls it back.
- Only family documents: the ops run in an fmc_doc session (a background family opened from a `.rft` in the template roots or a staging `.rfa`).
- `save_path` (real run only) must be an `.rfa` inside `family_staging_root` that passes the fmc_doc save rules.
- An existing file is refused unless `overwrite: true`. Then the file, its `.000N` backups and its `.build.json` are moved to `_Archive\<yyyyMMdd-HHmmss>_<name>` (archivePlan, as in fmc_file archive) before fmc_doc save writes the new one. Nothing is deleted.
- Loading into a project still goes through the F134 family approval gate; these tools never load or bind.

