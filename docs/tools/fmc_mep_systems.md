# fmc_mep_systems

Read-only. Lists duct and piping systems, system types, and the routing preferences of duct and pipe types. It starts no transaction.

| Action | What |
|---|---|
| `list` | Mechanical and piping systems: system type, classification, base equipment, element count, and Revit's `Flow`, `Static Pressure` and `Fixture Units` where it computes them. Filter by `name` and `classification`. |
| `types` | Duct and piping system types (`MEPSystemType`): classification and abbreviation. |
| `routing` | The routing rules of every duct and pipe type, read through `RoutingPreferenceManager.GetRule`, plus the groups with no usable rule. Pipes need Segments, Elbows, Junctions, Transitions and Unions. Ducts need Elbows, Junctions, Transitions and Unions. Knowing this up front lets a route say which fittings Revit cannot place. |

Not here:

- Editing system types or routing preferences. That is `modify_model edit_type routing`, the system-type editor.
- Connectivity, `IsWellConnected`, unused connectors and the critical path. Those belong to `fmc_mep_audit`.
- Open ends. Those belong to `fmc_trace`, and to `fmc_conduit` for conduit and tray.
- Assigning elements to systems and setting base equipment. That is the planned `fmc_mep_systems_apply`, on the fmc_conduit pattern.
