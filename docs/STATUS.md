# Status: built against plan and design

Checked 13 October 2026 against `docs/UI_DEVELOPMENT.md`, `docs/ROADMAP.md` and the boards in `design/boards/`.
Update this file whenever a step changes state.

## Plan

| Step | State | Note |
|---|---|---|
| U00 Repo, CI, running shell | Done | CI green on the first push: shell (net8 and net48), server tests, add-in for Revit 2025 |
| U01 UI kit in code | Done | PR #2: all kit styles, light and dark, theme follows Revit, Plex embedded, kit gallery, `tests/shell` (TUnit) |
| U02–U27 | To do | Next: U02 (pane frame at full parity) |
| Branch protection | Not available | GitHub needs a paid plan for protection on a private repo. Rule kept by convention (`CLAUDE.md`) |

## Shell code against its boards

| Screen (board) | Built | Differs from the board / missing | Fixed in |
|---|---|---|---|
| Theme (`core/UI_Kit`) | Every style on the board in every state, light and dark (dark follows Revit); IBM Plex embedded; kit gallery in the preview app | Drop-down (`FmcComboBox`, first needed in U05); Touch sizes (U22); dark values to be compared with Revit's own panels | U01 (open), U05, U10, U22 |
| Pane frame (`core/PaneShell`, `core/ResponsivePane`) | Header, orange line, search box (not working), group tabs, section buttons with module tag, document banner, footer status | Admin button; "Connected" chip for the Revit/Claude service (the header now shows licence state only); section icons; quick tools strip; footer action buttons; dialog host; banner's shared and live states; compact layout below 400 px | U02, U12 |
| Sections and parts (`core/Ribbon`, Settings boards) | 6 groups, 17 sections, module and phase on each, licence gating | Registry is in code, not a config file; parts switches; per-person settings | U03 |
| Search (`core/UI_Palette`) | — | Everything | U04 |
| Sign in (`account/PaneSignIn`) | Email, password, two-step code, Microsoft button, work offline, privacy line | Google button, forgot password, ask your admin, offline licence file drop, "what signing in does" checks | U05 |
| First-run setup (`account/PaneWelcome`) | Kit folder step | Steps 1–4 bar, kit checks, role and disciplines, parts to show, tour and shortcuts | U05 |
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
| Header chip | "Signed in" / "Not signed in" | "Connected" (Revit service) | Both appear after U02; licence and connection are separate states |

## Design files

- 54 boards in `design/boards/` (core 11, account 7, manage 18, flow 5, model 7, build 6).
- The "Every screen in the plugin" board still lists Scripts under Manage and doesn't list the account website;
  fix at the next board rebuild.
- Boards render only on the canvas. The kit gallery's PNGs (light and dark, 440 and 360 px) come from
  `Formcraft.Shell.Preview --snapshot`; CI uploads them as the `kit-snapshots` artifact.
