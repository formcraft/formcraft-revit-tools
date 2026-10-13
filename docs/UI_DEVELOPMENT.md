# UI development list

The order Claude builds the plugin's UI in. Do one step at a time: plan it, wait for a yes, build it on a
`feat/u<NN>-<name>` branch, test it as `docs/TESTING.md` says, open a pull request, then tick the box here.

Every step names its **board** (design in `design/boards/`, live on the central canvas), the **files** it touches,
what **done** means, and how it is **tested** (P = preview app, R = in Revit, M = through the Revit MCP, C = CI).

Status: `[ ]` to do · `[~]` in progress · `[x]` done

---

## Stage A: shell foundations (mock data, no Revit)

### [x] U00 Repo, CI and a running shell
- Board: `core/PaneShell`
- Files: `shell/`, `.github/workflows/build.yml`
- Done: CI green on `main`; the preview app opens; sign-in → first-run → main pane works on mocks.
- Test: C, P.

### [x] U01 Complete the UI kit in code
- Board: `core/UI_Kit`
- Files: `Theme/FmcTheme.xaml`, new `Theme/FmcColors.Light.xaml` + `Theme/FmcColors.Dark.xaml` (same keys),
  `Services/ThemeService.cs`, `Controls/*`, `tests/shell/` (new test project)
- Add styles: `FmcToggle` (on/off/locked), `FmcSegmented`, `FmcChip.{Good,Warn,Bad,Info,Grey}`, `FmcCheckRow`,
  `FmcReadOnly`, `FmcTable` (DataGrid), `FmcDocBanner` (setup/shared/live), `FmcDialog` overlay, focus visuals.
- Embed IBM Plex from `resources/fonts` as a WPF resource; fall back to Segoe UI.
- Dark dictionary with the same keys; theme follows Revit (Settings › General can override). `ThemeService.SetHostTheme`
  takes Revit's theme from the add-in; dark values sit with Revit's own dark panels.
- Done: a "kit gallery" page in the preview app shows every style in every state, light and dark.
- Test: P (compare with the UI kit board), C.

### [x] U02 Pane frame at full parity
- Boards: `core/PaneShell`, `core/ResponsivePane`
- Files: `Views/ShellView.xaml`, `ViewModels/ShellViewModel.cs`, new `Views/Parts/*`
- Header: Formcraft, Connected chip (opens Connect), Settings, Admin (admins only), Help.
- Search box, group tabs, section buttons with icon and module tag (`+Flow`, `+Model`, `+Build`), quick tools strip
  (Touch, Section Box, Tag Tidy) shown only when Flow is licensed, document banner (three states), footer with
  actions and status, dialog host.
- Width 320–560 px; compact layout below 400 px (icons only in section buttons, wrapped footer).
- Done: side by side with the board at 440 px and at 360 px, layout and text match.
- Test: P, C.

### [x] U03 Sections registry, parts switches and licence gating
- Boards: `core/Ribbon`, `manage|flow|model|build/PaneSettings*`
- Files: new `Services/SectionRegistry.cs` + `Services/sections.json` (UI config, not kit data, embedded),
  `Services/UserSettings.cs`, `ViewModels/PartsViewModels.cs`, `ShellViewModel`
- One registry lists every section: group, name, module, icon, phase, board. Parts switches hide or show groups per
  person (saved in `%APPDATA%\Formcraft\settings.json`). A module not licensed shows the locked page (U08).
- Parts (boards `*/PaneSettings*`): Manage's four parts are groups; Model's Systems and Structural hide those sections
  (Quantities is stored for Build); Flow's Touch, 3D and Tags hide quick tools, Sheet Layout and Tags the `+Flow` tags;
  Build's three parts become tabs of the Build section (U26) and hide the group when all are off. A part counts only
  while its module is licensed.
- Done: turning a part off in Settings removes its group; licence changes in the mock update the pane at once.
- Test: P, unit tests in `tests/shell`.

### [x] U04 Search (Ctrl+K)
- Board: `core/UI_Palette`
- Files: new `Views/Parts/SearchView.xaml`, `ViewModels/SearchViewModel.cs`, `search` entries in `sections.json`
- Finds sections, actions, settings and help from the registry; respects role and licence; Esc closes; arrow keys move.
- Matches titles and each entry's extra words, never the grey detail. Results replace the section body while there is a
  query. Unlicensed results show dimmed with why; parts switched off are not found. Roles come with Admin (U07).
- Done: the three sample searches on the board ("sheet", "qa", "level") return the same groups.
- Test: P, unit tests.

### [x] U05 Sign in and first-run setup, complete
- Boards: `account/PaneSignIn`, `account/PaneWelcome`
- Files: `Views/SignInView.xaml`, `Views/WelcomeView.xaml` (split out of `ShellView`), view models
- Microsoft and Google buttons open the browser flow (mocked); offline licence file drop; four setup steps (kit
  folder with checks, role and disciplines, parts to show, tour and shortcuts).
- Done: a new PC goes from sign-in to the main pane in four steps; every check line matches the board.
- Test: P.

### [x] U06 Settings: Account, General, Manage, Flow, Model, Build
- Boards: `account/PaneAccount`, `core/PaneSettings`, `*/PaneSettings*`
- Files: `Views/SettingsView.xaml`, `ViewModels/SettingsViewModel.cs` (the catalogue of every tab) and `SettingItems.cs`;
  the store is `IUserSettings` / `JsonUserSettings` (U03, U05)
- One Settings page with a tab per licensed module; each module tab has its parts list, its two ribbon buttons and
  "works with" status. Saved per person; never loosens a team rule.
- Done: every control on the six boards exists, saves and reloads.
- Test: P, unit tests for the store.

### [x] U07 Admin: roles, permissions, licences and seats (UI on mocks)
- Boards: `core/PaneAdmin`, `account/PaneSeats`
- Files: `Views/AdminView.xaml`, `ViewModels/AdminViewModel.cs`, `Services/AdminService.cs` (+ mock); rows and dialogs use
  `Views/SettingTemplates.xaml` (shared with Settings and the dialog host)
- Admin button visible to admins only. Seats table, invites, requests, two-step rule, Claude key policy.
- Done: matches both boards; non-admins never see Admin.
- Test: P.

### [x] U08 States: locked, offline, grace over, not connected, kit missing, live model, Revit busy
- Board: `account/PaneStates`
- Files: `Views/Parts/StateBanner.xaml`, `Views/LockedView.xaml`, `ViewModels/PaneStates.cs`, `ShellViewModel`
- Each state says what happened and the one next step, and keeps working parts working. Typed input is never lost.
- Done: a "states" menu in the preview app switches through all seven; each matches the table on the board.
- Test: P.

### [x] U09 Updates, about, and the Log file window
- Boards: `account/PaneUpdates`, `core/UI_Log`
- Files: Settings › Updates tab (`SettingsViewModel`, `Services/UpdateService.cs`), `Views/LogWindow.xaml`,
  `ViewModels/LogViewModel.cs`, `Services/LogReader.cs` (reads `FMC_MCP_FileLog.csv`), `tests/shell/fixtures/FMC_MCP_FileLog.csv`
- Log window filters All / Pane clicks / Claude / Refused and opens the CSV or folder. Never used to rank people.
- Done: the log window reads a real sample CSV from `tests/shell/fixtures`.
- Test: P, unit tests.

## Stage B: into Revit

### [~] U10 Host the shell in Revit; the five-panel ribbon
- Boards: `core/Ribbon`, `manage|flow|model|build/R_*`
- Files: `plugin/Core/Application.cs`, new `plugin/Shell/ShellHost.cs`, `plugin/Shell/RibbonBuilder.cs`
- Register a dockable pane hosting `ShellView` (net48 and net8 builds). Ribbon: Core (Pane, Connect AI, Log file),
  then one panel per licensed module with its parts switch (split button with checkboxes) and two small buttons.
  Icons from `resources/icons/png`.
- The current `FormcraftBrowserPage` stays reachable until the shell covers it.
- Theme: pass `UIThemeManager.CurrentTheme` to `ThemeService.SetHostTheme` at start-up and on every
  `UIApplication.ThemeChanged`.
- Done: in Revit 2025 the pane docks, floats and remembers its place; ribbon shows only licensed panels. Switching
  Revit between Light and Dark in Options › Colors switches the pane at once, and the dark pane sits flush with Revit's
  own panels (compare side by side; adjust `FmcColors.Dark.xaml` if not).
- Test: R, M (the add-in answers `list_open` as before), C.

### [~] U11 A Revit MCP bridge for UI tests
- Files: `commandset/Commands/Fmc/FmcUiCommand.cs`, `commandset/Services/Fmc/FmcUiEventHandler.cs`,
  `plugin/Shell/UiBridgeHost.cs`, `shell/Formcraft.Shell/Services/UiBridge.cs`, `server/src/fmc/ui.ts`,
  `server/src/tools/fmc_ui.ts`, guard classification (`PANE_COMMANDS` in `server/src/fmc/policy.ts`)
- New read-only MCP tool `fmc_ui`: `get_state` (signed in, licence, current group and section, open dialog, banner
  state, footer text), `open_section`, `set_mock_licence` (test builds only), `screenshot_pane` (saves a PNG of the
  pane to the reports folder). It never touches the model, so it is allowed on live models.
- Done: Claude can drive the pane to any section and read back what it shows.
- Test: M, server unit tests, C.

### [ ] U12 Connect wired to real checks
- Board: `core/PaneConnect`
- Files: `Views/ConnectView.xaml`, adapter over `plugin/Fmc/Readiness.cs` and `GuardStatus.cs`
- Start-up health check, kit and folders, safety locks (D1 toggle shown, user-only), Claude service start/stop.
- Done: matches the board with live values on the pilot PC.
- Test: R, M (`fmc_ui get_state` shows the same values).

## Stage C: module sections (each step: view + view model + adapter over carried tools)

Build in roadmap order. Each section follows the same recipe: view from its board, view model, adapter over the
carried server or command set tool, dry run → yes → run → log, and an `fmc_ui` check.

- [ ] U13 Manage › Project (start a project: details, naming, folders, models, sheets) — `manage/PaneProject`
- [ ] U14 Manage › Templates — `manage/PaneTemplates`
- [ ] U15 Manage › Families (plan, build, load test via `fmc_family`) — `manage/PaneFamilies`
- [ ] U16 Manage › QA and Rules — `manage/PaneQA`, `manage/PaneRules`
- [ ] U17 Real licence service behind `ILicenceService` (decision D6) — `account/*`
- [ ] U18 Manage › Materials — `manage/PaneMaterials`
- [ ] U19 Manage › Sheets, Annotate, Issue — `manage/PaneSheets`, `PaneAnnotate`, `PaneIssue`
- [ ] U20 Manage › Review, Workshare, Links; revision on the drawing — `manage/PaneReview`, `PaneWorkshare`, `PaneLinks`, `ReviewOnSheet`
- [ ] U21 Manage › Reports — `manage/PaneReports`
- [ ] U22 Flow: Touch, on-view previews, Section box, shortcuts — `flow/*`
- [ ] U23 Model › Start from brief — `model/PaneModelBrief`
- [ ] U24 Model › Scripts and automation — `model/PaneScripts`, `model/M_Automation`
- [ ] U25 Model › Systems and Structural — `model/PaneModelSystems`, `PaneModelStructural`
- [ ] U26 Build pane, workspace window, Revit views — `build/*`
- [ ] U27 Ask Claude in the pane (carried command, new view) — `core/PaneAsk`

The account website (`account/UI_AccountWeb`) and the Build web workspace (`build/B_Web`) are separate web projects,
not part of the add-in.
