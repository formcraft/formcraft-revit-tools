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
3. **Dry run first.** Every write shows a dry run and waits for a clear yes.
4. **Names** follow the kit: models `[Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt`, library
   families `FMC_[Role]_[CategoryToken]_[Description].rfa`, project families `[Project]_[Role]_…` (D4).
5. **Never decide for a professional**: no releases, gate approvals, structural sections, demand factors or signatures.
6. **Workshared models are never saved or synchronised by a tool.** The person does it in Revit.
7. **Kit data comes from the kit**, never from code. A missing value is a kit change request.
8. **Payments never happen in Revit.** The pane signs in and reads the licence; buying, renewals and invoices are on
   the Formcraft account website.
9. **Activity is never used to rank people** (Manual 14.5). Logs hold tools and results; Ask Claude logs tokens only.

## How work runs
- Plan first and wait for a yes before coding a step. Build phases in order (`docs/ROADMAP.md`).
- Every tool follows one pattern: server check → dry run → one Revit handler → log → pane.
- UI uses only the tokens and styles in `shell/Formcraft.Shell/Theme/FmcTheme.xaml` (`docs/UI_KIT.md`).
- The canvases are the design reference; `docs/SCREENS.md` maps each screen to its board.
- Keep tokens low: batch calls, ask for summaries, not element dumps.

## Branches
Treat `main` as protected: work on `feat/<step>` or `fix/<thing>` and open a pull request. CI must pass (shell, server, add-in).
GitHub can't enforce this on a private repo without a paid plan, so it is a rule we keep, not a lock: never push to `main` directly.
