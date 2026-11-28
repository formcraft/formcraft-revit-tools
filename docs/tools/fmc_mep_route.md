# fmc_mep_route

Pipe and duct routing with fittings. It is built on the route solver in `server/src/fmc/route.ts` (MEP item 1, the same one `fmc_trace route` uses) and on the planner in `server/src/fmc/mepfit.ts`.

| Action | What |
|---|---|
| `preview` | Runs the route solver, then plans the pieces (split at tees and stock-length joints) and the fittings: an elbow at each corner, a tee at each branch, a union at each joint, and a cap at each open end when `caps` is true. Revit is read only when `type_name` is given, to check that type's routing preferences. |
| `place` | `dry_run` is true by default. A real run needs `batch_lease`. It creates the pieces with the named pipe or duct type, system type and level, then each fitting. |

- **Fittings:** the type's routing preferences are used as they are.
  - A group with no rule (Elbows, Junctions, Unions, plus Segments for pipes, and Caps when `caps` is true) is `FMC-NO-FITTING-TYPE` before anything is sent.
  - A corner angle not in `angles_deg` is `FMC-ANGLE`.
  - Add a missing rule with `modify_model edit_type routing`. This tool never writes routing preferences.
- **Add-in** (`FmcMepRouteWork.cs`): one Transaction with a failure preprocessor.
  - Each piece (`Pipe.Create` or `Duct.Create`, then the diameter) is its own SubTransaction.
  - Each fitting (`NewElbowFitting`, `NewTeeFitting`, `NewUnionFitting`, or `PlumbingUtils.PlaceCapOnOpenEnds` with the type's first cap rule) is its own SubTransaction.
  - It matches free piece ends within 2 mm of each fitting point. It returns `saved: false` and never saves or syncs.
- **Guards:** HEBERT HOSTELS, a central model and `protected_paths` are refused, on the server and again in the add-in. The live-model lock and the AI gate apply through `sendCommand`, because `fmc_mep_route_apply` is in WRITE_COMMANDS. The tool never uses `sendRaw`.
- **Units:** coordinates are mm in the model's internal coordinates.
- **Codes:** `FMC-ROUTE-NONE`, `FMC-ROUTE-LIMIT` and `FMC-ROUTE-INPUT` (from the solver, or a type, system type or level that was not found), `FMC-ROUTE-GUARD`, `FMC-BATCH-LOCKED`, `FMC-NO-FITTING-TYPE`, `FMC-ANGLE`.
