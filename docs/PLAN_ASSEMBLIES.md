# Plan: Assemblies (F59: legends, patterns, curtain walls, railings, `fmc_assemblies`)

Tracker F59 ("Legends, patterns, curtain walls, railings", ref Canvas Fam_*). The Fam_* designs live in a Claude canvas that
isn't in the repo, the kit or D:\Fomcraft, so this builds the engine and the Revit side from what the tracker names and the
repo's conventions; the designs themselves come from the kit as `03_Master_Data\FMC_Assemblies.json` (a kit change request
until it exists) or from the call's `spec`. Nothing is defaulted: every name, size and base type is a design input.

## The designs (FMC_Assemblies.json)
```json
{
  "revision": "…",
  "patterns": [{ "name": "FMC_…", "target": "drafting | model", "grids": [{ "angle": 45, "spacing": 3, "shift": 0, "origin": [0, 0] }], "description": "…" }],
  "curtain_walls": [{ "name": "FMC_…", "base": "<curtain wall type in the template>",
    "vertical": { "layout": "none | fixed_distance | fixed_number | maximum_spacing | minimum_spacing", "spacing": 1500 },
    "horizontal": { "layout": "…", "spacing": 3000 }, "mullion": { "interior": "<type>", "border": "<type>" }, "panel": "<type>" }],
  "railings": [{ "name": "FMC_…", "base": "<railing type in the template>", "height": 1100, "top_rail": "<type>" }],
  "legend": { "view": "FMC_…", "columns": 2 }
}
```
Names start `FMC_`; spacings and heights are mm (drafting pattern spacing is paper mm). 1–6 grids per pattern, solid lines.

## The tool
| Action | Revit | What |
|---|---|---|
| check | no | the designs checked; their source and hash |
| pat | no | `.pat` files (mm, one per target) in `<project>\01_WIP\_Assemblies`, write roots only; dry run first, `confirm=true` to write; a changed file's old copy moves to `_Archive`; same designs, same bytes |
| read | read only | patterns (with grids), curtain wall types (grids, mullions, panel), mullion, panel, railing and top rail types, legend views (`fmc_assemblies_read`) |
| plan | read only | each design: create, update (changes listed), unchanged, or blocked (a base, mullion, panel or top rail type the model lacks; a kit request; nothing substituted) |
| apply | write | `fmc_assemblies_apply`: patterns made or changed; curtain wall and railing types duplicated from their base, or changed; one transaction, all or nothing. Dry run (default) through the read path and rolled back; real run needs `confirm=true` and goes through the lock (WRITE_COMMANDS) |
| legend | read only | the `fmc_legend` calls: `create_view` when the view is missing, then `place` with the curtain wall types as walls; railings and patterns are listed (fmc_legend places doors, windows, walls, floors, roofs and ceilings) |

Every reply has `run_id` (`AS-<date>T<time>-<6 hex>`, also in the file log rows) and `designs_hash`.

## Open
- The Fam_* canvas designs: not reachable here; the kit file is a kit change request.
- Not tried in live Revit: the read and apply commands compile against the R25 API; the parameter names used are
  SPACING_LAYOUT/LENGTH_VERT/HORIZ, AUTO_MULLION_INTERIOR/BORDER1/BORDER2_VERT/HORIZ, AUTO_PANEL_WALL, RailingType.TopRailHeight/TopRailType.
- Railing balusters and posts, curtain wall offsets and joins, dashed pattern lines and filled-region types for the legend are not covered.
- Not in the AI groups (AI mode refuses apply, like fmc_casework_place and pack: COMMAND_GROUPS has neither, and no test requires every write command there).
