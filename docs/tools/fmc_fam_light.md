# fmc_fam_light (FE-04)

The light source of a lighting family, ported from `docs/handoff/kisic_gap_scripts/revit/16_family_light_source.cs`. It sets `Lighting Fixtures` (unless `ensure_category: false`), turns Light Source on, remakes family types when light types are missing, and sets `shape`, `distribution`, `lumens` or `lumens_by_type`, `kelvin`, `beam_deg`/`field_deg` (spot) and `source_z_mm`. Only differences are changed.

```json
{ "session": "S1", "distribution": "spot", "lumens_by_type": { "600": 1200, "1200": 2400 }, "kelvin": 4000, "beam_deg": 40, "field_deg": 60 }
```

The LightFamily API path is not yet checked in Revit.

## Safety

- Dry run by default (`dry_run: true`): without `session` or `template` you get `planned_ops` only; with one, fmc_doc runs the batch and rolls it back.
- Only family documents: the ops run in an fmc_doc session (a background family opened from a `.rft` in the template roots or a staging `.rfa`).
- `save_path` (real run only) must be an `.rfa` inside `family_staging_root` that passes the fmc_doc save rules.
- An existing file is refused unless `overwrite: true`. Then the file, its `.000N` backups and its `.build.json` are moved to `_Archive\<yyyyMMdd-HHmmss>_<name>` (archivePlan, as in fmc_file archive) before fmc_doc save writes the new one. Nothing is deleted.
- Loading into a project still goes through the F134 family approval gate; these tools never load or bind.

