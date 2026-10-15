# Formcraft Revit Tools: rules for Claude

This repo builds Formcraft's Revit plugin bundle (Core, Manage, Flow, Model, Build). It serves Master Manual
FMC-BIM-MAN-001 v2.2 and the Revit standard FMC-BIM-STD-002 v2.2. The kit lives in `Z:\00_Standards\` and in the
claude.ai Project "REVIT MCP".

## Hard rules (enforced by the server; never work around them)
1. **Live-model lock.** Model-changing tools run only on families, new unsaved documents and files in `_Staging`
   and `_ChainTests`. On a live project they are refused. Setup tools reach shared models only while the user's
   "Claude in shared models" toggle is on (D1). Only the user sets it.
2. **Files.** Writes go only to WIP and staging folders, never to `02_Shared`, `03_Published`, `04_Archive`,
   `05_Incoming` or `04_Families\<Role>`. Nothing is deleted: archive moves a file to `_Archive`.
   One exception (owner's approval, 15 Oct): a person's **Release** in the pane (Setup › Families › Quality and
   release) moves a family that passed Gate A from staging into `04_Families\<Role>`, with a reviewer, a note and a
   confirmation, and logs it in `04_Families\FMC_Release_Log.csv`. It is a pane-only command: no MCP tool or AI can
   release.
3. **Dry run first.** Every write shows a dry run and waits for a clear yes.
4. **Names** follow the kit: models `[Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt`, library
   families `FMC_[Role]_[CategoryToken]_[Description].rfa`, project families `[Project]_[Role]_…` (D4).
5. **Never decide for a professional**: no releases, gate approvals, structural sections, demand factors or signatures.
6. **Workshared models are never saved or synchronised by a tool.** The person does it in Revit.
7. **Kit data comes from the kit**, never from code. A missing value is a kit change request.
8. **Payments never happen in Revit.** The pane signs in and reads the licence; buying, renewals and invoices are on
   the Formcraft account website.
9. **Activity is never used to rank people** (Manual 14.5). Logs hold tools and results; Ask Claude logs tokens only.

## Before every push: read the test feedback
Findings from live tests in Revit (by the tester, Claude in the claude.ai Project) are GitHub issues labelled
`test-finding`, titled `F-NNN: …`; `docs/TEST_FEEDBACK.md` keeps the runs and a summary. Before every push, read the
open issues (`gh issue list -l test-finding`) and the newest run in the file. For a finding your push fixes, comment on
its issue with the PR, add the label `fixed-retest`, and set it to **Fixed – retest** in the file; for one you disagree
with or that needs the user, comment why, add `needs-user`, and set **Answered**. Never close a finding issue or
delete a finding: the tester closes it after a passing retest (so write `Touches #N`, never `Fixes #N`, in PRs). List
the findings you touch in the PR description, or say you touch none.

## After every merge: stage the build
CI does it: on a push to `main` the `stage` job on the pilot PC's runner builds the add-in, command set and server and drops them in `%ProgramData%\Formcraft\Staging\next` (`scripts/fmc-stage.ps1 -Target`); the updater moves the drop in. Run `scripts/fmc-stage.ps1` by hand only when CI is off (`CI_RUNNER=hosted`). The Formcraft Updater (a logon task)
installs it the next time Revit is closed and records it in `%APPDATA%\Formcraft\installed.json`. Neither the updater
nor Claude Code ever closes Revit.

## How work runs
- Plan first and wait for a yes before coding a step. Build phases in order (`docs/ROADMAP.md`).
- Every tool follows one pattern: server check → dry run → one Revit handler → log → pane.
- UI uses only the tokens and styles in `shell/Formcraft.Shell/Theme/FmcTheme.xaml` (`docs/UI_KIT.md`).
- The canvases are the design reference; `docs/SCREENS.md` maps each screen to its board.
- Keep tokens low: batch calls, ask for summaries, not element dumps.

## Branches
Treat `main` as protected: work on `feat/<step>` or `fix/<thing>` and open a pull request. CI must pass (shell, server, add-in). CI runs on the pilot PC's self-hosted runner
(`docs/CI_RUNNER.md`): checks queue while the PC is off, so a queued check is waiting, not failed.
GitHub can't enforce this on a private repo without a paid plan, so it is a rule we keep, not a lock: never push to `main` directly.
