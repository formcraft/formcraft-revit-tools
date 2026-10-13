# tests

| Folder | What | Run |
|---|---|---|
| `commandset/` | Command set tests (carried) | `dotnet test tests/commandset` (needs Revit API references) |
| `fmc/` | Guard parity: the C# guard and the TypeScript policy agree | `dotnet run --project tests/fmc` |
| `shell/` | Shell: theme (both colour sets, kit styles, contrast, embedded fonts), `ThemeService`. TUnit | `dotnet test --project tests/shell/Formcraft.Shell.Tests.csproj` (.NET 10 SDK), or run `Formcraft.Shell.Tests.exe` |
| `../server` | Guard policy, CLI, Ask Claude tests | `cd server && npm test` |

All .NET tests use Microsoft.Testing.Platform (`global.json`), so test projects use TUnit, not xUnit or MSTest on VSTest.
Shell tests run without Revit or a window on screen; WPF parts run one at a time on an STA thread (`tests/shell/Sta.cs`).
CI uploads the shell results as the `shell-test-results` artifact (TRX), also when a test fails.
