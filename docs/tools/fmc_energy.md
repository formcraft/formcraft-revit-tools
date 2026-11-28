# fmc_energy

Energy tool for manifest item GAP-23 (energy analytical model, gbXML export and check). Four modes:

| Mode | What it does | Writes |
| --- | --- | --- |
| `envelope` (default) | Envelope U-values, UA and window-to-wall ratio check (below) | Nothing in the model; JSON and CSV report under `%LOCALAPPDATA%\Formcraft\energy` |
| `analytical` | Energy settings and the energy analytical model report | Nothing in the model; JSON report |
| `export` | gbXML file beside the open .rvt | One new `.xml` in the model's folder (`fmc_energy_export`, a model-changing command) |
| `check` | Offline gbXML check of a file in the project folder | Nothing in the model; JSON report |

## Envelope mode

Read-only. There is no dry run and no transaction: nothing is created, no parameter is written, nothing is rolled back and no energy analysis model is made.

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

## Analytical mode

Read-only, no transaction. The energy analytical model is read when it exists and is never created here.

- **Energy settings** (`EnergyDataSettings`, read by property name so a property a Revit version lacks is left out): analysis type (mode), building type, service type, construction class, export category and complexity, ground plane (with `ground_plane_missing`), project phase, resolutions and glazing defaults.
- **Location**: place, latitude, longitude, time zone, elevation; the angle to true north and the shared position; the project base point and survey point (internal and shared, mm).
- **Rooms and spaces**: placed, placed area m2, not placed, placed but not enclosed (area 0), and no level, with up to 20 ids each.
- **Energy analytical model** (`EnergyAnalysisDetailModel.GetMainEnergyAnalysisDetailModel`): whether it exists, and when it does the counts of spaces, zones (when the API has them), surfaces by type, openings and shading surfaces; surfaces with no analytical space; interior surfaces (interior wall, ceiling, interior floor, air) with no space on the other side.
- **Warnings**: Revit warnings about rooms, spaces, boundaries, levels or the energy model, counted, with the 15 most common texts.

The server turns this into findings: `ROOM_NOT_PLACED`, `ROOM_UNBOUNDED`, `ROOM_NO_LEVEL`, the same for spaces, `GROUND_PLANE_MISSING`, `NO_LEVELS`, `NO_SPATIAL_ELEMENTS` (the analysis uses rooms or spaces and none are placed), `SURFACE_NO_SPACE`, `SURFACE_NO_ADJACENT_SPACE`, `MODEL_NO_SPACES` and `REVIT_WARNINGS`. Status is `OK`, `WARN` or `NO_MODEL`.

## Export mode

Writes one gbXML file with `Document.Export(folder, name, GBXMLExportOptions)`. It goes **only** into the folder that holds the open .rvt (the directory of `Document.PathName`):

- The name is `<model>_gbXML_<yyyyMMdd-HHmm>.xml`, or `file_name` sanitised (letters, digits, `.`, `-`, `_`; separators, drive colons and `..` cannot survive). A default name that exists gets `-2` to `-20`; a given name that exists is refused (`FMC-ENERGY-EXISTS`). No file is ever overwritten, and the .rvt is never the target.
- Refused: a document never saved (`FMC-ENERGY-UNSAVED`), a cloud or Revit Server model (`FMC-ENERGY-CLOUD`), a family or other non-.rvt (`FMC-ENERGY-NOT-PROJECT`), a resolved path that is not directly in the model's folder (`FMC-ENERGY-OUTSIDE`), a folder the guard does not allow writing in, such as a CDE gate folder or one outside `write_roots` (`FMC-ENERGY-WRITE-REFUSED`), and an open transaction (`FMC-DOC-BUSY`). The server plans the name and checks these rules; the add-in checks them again against Revit's own path.
- `dry_run` defaults to true: it plans the file and checks the rules, and exports nothing.
- The model is **never saved, synced or relinquished**. The export is tried with no transaction. Only if Revit refuses it outside a transaction is it run again inside a transaction group (creating the energy analytical model first when there is none, with spaces), and the group is always rolled back. The reply says which (`transaction_used`: `none` or `group_rolled_back`), whether a model was made for the export, and whether the document shows as modified afterwards.
- `model_type`: `default` (Revit's setting), `spaces` or `building_elements`.
- `check_after` (default true) runs the gbXML check on the new file.

Policy: `fmc_energy` stays in `READ_VIA_SEND_COMMAND`. The export is a separate add-in command, `fmc_energy_export`, in `WRITE_COMMANDS`, because it writes a file and may open a transaction group. So the live-model lock, batch lease and memory gate apply to it like any other model-changing command: on a live project model the export is refused, and a person exports from Revit.

## Check mode

Offline (`server/src/fmc/gbxml.ts`, no Revit). `file` is a name or path that must resolve inside the project folder (subfolders allowed) and end in `.xml`; anything else is `FMC-ENERGY-CHECK-PATH`.

- Counts: Campus, Building, Space, Zone, Surface, Opening, Construction, WindowType; surfaces by type; the file's length and area units.
- Findings: `SURFACE_NO_ADJACENT_SPACE` (not shading), `ADJACENT_SPACE_MISSING` (a ref to a Space not in the file), `SURFACE_ZERO_AREA`, `OPENING_ZERO_AREA` (from the PolyLoop, else the rectangle), `CONSTRUCTION_REF_MISSING` and `CONSTRUCTION_NOT_DEFINED` (not shading or air).
- Status: `PASS`, `FAIL`, `EMPTY` (no surfaces) or `INVALID` (no gbXML root).

```json
{ "document": "F26901-FMC-ZZ-ZZ-M3-A-0001_USER", "mode": "export", "dry_run": false, "model_type": "spaces" }
```
