# Plan: line diagrams from the model (track LD, `fmc_diagram`)

**Goal (owner, 15 Oct):** the plugin scans a model and draws each discipline's line diagrams, correct and clean
enough to issue: electrical single-line diagrams, fire alarm and ELV risers, fire-fighting and plumbing schematics,
refrigerant schematics, and the lightning protection schematic.

**Rules that shape it**
- **Rule 5:** the diagram shows what the model holds. It never sizes, rates or loads anything. A missing value prints
  as `TBC` and is listed in the scan, so the engineer fills it in the model and regenerates.
- **Rules 1 and 3:** a dry run first, and no writes to live models. See decision 1 below.
- **Kit:** symbols from the register (the 300 `FMC_SYM_*` symbols plus `FMC_DI_*`), text types and line weights from
  the template, and sheet numbers from the Sheet Register. No graphics are hard-coded.

## How it works
1. **Scan (read-only; also runs on live and shared models).** It builds a system graph per discipline from Revit's
   own connections, not from guesses:

   | Diagram | Read from the model |
   |---|---|
   | E single-line (SLD) | Panels (Part Type), feeders and circuits (`ElectricalSystem`): way, rating, poles, cable (`FMC_Cable_Spec`), load name, apparent load, `FMC_Panel_ID` |
   | E fire alarm riser | Fire Alarm Devices by level, zone (`FMC_Fire_Compartment`) and loop; the panel (FACP) |
   | E ELV / security risers | Data, CCTV, access, intercom and electric-fence devices by level; racks, NVR, energiser |
   | FP riser and schematic | Fire Protection piping systems: pump set, tank, valves, risers, landing valves, hose reels, sprinkler zones |
   | P water and drainage | Domestic water and sanitary systems: tanks, pumps, risers and stacks per level, fixtures counted per level |
   | M refrigerant | Outdoor-to-indoor unit pairing (refrigerant systems), condensate routes |
   | LP schematic | Air terminations, down conductors, test joints, earth pits, ring electrode, bonds (`FMC_LP_Part`) |

   The scan reports the gaps: devices not on a circuit, circuits with no rating, pipes not connected, levels with no
   name, and parts with no `FMC_Keynote_Code`.
2. **Layout (in the server, deterministic, tested without Revit).**
   - **SLDs:** a tree top-down. Supply, MDB, then sub-boards, each with a horizontal busbar, its outgoing ways at a
     fixed pitch, and a breaker symbol and label block for each way (circuit, rating, cable, load).
   - **Risers:** vertical, with one band per level at true level order, symbols counted per level, and the panel or
     pump at the base.
   - **Schematics:** a left-to-right flow.

   It works on a fixed grid with no overlaps: a collision check on every symbol and label fails the layout rather than
   overlapping. Long boards split across views with match-line references. Each diagram also gets a legend of the
   symbols it uses.
3. **Build (a dry run first).** It makes one drafting view per diagram (`E-SLD-<board>`, `E-FA-Riser`, …) with the
   kit's symbols, detail lines on kit line styles, and FMC text types. Every element it draws carries its source
   element id, so regenerating updates the diagram in place and keeps notes a person added. A sheet comes from the
   Sheet Register when one exists.
4. **Check.** It takes a screenshot of every view (`fmc_doc screenshot`) and runs a visual QA: text clashes, symbols
   off-grid, empty bands. A Gate D in QA compares the diagram against the scan: every circuit drawn and every value
   from the model. The engineer signs the diagram off; the tool never does.

## Phases (each a PR, with tests and a chain test in `_ChainTests`)
| Phase | Delivers |
|---|---|
| LD1 | Scan engine for all disciplines, read-only, with a gaps report (pane: Engineer › Systems › Diagrams) |
| LD2 | Layout engine, plus E SLD end to end: the hardest and most used diagram |
| LD3 | Risers: fire alarm, ELV and security, FP, plumbing |
| LD4 | Schematics: refrigerant (M), lightning protection and earthing (LP), drainage long section (C) |
| LD5 | Sheets from the Sheet Register, legends, the regenerate-in-place flow, and Gate D in QA |

## Owner's decisions (15 Oct)
1. **A person presses Generate in the pane** to draw diagrams in a live project. The tool scans and plans
   everywhere, and draws by itself only in new documents, `_Staging` and `_ChainTests` (rule 1 unchanged).
2. **IEC/BS conventions:** IEC 60617 symbols, BS 7671 single-lines, BS 5839 fire alarm zone charts and BS EN 12845
   sprinkler schematics.
3. **All disciplines at once:** LD2–LD4 are built in parallel on the shared contract
   (`server/src/fmc/diagram/contract.ts`).

## Third-party tools already on the pilot PC
The ribbon shows the ElectroBIM Single Line and FireBIM Riser add-ins. They may cover SLDs and FP risers today. LD
reads the same model data, but uses Formcraft's kit, keynotes and QA gates, and covers every discipline from one scan.
