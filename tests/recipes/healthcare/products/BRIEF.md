# Brief: model hospital families as products (photo to family, 17 Oct)

The owner sells these families as a hospital pack. Each family must look like the real product when he turns it in
3D: real parts, true proportions, kit materials and colours, and the details that make it recognisable (handles,
hinges, grilles, knobs, screws, vision panels, LEDs, feet, castors, outlets, labels). The bar is set by the nine done here:
`FMC_E_ElecFixture_Socket_13A_Twin`, `FMC_P_MechEq_MedGas_Outlet_*`, `FMC_I_MedEq_Couch_Examination`,
`FMC_E_EQ_DB_Final_TPN`, `FMC_A_SpecEq_Dispenser_Sanitiser_Auto`, `FMC_FP_*` and the basin. Read
`make_products.py` first: it is the pattern to copy.

## Your job
For every family in your batch file (`batches/<batch>.json`; each record has the family name, category, types,
departments, connectors, clearance, note, keynote `kn` and a generic reference `ref`):
1. Write a parts model (a Python dict, same schema as `make_products.py`) in your own script `gen_<batch>.py`, in this
   folder. Use helper functions for families that share a form (door leaves, cabinets, panels, luminaires), but
   every family must still get its own recognisable details.
2. For each family, the script writes `<family>.product.json`, `<family>.recipe.json` (`fp.compile_product`),
   `<family>.preview.png` (`fp.render`) and `<family>.png` (`fp.render_type_image`). Call `fp.render_type_image` at
   size 600 to save time.
3. Look at your work. Build contact sheets of the previews, 6 to 9 per image, at about 1500 px wide, in your
   scratchpad, and Read them. Fix anything that doesn't read as the product: parts hidden inside other parts, floating
   parts, wrong proportions, missing signature features, a box where it should be rounded. Do at least one fix pass.

## Shapes and coordinates
They are documented at the top of `../../tools/fmc_parts.py`. In mm: x right, y back, z up.
- A wall-mounted product has its back at y = 0 and stands toward -y.
- A floor product stands on z = 0.
- A ceiling product hangs below z = 0.
- For `turn` on axis y, the profile's second value is the literal y (negative means in front of the wall).

Each part has:
- `n`: a unique, readable name such as "Door Leaf" or "Handle Left".
- `mat`: a key in `materials`.
- `lod`: `m`, `f` or `mf`. The default is `mf`. A Coarse envelope is added for you. Give fine details `lod: "f"` and
  main masses `mf`.

Use `repeat` for rows of things. Keep each family at or below 70 parts.

## Rules (the server and Gate A check these)
- **Required keys** in every product: `family`, `desc` (one line on what the product is), `ifc` (the IFC class, e.g. IfcDoor, IfcSanitaryTerminal, IfcFlowTerminal, IfcMedicalDevice, IfcFurniture, IfcLightFixture, IfcElectricDistributionBoard, IfcPump, IfcTank, IfcFooting, IfcColumn, IfcBeam, IfcBuildingElementProxy), `types` ([{name}]), `materials`, `parts`, `reference`, `values` and `about`.
- **Family name, category and keynote:** take them from the record (`keynote: f['kn']`).
- **Real Revit categories:** catalogue labels that aren't Revit categories need mapping. Map "Structures", "Site",
  "Fire Protection", "Lightning Protection" and "Generic Models" to a real category: Structural Foundations,
  Structural Columns, Structural Framing, Mechanical Equipment, Pipe Accessories, Electrical Fixtures, Site, Planting,
  Specialty Equipment or Generic Models. Put the category in `category`. List every mapping you made in your report.
- **Templates:**
  - Use `Metric Generic Model.rft` by default.
  - Doors use `Metric Door.rft` and windows use `Metric Window.rft`. Wall centre line at y = 0; geometry symmetric in y
    where you can. Set `type_values` `Width`, `Height` (and for windows `Sill Height`) to match the opening.
  - Mechanical Equipment uses `Metric Mechanical Equipment.rft` and Medical Equipment uses
    `Metric Generic Model.rft` + `category`.
- **Type names:** exactly `[KeySize]_[Variant]`, matching `^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$`, with one underscore.
  Examples: `926x2100_Single`, `1200_TPN`, `60_O2`. Never `Standard`. Use the record's types; make them comply.
- **Materials:** only names in `batches/KIT_MATERIALS.txt`. If the product needs a colour or finish the kit lacks,
  use the nearest kit material and add an entry to `batches/<batch>.materials_needed.json`
  (`[{name: "FMC_...", colour: "#RRGGBB", why}]`). The owner adds those to the kit.
- **Values:** every value is `{value, source_status, source}`.
  - `verified` only with a real URL to a datasheet or listing you actually fetched.
  - Otherwise `assumed` with a reason, e.g. "typical size, HBN 00-10".
  - Give 2 to 5 values per family: main dimensions, plus any rating the type name implies.
- **Reference:** `reference = dict(rec['ref'])`. Add `datasheet` if you used one. Never write a brand: no
  Manufacturer or Model values, because brand and model stay open for the owner.
- **Connectors:** from the record's `connectors` codes, on a real part, on the side the service comes from:

  | Code | Connector |
  |---|---|
  | CW | pipe DomesticColdWater, 15 mm, In |
  | HW | pipe DomesticHotWater, 15 mm, In |
  | SAN | pipe Sanitary, 40 to 110 mm, Out |
  | VNT | pipe Vent |
  | MG | pipe Other, 15 mm, one per gas |
  | E | electrical PowerBalanced; add `type_values` Voltage (240 or 415), Apparent Load and, for 3-phase, Number of Poles 3 so the compiler links them |
  | ELV | electrical Data, NurseCall, Communication, Security or FireAlarm, whichever fits |
  | DS | duct SupplyAir, with diameter or width + height |
  | DE | duct ExhaustAir |
  | ST | pipe Other (steam) |
  | FW | pipe FireProtectWet |

  **Medical Equipment** can't carry pipe connectors: give it its electrical and data connectors only, and put "water
  and gases via the nested service point" in `about`.
- **Clearances:** if the record has a clearance, add a `clearances` entry, a box on one of these `sub`s:
  `Clearance Accessibility`, `Clearance Maintenance`, `Clearance Operation` or `Clearance Radiation`.
- **Profiles** (category Profiles) are 2D sweep profiles, not parts models. Skip them and list them in your report.
- **Coordination:** don't touch git, the board, other batches' files, or the nine finished families. Write only in
  this folder, and only your batch's files plus `gen_<batch>.py`.
- **Research:** web search is optional and costs time. Use at most one search per five families, for products whose
  look or size you are unsure of. Good knowledge of typical products is enough. Mark values `assumed`.

## Report (your final message, short)
- How many families you modelled, and which you skipped and why.
- The category mappings.
- The materials you asked for.
- Any family you think still looks weak.

## Second pass (17 Oct, evening)
1. **Materials:** the kit now has the materials you asked for (`batches/KIT_MATERIALS.txt`, 223 names). Switch your
   stand-ins to them. Use `FMC_Plastic_EpoxyResin_Black` for epoxy worktops. Clearance solids need no material.
2. **Per-type geometry:** a part may carry `"only": ["<type>", ...]`. It then shows only in those types, through a
   Yes/No type parameter the compiler adds. Wherever your types differ in shape or size (L/U/straight, 2/3/4 piles,
   1G/2G/3G, 5/6 kg, 600/1200 panels, 900/1000 doors), give each type its own parts. Leave shared parts without `only`.
   Previews draw the first type; check the others by setting `prod['_render_type'] = '<type>'` before rendering.
3. **Photos:** each record's `ref` now has a real product page in `ref['photo']`, and the compiler writes it to `URL`.
   Rerun your script so the references are current.
4. **Compiler changes, no action needed:**
   - It adds every kit shared parameter bound to the category, and the keynote description and group.
   - Ceiling categories are seen from below; ground items stay seen from above (`"view": "above"|"below"` overrides).
   - Medical Equipment keeps only electrical connectors.
   - Glass renders see-through, except materials named Display.
5. **Finish:** rerun the whole batch, check the contact sheets once more, and report in 5 lines: what changed, and
   which families now use `only`.
