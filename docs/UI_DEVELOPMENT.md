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

### [x] U12 Connect wired to real checks
- Board: `core/PaneConnect`
- Files: `Views/ConnectView.xaml`, `ViewModels/ConnectViewModel.cs`, `Services/ConnectInfo.cs`; adapter
  `plugin/Shell/RevitConnectInfo.cs` over `plugin/Fmc/Readiness.cs` and `GuardStatus.cs`; fixes in `plugin/Fmc/FmcFixes.cs`
- Start-up health check, kit and folders, safety locks (D1 toggle shown, user-only), Claude service start/stop.
- Done: matches the board with live values on the pilot PC.
- Test: R, M (`fmc_ui get_state` shows the same values).

## Stage C: module sections (each step: view + view model + adapter over carried tools)

Build in roadmap order. Each section follows the same recipe: view from its board, view model, adapter over the
carried server or command set tool, dry run → yes → run → log, and an `fmc_ui` check.

- [~] U13 Manage › Project (start a project: details, naming, folders, models, sheets) — `manage/PaneProject`. **Done:** details,
  naming, folder tree, manifest, one model per role with Project Information (`fmc_project`). **To do:** sheets from the
  register, linking the models, project family set, first QA run, undo start
- [~] U14 Manage › Templates — `manage/PaneTemplates`. **Done:** new file from the kit's templates (named by the project, Project
  Information filled in), firm look (brand pack fonts, dry run first), template audit (Must, Should, Advice), template library,
  settings for new projects (`fmc_template`). **To do:** the template builder, compare versions, keep projects in step (Phase 2)
- [x] U15 Manage › Families (plan, build, load test via `fmc_family`) — `manage/PaneFamilies`. Compliance scan, families and
  what each needs, bring in from outside, shared parameters, keynotes (`fmc_library`), and the builder
- [x] U16 Manage › QA and Rules — `manage/PaneQA`, `manage/PaneRules`. QA runs the kit's rules per gate (`fmc_qa`), Rules
  browses the rulebooks; format in `docs/RULEBOOKS.md`
- [ ] U17 Real licence service behind `ILicenceService` (decision D6) — `account/*`
- [~] U18 Manage › Materials — `manage/PaneMaterials`. **Done:** database, assign (dry run), audit, purge, requests (`fmc_material`).
  **To do:** fix texture paths, merge duplicates; finish colour view and schedules with Build (U26)
- [x] U19 Manage › Sheets, Annotate, Issue — `manage/PaneSheets`, `PaneAnnotate`, `PaneIssue`. **Done** (`fmc_sheets`,
  `fmc_annotate`, `fmc_issue`)
- [x] U20 Manage › Review, Workshare, Links; revision on the drawing — `manage/PaneReview`, `PaneWorkshare`, `PaneLinks`, `ReviewOnSheet`.
  **Done** (`fmc_links`, `fmc_workshare`, `fmc_review` with clouds and prints)
- [x] U21 Manage › Reports — `manage/PaneReports`. **Done** (`fmc_report`: Markdown and CSV; branded PDF, Excel, sending and the weekly run later)
- [x] U22 Flow: Touch, Section box, Sheet Layout, Tag Tidy, shortcuts — `flow/*`. Touch (touch engine in `touch/`, formerly TouchKit; Settings › Flow › Touch; Flow ribbon Touch on). `plugin/Shell/FlowTools.cs`: Section box (drag on a plan → your own `FMC_3D_<user>` view with the box, offset and level-aware from Settings › Flow), Sheet Layout (align tops, lefts or distribute viewports), Tag Tidy (selected tags only: row, column, leaders, duplicates). Each asks first in a Revit dialog and is one Undo; from the ribbon and the pane's quick tools. Shortcuts: the kit has no shortcuts file yet (rule 7), so Settings › Flow opens Revit's Keyboard Shortcuts. On-view ghost previews wait for a kit sheet grid
- [x] U23 Model › Start from brief — `model/PaneModelBrief`. **Done** (`fmc_brief` + `fmc_brief_apply`: CIS fmc-cis/0.1 in docs/CIS.md, every parameter checked against the kit; levels with floor plans, Project Information, unplaced rooms with programme data, approved kit families; new unsaved models only, dry run then one Undo; materials wait for the kit library, F-011)
- [x] U24 Model › Scripts and automation — `model/PaneScripts`, `model/M_Automation`. **Done** (`fmc_scripts`: the kit's 05_Scripts from each file's header, with where it runs and the Formcraft section that does the same job, never run by Formcraft; automations of Formcraft's own read-only checks and the weekly report, by hand, stopping at the first failure. Scheduled, on-open and before-sync triggers later)
- [x] U25 Model › Systems and Structural — `model/PaneModelSystems`, `PaneModelStructural`. **Done as checks** (`fmc_systems`, read-only: electrical boards, loads, circuits and feeders; the structural analytical model, supports, kit fields, load cases and FMC_FEA_ results. Capability status said honestly: no system is complete. Electrical 0.1's Enrich and Size wait for their 16 FMC_ parameters in the kit, rule 7)
- [x] U26 Build pane, workspace window, Revit views — `build/*`. **Done** (`fmc_build`: quantities by each type's FMC_Keynote_Code joined to the kit's codes, the unit decides area, volume, length or count, other units left for the QS; changes since a saved baseline; elements with no code listed; progress and package counts; rates never shown. The workspace window shows BOQ, packages and progress at full size, on a second monitor too. The active view is coloured by FMC_Construction_Status or FMC_Trade_Package with view filters, person-run, asks first, one Undo. The data package and site changes come with the separate web workspace)
- [x] U27 Ask Claude in the pane (carried command, new view) — `core/PaneAsk`. **Done** (Ask section: the conversation with what Claude read, tokens and model for each answer, follow-ups until ask reset; `ask …` or `? …` in the search box sends the question; read-only tools, key saved or missing (never shown), model, budget and today's use, the log of tools and tokens, never the text. Proposing changes for a dry run is Phase 2)

The account website (`account/UI_AccountWeb`) and the Build web workspace (`build/B_Web`) are separate web projects,
not part of the add-in.

---

## Stage D: assisted modelling, builders, coordination and data (proposed 14 Oct 2026)

From `docs/PLAN_EXECUTION.md`. Boards are in `design/boards/{core,manage,model,coord}/` (drawn on the claude.ai canvas
"Formcraft New Panes"). They have no guide table, so each step below carries it: **control → what it calls → rule**.
The same rules apply as in Stage C: view + view model + adapter, dry run → yes → run → log, `fmc_ui` check, and plan
first and wait for a yes. New server tools are named here as proposals. Each one is designed in its own plan
before code.

Order: U28 first (it gates every AI write), then U29–U32, then U33 (Robot is installed on the pilot PC), then U34,
then U35–U36 (Navisworks is not installed yet).

- [ ] U28 Admin › AI involvement — `core/PaneAdminAI`. **Needs first:** the owner approves the Manual role "AI
  assistant modeller", the kit rulebook `FMC_Rulebook_AIUse` and the new wording of CLAUDE.md hard rule 1 (the lock
  becomes policy-aware, WIP models only). Guide:
  - **AI modelling switch.** Calls `fmc_ai policy set {enabled}`. Admin only: locked with a padlock for every other role. Off means every AI write is refused.
  - **Involvement level slider (0–100, default 20).** Calls `fmc_ai policy set {level}`. The tier bands and the cap
    meaning come from the rulebook, not code. The metric is open: share of elements, share of changes, or tier-only.
    The owner hasn't decided, so the measure is pluggable.
  - **"At this level, AI may".** Calls `fmc_ai policy explain`, which lists the allowed op classes for the level from the rulebook.
  - **AI share gauge.** Calls `fmc_ai share {model}`. It counts elements stamped `FMC_Author` = AI plus the log. At the cap, the server answers Suggest-only. It never shows per-person figures (Manual 14.5).
  - **Rules table.** Read-only view of the rulebook (risk class Low/Medium/High/Never, approval thresholds, Nevers).
    Edits go through a kit change request.
  - **Per-discipline overrides** (e.g. S 5). Calls `fmc_ai policy set {overrides}`. Admin only.
  - **Save policy.** Shows a dry run (what changes for open models), then writes to the kit's policy file and the log.
  - **Server:** every write tool asks `policy.allows(op, model, count)` before its dry run. Hard Nevers, whatever the level:
    - grids, levels and coordinates;
    - `02_Shared` / `03_Published` models;
    - sync, issue and sign;
    - structural sizing, loads and demand factors;
    - openings and sleeves without the engineer.

  **Test:** P, M, and R on a `_ChainTests` model.
- [ ] U29 Manage › Templates › Builder — `manage/PaneTemplatesBuilder` (grows U14). Guide:
  - **Template picker.** Lists `06_Templates\_Staging\*.rte`.
  - **Recipe layers table.** Calls `fmc_template compare {recipe}`. Each layer shows Same, n changes or To do, against the built file.
  - **Discipline chips.** Green when the role's kit value tables exist; amber when missing (link to the change request).
  - **Dry run (compare)** and **Rebuild all 13.** Call `fmc_template build {recipe, dry_run}`, staging only (TPL-029).
  - **Explain this change (AI).** Plain words from the compare result.
  - **Ask to publish.** Raises a publish request for the BIM Manager; the tool never copies to `06_Templates` itself.
  - **Source:** `scripts/kitbuild/template/*` is the hand-run reference. Phase 1 turns it into `fmc_doc` project ops
    and `Base.recipe.json`.

  **Test:** M (rebuild matches the 14 Oct audit: Pass, 0 warnings).
- [ ] U30 Manage › Families › Quality and release — `manage/PaneFamiliesRelease` (grows U15). Guide:
  - **Gate A list.** Calls `fmc_family load_test` extended. It checks:
    - name and category against the register;
    - kit parameters by GUID;
    - flex of every type;
    - Coarse, Medium and Fine geometry;
    - code checks (e.g. clear opening ≥ 900 mm);
    - tag, schedule and legend;
    - materials and IFC class;
    - values from a verified source (kit field `source_status`: verified, EA, assumed, pending).
  - **Gate B reviewer and note.** The reviewer is picked from roles. Engineering families need the discipline's engineer.
  - **Write the review summary (AI).** Drafts the note; a person edits it.
  - **Send back** and **Release to `04_Families\<Role>`.** Call `fmc_library release {family, reviewer, note}`, which moves the file from staging and appends the release log. People only; never automatic.

  **Test:** M with the steel fanlight door; R for flex.
- [ ] U31 Manage › Sheets › Legends and schedules — `manage/PaneLegends` (grows U19). Guide:
  - **Column set segmented control** (Permit / Tender / Construction / Client). Calls `fmc_legend columns {set}`, which hides and shows schedule fields from the kit's `Column_Sets` tab (kit change). Dry run first, one Undo.
  - **Preview.** Legend view (live legend components with dimensions) over its schedule. Rows follow the legend order.
  - **Legends list.** Calls `fmc_legend status`. Each legend shows new types not yet in it.
  - **Refresh legends.** Calls `fmc_legend refresh`. It copies the seed legend component (Revit has no API to create the first one), sets the type, dimensions and re-sorts. If dimensions can't be placed by API, it flags the type instead.
  - **Hide a column everywhere (AI).** Turns a sentence into a `columns` call, with a dry run.

  **Test:** R on the door chain test; M.
- [ ] U32 Model › Automation › Runs and triggers — `model/PaneAutomationRuns` (grows U24). Guide:
  - **Scheduled runs table:**
    - template rebuild and audit;
    - clash tests;
    - family quality gate;
    - weekly QA;
    - morning report.

    Calls `fmc_automation list/run`. Runs need Revit open with the workbench file (`_Staging\FMC_Claude_Workbench.rvt`). The schedule itself is a Claude scheduled task or Windows Task Scheduler (to decide).
  - **Revit triggers:**
    - QA on save;
    - refresh legends on type change;
    - before issue;
    - export on publish.

    Each is a switch backed by an IUpdater/event in the add-in. Each trigger checks and reports only, unless the AI policy allows auto-apply for that op class.
  - **Always a person:** a fixed list from the policy Nevers plus the people gates.
  - **Propose fixes (AI).** A dry run on a failed run's items.

  **Test:** R, M.
- [ ] U33 Model › Structure with Robot — `model/PaneStructRobot` (grows U25). **Robot Structural Analysis is
  installed on the pilot PC.** Guide:
  - **Step bar** (Check, Send, Loads, Run, Back).
  - **Check.** Uses `fmc_systems structural` (exists).
  - **Send.** Calls `fmc_robot send`, a new connector through Robot's COM API (RobotOM). It writes a WIP `.rtd` only.
  - **Loads and code form.** The engineer enters every value. No defaults, never AI (CLAUDE.md rule 5).
  - **Run analysis.** Calls `fmc_robot run`, enabled only when the form is complete.
  - **Results table.** Calls `fmc_robot results`, which writes the `FMC_FEA_NEd_kN`, `MEd_kNm`, `Utilisation` and `Run_Ref` fields in WIP. `FMC_FEA_Approval_Ref` is filled only by the engineer.
  - **What changed (AI).** Compares runs.
  - **Sign as engineer.** Records the signature in the log. Never automatic.

  **Test:** R with Robot on a `_ChainTests` structural model.
- [ ] U34 Manage › Reports › Data: Excel and Power BI — `manage/PaneData` (grows U21). Guide:
  - **Excel tables:**
    - door and window types;
    - room data sheet;
    - sheet register;
    - priced BOQ.

    Calls `fmc_data export/import`. Exports go to `01_WIP\Data`.
  - **Coming back from Excel.** Shows a dry run of the changes, flags values not in the kit, and applies in WIP only.
  - **Kit-in-Excel note.** Kit files change only by change request. Excel MCP writes go to staging copies.
  - **Power BI tiles:**
    - model health;
    - clashes;
    - cost;
    - procurement.

    Fed from the log and schedules. Built through Microsoft's Power BI authoring MCP when the owner has a licence (to confirm).
  - **Ask the dashboard (AI).**

  **Test:** M; Power BI part when a licence exists.
- [ ] U35 Coordinate › Clashes — `coord/PaneCoordClashes`. New **Coordinate** group in the Revit pane, `+Coord` tag
  (new module accent to add to the UI kit). Guide:
  - **Counts.** New, active and resolved.
  - **Clash matrix.** A discipline × discipline grid of open clashes per pair, worst pairs in red. Selecting a cell
    filters the list. Pairs, tests and tolerances come from the kit clash matrix (a new kit table, by change request).
  - **Groups by owner.**
  - **Clash card:**
    - **Show in Revit**;
    - **Assign** (a Review item);
    - **Mark tolerable**.
  - **Sort these clashes (AI)** and **Suggest a fix (AI).** Fixes are WIP-only, within the AI involvement policy. Structure, grids and levels are never touched. Openings and sleeves need the engineer.
  - **Send to Review.** Uses `fmc_review raise`.

  **Needs:** clash results from U36, or an imported Navisworks XML report until then.
- [ ] U36 Formcraft pane in Navisworks — `coord/PaneNavisworks`. **Waits:** Navisworks Manage isn't installed on the pilot PC.
  Plan:
  - Evaluate the open-source Navisworks MCPs (e.g. NavisWorksMaster, naviscoord-mcp) and use one as a reference or fork it, after a licence check.
  - Host the same shell in Navisworks.
  - **Federate.** NWCs from `02_Shared`.
  - **Clash matrix.** The kit's tolerances, a new kit table.
  - **Run now or nightly.**
  - **TimeLiner links.** Through `FMC_Task_ID`.
  - **Send clashes to Review.**
  - Navisworks never edits Revit models.
