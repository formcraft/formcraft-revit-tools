# Plan: Casework Assistant (Engineer › Casework, +Model, `fmc_casework`)

**Goal (owner, 15 Oct):** from a room and a sentence to coordinated casework in the model and a workshop pack the
carpenters can cut from: real panels, real boards, real checks. Design: boards CW_Overview, CW_Pane and CW_Outputs.
The owner approved building everything that doesn't need Revit first.

**Rules that shape it**
- **Rule 5:** dimensions are design inputs. The tool never decides gas, electrical or structural items: cooker, hood
  and socket matters are flagged with the kit rule for the professional, never changed.
- **Rule 7:** sizes, boards, construction allowances, hardware rules and prices come from the kit. The kit has no
  casework standards yet, so they travel with the call until `03_Master_Data\FMC_Casework_Standards.json` exists;
  nothing has a default in code. Prices come only from `07_Materials\FMC_Materials.json` (`price{ugx, unit, date,
  source, status}`); a missing price shows "price needed" and a board missing from the library is a kit change request.
- **Rules 1, 2 and 3:** files go only into `<project>\01_WIP\_Casework` inside the write roots, after a dry run; a
  replaced file moves to `_Casework\_Archive`, nothing is deleted. Model placement waits for CW2 and the live-model lock.

## Steps

| Step | Delivers | State |
|---|---|---|
| CW1 Engine | `fmc_casework` (pure, no Revit): `units` from a run (walls, openings, fixed sink and appliances, corner unit, tall unit at an end; greedy fill from the module list, fillers at the stretch end), `parts` (panels per unit with board and edge banding), `nest` (guillotine shelf packing per board on the standard sheet with the kerf), `cutlist`, `hardware`, `summary` (with cost from the library and kit change requests), `pack` (cut list, nesting per sheet, hardware and BoQ as CSV). Golden test: the boards' kitchen (12 units, 120 pieces, 15 sheets, 98.5 m edge, 4.8 m worktop, 28 hinges), nesting identical to the reference `cw_kitchen.py` | This PR |
| CW2 Revit placement and shop drawings | Revit commands `fmc_casework_place` (FMC_I_Casework_* unit families from the kit, FMC_Assembly_Mark, FMC_Carcass_Spec, FMC_Worktop_Spec; one transaction group, one Undo; dry run is the real run rolled back; behind the live-model lock) and `fmc_casework_pack` (shop-drawing views and sheets on FMC_TB_A3, the I11_Joinery_Cutlist schedule). Room reading (walls, openings, water, waste, gas, sockets) becomes the run; the coordination checks on board CW_Pane step 3 read the model and flag with the kit rule. Needs the unit families through Gate A first | Built, Revit check due |
| CW3 Pane screens | Engineer › Casework from board CW_Pane: Room and brief, Layouts, Checks and dry run, Unit editor, Workshop pack; in `sections.json` with the +Model tag and part. Built on sample data before CW2 (owner, 15 Oct: everything that doesn't need Revit first); Place stays disabled until CW2 | Built, Revit check due |
| CW4 Workshop pack PDF | The pack as a PDF the workshop reads: shop drawings, cut list per assembly mark, nesting drawings per sheet, hardware, cost with its sources | Built, Revit check due |

Later, from board CW_Overview: layouts from a brief (three options), style from the design-movement profile sets,
beyond kitchens (wardrobes, vanities, counters, labs), CNC DXF and workshop rules learned into the kit.

## The engine in short (CW1)
- **Units.** On each wall the corner unit, the corner return, fixed sinks and appliance gaps and door openings go first.
  Each free stretch is filled from its start with the largest module that fits; a tall unit is packed first or last in
  its stretch; what is left is a filler at the stretch's end (scribed on site, not in the cut list). Wall units sit over
  the base cabinets, never over a window, door, tall unit or cooker; a run that starts at a window begins on the next
  base-unit line. Fronts follow simple defaults (door up to 600, else two doors; sink and tall two doors) and are set
  per mark. A unit list can be given instead of a run (the unit editor's path).
- **Panels** follow the workshop standards: sides, bottom, top or rails, back, shelves, blind panel, doors and drawer
  boxes, each with its board and banded edges.
- **Nesting** rotates parts freely (plain boards, no grain yet), widest first, rows across the sheet with the kerf
  between every cut; a part bigger than the sheet is named, never placed.
- **Cost** multiplies a library price only when its unit fits the quantity (a sheet of this size, a metre, a square
  metre); ranges stay ranges with their status, source and date.

## Kit change requests from CW1
- `03_Master_Data\FMC_Casework_Standards.json`: sheet, kerf, boards, carcass sizes, construction allowances, drawer
  heights, shelves, hardware rules.
- `FMC_Board_MDF_Back6` (6 mm MDF for backs and drawer bottoms) is not in the material library.
- An edge-band material (per metre) and a hardware price list (hinges, runners, handles, legs, shelf pins, hangers,
  kick board) are not in the kit.
- MDF, melamine, HPL and granite or quartz worktops have no price yet (the library's own `gaps` list says so).

## Kit change requests from CW2
- `FMC_I_Casework_KitchenUnit` has Base, Wall and Tall types only: corner and sink units need a Corner and a Sink type (the A family
  `FMC_A_Casework_KitchenBase` has 1000_Corner and 1200_SinkUnit). Until then they are not placed, unless the person names a type for them
  (`type_for`). The family is in the register but not built yet (no .rfa in `04_Families\_Staging\I`).
- The wall units' mounting height (underside above the floor) belongs in `FMC_Casework_Standards.json`; placing asks for it.
- Casework coordination rules (sink over the waste, sockets clear of tall units and the hob, sill above the worktop) belong in the kit;
  the checks flag without a threshold until then.
