# fmc_fam_light (FE-04)

The light source of a lighting family, ported from `docs/handoff/kisic_gap_scripts/revit/16_family_light_source.cs`. It sets `Lighting Fixtures` (unless `ensure_category: false`), turns Light Source on, remakes family types when light types are missing, and sets `shape`, `distribution`, `lumens` or `lumens_by_type`, `kelvin`, `beam_deg`/`field_deg` (spot) and `source_z_mm`. Only differences are changed.

```json
{ "session": "S1", "distribution": "spot", "lumens_by_type": { "600": 1200, "1200": 2400 }, "kelvin": 4000, "beam_deg": 40, "field_deg": 60 }
```

`kelvin` is 1800 to 20000 (Revit's `CustomInitialColor` range). A spot without angles gets 60° beam and 90° field, written into `planned_ops`.

API check (builder16, 28 Nov 2026, against the Revit 2025 reference `RevitAPI.xml`/`RevitAPI.dll` in `nice3point.revit.api.revitapi` 2025.4.0): `LightFamily.GetLightFamily`, `Get/SetLightShapeStyle`, `Get/SetLightDistributionStyle`, `GetNumberOfLightTypes`, `GetLightType(int)`, `GetLightTypeName(int)`, `LightType.Get/SetInitialIntensity`, `Get/SetInitialColor`, `Get/SetLightDistribution`, `InitialFluxIntensity.Flux`, `CustomInitialColor.Temperature` (the op used `TemperatureValue`; changed to the documented `Temperature`), `SpotLightDistribution.SpotBeamAngle/SpotFieldAngle` and `BuiltInCategory.OST_LightingFixtureSource` are all there. Not yet run in Revit: the Light Source switch by its English name, the family type rebuild, and moving the source element for `source_z_mm`.

## Safety

- Dry run by default (`dry_run: true`): without `session` or `template` you get `planned_ops` only; with one, fmc_doc runs the batch and rolls it back.
- Only family documents: the ops run in an fmc_doc session (a background family opened from a `.rft` in the template roots or a staging `.rfa`).
- `save_path` (real run only) must be an `.rfa` inside `family_staging_root` that passes the fmc_doc save rules.
- An existing file is refused unless `overwrite: true`. Then the file, its `.000N` backups and its `.build.json` are moved to `_Archive\<yyyyMMdd-HHmmss>_<name>` (archivePlan, as in fmc_file archive) before fmc_doc save writes the new one. Nothing is deleted.
- Loading into a project still goes through the F134 family approval gate; these tools never load or bind.

