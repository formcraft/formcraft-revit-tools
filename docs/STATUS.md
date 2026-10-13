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
| U05 Sign in and first-run setup | In progress | Branch `feat/u05-signin-first-run`: both boards built; code dialog; Microsoft/Google and offline licence file (mocked); kit check; four steps; choices saved |
| U06–U27 | To do | Next: U06 (Settings: Account, General, Manage, Flow, Model, Build) |
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
| Settings › Account (`account/PaneAccount`) | Who you are, module table with status and dates, offline days, check now, release seat, sign out, payments note | Settings tabs bar, request a module, licence key dialog, seat name, Ask Claude tokens | U06 |
| Other Settings tabs (`core/PaneSettings`, `*/PaneSettings*`) | — | General, Manage, Flow, Model, Build tabs | U06 |
| Admin, seats (`core/PaneAdmin`, `account/PaneSeats`) | — | Everything | U07 |
| States (`account/PaneStates`) | Locked module page with trial and ask-admin buttons | "See what it does"; offline, grace over, not connected, kit missing, live model, Revit busy | U08 |
| Updates, Log window (`account/PaneUpdates`, `core/UI_Log`) | — | Everything | U09 |
| Ribbon in Revit (`core/Ribbon`, `*/R_*`) | Old fork ribbon still in the add-in | Five panels, parts switches, new icons (PNG ready in `resources/icons/png`) | U10 |
| Pane in Revit | Old `FormcraftBrowserPage` still hosted | Shell not yet hosted in the dockable pane | U10 |
| Revit MCP UI bridge | Carried read-only tools work | `fmc_ui` tool | U11 |

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

## Design files

- 54 boards in `design/boards/` (core 11, account 7, manage 18, flow 5, model 7, build 6).
- The "Every screen in the plugin" board still lists Scripts under Manage and doesn't list the account website;
  fix at the next board rebuild.
- Boards render only on the canvas. The kit gallery's PNGs (light and dark, 440 and 360 px) come from
  `Formcraft.Shell.Preview --snapshot`; CI uploads them as the `kit-snapshots` artifact. Since U02 the same artifact
  holds the signed-in pane at 440 and 360 px, light and dark, in each document state, and its dialog.
