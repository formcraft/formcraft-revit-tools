# fmc_mep_audit

Read-only MEP connectivity and system audit. It opens **no transaction**, takes **no `batch_lease`**, and changes nothing. Builder 19 owns it. Its output feeds `fmc_calc` and Builder 8's `fmc_mep_size`.

**Conduit and cable tray are not audited here.** `fmc_conduit scan` and `fmc_trace` (`domain` `conduit`, `tray` or `electrical_containment`) already report their open ends. The add-in never collects conduit or tray categories. If a conduit or tray row still arrives, the server drops it and counts it in `dropped_out_of_scope`.

## What it checks

| Check | Revit API | Codes |
|---|---|---|
| Open End connectors on pipes, flex pipes, ducts, flex ducts, their fittings and accessories | `ConnectorManager.UnusedConnectors` with `Connector.IsConnected`; `PlumbingUtils.HasOpenConnector` as a cross-check on pipe curves, fittings and accessories (`plumbing_open`) | `MEP-OPEN-CURVE-END`, `MEP-OPEN-FITTING`, `MEP-OPEN-ACCESSORY` |
| Open End connectors on mechanical equipment, plumbing fixtures, sprinklers and air terminals (piping and HVAC connectors only) | `FamilyInstance.MEPModel.ConnectorManager.UnusedConnectors` | `MEP-OPEN-EQUIPMENT`, `MEP-OPEN-FIXTURE`, `MEP-OPEN-TERMINAL` |
| An open connector that belongs to no system | `Connector.MEPSystem` | `MEP-CONN-NO-SYSTEM` |
| Systems that are not well connected | `PipingSystem.IsWellConnected`, `MechanicalSystem.IsWellConnected` | `MEP-SYS-NOT-WELL-CONNECTED` |
| Systems with no base equipment | `MEPSystem.BaseEquipment` | `MEP-SYS-NO-BASE-EQUIPMENT` |
| Empty or invalid systems | `MEPSystem.IsEmpty`, `MEPSystem.IsValid` | `MEP-SYS-EMPTY`, `MEP-SYS-INVALID` |
| Flow, static pressure, critical-path pressure loss and fixture units per system | `GetFlow()`, `GetStaticPressure()`, `MEPSystem.PressureLossOfCriticalPath`, `MEPSystem.GetCriticalPathSectionNumbers()`, `PipingSystem.GetFixtureUnits()` | `MEP-SYS-CALC-UNAVAILABLE` when a value could not be read |

Severities:

- `error`: `MEP-OPEN-CURVE-END`, `MEP-OPEN-FITTING`, `MEP-OPEN-ACCESSORY`, `MEP-SYS-NOT-WELL-CONNECTED`.
- `warning`: `MEP-OPEN-EQUIPMENT`, `MEP-OPEN-FIXTURE`, `MEP-OPEN-TERMINAL`, `MEP-SYS-INVALID`, `MEP-SYS-NO-BASE-EQUIPMENT`.
- `info`: `MEP-CONN-NO-SYSTEM`, `MEP-SYS-EMPTY`, `MEP-SYS-CALC-UNAVAILABLE`.

`MEP-SYS-NO-BASE-EQUIPMENT` is `info` for Sanitary, Vent, OtherPipe and the fire-protection classifications, because those systems usually end at a drain, a stack or a riser.

Revit only gives valid calculated values on a well-connected system. On a system that is not well connected, flow, pressure and fixture units are not read and come back `null`. `calc_valid` is `false`, and the system gets `MEP-SYS-NOT-WELL-CONNECTED`, not a calc issue.

## Arguments

```json
{
  "document": "F26901-FMC-ZZ-ZZ-M3-P-0001_USER",
  "domain": "both",
  "systems": [],
  "levels": [],
  "include_equipment": true,
  "analysis": true,
  "mode": "summary",
  "max_results": 200
}
```

- `domain`: `piping`, `duct` or `both` (the default).
- `systems`: system names (case-insensitive) or element ids.
- `levels`: level names. An element uses its reference or host level. A system uses the levels of its members, up to 20.
- `include_equipment`: set to `false` to audit only the network (curves, fittings and accessories).
- `analysis`: set to `false` to skip flow, pressure and fixture units. This is faster on big models.
- `mode`:
  - `summary` (the default) gives counts, the `error` and `warning` issues, up to 20 ids per code in `sample_ids`, and only the systems that have an issue.
  - `detail` gives every issue and every system.
- `max_results`: caps `issues`, `systems` and `facts.mep_systems` (1 to 5000). The add-in also caps its raw snapshot at 20,000 open connectors and 5,000 systems (`source_truncated`).

## Reply (`schema: "fmc_mep_audit/1"`)

```json
{
  "tool": "fmc_mep_audit",
  "schema": "fmc_mep_audit/1",
  "read_only": true,
  "document": { "title": "...", "path": "..." },
  "filters": { "domain": "both", "systems": [], "levels": [], "include_equipment": true },
  "mode": "summary",
  "summary": {
    "open_connectors": 12,
    "open_connectors_by_kind": { "curve": 5, "fitting": 3, "equipment": 4 },
    "issues": 20,
    "by_code": { "MEP-OPEN-CURVE-END": 5 },
    "by_severity": { "error": 9, "warning": 7, "info": 4 },
    "systems": { "total": 8, "piping": 5, "duct": 3, "not_well_connected": 1, "no_base_equipment": 2, "empty": 0 },
    "totals": { "fixture_units": 42 }
  },
  "issues": [
    { "code": "MEP-OPEN-CURVE-END", "severity": "error", "domain": "piping", "element_id": 1, "connector_index": 1,
      "system_id": 900, "system": "DCW 1", "level": "L01", "message": "..." }
  ],
  "issues_truncated": false,
  "sample_ids": { "MEP-OPEN-CURVE-END": [1] },
  "systems": [ "same rows as facts.mep_systems" ],
  "systems_truncated": false,
  "facts": {
    "mep": { "model": "...", "pipe_systems": [{ "id": 900, "name": "DCW 1", "classification": "DomesticColdWater" }],
             "counts": { "pipe_systems": 5, "duct_systems": 3, "open_connectors": 12 } },
    "mep_systems": [
      { "id": 900, "name": "DCW 1", "domain": "piping", "classification": "DomesticColdWater", "system_type": "Domestic Cold Water",
        "is_well_connected": true, "base_equipment_id": 5000, "base_equipment_name": "...", "element_count": 120, "levels": ["L01"],
        "flow_lps": 1.25, "static_pressure_pa": 1200.0, "critical_path_pressure_loss_pa": 800.0, "critical_path_sections": [1, 2, 3],
        "fixture_units": 14, "calc_valid": true }
    ]
  },
  "scanned": { "elements": 400, "connectors": 1600, "systems": 8 },
  "source_truncated": { "connectors": false, "systems": false },
  "dropped_out_of_scope": 0,
  "skipped_non_family": { "count": 0, "ids": [] },
  "excludes": "Conduit and cable tray are not audited here: ...",
  "api_notes": ["..."]
}
```

Units: flow is in L/s, pressures are in Pa, and fixture units have no unit. Fixture units are `null` on duct systems. `summary.totals.fixture_units` adds up only well-connected piping systems.

### Feeding other tools

- **`fmc_calc`**: `facts.mep` uses `MepFacts` field names (`model`, `pipe_systems[{id, name, classification}]`, `counts`). Merge it into the `mep` section of a `facts_file` (`{ mep, boards }`) next to the rooms and fixtures from `fmc_mep_facts`.
- **`fmc_mep_size`** (Builder 8): read `facts.mep_systems`. Use a value only when `calc_valid` is `true`. Field names and units are stable within `fmc_mep_audit/1`. A breaking change gets a new schema version.

## API limits (Revit 2025)

- `CriticalPathCollector` (`Autodesk.Revit.DB.Analysis`) needs an `MEPNetworkSegmentId` from the systems-analysis model, so it is not used. The critical path is `MEPSystem.PressureLossOfCriticalPath` plus `GetCriticalPathSectionNumbers()` (section numbers in flow order, up to 100). Per-section pressure drop is not read.
- `GetFlow`, `GetStaticPressure` and `GetFixtureUnits` run Revit's own system calculation synchronously when called from an add-in. On a big model, `analysis: false` avoids that cost.
- `PlumbingUtils.HasOpenConnector` covers only pipe curves, pipe fittings and pipe accessories. For ducts and equipment, `UnusedConnectors` is the only check.
- Equipment often has optional connectors (for example a spare drain). Those are reported as `MEP-OPEN-EQUIPMENT` warnings, not errors.
- Electrical and conduit/cable-tray connectors (`Domain.DomainElectrical`, `Domain.DomainCableTrayConduit`) are skipped on purpose.

## Examples

Piping only, level L01, full detail:

```json
{ "document": "P-0001_USER", "domain": "piping", "levels": ["L01"], "mode": "detail", "max_results": 500 }
```

One system, without calculations:

```json
{ "document": "M-0001_USER", "systems": ["SA 1"], "analysis": false }
```
