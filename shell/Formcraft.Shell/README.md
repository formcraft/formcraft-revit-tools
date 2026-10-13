# Formcraft.Shell

| Folder | What goes here |
|---|---|
| `Theme/` | `FmcTheme.xaml`: every colour, size and control style. Views never hard-code a colour |
| `Views/` | XAML user controls. `ShellView` is the pane frame; sections become their own views as they are built |
| `ViewModels/` | One view model per view. `ShellViewModel` owns navigation, licence gating and status |
| `Services/` | Interfaces the shell depends on (`ILicenceService`…) and their mock implementations |

Rules
- MVVM: no logic in code-behind except what WPF forces (e.g. `PasswordBox`).
- Every service is an interface with a mock, so the preview app and tests run without Revit or a server.
- Text follows the canvas boards word for word unless a step in `docs/UI_DEVELOPMENT.md` says otherwise.
- No Revit API here. Anything that needs Revit goes through a service the add-in implements.
