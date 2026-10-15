# Plan: Ceiling Design Assistant (Engineer › Ceilings, +Model; `fmc_ceiling`)

**Goal (owner, 15 Oct):** from a room and a sentence to a coordinated ceiling in the model, with the lights, fan,
grilles and detectors in place, and a set-out and bill of quantities the installer can build from. Same pattern as the
Casework Assistant: one section of the pane, dry run first, kit data only. Design: canvas boards `CL_Overview`,
`CL_Pane` (five steps: Room, Designs, Check, Features, Pack) and `CL_Pack` (the A3 sheet and the BoQ).

**Rules that shape it**
- **Rule 5:** the light level is an indicative lumen-method figure, always shown as **Engineer** (CA-E-03), never a
  pass; the electrical engineer designs the lighting. Downlights, cove LED and drivers are priced from the lighting
  design, not by the tool. Detector and sprinkler positions are flagged for the fire engineer, never decided.
- **Rule 7:** set-out values come from the kit. The kit (v2.2, 15 Oct) has none yet, so the engine falls back to the
  approved reference example (`cl_room.py`, `cl_boards.py`) and lists every fallback as a kit change request in each
  answer (see below). Prices come only from `07_Materials\FMC_Materials.json`; a missing price shows "price needed".
- **Rules 1–3:** the engine never touches a model; the pack writes only into `<project>\01_WIP\_Ceilings\…` inside the
  guard's write roots, after a dry run and a person's yes (`confirm=true`). Placing (CL2) runs behind the live-model lock.

## Steps

| Step | Delivers | State |
|---|---|---|
| **CL1 Engine** | Server tool `fmc_ceiling` (pure computation): `designs`, `checks`, `setout`, `quantities`, `boq`, `pack` (CSVs). Golden test = the CL boards' living room | This PR |
| CL2 Revit placement | Revit commands `fmc_ceiling_place` / `_edit`: ceilings by boundary at each height (field, bulkhead soffit, raft, coffers) with the kit's I.CLG ceiling type; bulkhead, cove and raft faces and coffer mouldings as line/face-based families (built with `fmc_doc` recipes, Gate A, released by a person); cornice from the profile sets; fixtures (downlights, fan, grilles, detectors, hatch) from the kit families. One TransactionGroup, the dry run is the real run rolled back, one Undo. Behind the live-model lock: the tool places by itself only in new documents, `_Staging` and `_ChainTests`; in a live project a person presses Place in the pane. Reads the room outline, level, ties/slab above and existing fixtures from the model (`fmc_ceiling_facts`, read-only) so the engine's inputs come from Revit | Next |
| CL3 Pane screens | Engineer › Ceilings from `CL_Pane`: Room and brief, three designs (ghosted on the RCP via the Flow overlay), checks and dry run, features (width and drop, edge, cove, cornice; edit by sentence), pack. Adds `fmc_ceiling` to `fmc/cli.ts` for the pane | After CL2 |
| CL4 RCP sheet and set-out drawing | `VT_I_RCP` 1:50 sheet with heights, fixtures and keys (kit `FMC_SYM_I_*` symbols, ceiling-height tags); the board set-out drawing (numbered boards, furring, mains, hangers, setting-out points) as a drafting view; section details (bulkhead, cove, cornice, hatch); PDF and Excel of the BoQ in the pack | After CL3 |

## CL1: what the engine does

Input: the room (`width_mm`/`depth_mm` or an orthogonal `outline_mm`, `structure_height_mm` to the underside of the
truss ties or slab, tie spacing and direction if known), fixtures (fan with sweep and drop, downlights, detectors, AC
grilles with duct height, access hatch, sprinklers) and the brief (styles `flat`, `tray`, `bulkhead`, `cove`, `raft`,
`coffer`, `cornice`; the board as a kit keynote, default `I.CLG_02`; bulkhead width and drop; raft and coffer sizes).
Coordinates in mm from the room's corner.

- **Designs.** Up to three, the brief's first: **tray** (field at the structure less the void, a perimeter bulkhead
  dropped below it: the room eroded square by the bulkhead width), **flat with a floating raft** (centred, half the
  room on a 300 module, or as given), **coffered** (recesses up to the field height, beams and margin dropped). Each
  with heights, board area and sheets, an indicative light level and its checks; the first with no Fail is recommended.
- **Checks.** Clearance to the structure, hangers on the ties (noggins where they miss), AC duct fits the drop at the
  grille, fan centred in its tray/raft/coffer with blades high enough and no downlight in the sweep, detectors at the
  highest ceiling and clear of walls, steps (cove), grilles and the fan airflow, access to drivers, light level
  (**Engineer**), board joints (slivers, stagger), sprinklers (fire engineer), headroom (once the kit sets it).
  Results: Fail, Decide, Engineer, Info, OK, N/A. They flag; the person decides.
- **Set-out.** Each ceiling zone, and each separate part of it (a coffer, a raft), is laid in rows of sheets with the
  long edges across the furring and end joints staggered half a sheet. The start is searched (a 50 mm step and every
  offset that lands a joint on the zone's own edge) for no piece under the minimum, then fewest boards, then the start
  nearest the corner. Boards are numbered (F field, B bulkhead, R raft, C coffer) with their positions; boards cut round
  a notch keep their pieces. Plus main channel and furring lines, hanger points and the vertical faces.
- **Quantities and BoQ.** Board area (plan plus faces), sheets with waste, mains, furring plus studs and rails at the
  steps, hangers, screws, joint tape, cornice (room perimeter), cove LED (step length), downlights, hatch, skim and
  paint. Keynotes from the kit (`I.CLG_02` board, `I.MLD_00` cornice, `I.PNT_00` emulsion); prices from the library
  with their unit, date, source and status; a total only when the library's unit matches.
- **Pack.** `FMC_Ceiling_<room>_<design>_SetOut.csv`, `_BoQ.csv`, `_Checks.csv` into
  `<project>\01_WIP\_Ceilings\<date>_<room>_<design>` (a new folder each time).

**Golden test (CL boards):** 6.0 × 4.5 m, ties at 3000, tray with a 600 bulkhead dropped 300: field 15.84 m²,
bulkhead soffit 11.16, face 4.86, board 31.86 m², 13 sheets (2400 × 1200, 10 % waste), mains 30 m, furring 99.9 m,
30 hangers, cornice 21 m, cove LED 16.2 m, tape 21.9 m, paint 31.9 m², 6 downlights, 796 screws, about 258 lx; seven
field boards F1–F7 from the field corner; the coffered option flags the fan on a beam (off-centre).

## Kit change requests (CL1)

1. **`03_Master_Data\FMC_Ceiling_Standard.json` (proposed)** with: `main_channel_cc_mm` 1200, `furring_cc_mm` 450,
   `hanger_grid_mm` 1200, `min_void_mm` 150, `min_board_piece_mm` 300, `end_joint_stagger_mm` 1200, `board_waste` 0.10
   (or fill `waste` for `I.CLG_02` in FMC_Master_Data), `screws_per_m2` 25, `joint_tape_factor` 0.55,
   `hanger_tie_tolerance_mm` 50, `fan_min_blade_height_mm` 2300, `fan_centre_tolerance_mm` 150,
   `detector_wall_clearance_mm` 500, `detector_grille_clearance_mm` 1000, the lumen-method assumptions
   (`lumens_per_downlight` 800, `cove_lumens_per_m` 900, `utilisation_factor` 0.45, `maintenance_factor` 0.8), and
   `min_ceiling_height_mm` per room use (no fallback). Values shown are what the engine uses until the kit sets them;
   furring for 12 mm board may differ.
2. **Keynotes** for main channel, furring channel, hangers, drywall screws, joint tape, cove LED strip and channel,
   access hatch. The keynote file has I.CLG_00…_05 only.
3. **Keynote mismatch** between the material library and the keynote file: `FMC_Board_SoftBoard_Ceiling` is
   `I.CLG_04` in the library but soft board is `I.CLG_03` in the keynotes; `FMC_Plastic_PVCCeiling_Panel` is `I.CLG_05`
   (keynotes: PVC is `I.CLG_04`, woven mat is `I.CLG_05`); `FMC_Vernacular_Bamboo_Ceiling` is `I.CLG_06`, which the
   keynote file doesn't have.
4. **Prices** for channels, hangers, screws, tape, cornice (`FMC_Finish_Plaster_Gypsum_Painted`), cove LED, hatch; a
   per-m² or coverage figure for the emulsion (the library prices it per 20 L tin) and for skim.

## Open questions (from `CL_Overview`)
- Which ceilings Formcraft builds most (gypsum on metal, gypsum on timber, PVC, T&G): CL1 sets out boards on metal
  furring; brandering and planks need their own rules.
- Who installs (own team or subcontractors): decides how detailed the set-out drawing in CL4 is.
- Should the assistant place lights and fans in CL2, or only leave marked positions for the electrical design?
