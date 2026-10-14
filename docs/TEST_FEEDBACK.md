# Test feedback: findings from live tests in Revit

This file is the feedback loop between the **tester** (Claude in the claude.ai Project "REVIT MCP", which tests the
plugin by driving Revit on the pilot PC with computer use) and **Claude Code** (which writes and pushes the code).

## The loop

Since 14 Oct each finding is also a GitHub issue labelled `test-finding` (title `F-NNN: …`), so fixes and replies
happen on the issue; this file keeps the runs and the summary. Labels: `fixed-retest` (a merged change should fix it),
`needs-user` (answered, waits for the user). Claude Code never closes a finding issue; the tester closes it after a
passing retest.

0. **Start of every run:** call `fmc_selftest`. It reports the build in Revit (and whether it matches the server),
   the AI connection, every command known to Revit, whether Revit may be closed, the guard's paths and the kit layout.
   Fix-first lines become findings; a "Ready to test" result means the run can go on.
1. **Tester** runs a live test in Revit and adds a new test run at the top of "Test runs", with one row per finding.
   Each finding gets an id (`F-NNN`) that never changes, and the state **Open**, and an issue.
2. **Claude Code, before every push** (rule in `CLAUDE.md`), reads this file and the open findings:
   - For a finding the push fixes, set **Fixed in** to the commit or PR and the state to **Fixed – retest**.
   - For a finding it disagrees with, or that needs the user to decide, set the state to **Answered** and write why in
     **Reply**.
   - Untouched findings stay **Open**. Claude Code never deletes a finding or closes one itself.
   - In the PR description, list the findings the push touches (`Touches F-003, F-005`).
3. **Tester**, on the next run, retests every **Fixed – retest** finding: it becomes **Closed** if it now passes, or
   goes back to **Open** with a note if it doesn't.
4. If the user says "leave fixing" for a run, Claude Code reads it but changes nothing until the user says to start.
5. **Installs** (decision of 14 Oct): after each merge Claude Code stages the build; the Formcraft Updater installs it
   when Revit is closed and never closes Revit itself. The tester may close Revit for an install only when every open
   document is new (never saved) and unchanged, as `fmc_selftest` → "Safe to close Revit for an install" reports;
   otherwise it asks the user. After reopening, `fmc_selftest` → "Add-in in Revit" shows the installed build.

States: `Open` → `Fixed – retest` → `Closed` (or back to `Open`), or `Answered` (needs the user).

## Open findings at a glance

| Id | Severity | Area | Short | State |
|---|---|---|---|---|
| F-001 | Blocker | Install | Installed add-in is older than `main` (#29) | Closed (run 2) |
| F-002 | Blocker | AI connection | Connect AI doesn't start the listener; MCP gets "connect to revit client failed" | Closed (run 2) |
| F-003 | High | Kit / guard | Kit folder set to the D: kit (run 3), but it still isn't a kit to the plugin → F-011 · #34 | Answered (step 1 done) |
| F-004 | Medium | Pane results | Audit and Issue › Run check give no visible result · #35 | Closed (run 4) |
| F-005 | Medium | Pane layout | Banners leave too little room; wheel barely scrolls · #36 | Closed (run 4) |
| F-006 | Low | Pane footer | A tool's footer message stays after switching sections · #37 | Closed (run 4) |
| F-007 | Info | U11 / M test | `fmc_ui` bridge run against Revit | Closed (run 2) |
| F-008 | High | Ribbon | The Formcraft ribbon tab doesn't open when clicked · #38 | Closed (run 5: not a plugin bug, see run 5) |
| F-009 | Medium | Server / tokens | `fmc_library scan` returns 428,000 characters for 346 families · #39 | Closed (run 7) |
| F-010 | Medium | Families scan | "Required FMC parameters" shows Pass for families with no kit spec · #40 | Fixed – retest |
| F-011 | High | Kit layout | The plugin's idea of a kit doesn't match the real kit on the PC · #41 | Closed for layout (run 5); schema → F-017 |
| F-012 | Medium | Search / banner | Search can't find the kit setting; the banner's Open Settings doesn't go to it · #42 | Fixed – retest |
| F-013 | Low | Updates page | Settings › Updates shows the sample feed as a real update · #43 | Closed (run 7) |
| F-014 | Medium | Sign-in | Sign-in isn't kept after Revit restarts with "Keep me signed in" on · #45 | Fixed – retest |
| F-015 | Low | QA rules | `fmc_qa rules` is silently empty when the rulebook folder has no books · #46 | Fixed – retest |
| F-016 | Low | Carried tools | `create_room` returns feet / sq ft while inputs are mm · #47 | Closed (run 7) |
| F-017 | High | Rulebooks | Kit rulebook schema ≠ plugin schema: all 344 rules become Advice, 0 can run · #49 | Closed (run 6) |
| F-018 | High | QA verdict | "No Must rule blocks the move" when 319 of 319 rules were Not checked · #50 | Closed (run 6) |
| F-019 | Medium | Project start | PST-002 subfolders (06_QA\Health…, 07_Cost\QTO…) aren't made · #55 | Fixed – retest |
| F-020 | Medium | Test loop | Sign-in bypass for the tester on the pilot PC (user's request) · #56 | Fixed – retest |
| F-021 | Low | Test loop | Clicks at Revit's top edge (tabs, window buttons) lost during tests; not a plugin bug · #59 | Open |
---

## Test runs

### Run 7 · 2026-10-14 (later) · pilot PC · Revit 2025.4 · build `a4e2e72`

**`fmc_selftest`: Ready to test** (add-in and server `a4e2e72`). The user opened Revit; the tester closed it (Exit
command after checking only a new, unsaved model was open; "Save changes?" → **No**).

| Id | Result | State |
|---|---|---|
| F-009 #39 | `fmc_library scan` → summary + 15 worst + `more` | Closed |
| F-016 #47 | `create_room` → `area_m2: 14.8`, `perimeter_mm: 15390` | Closed |
| F-013 #43 | "No update feed yet…", installed build shown | Closed |
| F-010 #40 | Pane: "Not checked · 346 (no kit spec: a person decides)" ✅; MCP `by_check` still `fail: 0` with no not-checked count | Open |
| F-012 #42 | Search "kit" finds **Kit folder** ✅; Enter opens General at the top, not at the field | Open |
| F-014 #45 | Licence kept after two restarts (`signed_in: true`) but the pane opens on **Sign in**; with no model, state reads "Live" | Open |
| F-020 #56 | Still needed: the tester can't get past Sign in without typing credentials | Open |
| New F-021 #59 | Clicks at the top edge of Revit (tabs, window buttons, right half) are lost during tests: not a plugin bug | Open (low) |

Also seen: the server's "not listening" error now says exactly what to click ("AI: off" → "AI: on", or
start_with_revit) — the #29 promise. Footer carry-over between Settings tabs noted on #37.

---

### Run 6 · 2026-10-14 (later) · pilot PC · Revit 2025.4 · build `6a6b61e`

**`fmc_selftest`: Ready to test** (20 pass, 3 warn: materials file, annotation standard, no `.rte` in 06_Templates).
Add-in and server both `6a6b61e`; 51 commands registered; "safe to close" correct. Info line "Ribbon updates: 3
updates, 21 changed the ribbon" reads oddly (more changes than updates).

| Id | Result | State |
|---|---|---|
| F-018 #50 | `fmc_qa run` → **Blocked**, `clear: false`, 3 pass / 8 fail / 305 not checked, "221 Must rules weren't checked either" | Closed |
| F-017 #49 | Must 233 / Should 83 / Advice 28; 11 rules run; the rest grouped in `not_checked_by_reason` | Closed |
| F-009 #39 | `fmc_qa` replies are summaries now; `fmc_library scan` not retested | Open |
| F-014 #45 | Not retested: the tester's relaunch of Revit failed in Autodesk licensing ("The License Manager is not running… Revit will shut down now") | Open |
| F-015 #46 | Not retested (the rulebook folder isn't empty any more) | Open |

**Project start test (user's request):** empty folder `D:\Fomcraft\FMC_PROJECTS_27\F26901_TestHouse` (made by the
tester on the user's behalf) → `fmc_project plan` → `start` dry run → `start` for real: 18 folders,
`01_WIP\FMC_Project.json`, models A S M E P named `F26901-FMC-ZZ-ZZ-M3-<Role>-0001.rvt` (5–10 MB) from Revit's metric
templates; Project Information in the A model: Name "Test House (3-bedroom bungalow)", Client "Formcraft (test)",
Number F26901, Status G2. `FMC_District` reported as not in the template (correct). New **F-019 #55**: the PST-002
subfolders aren't made. The test folder is left in place.

**Close / reopen:** Revit closed cleanly from the tester (`ExitRevit`, only an unchanged new document open). From the
next run on **the user opens Revit and the tester only closes it**. New **F-020 #56**: a sign-in bypass for the
tester on the pilot PC (user's request).

---

### Run 5 · 2026-10-14 (later) · pilot PC · Revit 2025.4 · build `03e0f0c`

**Installed build:** `03e0f0c` (updater.log: "Installed 03e0f0c (server: True)" at 10:20:27, backup kept);
`fmc_ui get_state` shows `build.commit = 03e0f0c`. `fmc_selftest` isn't offered yet: the Revit MCP connector in the
Claude app needs a restart to load the new server.
**Kit:** the tester copied the 11 rulebooks + index from the claude.ai Project into
`03_Master_Data\FMC_Rulebook\` (user's yes): 344 rules, counts per book and status match `FMC_Rulebook_Index.md`.

| Id | Result | State |
|---|---|---|
| F-001 #— | Core button now reads **"AI: on"** (last open part of F-001) | Closed |
| F-008 #38 | **Not a plugin bug.** At y≈36 clicks on every tab right of x≈950 were lost (ElectroBIM, FireBIM and Formcraft alike) while Structure and Enscape opened; at y≈43 the Formcraft tab opens with Core, Manage, Flow, Model. An invisible overlay (likely the tester's remote-control indicator) swallowed the clicks. | Closed |
| F-011 #41 | Rulebooks in place; `fmc_qa rules` reads 11 books, 344 rules, no problems | Layout done → F-017 |
| F-014 #45 | Seen again after the update and restart | Open |
| F-009 #39 | Same on `fmc_qa`: `rules` 120 k characters, `run` 93 k characters | Open |
| New F-017 #49 | Kit severities error/warning/info all map to **Advice**; kit `check.type` isn't a plugin `check.kind`, so nothing runs | Open (needs the user) |
| New F-018 #50 | `fmc_qa run` wip_to_shared: 319 of 319 **Not checked**, verdict "No Must rule blocks the move." | Open |

**Tester's note:** for clicks on the right half of Revit's tab row, aim a few pixels below the label (y≈43 on a
1456 × 819 frame).

---

### Run 4 · 2026-10-14 (later) · pilot PC · Revit 2025.4 · new unsaved models

**Repo at test time:** `main` @ `03e0f0c` (#44). **Installed build:** the one the updater installed when Revit closed
(add-in dated 10:08 local), which has #32 but not #44: no build stamp in `fmc_ui get_state`, no `fmc_selftest` tool.
**What ran:** a 3-bedroom house modelled through MCP in the unsaved Project1; Revit closed with **Don't save**; Revit
reopened (unsigned add-in prompt: **Load once**); new model from Imperial Multi-discipline; the user signed in by hand.

#### MCP modelling test: 3-bedroom bungalow, 13 × 10 m, L1

| Step | Tool | Result |
|---|---|---|
| Family types | `get_available_family_types` | ✅ walls, doors, windows, floors, roofs (the 60-row limit cut off floors on the first call) |
| 4 exterior walls (Brick on Wood Stud), 6 interior partitions | `create_line_based_element` | ✅ 10 walls |
| 8 doors (front, hall, 3 bedrooms, bath, kitchen) | `create_point_based_element` with `hostWallId` | ✅ 8 hosted |
| 11 windows (sills 900–1500 mm) | `create_point_based_element` | ✅ 11 hosted |
| Slab and roof | `create_surface_based_element` | ✅ 1 floor, 1 roof |
| 7 rooms (Living/Dining, Kitchen, Hall, Bedroom 1–3, Bathroom) | `create_room` | ✅ all closed, 120.3 m² in total · ⚠️ F-016 units |
| Check | `send_code_to_revit` (read-only count) | ✅ Walls 10, Doors 8, Windows 11, Rooms 7, Floors 1, Roofs 1, **0 warnings** |
| Close | Revit close → "Save changes to Project1?" → **No** | ✅ nothing saved |

#### Retest

| Id | Result | State |
|---|---|---|
| F-004 #35 | Templates › Audit → footer "The kit has no templates to audit."; Issue › Run check → "Choose the sheet register in Drawings › Sheets first." | Closed |
| F-005 #36 | 5 wheel notches ≈ one screen; with one banner the page keeps most of the pane | Closed |
| F-006 #37 | Footer resets on every section change and after sign-in | Closed |
| F-008 #38 | Still doesn't open, but #44 (the fix) wasn't installed | Fixed – retest |
| F-011 #41 | `FMC_Kit.json` r4 is in the kit and the kit banner is gone; `03_Master_Data\FMC_Rulebook\` has only `_README.txt`, so QA refuses "The kit's rulebooks have no rules" | Answered (user to copy the rulebooks) |

#### New findings (run 4)

| Id | Severity | Short | Issue |
|---|---|---|---|
| F-014 | Medium | Sign-in isn't kept after Revit restarts with "Keep me signed in" on | #45 |
| F-015 | Low | `fmc_qa rules` is silently empty when the rulebook folder has no books (`run` refuses correctly) | #46 |
| F-016 | Low | `create_room` returns feet / sq ft while inputs are mm | #47 |

#### Not tested this run
`fmc_selftest` and the build stamp (#44 not installed), F-009, F-010, F-012, F-013 (no fix yet), QA with real rules
(rulebooks not copied).

---

### Run 3 · 2026-10-14 (later) · pilot PC · Revit 2025.4 · Project1 (new, unsaved)

**Repo at test time:** `main` @ `d084eac` (#32, "Fix F-004 to F-006"). **Installed build:** the run 2 build: #32 is
merged but not installed (F-006 still shows: "Saved…" from Settings stayed in the Templates footer).
**Done with the user's yes:** Settings › General › kit folder set to `D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2`
and saved. Nothing in the model was changed.

#### Retest

| Id | Result | State |
|---|---|---|
| F-003 | Step 1 of Claude Code's answer done: kit folder set and saved. "Check the kit again" still says "No kit found here: kit tools wait until it is." Cause in F-011. | Answered (step 1 done) |
| F-004, F-005, F-006 | Not retestable: #32 isn't installed in Revit yet. Wheel still about 1–2 px per notch (60 notches moved the Settings page about 80 px). | Fixed – retest |
| F-008 | Clicked the Formcraft tab label again: Revit stays on the current tab. | Open |

#### New findings (run 3)

| Id | Severity | What happened | Expected | Steps | Fixed in | Reply | State |
|---|---|---|---|---|---|---|---|
| F-011 | High | The kit folder on the PC is right, but `KitService` only counts a folder as a kit if `FMC_Kit.json` is at its root, and the real kit has none. Listing `D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2`: `_build`, `01_Shared_Parameters`, `02_Keynotes`, `03_Master_Data` (Family Register, Family Specs, Master Data .json/.xlsx, Revit Kit .xlsx, Sheet Register), `04_Families`, `05_Scripts`, `06_Templates` (only `_README.txt`), `07_IFC_IDS` … `11_Brand`, `README.md`. Missing against what the plugin expects: `FMC_Kit.json`, rulebooks (`05_Rulebooks` in the guard; in the kit `05_` is `05_Scripts`, and the claude.ai Project's copy keeps rulebooks in `03_Master_Data\FMC_Rulebook\`, which the PC doesn't have yet), `04_Families\_Staging`, `06_Templates\_Staging`, any `.rte`, the annotation standard and the materials database. | The plugin and the kit agree on one layout. Either a kit update (r4) adds `FMC_Kit.json`, the rulebooks and the `_Staging` folders, or the plugin reads the kit as it is (e.g. versions from `README.md`/`FMC_Master_Data.json`, rulebooks from `03_Master_Data\FMC_Rulebook`). | Settings › General › kit folder = the path above → Check the kit again. | Kit r4 on the pilot PC (14 Oct): FMC_Kit.json, 03_Master_Data\FMC_Rulebook\, 04_Families\_Staging, 06_Templates\_Staging; fmc_guard.json rulebooks_dir points there | The user chose the kit change (r4). The rulebook files themselves are only in the claude.ai Project: the tester copies them into 03_Master_Data\FMC_Rulebook\ (fmc_selftest says when the folder has .json files). No .rte templates, annotation standard or materials database yet: fmc_selftest lists them as Warn | Answered |
| F-012 | Medium | The banner says "Point to the kit folder in Settings", but pane search finds nothing for "kit" or "kit folder" ("Try: sheet, qa, level"), and the banner's Open Settings opens the top of General; the field is in "General · kit", several screens down. With F-005 it took six scrollbar drags to reach it. | Search finds settings by name (at least the kit folder), and Open Settings on the kit banner lands on the kit field with focus. | Kit missing → type "kit" in Find…; or click Open Settings on the banner. | | | Open |
| F-013 | Low | Settings › Updates › Check for updates says "Update 0.1.1 is available" with "Update when Revit closes", "Release notes" and "Roll back to 0.0.9 (sample)". It's the sample feed (the real feed comes with the installer, STATUS U09), but only the rollback line says "sample". I didn't click Update. | Until the feed is real, label the whole card as a sample, or say "No update feed yet: updates come from the installer". | Settings › Updates → Check for updates. | | | Open |

#### Not tested this run
Everything that needs the kit (QA run, Rules, Templates audit, Sheets compare, Annotate, Families against specs) waits for
F-011. #32's fixes (F-004 to F-006) wait for the new build to be installed on the PC.

---

### Run 2 · 2026-10-14 (later) · pilot PC · Revit 2025.4 · Project1 (new, unsaved) · Formcraft 0.1 (shell preview)

**Repo at test time:** `main` @ `996855c` (#31). A newer build was installed on the PC between runs (Team › Links is
built; the AI connection answers).
**How:** the Revit MCP tools and the `fmc_ui` bridge from claude.ai, plus computer use for the clicks. The user signed
in (test sign-in) by hand. Only read-only tools were run; nothing in the model was changed.

#### Retest of run 1

| Id | Result | State |
|---|---|---|
| F-001 | New build is installed: Team › Links is the real page (coordinates, audit, Link…, Pin all). The "AI: on/off" label couldn't be checked because of F-008. | Closed |
| F-002 | The pane chip is green and every MCP call reached Revit (`fmc_ui`, `fmc_file list_open`, `get_current_view_info`, `analyze_model_statistics`, `fmc_qa rules`, `fmc_library scan`). | Closed |
| F-003 | Unchanged: kit banner on every page; `fmc_qa rules` → "Rulebooks not readable at Z:\00_Standards\05_Rulebooks". | Open |
| F-004 | Still no visible result. Cause from the code (`shell/Formcraft.Shell/ViewModels/TemplatesPage.cs`, `Audit()`): with no kit, `library.Count == 0` returns early and only calls `_auditMessages.Show(...)` inside the "Audit a template" group lower on the page; `_status(...)` (the footer) isn't called on that path. Same symptom on Drawings › Issue › Run check (no change after 8 s). | Open |
| F-005 | Not retested (same banners shown). | Open |
| F-006 | Seen again: after signing in, the footer still said "Without a seat only Connect, Log file and Help are available."; the Links footer ("0 links in Project1.rvt…") stayed on Templates and Families. | Open |
| F-007 | Bridge works in Revit: `get_state` (signed out and in), `open_section` (Team › Links, Setup › Templates, Setup › Families, Drawings › Issue, Engineer › Systems, Settings › General), `screenshot_pane` (PNG saved to `%USERPROFILE%\FMC_Reports`). `set_mock_licence` refuses on a release build with a clear message, as designed. `open_section` before sign-in refuses with "Sign in and finish set-up first", also as designed. | Closed |

#### Result per screen (run 2)

| Screen | Result |
|---|---|
| Sign in · Work offline | ✅ Without a seat, the footer says only Connect, Log file and Help work |
| Formcraft ribbon tab | ❌ F-008 |
| Team › Links | ✅ Coordinates read (FMC_CRS not set, origin E0 N0, 0.00°, Default Site); footer "0 links in Project1.rvt, all as the Manual asks." |
| Setup › Templates › Audit | ❌ F-004 |
| Setup › Families › Scan file | ✅ 346 scanned, 0 compliant, 346 need a person; footer updated · ⚠️ F-010 |
| Drawings › Issue › Run check | ❌ No visible result (F-004 pattern) |
| Engineer › Systems | ✅ Opens (no footer actions yet) |
| Settings › General | ✅ Tabs Account, General, Manage, Flow, Model, Updates; modules list with licence chips |

#### New findings (run 2)

| Id | Severity | What happened | Expected | Steps | Fixed in | Reply | State |
|---|---|---|---|---|---|---|---|
| F-008 | High | Clicking the "Formcraft" ribbon tab (4 tries, on the label) leaves the current tab active. Structure, Add-Ins and the other tabs switch normally. In run 1 (older build) the same tab opened. | The Formcraft tab opens and shows Core, Manage, Flow, Model. | Revit 2025.4 with the new build, signed in or out → click the Formcraft tab. Check the journal for an exception while building the tab or its panels (a tab with no panels can't be selected). | Selftest and updater PR (this push) | Likely cause: RibbonBuilder.Update() ran on every settings change (a keystroke in the pane saves one) and re-wrote every panel, label and icon, so Revit re-laid the ribbon over and over, which can swallow a tab click. It now writes only what differs. fmc_selftest shows "Ribbon updates": how often it ran and how often it changed the ribbon, so the retest can confirm it | Fixed – retest |
| F-009 | Medium | `fmc_library scan` returned 428,144 characters (13,874 lines) for a new project from the Systems template: about 1.2 KB per family × 346. Too big for a Claude call (CLAUDE.md: "summaries, not element dumps"). | A summary by default (counts, by_check, worst N families), with a `limit` or `detail` option for the full list. | `fmc_library` action `scan` on a new project from the Systems template. | | | Open |
| F-010 | Medium | Families scan: "Required FMC parameters present (by GUID)" is Pass with 0 fails, but none of the 346 Revit default families has a spec in `FMC_Family_Specs.json`, and the kit isn't even set (F-003). | "Not checked" (with the reason: no spec or no kit), never Pass. STATUS U16 rule: "A rule QA can't run shows as Not checked … never as a pass"; U15: a family with no spec "needs a person". | Setup › Families › Scan file with no kit set. | | | Open |

#### Not tested this run
Write tools (Start, New file, Create missing, Apply look, Bring in, Link, Pin all), Drawings › Sheets and Annotate,
Check › Rules, Reports and Scripts, Team › Workshare, Setup › Materials, Admin, Flow quick tools. First on the next run,
once F-003 (kit folder) and F-008 (ribbon tab) are cleared.

---

### Run 1 · 2026-10-14 · pilot PC · Revit 2025.4 · Project1 (new, unsaved) · Formcraft 0.1 (shell preview)

**Repo at test time:** `main` @ `171009c` (#29, AI connection switch).
**How:** computer use on the open Revit (clicks visible on the real cursor), plus the Revit MCP tools from claude.ai.
**Model:** new unsaved project; nothing in the model was changed. Only read-only tools were run (QA, Audit).

#### Result per screen

| Screen | Result |
|---|---|
| Ribbon › Formcraft (Core, Manage, Flow, Model) | Builds with every button |
| Core › Connect AI | ❌ F-001, F-002 |
| Setup › Project | ✅ Fields, Browse, Check, Start (dry run), Preview present |
| Setup › Templates | ✅ Page and fields present · ⚠️ Audit F-004 |
| Drawings › Sheets | ✅ Stage, issue set, role chips, Compare, Create missing (dry run) |
| Team › Review | ✅ Placeholder "built in phase 3" (correct, not built) |
| Team › Links | ❌ Placeholder "built in phase 3", but STATUS has U20 Links done → F-001 |
| Check › QA › Run QA | ✅ Refused cleanly with the reason (rulebooks not readable) → cause F-003 |
| Engineer › Brief | ✅ Placeholder (correct) |
| Build | ✅ Locked page "not on your licence", trial and ask-admin buttons |
| Connect page (health check) | ✅ Lists guard, write roots (3 of 4), command set, MCP server, specs, shared parameters, kit (Not set), licence (Team), AI service (Not used yet) |

#### Findings

| Id | Severity | What happened | Expected | Steps | Fixed in | Reply | State |
|---|---|---|---|---|---|---|---|
| F-001 | Blocker | The add-in in Revit is older than `main`: the button reads "Connect AI" (code since #29 sets "AI: on / AI: off", `RibbonBuilder.cs` l.61/84) and Team › Links is still a placeholder (U20 Links is done in STATUS). | The installed build matches the latest merged `main`. | Formcraft tab → look at Core panel; open Team › Links. | Installed 14 Oct 09:32 from `main` @ `9fd6865` (#27–#30); backup `_FormcraftBackup\2026-10-14_0932_before-links-connect` | Revit was reopened before the install watcher saw it closed, so the old build stayed. Connect will show the installed build next (proposed) | Closed (run 2) |
| F-002 | Blocker | Clicked Connect AI twice; the pane's chip stayed red; `fmc_ui get_state` and `get_current_view_info` both returned "connect to revit client failed". The server's error doesn't say what to click (also promised in #29). | One click starts the listener on 127.0.0.1, the chip goes green, the label reads "AI: on", MCP calls reach Revit. | Core › Connect AI, then any MCP tool. Likely fixed by installing #29 (F-001); retest after install. | #29 (one-click switch, "AI: on/off", on at start-up, 127.0.0.1, error says what to click) and #30 (commandRegistry.json was missing every command added since U16) | The log showed the listener was never started after 04:14: Connect AI only opened the Connect page when signed in. Expect "AI: on" right after Revit starts | Closed (run 2) |
| F-003 | High | Kit folder shows "Not set"; Run QA says "Rulebooks not readable at Z:\00_Standards\05_Rulebooks (rulebooks_dir in fmc_guard.json)". The pilot PC's kit is at `D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2` and has no Z: drive. | Guard and kit folder point at the real kit on the PC, or the pane offers to set them on first run. | Check › QA › Run QA. Probably a setup step for the user (set kit folder in Settings › General) plus a fix to `fmc_guard.json`; confirm with the user. |  | Not a code fault: the kit on this PC has no rulebooks, annotation standard or materials database, so QA refusing is right. The user decides: (1) set the kit folder in Settings › General to D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2; (2) where the rulebooks live and their format (still open in STATUS), then `rulebooks_dir` in fmc_guard.json points there | Answered |
| F-004 | Medium | Setup › Templates › Audit: clicked, waited 6 s, no result, no footer message, no error. | A result list (Must / Should / Advice) or a reason why it can't run (e.g. kit not set, AI service off). | Setup › Templates → footer Audit, on a new unsaved project. | PR "Fix F-004 to F-006" (this push) | With no kit folder the kit has no templates, so Audit stopped with a note inside the Audit group, off screen. Every tool that stops early now also says why in the footer (19 places) | Fixed – retest |
| F-005 | Medium | With "New model – not saved yet" and "Point to the kit folder in Settings" both shown, about 150 px is left for the page at this pane height; the mouse wheel moves the page only a few pixels per notch. | The page keeps most of the pane height (e.g. compact or collapsible banners, one banner at a time as in the U08 rule); normal wheel scroll steps. | Any section, pane docked at default height on a 1080p screen. | PR "Fix F-004 to F-006" (this push) | Wheel: a normal step per notch (about 64 px), and a table at its end hands the wheel to the page. Banners: while a state banner shows, the document banner keeps one line; its detail is in the tooltip | Fixed – retest |
| F-006 | Low | After Run QA, its refusal text stayed in the footer on Engineer, Build, Team and Setup. | The footer note belongs to the section that wrote it and clears or changes when another section opens. | Check › QA › Run QA → open another tab. | PR "Fix F-004 to F-006" (this push) | Opening another section resets the footer | Fixed – retest |
| F-007 | Info | The `fmc_ui` M test (U11) couldn't run because MCP doesn't reach Revit. | Run `fmc_ui get_state`, `open_section`, `screenshot_pane` on the next test. | Blocked by F-001 and F-002. | | | Closed (run 2) |

#### Not tested this run
Write tools (Start, New file, Create missing, Apply look), Settings and Admin pages, Flow (Touch, Section Box, Tag
Tidy), Model panel buttons, Engineer › Systems and Structural, Setup › Families and Materials, Drawings › Annotate and
Issue. These are first on the next run once F-001 to F-003 are cleared.
