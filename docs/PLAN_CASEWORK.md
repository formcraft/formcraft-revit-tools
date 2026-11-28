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

## Safe shop PDF, run id, standards revision (28 Nov)
- `shop_drawings` no longer archives the old shop PDF before Revit runs. Revit exports to `<name>.pending-<run id>.pdf` beside it; only when
  the add-in reports `exported` and the file is there does the old PDF move to `_Archive` and the new one take its name. Any failure (Revit
  says no, the connection drops, the changes roll back, no file) removes the temporary file and leaves the current PDF untouched.
  The Revit side keeps its one Undo: a failed export does not undo the views and sheets it made.
- Every reply has `run_id` (`CW-<date>T<time>-<6 hex>`); pack, place and shop_drawings write it into the `FMC_MCP_FileLog.csv` detail as
  `run <id>: ...`. Pack files and the PDF carry no run id, so a re-run still sees "unchanged".
- Replies after the standards are read have `standards_revision`: the kit file's own `revision`/`rev`/`version` label if it has one, the file's
  modified time and hash, the hash of the standards actually used, and `call_overrides`.

## The rest of the casework spec (28 Nov, tools 1–25 batch)
- **run_id handle.** Every call's inputs (run, units, standards, the last room read) are saved under its `run_id` in
  `%APPDATA%\Formcraft\casework\runs` (or `FMC_CASEWORK_RUNS`), pruned after 30 days / 500 files; never beside the pack, so the
  byte-for-byte "unchanged" check still holds. A call with `run_id` uses those inputs; anything it sends wins; `inputs_from` echoes the id.
  `modules` goes over the run's modules.
- **units_hash** (12 hex) in every reply after the standards are read.
- **room** returns `run: {walls, modules: []}` ready for the next call (run_id plus modules); nothing is defaulted.
- **Room-read cache.** check and place reuse the room read saved along the run_id chain when it is the same room and under
  10 minutes old (`room_read: {from, at, age_s}` in the reply); `fresh_room: true` reads again. No hidden in-process cache.
- **confirm.** pack, shop_drawings and remove refuse `dry_run=false` without `confirm=true`, before any write or Revit call; a saved
  run never carries a confirm.
- **remove.** New add-in command `fmc_casework_remove` (command.json, a write command behind the lock). It finds the casework whose
  Comments carry `FMC:casework:<label>` (place's tag). The dry run (default) is read only (no transaction) and lists them; the real
  run (dry_run=false, confirm=true) deletes them in one transaction (one Undo).
- **Split for the 300-line rule.** `casework.ts` and `fmc_casework.ts` are barrels/dispatchers over casework_standards, _layout,
  _parts, _cost, _fitted, _place_plan, _room, _shop, _shape, _tool, _actions, _revit, _store, _more; no behaviour change.
- **Wardrobes and vanities.** `run.kind` kitchen (default, unchanged) | wardrobe | vanity; unit kinds wardrobe, vanity, basin (a
  fixed unit like the sink). Straight runs: doors kept clear (windows too for wardrobes), modules fill, fillers at the end; the vanity
  top is measured like a worktop. Sizes from the kit (`wardrobe.height/depth`, `vanity.height/depth`, `shelves.wardrobe/vanity`);
  refused when missing. Wardrobes: full top, tall-door hinges, hanging rail (inner widths) and two brackets each; those rows appear
  only when there are wardrobes, so kitchen packs are byte-identical.
- **options.** Three layouts of one run: A largest units (as given), B even widths (the one module leaving least filler), C more
  drawers (the kit's largest drawer set in base/vanity units up to 600) or, for wardrobes, narrow doors (modules up to 600). Each is
  saved as `<run_id>-A/-B/-C` with its scores; the choice is the person's.
- **bulk.** Up to 50 rooms (read through the read-only path) and/or `runs: [{label, run}]`; each gets its own saved run_id, a layout
  and scores when `modules` are given, and totals. Read only: no pack, no place.
- **Later / open.** CNC/DXF export (deferred). A free-text brief isn't parsed (options take a run). The kit has no Wardrobe, Vanity or
  Basin types in FMC_I_Casework_KitchenUnit: place skips them with a kit request unless `type_for` names a type. remove is not yet
  tried in live Revit. layoutRun, packAction and shopAction are over the hub's 40-line function rule.
