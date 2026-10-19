# Plan: engineering services

**Status: Approved, 19 October 2026 (owner's yes).** Steps E0–E4. Tracker rows F77–F80; the older "MEP sizing and design
tools" row (F35) now points here.

## The idea
Formcraft prepares an engineer's work on the building services and structure; the engineer decides and signs. Each
building system (power distribution, lighting, drainage, structure…) gets the same seven capabilities, and we say
honestly, cell by cell, how far each one has got:

| Capability | What it means |
|---|---|
| Enrich | Fill the kit's data on the model's elements (loads, ratings, flows, marks) |
| Size | Propose sizes (cables, breakers, pipes, ducts, plant) as drafts; the engineer decides |
| Diagram | Draw the system's line diagram from the model, values from the model only |
| Calculate | Run the kit's calculation on the model's facts; a calc sheet with TBC where data is missing |
| Review | Check the model and the results read-only and list what is wrong or missing |
| Quantities | Schedules and quantities that feed the BoQ and procurement |
| Document | Sheets from the Sheet Register, ready to issue |

23 systems × 7 capabilities = 161 cells. The grid lives in **one file**, [`docs/tracker/mep_matrix.json`](tracker/mep_matrix.json).

## The rules that don't move
- **Rule 5: never decide for a professional.** Formcraft never picks a demand factor, a size or a structural section,
  and never signs. Everything it proposes is a draft with the engineer's name left empty.
- **Rule 7: kit data comes from the kit.** When the kit is missing a value (a parameter, a calculation, a sheet row),
  the plugin drafts a **kit change request** with the values marked **"assumed"** (owner's choice, 19 Oct). A person
  approves the request before any of those values are used.
- Read the model, never change it, unless the step says so; then dry run first and the live-model lock as everywhere.
- Each step gets an **unattended Revit scenario** in `tests/revit`, so it is checked in Revit without anyone watching
  (`docs/TESTING.md`). A cell moves to "Tested in Revit" only after a passing run on a real model.

## Steps
| Step | What | Done when |
|---|---|---|
| E0 | **The grid.** `docs/tracker/mep_matrix.json` (`fmc-mep-matrix/0.1`): every cell's state, the files that build it, its tracker row and the step that fills it. The pane (Engineer › Systems), the build tracker and the Master Board read it; `fmc_systems matrix` returns the counts. Nothing is counted by hand | The board shows the counts from the file, not a typed number |
| E1 | **Calculations from the kit.** The kit's calculations (Calculations tab of `FMC_Revit_Kit.xlsx`: CA-E-01 maximum demand, CA-E-02 voltage drop, CA-E-03 lighting levels, CA-M-01 cooling, CA-M-02 ventilation, CA-P-01 water, CA-P-02 drainage, CA-P-03 rainwater, CA-FP-01 extinguishers, CA-FP-02 hose reels, CA-LP-01 lightning protection, CA-LP-02 earth resistance) ported to code. They read the Revit facts read-only, and write calc sheets to the project's `01_WIP` with **TBC** wherever data is missing. Demand factors, the LPS class and other judgements are the engineer's inputs, never defaults. The engineer signs | Each calculation runs on the pilot model and matches the kit's own sheet on the same numbers |
| E2 | **Line diagram sheets (LD5).** The diagrams already drawn by `fmc_diagram` (LD1–LD4) go onto the sheets the Sheet Register asks for: E-0003 single-line diagram and load summary, E-0004 earthing and bonding, E-6002 riser diagram, P-0003 water and drainage schematics. Gate D in QA compares each diagram with the model; a **Generate** button in the pane; the drainage long section | The four sheets come out of a real model and pass Gate D |
| E3 | **Electrical enrich and sizing in the plugin.** FormCraft Electrical 0.1 (built outside this repo) fills load data, sizes feeders and checks voltage drop, but writes 16 parameters the kit doesn't have. It is folded into the one plugin through kit parameters (kit change request first), as drafts only; the engineer signs | Enrich and Size work on the pilot model with kit parameters only |
| E4 | **Auto-MEP from room types** (QX1–QX7). A room-type services table, `FMC_Room_Type` on rooms, stage stamps `FMC_Auto_Stage` and `FMC_Auto_Run` on what it places, an `FMC_AI_Hint` marker family for what a person must decide, and a run journal. Lighting and small power first, through the recipe-tree room build (`server/src/tree/room.ts`, `commandset/Services/Fmc/FmcRoomBuild.cs`) | A room of a known type gets its lighting and small power placed as a draft, stamped and journalled |

## Where things are today (from the grid)
Nothing is tested in Revit yet. Built and waiting for a Revit check: the line diagrams (F23) for power distribution,
ELV and security, fire alarm, fire fighting, sprinklers, cold and hot water, drainage, rainwater, refrigerant, BMS,
lightning and earthing; the structural review and the Robot hand-off (F32). Partly built: the electrical check (F31),
the kit schedules behind Quantities (F60). The kit's own calculations exist only in the spreadsheet until E1. The live
counts: `fmc_systems` with `action: "matrix"`, or the pane's Engineer › Systems.

## Keeping the grid true
A pull request that changes what a cell can do changes its row in `mep_matrix.json` in the same PR, with the files
that implement it in `evidence` (repo paths; the server test checks each exists). The states, exactly:
"Tested in Revit", "Built, Revit check due", "Partly built", "Kit calculation only", "Planned", and "Not applicable"
(with the reason in the note).
