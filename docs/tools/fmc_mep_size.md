# fmc_mep_size

Read-only MEP sizing preview (GAP-15). Nothing is written to the model, and the tool has no apply. Every answer is a **draft for the engineer** and carries `engineer_signoff_required: true`: Formcraft does not size or sign (CLAUDE.md rule 5, `docs/MEP_CALCULATIONS.md`).

| Action | What |
|---|---|
| `duct`, `pipe` | Smallest round size in `standard_sizes_mm` whose velocity (and friction, when the limit and the roughness are known) is within the limits. Also the minimum diameter by velocity. |
| `pressure` | Per segment: velocity, Reynolds number, Darcy-Weisbach friction (Swamee-Jain friction factor, laminar 64/Re), fitting loss = ΣK × ½ρv², total loss. |
| `critical_path` | `pressure`, plus the index run: the root-to-leaf path (by `upstream` ids) with the largest summed loss. A path with a TBC loss is listed, never picked. A missing parent or a cycle is reported. |
| `voltage_drop` | Per circuit: VD = ROUND(mV/A/m × I × L / 1000, 2) and VD % against the limit (the kit's Calc_E_VoltDrop method). Gives the smallest cable in `cables` that passes (and its rating ≥ I when given), and checks the modelled wire size. The circuits come from the call, or from Revit through `fmc_mep_facts` (read-only) with `from_model: true`. |

## Where the numbers come from

- **Limits:** standards-bank keys `mep.duct_velocity_max_ms`, `mep.duct_friction_max_pa_m`, `mep.duct_roughness_mm`, `mep.pipe_velocity_max_ms`, `mep.pipe_friction_max_pa_m`, `mep.pipe_roughness_mm`, `trace.voltage_drop_pct` and `mep.voltage_drop_pct_lighting`, or `limits` on the call (tagged `engineer`).
  - A key that is missing is **TBC**. A tool default from `trace_bank.ts` is tagged `provisional:`.
  - The `mep.*` keys are new and are not in the bank yet. This is a kit change request.
- **Size list and cable table:** these come only from the call (the type's size table, the kit or the engineer). The kit v2.2 has no mV/A/m table (CA-E-02 kit change request), and there is no 2026 cable table yet. `voltage_drop` with no `cables` is the error `FMC-NO-CABLE-TABLE`, and no rows are returned.
- **Fluid properties:** air and water at 20 °C (tagged `physics`), or `fluid` on the call.

## Example

```json
{ "action": "critical_path",
  "limits": { "velocity_max_ms": 8, "friction_max_pa_m": 1.5, "roughness_mm": 0.15 },
  "segments": [
    { "id": "AHU-1", "kind": "duct", "flow_l_s": 600, "size_mm": 450, "length_m": 10 },
    { "id": "A", "kind": "duct", "flow_l_s": 300, "size_mm": 315, "length_m": 12, "k": [0.3, 0.2], "upstream": "AHU-1" },
    { "id": "B", "kind": "duct", "flow_l_s": 300, "size_mm": 355, "length_m": 5, "upstream": "AHU-1" } ] }
```

`fmc_mep_audit` (Builder 19) is planned to output its critical-path sections in this `segments` shape.

## Not here

- Writing sizes to the model. Per GAP-15 there is no second sizing tool. Applying sizes would be a later, gated core step with an engineer sign-off flag, and it is not in this slice.
- Size tables and routing preferences belong to `modify_model` (the system-type editor).
- Connectivity findings belong to `fmc_trace` and `fmc_mep_audit`.
