# Formcraft.Shell

| Folder | What goes here |
|---|---|
| `Theme/` | `FmcColors.Light.xaml` / `FmcColors.Dark.xaml` (colours, same keys) and `FmcTheme.xaml` (sizes, styles). Views never hard-code a colour and read colours with `DynamicResource` |
| `Controls/` | Small kit controls (`FmcCheckRow`, `FmcDocBanner`, `FmcDialog`) and the `Fmc.*` attached properties |
| `Views/` | XAML user controls. `ShellView` is the pane; `Views/Parts/` its frame (`HeaderBar`, `GroupNav`, `QuickTools`, `FooterBar`); sections become their own views as they are built. Parts load before they join the pane, so they use `DynamicResource` for theme styles |
| `ViewModels/` | One view model per view. `ShellViewModel` owns navigation, licence gating and status |
| `Services/` | Interfaces the shell depends on (`ILicenceService`…) and their mock implementations: `ILicenceService`, `IConnectionService` (Connected chip), `IDocumentContext` (banner), `IUserSettings` (parts switches, JSON file); `ThemeService` (follows Revit's theme); `SectionRegistry` reads `sections.json`, the pane's groups, sections, quick tools and parts |

Rules
- MVVM: no logic in code-behind except what WPF forces (e.g. `PasswordBox`).
- Every service is an interface with a mock, so the preview app and tests run without Revit or a server.
- Text follows the canvas boards word for word unless a step in `docs/UI_DEVELOPMENT.md` says otherwise.
- No Revit API here. Anything that needs Revit goes through a service the add-in implements.
