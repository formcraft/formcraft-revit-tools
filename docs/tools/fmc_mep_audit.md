# fmc_mep_audit

Read-only MEP connectivity and system audit. It opens **no transaction**, takes **no `batch_lease`**, and changes nothing. Builder 19 owns it.

## Scope: what it adds to fmc_trace

`fmc_trace` already emits FLOW-OPEN-END, NOT-CONNECTED, NEAR-MISS, SIZE-MISMATCH, NO-SYSTEM, NO-SOURCE, ISLAND and the NO-FITTING, CAP, TRAP, VENT, WASTE, CLEANOUT and ISOLATION codes. `fmc_mep_audit` repeats none of them. It adds only:

1. **A cross-check of `fmc_trace`'s open_end** on piping and HVAC. `ConnectorManager.UnusedConnectors` lists open End connectors (`MEP-OPEN-*`, severity info; FLOW-OPEN-END stays the finding of record). `PlumbingUtils.HasOpenConnector` is checked both ways on pipe curves, fittings and accessories. Where the two APIs disagree, the element gets `MEP-XCHK-MISMATCH` (warning).
2. **IsWellConnected** per piping and mechanical system (`MEP-SYS-NOT-WELL-CONNECTED`).
3. **Systems with no BaseEquipment**, as a count plus ids (`summary.systems.no_base_equipment` and `no_base_equipment_ids`, code `MEP-SYS-NO-BASE-EQUIPMENT`). The wording is "no BaseEquipment set", never "no source".
4. **Static pressure, PressureLossOfCriticalPath and the critical-path sections.** `GetCriticalPathSectionNumbers()` gives the sections in flow order. Each one is read with `MEPSystem.GetSectionByNumber`: `MEPSection.TotalPressureLoss`, `Flow`, `TotalCurveLength`, `Velocity`, `Roughness`, `TotalCoefficient`, `FixtureUnit`, its element ids, and the size of its first pipe or duct.
5. **Fixture units** per piping system (`PipingSystem.GetFixtureUnits()`), and the plumbing fixtures' DU for `fmc_calc` (`facts_file`).

`MEP-SYS-EMPTY`, `MEP-SYS-INVALID` and `MEP-SYS-CALC-UNAVAILABLE` explain why a system has no valid values.

**Conduit and cable tray are not audited here.** `fmc_conduit scan` and `fmc_trace` (`domain` `conduit`, `tray` or `electrical_containment`) report their open ends. The add-in never collects conduit or tray categories, and the server drops any such row (`dropped_out_of_scope`).

## Codes

| Code | Severity | Meaning |
|---|---|---|
| `MEP-OPEN-CURVE-END`, `MEP-OPEN-FITTING`, `MEP-OPEN-ACCESSORY` | info | UnusedConnectors: an open End connector on a pipe, duct or flex curve, a fitting or an accessory. Cross-check of FLOW-OPEN-END. |
| `MEP-OPEN-EQUIPMENT`, `MEP-OPEN-FIXTURE`, `MEP-OPEN-TERMINAL` | info | The same on mechanical equipment, plumbing fixtures and sprinklers, or air terminals (piping and HVAC connectors only). |
| `MEP-XCHK-MISMATCH` | warning | UnusedConnectors and HasOpenConnector disagree on a piping element. |
| `MEP-SYS-NOT-WELL-CONNECTED` | error | IsWellConnected is false. Revit's calculated values are invalid. |
| `MEP-SYS-NO-BASE-EQUIPMENT` | warning (info for Sanitary, Vent, OtherPipe and fire protection) | BaseEquipment is not set. |
| `MEP-SYS-EMPTY` | info | The system has no components. |
| `MEP-SYS-INVALID` | warning | IsValid is false. |
| `MEP-SYS-CALC-UNAVAILABLE` | info | A calculated value threw on a well-connected system. `calc_notes` says which. |

## Arguments

```json
{ "document": "F26901-FMC-ZZ-ZZ-M3-P-0001_USER", "domain": "both", "systems": [], "levels": [],
  "include_equipment": true, "analysis": true, "mode": "summary", "max_results": 200 }
```

- `domain`: `piping`, `duct` or `both` (the default).
- `systems`: names (case-insensitive) or element ids.
- `levels`: level names. An element uses its reference or host level. A system uses its members' levels (up to 20).
- `include_equipment`: set to `false` to audit only the network.
- `analysis`: set to `false` to skip flow, pressure, fixture units and the sections. This is faster on big models.
- `mode`: `summary` (the default) gives counts, the error and warning issues, up to 20 ids per code in `sample_ids`, and only the systems with an issue. `detail` gives every issue and every system.
- `max_results`: caps `issues`, `systems`, `mep_systems` and the id lists (1 to 5000). The add-in caps its raw snapshot at 20,000 open connectors, 5,000 systems, 100 sections per system and 50 element ids per section.

## Reply (`schema: "fmc_mep_audit/1"`)

- `summary`: `open_connectors`, `open_connectors_by_kind`, `cross_check { of, unused_connectors, plumbing_open_elements, mismatches }`, `issues`, `by_code`, `by_severity`, `systems { total, piping, duct, not_well_connected, not_well_connected_ids, no_base_equipment, no_base_equipment_ids, empty }`, `totals { fixture_units }`.
- `issues[]`: `{ code, severity, domain, element_id?, connector_index?, system_id, system, level, message }`, errors first.
- `sample_ids` (summary mode only): ids per code.
- `systems[]` and `mep_systems[]`: one row per system:
  `{ id, name, domain, classification, system_type, is_well_connected, base_equipment_id, base_equipment_name, element_count, levels, flow_lps, static_pressure_pa, critical_path_pressure_loss_pa, critical_path_sections, critical_path[], fixture_units, calc_valid }`.
  Each `critical_path[]` entry is `{ number, flow_lps, length_m, pressure_loss_pa, velocity_ms, fixture_units, element_count }`.
- `segments[]`: the critical path of each well-connected system as **`MepSegment`** rows. The type is copied from Builder 8's `server/src/fmc/mepsize.ts` (`feat/mep-tools`, commit `cbe2bf5`) into `mepaudit.ts`. `fmc_mep_size` `pressure` or `critical_path` can take them directly:
  `{ id: "<system_id>:<section>", kind: "pipe"|"duct", flow_l_s, length_m?, shape?, size_mm? | w_mm?/h_mm?, roughness_mm?, k?: [TotalCoefficient], upstream?, source: "model:<system_id>#section:<n>" }`.
  Sections are in flow order: each section's `upstream` is the previous one, and the first has none. A section without flow is skipped and listed in `segment_notes`.
- `segment_checks[]`: Revit's own values beside each segment, `{ id, system_id, section, revit_pressure_loss_pa, velocity_ms, fixture_units, element_ids }`, so `fmc_mep_size` can compare its loss with Revit's. `segments_truncated` is set when there are more than `max(max_results, 1000)`.
- `facts_file`: **fmc_calc's `{ mep, boards }`** for CA-P-01 (water demand and storage) and CA-P-02 (drainage). `mep` uses fmc_calc's `MepFacts` names: `model`; `plumbing_fixtures[{ id, family, type, level, room, du, pipe_system }]`, where `du` is `FMC_Discharge_Units` (the parameter `fmc_mep_facts` reads) and is `null` when missing; `pipe_systems[{ id, name, classification }]`; and `counts { plumbing_fixtures, fixtures_without_du, pipe_systems, duct_systems }`. `boards` is `[]`. Save it as JSON and pass it as `facts_file` to `fmc_calc run` or `sheet`. Rooms (population), tanks, fire devices and circuits are not read here, so merge `fmc_mep_facts`' sections in when a calc needs them. Not capped. Fixtures follow the `domain`, `levels` and `systems` filters.
- `scanned`, `source_truncated`, `dropped_out_of_scope`, `skipped_non_family`, `excludes`, `api_notes`.

Units: flow is in L/s, pressure in Pa, length in m, velocity in m/s and sizes in mm. Fixture units have no unit and are `null` on duct systems. Only rows with `calc_valid: true` (well connected) carry trustworthy values.

## API limits (Revit 2025)

- `CriticalPathCollector` (`Autodesk.Revit.DB.Analysis`) needs an `MEPNetworkSegmentId` from the systems-analysis model, so it is not used.
- `GetFlow`, `GetStaticPressure`, `GetFixtureUnits` and the `MEPSection` values run Revit's system calculation synchronously when read from an add-in. Use `analysis: false` on big models.
- `PlumbingUtils.HasOpenConnector` covers only pipe curves, pipe fittings and pipe accessories. For ducts and equipment there is no second API to cross-check against.
- A section's size comes from its first pipe (inner diameter) or duct (diameter, or width and height). Flex curves and sections without a straight curve have no size.
- Electrical and conduit/cable-tray connectors are skipped on purpose.
