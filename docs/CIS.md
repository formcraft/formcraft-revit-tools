# Concept Information Set (CIS) · fmc-cis/0.1

Model › Start from brief (U23) reads the approved concept as data and sets up a new model from it. The kit has no
CIS schema yet, so this is the plugin's proposal. When the kit publishes one, the kit wins (rule 7) and this page follows it.

```json
{
  "schema": "fmc-cis/0.1",
  "project": "F26001",
  "revision": "R4",
  "approved": "2026-10-13",
  "levels": [{ "name": "00 Ground Floor", "elevation_mm": 0 }],
  "project_info": { "FMC_Plot_No": "112", "FMC_FFL_MSL": "" },
  "rooms": [{ "number": "G01", "name": "Entrance", "params": { "FMC_Target_Area": 9.0, "FMC_Finish_Set": "FS-01" } }],
  "materials": ["FMC_Concrete_Cast"],
  "families": ["FMC_A_Door_Single"]
}
```

| Field | Rules |
|---|---|
| `levels` | A name and an elevation in mm. Names must not repeat. A level that is already in the model by name is left alone. A level at the same height is renamed. Each new level gets a floor plan. |
| `project_info` | Each key must be a kit parameter bound to Project Information (`03_Master_Data\FMC_Master_Data.json`). An empty or null value is a **blank**: it is listed and left blank, never guessed. |
| `rooms` | Number and name are needed, and numbers must not repeat. Rooms are created **unplaced**: a modeller places them once walls exist. Each `params` key must be a kit parameter bound to Rooms. |
| `materials` | Listed, but not loaded until the kit has a materials library (F-011). |
| `families` | Loaded by name from the kit's approved `04_Families` folders, never from `_Staging` or `_ChainTests`. A family that isn't there is listed as skipped. |

## How a run works

- It runs only on a **new, unsaved, non-workshared** model. On anything else it is refused, by both the Revit command and the live-model lock.
- `plan` is read-only. `apply` is a dry run in Revit that reports the counts and is then rolled back. Only `dry_run=false` writes, as one Undo, and adds a log line to FMC_MCP_FileLog.csv.
- It never draws geometry and never saves.

A sample is in `tests/brief/F26001_CIS_sample.json`.
