# fmc_energy

Read-only envelope energy check. There is no dry run and no transaction: nothing is created, no parameter is written, nothing is rolled back and no energy analysis model is made.

The add-in reads the envelope of the named document:

- **Walls** whose type Function is Exterior (basic walls and stacked-wall members as `wall`, curtain walls as `curtain_wall`), with Revit's net area (openings cut) and the wall's outward orientation.
- **Roofs** (all), with area.
- **Floors**, with area and level. By default only floors on the lowest level that has floors are kept (`floor_scope: "lowest"`); `all` keeps every floor.
- **Windows and doors** hosted in those exterior walls (a window in a roof is a `skylight`), with nominal width x height and the host wall's direction. Windows and doors in interior walls are left out.

For each type: U-value from the type's Heat Transfer Coefficient (U), else its thermal properties, else 1 / Thermal Resistance (R); SHGC and visible light transmittance for glazing; and, for wall, floor and roof types, how many layers have a material without a thermal asset. A U of 0 or blank is **unknown**: it is never guessed, it is listed as `U_UNKNOWN`, and its area is left out of UA and the mean U. The project's angle to true north (ProjectPosition.Angle) turns directions to compass bearings.

The server (`server/src/fmc/energy.ts`, no Revit dependency) returns:

| Output | What it is |
| --- | --- |
| `types` | One line per class and type: elements, area m2, U W/m2K, R, SHGC, U x A W/K, element ids |
| `summary` | Per class (wall, glazing, door, roof, floor): area, area with known U, area-weighted mean U, UA; total UA (fabric heat loss coefficient, W/K) |
| `wwr` | Window-to-wall ratio overall and per orientation N (315-45), E, S, W: glazing / (net wall + glazing + doors) on vertical faces. Curtain walls count as glazing; windows in curtain walls are not added again; skylights are not in the ratio |

## Checks

Limits come from the call (`limits`), else the standards bank, else there is no limit and the check is `NO_LIMIT`. There are no built-in values.

| Check | Limit key | Code |
| --- | --- | --- |
| Wall U | `energy.max_u_wall_w_m2k` (`limits.wall`) | `U_ABOVE_MAX` |
| Roof U | `energy.max_u_roof_w_m2k` (`limits.roof`) | `U_ABOVE_MAX` |
| Ground floor U | `energy.max_u_floor_w_m2k` (`limits.floor`) | `U_ABOVE_MAX` |
| Window, skylight, curtain wall U | `energy.max_u_window_w_m2k` (`limits.window`) | `U_ABOVE_MAX` |
| Exterior door U | `energy.max_u_door_w_m2k` (`limits.door`) | `U_ABOVE_MAX` |
| Glazing SHGC | `energy.max_shgc` (`limits.shgc`) | `SHGC_ABOVE_MAX` |
| WWR overall and per orientation | `energy.max_wwr` (`limits.wwr`) | `WWR_ABOVE_MAX` |

A bank entry without a clause, or with another status than draft or approved, is provisional and cannot PASS. Status per check: `PASS`, `FAIL`, `PROVISIONAL`, `NO_LIMIT` (values known, no limit), `UNKNOWN` (the class is in the model but no type has a known value) or `NOT_APPLICABLE` (nothing of that class). Each failure has the type id and name, element ids, the value and the requirement. This is a fabric check only: no thermal bridging, ventilation, solar gains or energy simulation. The energy assessor signs off compliance.

The full JSON and a CSV of types are under `%LOCALAPPDATA%\Formcraft\energy`. There are no pictures.

```json
{
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0001_USER",
  "limits": { "wall": 0.35, "roof": 0.25, "window": 2.2, "shgc": 0.4, "wwr": 0.4 },
  "floor_scope": "lowest"
}
```

Not yet implemented (paused): analytical model report, gbXML export to project folder, gbXML check.
