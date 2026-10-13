# tests

| Folder | What | Run |
|---|---|---|
| `commandset/` | Command set tests (carried) | `dotnet test tests/commandset` (needs Revit API references) |
| `fmc/` | Guard parity: the C# guard and the TypeScript policy agree | `dotnet run --project tests/fmc` |
| `../server` | Guard policy, CLI, Ask Claude tests | `cd server && npm test` |

Shell tests go in `tests/shell/` (UI step U1 adds the project): view models and mock services, no Revit.
