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
| F-004 | Medium | Pane results | Audit and Issue › Run check give no visible result · #35 | Fixed – retest (#32 not installed yet) |
| F-005 | Medium | Pane layout | Banners leave too little room; wheel barely scrolls · #36 | Fixed – retest (#32 not installed yet) |
| F-006 | Low | Pane footer | A tool's footer message stays after switching sections · #37 | Fixed – retest (#32 not installed yet) |
| F-007 | Info | U11 / M test | `fmc_ui` bridge run against Revit | Closed (run 2) |
| F-008 | High | Ribbon | The Formcraft ribbon tab doesn't open when clicked · #38 | Fixed – retest |
| F-009 | Medium | Server / tokens | `fmc_library scan` returns 428,000 characters for 346 families · #39 | Open |
| F-010 | Medium | Families scan | "Required FMC parameters" shows Pass for families with no kit spec · #40 | Open |
| F-011 | High | Kit layout | The plugin's idea of a kit doesn't match the real kit on the PC · #41 | Answered (kit r4 shipped; rulebook files to copy) |
| F-012 | Medium | Search / banner | Search can't find the kit setting; the banner's Open Settings doesn't go to it · #42 | Open |
| F-013 | Low | Updates page | Settings › Updates shows the sample feed as a real update · #43 | Open |
---

## Test runs

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
