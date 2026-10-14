# Status: built against plan and design

Checked 13 October 2026 against `docs/UI_DEVELOPMENT.md`, `docs/ROADMAP.md` and the boards in `design/boards/`.
Update this file whenever a step changes state.

## Plan

| Step | State | Note |
|---|---|---|
| U00 Repo, CI, running shell | Done | CI green on the first push: shell (net8 and net48), server tests, add-in for Revit 2025 |
| U01 UI kit in code | Done | PR #2: all kit styles, light and dark, theme follows Revit, Plex embedded, kit gallery, `tests/shell` (TUnit) |
| U02 Pane frame at full parity | Done | PR #3: header with Connected chip, Settings, Admin, Help; search box; tabs and section buttons with icons and module tags; quick tools; banner in three states; footer; dialog host; compact below 400 px |
| U03 Sections registry, parts switches, licence gating | Done | PR #4: `sections.json`, parts switches saved per person, licence gating, Structural section |
| U04 Search (Ctrl+K) | Done | PR #5: sections, actions, settings and help from `sections.json`; the board's three sample searches match row for row; keys; licence and parts |
| U05 Sign in and first-run setup | Done | PR #6: both boards built; code dialog; Microsoft/Google and offline licence file (mocked); kit check; four steps; choices saved |
| U06 Settings | Done | PR #7: Account, General and a tab per licensed module; every control on the six boards; saves and reloads; theme setting live; reset |
| U07 Admin | Done | PR #8: Team and roles, Licences and seats; every group on both boards; add/change/remove people, permissions, handover, invites, requests; audit log |
| U08 States | Done | PR #9: locked page, offline, grace over, not connected, kit missing, live model, Revit busy; the preview's State menu switches through all seven |
| U09 Updates and the Log file window | Done | PR #10: Settings › Updates; Log file window reading the tools' own CSV format; filters, open, copy row |
| U10 Host the shell in Revit; ribbon | Done (R test partial) | PR #11. In Revit 2025.4 (journal 0031) the add-in starts and the Core, Manage, Flow, Model and Build panels build with every button; the pane itself, its theme switch and the banner on a new model still need a person to look (Revit's unsigned add-in prompt and the Home screen need clicks): Formcraft pane registered beside the Formcraft Browser; Core panel and a panel per licensed module; theme follows Revit; banner from the guard; built for Revit 2025 |
| U11 A Revit MCP bridge for UI tests | In progress (M test open) | Branch `feat/u11-ui-bridge`: `fmc_ui` tool (get_state, open_section, set_mock_licence in test builds, screenshot_pane); shell, command set and server unit tests pass. The M test in Revit needs the Claude service started from the ribbon, which needs a person |
| U22 Flow (Touch part) | Done; Section box, previews, shortcuts to do | Touch engine (formerly TouchKit 0.2) moved into the repo (`touch/`) and started by the Formcraft add-in in Revit 2025+. Flow's gesture plan built: long press selects with a filling ring, two-finger tap opens the right-click menu, double tap zooms to fit, one finger pans in 2D and orbits in 3D, pinch zooms. Settings › Flow › Touch from board flow/PaneFlowTouch, live. Flow ribbon "Touch on" is the master switch; the Touch quick tool opens the page |
| U12 Connect wired to real checks | Done | Connect from board core/PaneConnect on live values: health check (Revit, guard, write roots, command set, MCP server, family specs, shared parameters, kit, rulebooks, licence, AI service) with fixes on the line; kit and rules; folders from fmc_guard.json; MCP service switch and probe; safety (D1 switch, locks); diagnostics zip and feedback |
| U13–U21, U23–U27 | To do | Next: U13 (Manage › Project) |
| Branch protection | Not available | GitHub needs a paid plan for protection on a private repo. Rule kept by convention (`CLAUDE.md`) |

## Shell code against its boards

| Screen (board) | Built | Differs from the board / missing | Fixed in |
|---|---|---|---|
| Theme (`core/UI_Kit`) | Every style on the board in every state, light and dark (dark follows Revit); IBM Plex embedded; kit gallery in the preview app | Drop-down (`FmcComboBox`, first needed in U05); Touch sizes (U22); dark values to be compared with Revit's own panels | U01 (open), U05, U10, U22 |
| Pane frame (`core/PaneShell`, `core/ResponsivePane`) | Every part of the frame on the boards, at 320–560 px, compact below 400 px, light and dark (U02) | Search finds nothing yet (U04); Connected chip and banner read mocks until the add-in hosts the pane (U10, U12); quick tools only report in the footer (U22); no section fills the footer yet (Stage C) | U04, U10, U12, U22 |
| Sections and parts (`core/Ribbon`, Settings boards) | 6 groups and 18 sections from `sections.json` (with board and part on each), parts switches per person, licence gating (U03) | Parts switches sit on the Settings page for now; the module tabs come in U06 and the ribbon parts switches in U10 | U06, U10 |
| Search (`core/UI_Palette`) | Sections, actions, settings and help; "sheet", "qa" and "level" return the board's groups and rows; arrows, Enter, Esc, Ctrl+K; licence and parts (U04) | Results by role (Admin roles, U07); actions only open their section until they are built (Stage C); help opens no guide yet | U07, Stage C |
| Sign in (`account/PaneSignIn`) | Everything on the board: email, password, keep me signed in, Microsoft and Google, forgot password, ask your admin, offline licence file (drop or choose), what signing in does, two-step code dialog (U05) | Microsoft, Google and the licence file are mocked until the licence service exists (D6, U17) | U17 |
| First-run setup (`account/PaneWelcome`) | Step bar; kit folder with its four checks; role (read-only) and disciplines; parts to show; tour and shortcuts switches; saved per person; skipped after the first time (U05) | Tour and the shortcuts import arrive later (the switches are saved); role is read from the account until Admin sets it (U07) | U07, later |
| Settings › Account (`account/PaneAccount`) | Every row on the board: you, your modules with status chips and dates, Request <module>, Enter a licence key dialog, this PC (seat, last check, offline days), check now, release seat, sign out, Ask Claude key and today's use (U06) | Today's Ask Claude tokens arrive with Ask Claude (U27); seat registration date with the licence service (U17) | U17, U27 |
| Other Settings tabs (`core/PaneSettings`, `*/PaneSettings*`) | General, Manage, Flow, Model, Build: every group and control on the boards; saved per person; locked rows stay locked; Works with follows the licence; Reset my settings and Apply shortcuts dialogs (U06) | Text size Large is saved but the pane doesn't scale yet; ribbon button choices take effect with the ribbon (U10); module settings feed their tools as those are built | U10, Stage C |
| Admin, seats (`core/PaneAdmin`, `account/PaneSeats`) | Both boards: you, team table with Add person / Change role / Remove dialogs, permissions by role with Edit and Reset, project settings, AI caps, automation, project data, modules and licences, audit log, handover, considerations; subscription, seats, people with invite, requests with Approve, rules (U07) | All on a mock: the team file comes with U12, seats and invites with the licence service (U17) | U12, U17 |
| States (`account/PaneStates`) | Locked page (what it adds, 14-day trial, ask your admin, see what it does, footer Start a trial); a banner for offline, grace over, not connected, kit missing and Revit busy with the board's words and one next step; live model in the document banner; typed input kept (U08) | Real offline and connection checks arrive with the licence service (U17) and Connect (U12) | U12, U17 |
| Updates, Log window (`account/PaneUpdates`, `core/UI_Log`) | Settings › Updates: installed, kit, channel, update that waits for Revit to close, release notes, rollback, guide, tour, support report, open the log, legal; Log file window: All / Pane clicks / Claude / Refused, today or all days, open the CSV or folder, copy a row for support (U09) | The update feed and the support report file come with the installer; From needs a `source` column in the tools' log (see decisions) | Installer, server |
| Ribbon in Revit (`core/Ribbon`, `*/R_*`) | Core (Pane, Connect AI, Log file) and a panel per licensed module: parts drop-down with ticks, two small buttons from Settings (Build: Workspace, Web app), icons from `resources/icons/png` (U10) | Small buttons open the pane where their tool will live; the old "Claude" panel stays until the pane covers it | Stage C |
| Pane in Revit | The Formcraft pane (ShellView) in its own dockable pane, tabbed with Properties on first run; theme from Revit (start and ThemeChanged); banner from GuardStatus.Verdict; Connected from the socket service; settings in %APPDATA%\Formcraft (U10). The Formcraft Browser stays reachable | Sign-in is still the mock (code 123456) until U17; workshared models show as live until "Claude in shared models" reaches the add-in; docking, floating and the live theme switch need a person at Revit to confirm | U17, R test |
| Revit MCP UI bridge | `fmc_ui`: get_state (screen, licence, group, section, settings tab, dialog, banner, footer, connection, document, theme, openable sections), open_section (section, "Group › Section", Connect, Settings › tab, Admin), set_mock_licence (presets and module statuses, test builds only), screenshot_pane (PNG to the reports folder) (U11) | Not yet run against Revit (M test) | Revit (M) |

## Navigation: code against canvas

| Item | Code | Canvas | Decision |
|---|---|---|---|
| Engineer group | Brief, Systems | Systems only (Start from brief is drawn as its own pane) | Keep Brief in code; add it to the canvas nav at the next board rebuild |
| Scripts | Check › Scripts, Model, `+Model` | Check › Scripts, `+Model` on the Scripts pane; Model column | Matched in this change |
| Header chip | "Connected" / "Not connected" (Revit service) | "Connected" | Matched in U02. Licence problems show in the state banners (U08) and Settings › Account, not in the header |
| Brief icon | Clipboard (`resources/icons/pane-brief.svg`) | None | Added in U02 and to `gen_panes.py` ICONS; appears on the canvas at the next board rebuild |
| Engineer › Structural | Section with an I-beam icon (`pane-structural.svg`), Model part Structural | Board `model/PaneModelStructural`, not in the canvas nav | Added in U03; add it to the canvas nav and ICONS at the next board rebuild |

## Decisions taken without a board answer (U05 onwards)

Each was decided during the unattended run on 13 October 2026 and can be overruled.

| Step | Decision | Why |
|---|---|---|
| U05 | The kit check reads the kit and rulebook versions from `FMC_Kit.json` at the kit root; the shared parameters file and `_Staging` folders follow `fmc_guard.example.json` | The boards show "FMC Kit v2.2" and "Rulebooks v0.2" but no file says where they live. If the real kit keeps them elsewhere it is a kit change request or a change to `FolderKitService` |
| U05 | Setup lets you go on when the kit isn't found; the hint says kit tools wait until it is | Blocking would stop anyone without the kit using the pane at all; the "kit missing" state is U08 |
| U05 | One step per page (the board draws step 2 with the bar); a step that is done can be opened again, a later one can't | "Four short steps" on the board |
| U05 | Setup runs once per PC and person (`setupDone` in settings.json); Settings changes everything later | Board: "Everything here can be changed later in Settings" |
| U05 | The 6-digit code is a dialog (board) that stays open with the error on a wrong code | Typed input is never lost (U08 rule) |
| U05 | Sample kit in `tests/shell/fixtures/kit`, marked as a sample everywhere it shows | No kit on the build PC; agreed before the run |
| U06 | Account is the first tab and Settings opens on the tab used last | Board account/PaneAccount: "Account and licence sit first in Settings" |
| U06 | Defaults where the board shows a sample state: tour again off, start-of-day card on, the first three "Tell me when" on, usage counts off, touch in view off, ghost preview on, all Tag Tidy rules on, view types Plans and 3D, systems Power, Small power and Lighting, links ARC and STR | Boards show one sample state; privacy-type switches default off |
| U06 | Settings save as you change them; Save in the footer confirms; Author's considerations save on Save | Board footers show Save; nothing typed is lost |
| U06 | Text size Large is stored only; scaling the pane comes later | Needs every size in the theme to become a live resource |
| U06 | "Revit user name" shows the Windows user name until Admin has the team file (U07) | No team file yet |
| U06 | Reset my settings resets every tab of the person's own settings | The board text names General, Manage and Flow (written before Model and Build tabs) |
| U07 | **Scheduled sync** (board core/PaneAdmin › Automation) is shown off and locked | CLAUDE.md rule 6: workshared models are never saved or synchronised by a tool. The board's switch conflicts with that rule; it stays locked until the rule changes. **Please confirm.** |
| U07 | "Claude in shared models" sits in Admin as on the board, default off | CLAUDE.md rule 1 says only the user sets it; an admin is a person. **Please confirm** whether each person or the admin sets it |
| U07 | People on the Admin boards appear as [NAME A]…[NAME E] / name.a… | The board shows real-looking sample names; placeholders avoid real people in code |
| U07 | Admin is two sections in one page: Team and roles, Licences and seats | Board account/PaneSeats is "Admin › Licences and seats" |
| U07 | Admin edits apply at once and go in the audit log; Save in the footer confirms | Every change is logged with who and when (board) |
| U08 | One state banner at a time, most urgent first: grace over, not connected, Revit busy, kit missing, offline | Several at once would bury the one next step the board asks for |
| U08 | "What it adds" for Manage, Flow and Build written from their boards (the states board only gives Model's) | Needed for the locked page of each module |
| U08 | Kit folder is now also in Settings › General › kit, where "kit missing" sends people | The board says "Point to the kit folder in Settings" |
| U09 | The log window reads the tools' real columns (timestamp, action, dry_run, target, result, detail). The board's **From** column needs a `source` column the tools don't write yet: the reader takes one if present and shows "—" otherwise, so Pane clicks / Claude filter empty on today's logs | **Follow-up for the server:** add `source` (Pane, Claude, Ask, Script) to `fmc_file.ts` and `fmc_family.ts` log rows |
| U09 | Kind comes from the row: refused → Refused, dry run → Dry run, plan/check → Check, list/read/info/statistics → Read, else Run | The board's Kind values |
| U09 | Updates is a tab of Settings (board: "Pane · Settings › Updates"); the shell has one version, 0.1.0, shown in General and Updates | One place for version and updates |
| U10 | The parts switch on the ribbon is a drop-down whose items toggle a part and show a tick | Revit's API has no checkbox in a split button |
| U10 | Each ribbon button has its own small command class (generated from sections.json) | A Revit command can't tell which button ran it |
| U10 | ~~The new pane is a second dockable pane named "Formcraft"; the "Formcraft Browser" pane and its "Claude" panel stay~~ Replaced on 2026-10-14 at your request: one add-in, one pane (next row) | U10 said the browser stays reachable until the shell covers it |
| U12 | "Claude in shared models" is each person's switch in Connect › Safety; Admin shows where it is, read-only. It takes effect with the setup tools (U13 on) | CLAUDE.md rule 1: only the user sets it. Closes the U07 question |
| U12 | The families and files page (formerly the Formcraft Browser) now shows under Setup › Families until U15 builds that section from its board | Its tools work today; Connect is now the board's own page |
| U12 | Send feedback saves `FMC_Feedback_<time>.txt` in the reports folder; diagnostics save `FMC_Diagnostics_<time>.zip` there, file paths replaced by &lt;path&gt; | There is no feedback service yet (comes with the account website) |
| U12 | Client Kit is a per-person choice from a sample list; new clients come from the account website | The board's "New client…" form belongs with client kits on the website |
| U22 | Where TouchKit 0.2 and the Flow boards differ, the boards win (you said Flow is the newer plan): long press selects (was right-click), two-finger tap is the right-click menu (new), single tap does nothing by default (was click), badges off by default, frame Studio Green #7FC7BE (was blue), 2 px | Boards flow/Flow_Gestures, flow/PaneFlowTouch, and TouchKit's own 0.3 decisions |
| U22 | Speeds are Gentle / Normal / Fast (0.6×, 1×, 1.6×) instead of free numbers | Board PaneSettingsFlow's Sensitivity control |
| U22 | Recognition timings (tap tolerance, long press time…) aren't in the pane; they keep their values and the reset leaves them | The boards don't show them; they are tuning for support, reached through the touch probe report |
| U22 | Views in background tabs never get touch or overlays; their switch is kept for when they come on screen | TouchKit 0.3 decision |
| U22 | Touch settings stay in %APPDATA%\Formcraft\TouchKit, so what people set in TouchKit 0.2 carries over | No one loses their settings |
| U22 | The Flow ribbon keeps its labels; "Touch on" toggles and the pane's status line says on or off | You asked for the ribbon as is |
| One plugin | The Formcraft Browser's page (Claude service, health, probe, families, files, activity, guard) is now the **Connect** page inside the Formcraft pane; its own pane and "Claude" ribbon panel are gone. Core has Pane, Connect AI, Claude service and Log file. The add-in is named "Formcraft" (`Formcraft.addin`, same add-in id) | You asked for one plugin. The page keeps its own look until U12 restyles it to the board; the Claude service button sits on Core because Connect needs a signed-in pane |
| U11 | "Test builds" for set_mock_licence means a Debug build of the add-in, or `FMC_UI_TEST=1` in Revit's environment; a Release build without it refuses | The step says "test builds only" without saying how a build is marked |
| U11 | open_section can open only what the pane lists (parts switched off are hidden); Admin is refused for non-admins, as in the pane | The tool must not reach anything a person couldn't click |
| U11 | The command set finds the pane by type name (`revit_mcp_plugin.Shell.UiBridgeHost`) and passes JSON, so neither assembly references the other | Two Revit add-in folders; a shared reference would load the shell twice |
| U11 | fmc_ui calls write nothing to the tools' log | It changes no file and no model; **Please confirm** if pane clicks by Claude should be logged too |

## Design files

- 54 boards in `design/boards/` (core 11, account 7, manage 18, flow 5, model 7, build 6).
- The "Every screen in the plugin" board still lists Scripts under Manage and doesn't list the account website;
  fix at the next board rebuild.
- Boards render only on the canvas. The kit gallery's PNGs (light and dark, 440 and 360 px) come from
  `Formcraft.Shell.Preview --snapshot`; CI uploads them as the `kit-snapshots` artifact. Since U02 the same artifact
  holds the signed-in pane at 440 and 360 px, light and dark, in each document state, and its dialog.
