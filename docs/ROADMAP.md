# Roadmap

Build in order. A phase starts only after the previous one has run on the pilot PC (Revit 2025).

| Phase | What | Done when |
|---|---|---|
| 0 | New repo, CI for shell, server and add-in | CI green on `main` |
| 1 | **Shell on mock data**: theme, pane frame, groups and sections, search (Ctrl+K), Settings tabs (Account, General, Manage, Flow, Model, Build), sign-in, first-run setup, Admin › Licences and seats, locked/offline/error states, Updates, Log file window, ribbon (Core + one panel per module, parts switches). Host the shell in the Revit dockable pane | Every screen in `docs/SCREENS.md` (Core and Account columns) opens in Revit on mock data |
| 2 | Real licence service (D6) behind `ILicenceService`; Manage first sections wired to the carried tools: Project, Templates, Families (`fmc_file`, `fmc_family`), QA, Rules | Pilot project started and checked from the pane |
| 3 | Manage rest (Materials, Sheets, Annotate, Issue, Review, Workshare, Links, Reports, Scripts) and Flow (Touch, Sheet Layout, Tag Tidy, Section box, shortcuts) | Pilot sheets issued through the pane |
| 4 | Model: Start from brief (Concept Information Set into a new model) | A concept booklet becomes a new model with levels, rooms and finishes |
| 5 | Model: MEP systems, structural checks around the Robot link, quantities | Pilot E and S models checked |
| 6 | Build: pane, workspace window, coloured Revit views, web workspace | A QS prices the pilot BoQ in Revit |

Every tool follows one pattern: server check → dry run → one Revit handler → log → pane.
