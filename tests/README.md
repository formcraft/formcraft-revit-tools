# tests

| Folder | What | Run |
|---|---|---|
| `commandset/` | Command set tests (carried) | `dotnet test tests/commandset` (needs Revit API references) |
| `fmc/` | Guard parity: the C# guard and the TypeScript policy agree | `dotnet run --project tests/fmc` |
| `shell/` | Shell: theme (both colour sets, kit styles, contrast, embedded fonts), `ThemeService` | `dotnet test tests/shell` |
| `../server` | Guard policy, CLI, Ask Claude tests | `cd server && npm test` |

Shell tests run without Revit or a window on screen; WPF parts run on an STA thread (`tests/shell/Sta.cs`).
