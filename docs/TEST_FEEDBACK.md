# Test feedback: findings from live tests in Revit

This file is the feedback loop between the **tester** (Claude in the claude.ai Project "REVIT MCP", which tests the
plugin by driving Revit on the pilot PC with computer use) and **Claude Code** (which writes and pushes the code).

## The loop

1. **Tester** runs a live test in Revit and adds a new test run at the top of "Test runs", with one row per finding.
   Each finding gets an id (`F-NNN`) that never changes, and the state **Open**.
2. **Claude Code, before every push** (rule in `CLAUDE.md`), reads this file and the open findings:
   - For a finding the push fixes, set **Fixed in** to the commit or PR and the state to **Fixed – retest**.
   - For a finding it disagrees with, or that needs the user to decide, set the state to **Answered** and write why in
     **Reply**.
   - Untouched findings stay **Open**. Claude Code never deletes a finding or closes one itself.
   - In the PR description, list the findings the push touches (`Touches F-003, F-005`).
3. **Tester**, on the next run, retests every **Fixed – retest** finding: it becomes **Closed** if it now passes, or
   goes back to **Open** with a note if it doesn't.
4. If the user says "leave fixing" for a run, Claude Code reads it but changes nothing until the user says to start.

States: `Open` → `Fixed – retest` → `Closed` (or back to `Open`), or `Answered` (needs the user).

## Open findings at a glance

| Id | Severity | Area | Short | State |
|---|---|---|---|---|
| F-001 | Blocker | Install | Installed add-in is older than `main` (#29) | Open |
| F-002 | Blocker | AI connection | Connect AI doesn't start the listener; MCP gets "connect to revit client failed" | Open |
| F-003 | High | Kit / guard | Kit folder not set; `rulebooks_dir` points at `Z:\`, which doesn't exist on the pilot PC | Open |
| F-004 | Medium | Templates | Audit gives no visible result or message | Open |
| F-005 | Medium | Pane layout | Banners leave too little room for the page; mouse wheel barely scrolls | Open |
| F-006 | Low | Pane footer | A tool's footer message stays after switching to another tab | Open |
| F-007 | Info | U11 / M test | `fmc_ui` bridge still not run against Revit (blocked by F-001, F-002) | Open |

---

## Test runs

### Run 2026-10-14 · pilot PC · Revit 2025.4 · Project1 (new, unsaved) · Formcraft 0.1 (shell preview)

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
| F-001 | Blocker | The add-in in Revit is older than `main`: the button reads "Connect AI" (code since #29 sets "AI: on / AI: off", `RibbonBuilder.cs` l.61/84) and Team › Links is still a placeholder (U20 Links is done in STATUS). | The installed build matches the latest merged `main`. | Formcraft tab → look at Core panel; open Team › Links. | | | Open |
| F-002 | Blocker | Clicked Connect AI twice; the pane's chip stayed red; `fmc_ui get_state` and `get_current_view_info` both returned "connect to revit client failed". The server's error doesn't say what to click (also promised in #29). | One click starts the listener on 127.0.0.1, the chip goes green, the label reads "AI: on", MCP calls reach Revit. | Core › Connect AI, then any MCP tool. Likely fixed by installing #29 (F-001); retest after install. | | | Open |
| F-003 | High | Kit folder shows "Not set"; Run QA says "Rulebooks not readable at Z:\00_Standards\05_Rulebooks (rulebooks_dir in fmc_guard.json)". The pilot PC's kit is at `D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2` and has no Z: drive. | Guard and kit folder point at the real kit on the PC, or the pane offers to set them on first run. | Check › QA › Run QA. Probably a setup step for the user (set kit folder in Settings › General) plus a fix to `fmc_guard.json`; confirm with the user. | | | Open |
| F-004 | Medium | Setup › Templates › Audit: clicked, waited 6 s, no result, no footer message, no error. | A result list (Must / Should / Advice) or a reason why it can't run (e.g. kit not set, AI service off). | Setup › Templates → footer Audit, on a new unsaved project. | | | Open |
| F-005 | Medium | With "New model – not saved yet" and "Point to the kit folder in Settings" both shown, about 150 px is left for the page at this pane height; the mouse wheel moves the page only a few pixels per notch. | The page keeps most of the pane height (e.g. compact or collapsible banners, one banner at a time as in the U08 rule); normal wheel scroll steps. | Any section, pane docked at default height on a 1080p screen. | | | Open |
| F-006 | Low | After Run QA, its refusal text stayed in the footer on Engineer, Build, Team and Setup. | The footer note belongs to the section that wrote it and clears or changes when another section opens. | Check › QA › Run QA → open another tab. | | | Open |
| F-007 | Info | The `fmc_ui` M test (U11) couldn't run because MCP doesn't reach Revit. | Run `fmc_ui get_state`, `open_section`, `screenshot_pane` on the next test. | Blocked by F-001 and F-002. | | | Open |

#### Not tested this run
Write tools (Start, New file, Create missing, Apply look), Settings and Admin pages, Flow (Touch, Section Box, Tag
Tidy), Model panel buttons, Engineer › Systems and Structural, Setup › Families and Materials, Drawings › Annotate and
Issue. These are first on the next run once F-001 to F-003 are cleared.
