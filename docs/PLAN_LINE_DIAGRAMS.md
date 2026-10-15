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

## Revit side (commands)
- `fmc_diagram_scan` (read-only; `kinds`, optional `document`): `commandset/Services/Fmc/FmcDiagramScan.cs`. Element
  nodes use the UniqueId, circuits `circuit:<id>`, the synthetic supply `supply:<board name>`. SLDs are one diagram
  per top-level supply tree (feeders are circuits whose loads include a board); piping schematics are one diagram per
  piping system, with edges found by following connectors through pipes and fittings to the next component; the LP
  schematic joins parts whose points or line ends lie within 100 mm. Params use the first names in `PARAM_KEYS`
  (`circuit`, `rating` in A, `apparent_load` in VA, `size` as "50 mm"…); each edge carries `id` (the circuit, system or
  first pipe's UniqueId) and runs upstream to downstream: from the connector's flow when Revit has one, else by part kind
  (supply side first, terminals last; LP air terminal to earth). A request for `e_power_riser` scans the SLDs.
- `fmc_diagram_draw` (DRAW_SPEC + optional `document`, documents already open): `FmcDiagramDraw.cs`. One transaction
  group, rolled back on a dry run; never saves. Tool-drawn items carry the key `view|source_id or index|t` in
  extensible storage (schema `FMC_DiagramSource`), so a rerun redraws them and keeps a person's notes (`kept_by_hand`).
  Symbols must already be loaded (Generic Annotations or Detail Items); a missing one is a warning, never a load from disk.
  Texts are placed top-aligned at `at` and turned by `rotation_deg` (TextNoteOptions.Rotation, counter-clockwise).

## Server side (LD2–LD4 layout, `server/src/fmc/diagram/`)
| Module | Does |
|---|---|
| `contract.ts` | SCAN_RESULT in, DRAW_SPEC out. Added for LD2 (additive): `SCAN_EDGE.id` (the circuit or pipe id, used as `source_id`), `rotation_deg` on text items, `PARAM_KEYS` (the parameter names the layout reads, with aliases) and `DRAW_CONVENTIONS` (symbol `at` = centre; text `at` = top of the box at its alignment side; rotation counter-clockwise) |
| `symbols.ts` | Node kind + category/family/name hints → kit symbol (`FMC_DI_E_SLD_*`, `FMC_DI_P_Schematic`, `FMC_SYM_<Role>_<Name>`); breaker type only from what the model says (unknown: MCB, labelled "type TBC"); styles (grid, text types, line styles); symbol sizes for the collision check. A node no rule matches is drawn as a plain box with its name and a warning, never a guessed symbol |
| `geometry.ts` | Canvas in paper mm on a 5 mm grid, text measuring, the TBC collector, the frame (title, legend of the symbols used, notes listing every TBC value) and `collisions(view)` |
| `sld.ts` | E single-lines: supply chain, board title block, busbar, ways at 20 mm (feeders 40 mm), breaker and a label block per way, sub-boards below; more than 24 ways continues on `<view>-2` |
| `riser.ts` | E power riser (`e_power_riser`, added 15 Oct, laid out from the e_sld graph): level bands, the supply and each board on its level (boards on one level side by side) with part type, ways, the feeder serving it (rating · poles · device, cable; TBC when null) and "See E-SLD-…"; feeders run on a track at the foot of the parent's level and rise or drop on the fed board's own column. Final circuits stay on the SLDs |
| `bands.ts` | Level bands (top level at the top): FA zone chart (columns per zone, panel at the base), ELV (columns per system, head end at the base), FP / water / drainage (a column per riser or stack, plant in flow order, devices counted per level, pipe sizes beside the riser), LP (bands by part, a column per down conductor, MET, SPDs and bonds at the base) |
| `schematic.ts` | Refrigerant: outdoor-unit trees, refrigerant on FMC_Medium, condensate on the kit's dashed style (FMC_Thin and a note while there is none) |
| `layout.ts` | `layoutScan(scan, kit, kinds)` → views with TBC counts, collisions, warnings and coverage; `drawSpec`, `planSummary` |

Layouts are pure and deterministic (stable sorts by name and id), so regenerating gives the same items. A view with a
collision is never drawn: `fmc_diagram draw` refuses it with the list.

**Kit override (rule 7).** The symbol table, styles, sizes and layout numbers are kit data. The code holds the default;
`<kit>\03_Master_Data\FMC_Diagram_Symbols.json` replaces it when present (same shape: `styles`, `layout`, `sizes` merge key
by key; `symbols` and `breakers` replace the lists). `tests/fixtures/FMC_Diagram_Symbols.json` is the default, ready to
copy into the kit. Rules with a bad regular expression or no family are dropped and reported, never fatal.

**Tool `fmc_diagram`.** `scan` (read-only: counts and gaps per diagram), `plan` (read-only: per view name, item counts,
TBC count, collisions, warnings; `save: true` writes the draw spec JSON to `<reports>\Diagrams`), `draw` (a dry run by
default; `dry_run: false` needs `confirm: true`). `fmc_diagram_draw` is in `WRITE_COMMANDS`, so on a live project the
draw is refused and a person presses Generate in the pane.

## Third-party tools already on the pilot PC
The ribbon shows the ElectroBIM Single Line and FireBIM Riser add-ins. They may cover SLDs and FP risers today. LD
reads the same model data, but uses Formcraft's kit, keynotes and QA gates, and covers every discipline from one scan.
