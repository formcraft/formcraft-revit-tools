# Shell

The Formcraft pane: everything the user sees around the features. Built first, on mock data, so every feature later
drops into a shell that already handles sign-in, licences, navigation, settings and states.

| Project | What | Targets |
|---|---|---|
| `Formcraft.Shell` | Theme, views, view models, services. No Revit reference | net48 (Revit 2020–2024), net8.0-windows (Revit 2025+) |
| `Formcraft.Shell.Preview` | Small WPF app that hosts the shell on its own, with mock services | net8.0-windows |

Run it: `dotnet run --project shell/Formcraft.Shell.Preview`. Sign in with any email and password, then code `123456`.

The add-in (`plugin/`) will host `ShellView` in a Revit dockable pane (UI step U10 in `docs/UI_DEVELOPMENT.md`).
