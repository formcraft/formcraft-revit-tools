# Kit change request · engineering services (MEP) · 19 Oct 2026

**Status: raised 19 Oct 2026, for the BIM Manager, through the kit change process.** Drafted under the owner's direction
of 19 Oct 2026: "draft kit requests with values marked 'assumed' from the standards; a person approves before anything
uses them as standard."

**Every value in these files is assumed until a professional confirms it.** None of them is verified, and none is a
design. The building services engineer, the public health engineer, the fire engineer and, for hospitals, the client's
medical-equipment and infection-control leads confirm or replace each value per project. Until the kit publishes a file,
no plugin uses it as standard (rule 7: the kit decides).

Steps that need these files:
- **E1 calc:** electrical calculations (CA-E-01 maximum demand, CA-E-02 voltage drop).
- **E2 LD5:** line diagrams (SLD and risers) from real circuits.
- **E3 Electrical:** the FormCraft Electrical add-in (Enrich Data, Size Feeders).
- **E4 Auto-MEP:** services drafted per room.
- **T2 room rules:** recipe-tree room rule sets (`docs/PLAN_RECIPE_TREE.md`).

## 1. Room services rulebook
**File:** `FMC_Room_Services.json`, schema `fmc-room-services/0.1`. Proposed as
`03_Master_Data\FMC_Rulebook\FMC_Rulebook_RoomServices.json`.

**What it holds:** 22 room types, each mapped to its services by rule. 462 values in all, every one written as
`{value, unit, source, source_status: "assumed"}`.
- **General rooms:** office, meeting, corridor, stair, WC, kitchen, store, plant room.
- **Homes, schools and shops:** bedroom, living, classroom, retail.
- **Hospital rooms:** ward bay, ICU bed, theatre, consulting/examination, treatment, nurse station, clean utility,
  dirty utility, sluice, lab.

**Services it covers:**
- lighting (lux, uniformity, UGR, fitting hint, switching)
- small power (sockets per room, per m of wall, per bed and per workstation; heights; BS 7671 Section 710 medical
  location group)
- data and nurse call
- fire detection (detector type)
- emergency lighting
- water fixtures
- drainage (discharge units)
- medical gases (outlets per bed)
- ventilation (ACH or L/s per person, and pressure)

**Standards named:**

| Service | Standards |
|---|---|
| Lighting | BS EN 12464-1, CIBSE SLL Code and LG2 |
| Small power | BS 7671 with IET guidance, HBN 04-01, HBN 04-02, HBN 26, HTM 06-01 |
| Fire detection | BS 5839-1 and BS 5839-6 |
| Emergency lighting | BS 5266-1 |
| Water fixtures | HBN 00-09 and HBN 00-10 |
| Drainage | BS EN 12056-2, System III |
| Medical gases | HTM 02-01, with the ASPE PEDH Table 2-4 counts the kit's staged medical-gas recipes already hold |
| Ventilation | HTM 03-01, CIBSE Guide A, Approved Document F, BB101, DW/172 |
| Hospital equipment | Uganda MoH National Medical Equipment Guidelines 2024, as an equipment check per facility level |

**Why:** Auto-MEP and the recipe tree need room rules as kit data, not code. Today the kit has only `FMC_Lux_Target`,
with no table behind it. **Needed by:** T2, E4 and E1 (load estimates).

**Assumed until a professional confirms.** Points that only a professional can decide:
- **Fire:** the fire alarm system category (L1, L2, P1…), detection in WCs, stair smoke ventilation, and whether
  emergency lighting is maintained or non-maintained.
- **Medical gases:** the outlet counts. HTM 02-01 and the PEDH counts differ. The values are the PEDH minimums, with a
  note that the higher count governs, and theatres need SA7 surgical air or N2.
- **Hospital power:** socket counts per bed and the essential/UPS split.
- **Drainage:** the BS EN 12056-2 drainage system. System III is assumed. Hopper and macerator DU are set equal to a
  9 L WC because the standard gives no value for them.
- **Ventilation:** whether a room may be naturally ventilated (Uganda practice) rather than mechanically.

## 2. Auto-MEP and electrical parameters
**Files:** `FMC_Auto_MEP_Parameters.txt` (a Revit shared-parameter file, the kit's layout) and
`FMC_Auto_MEP_Parameters.json` (the same list with group, datatype, binding, categories, reasons, and the Electrical 0.1
mapping).

**GUIDs:** the kit's own method, `uuid5(6f0c2b7e-4a51-4e0b-9d3a-f0c3a1b2c3d4, name)` (`_build/build_kit.py`, line
21). It reproduces `FMC_Project_Code = 9a41f255-057a-54f2-959f-d295edf4416b`. So when these names are added to
`fmc_data.py`, the kit build makes exactly these GUIDs.

**16 new parameters:**

| Parameter | Type | Binding | Group | For |
|---|---|---|---|---|
| FMC_Room_Type | Text | Instance: Rooms, Spaces | 23 | T2, E4 (values = the 22 room-type ids) |
| FMC_Auto_Stage | Text | Instance: rooms + MEP categories | 18 | E4 |
| FMC_Auto_Run | Text | Instance: rooms + MEP categories | 18 | E4 |
| FMC_Auto_Locked | Yes/No | Instance: rooms + MEP categories | 18 | E4, T3 |
| FMC_AI_Hint_Kind | Text | Type: Generic Models | 18 | E4 (item 3) |
| FMC_Switch_Ref | Text | Instance: Lighting Fixtures, Lighting Devices, Electrical Fixtures, Generic Models | 8 | E3, E4. Replaces KISIC's ad-hoc `FMC Switch` (gap script 19, P1) |
| FMC_Elec_System | Text | Instance: load categories | 8 | E3 |
| FMC_Phases | Integer | Instance: load categories | 8 | E1, E3 |
| FMC_Design_Current_A | Number | Instance: load categories | 8 | E1, E3 |
| FMC_Protective_Device_A | Number | Instance: Electrical and Mechanical Equipment | 8 | E1, E2, E3 |
| FMC_Conductor_Size_mm2 | Text | Instance: Electrical and Mechanical Equipment | 8 | E1, E2, E3 |
| FMC_CPC_Size_mm2 | Text | Instance: Electrical and Mechanical Equipment | 8 | E1, E3 |
| FMC_Voltage_Drop_Pct | Number | Instance: Electrical and Mechanical Equipment | 8 | E1 (CA-E-02 can write back), E3 |
| FMC_Calc_Status | Text | Instance: load categories | 18 | E1, E3 |
| FMC_Data_Source | Text | Instance: load categories | 18 | E3 |
| FMC_Elec_Code_Pack | Text | Project Information | 8 | E1, E3 |

**Electrical 0.1's 16 parameters:** 6 map to something the kit or Revit already has. The other 10 are the new
electrical rows above.

| Electrical 0.1 | Use instead |
|---|---|
| FMC_Circuit_ID | **FMC_Circuit_Ref** (kit). Widen its binding to the load categories. |
| FMC_Load_VA | **FMC_Power_W** (kit) and the connector's built-in Apparent Load, which kit families already set to W / PF. |
| FMC_Voltage | Built-in **Voltage**, linked to the connector in every kit electrical recipe. |
| FMC_Poles | Built-in **Number of Poles**, linked the same way. |
| FMC_Load_Class | Built-in **Load Classification**, from the kit's 8 classes in Electrical_Settings. |
| FMC_Demand_Factor | **Load classification demand factors** (Electrical_Settings), which the engineer approves per project. No per-element parameter is proposed, so Electrical 0.1 should stop writing one. |

**Why:** Electrical 0.1 binds 16 `FMC_` names from its own private shared-parameter file, with random GUIDs. The kit
has none of these names. If the kit later adds them, the same name exists twice with different GUIDs, and schedules and
filters break. **Needed by:** E3 first, then E1 and E4.

**For the electrical engineer:**
- **Load library:** Electrical 0.1's `Library/load-defaults.json` is North American (120 V receptacles at 180 VA,
  277 V high-bay). Uganda projects need a 240/415 V, BS 1363 library first.
- **Default voltage:** its IEC pack defaults to 230 V, while the kit's distribution systems are 415/240 V.

**Assumed until a professional confirms.** The names and bindings are proposals, and the BIM Manager decides them.

## 3. AI hint marker family
**File:** `FMC_AI_Hint_Marker.recipe.json` (fmc-recipe/0.1). The family is named
`FMC_A_GenericModel_AIHint_Marker`, in kit token order.

**What it is:** a flat, stretchable Generic Model zone (instance Width and Depth, locked to planes with EQ dimensions)
with six types:
- `600_DBHere`
- `1000_RiserZone`
- `1000_NoServices`
- `1000_KeepClear`
- `600_FeatureLight`
- `600_SupplyIntake`

Each type carries `FMC_AI_Hint_Kind`, plus instance `FMC_Auto_Run` and `FMC_Auto_Locked`. The solid sits on the
subcategory **Clearance AI Hint**, so the kit's Clearance rule applies: it shows in working views, and every print view
template turns it off, as it does for Clearance zones. Gate A treats the keynote check as exempt.

**Kit side:**
- Add the family to the family register.
- Add `Generic Models > Clearance AI Hint` = off to the print view templates.
- Optionally, add a filter that colours by `FMC_AI_Hint_Kind` in the Auto-MEP working view.

**Why:** a person can steer Auto-MEP by placing a marker (board here, keep clear, riser zone) instead of typing
instructions. **Needed by:** E4.

**Assumed until a professional confirms.** The sizes and colour are firm practice. The family is not built or
Revit-checked yet.

## 4. Auto-MEP run journal format
**File:** `fmc-auto-run.schema.json` (JSON Schema 2020-12, `fmc-auto-run/0.1`).

**What the journal records:**
- run id and model (path, container name, version GUID)
- the kit rule files used, with their revision and sha256
- stages done, approved (by whom and when) and left
- per-room stamps per stage, with the rule values used and what was achieved
- every element placed or changed: UniqueId, ElementId, family, type, xyz and the parameters written
- elements and rooms a person locked
- a resume pointer: stage, next room, and the reason for the pause (sleep, battery saver, waiting for approval, limit
  reached)

The stage list is the same as `FMC_Auto_Stage`'s values.

**Why:** a run can stop at any time and carry on without redoing or undoing approved work. Each placed element traces
to the run and to the rule revision that made it. **Needed by:** E4 (and T3/T4 incremental rebuilds).

**Assumed until a professional confirms.** This is a data format, so no engineering values are in it.

## 5. Diagram symbol table
**File:** `FMC_Diagram_Symbols.json`. Proposed as `03_Master_Data\FMC_Diagram_Symbols.json`, which the kit lacks.

**What it holds:**
- The default table `fmc_diagram` already uses (`tests/fixtures/FMC_Diagram_Symbols.json`), copied unchanged.
  `fmc_diagram` ignores the two added keys, `about` and `missing_families`.
- **Missing families:** of the 71 symbol families the table names, 22 are in the family register but have no `.rfa`
  under `04_Families`.
  - **P1, electrical:** FireAlarmPanel, LoopIsolator, InterfaceModule, NVR, ElectricFenceEnergiser, FenceZone,
    AccessReader, DoorRelease, Intercom.
  - **P1, fire protection:** JockeyPump, FireWaterTank, DrainTestValve, CheckValve, GateValve.
  - **P2, BMS and controls:** `FMC_SYM_M_` BMSController, Gateway, DDCController, Sensor, Actuator, and `FMC_SYM_E_`
    LightingController, MotorStarter, VFD.

  Until each is built, a diagram that needs it draws a plain box with a warning.

**Why:** the kit should own the symbol table, so it can change symbols without a plugin release. **Needed by:** E2.

**Assumed until a professional confirms.** The symbol choices are drafting conventions for the BIM Manager.

## 6. Board family fix: FMC_E_EQ_DB_Final_TPN accepts no distribution system
**Evidence** (`docs/handoff/KISIC_GAP_SCRIPTS.md` 4.4):
- `ElectricalSystem.Create` works, but `SelectPanel` fails on this board with every distribution system, including a
  415/240 V system set on the instance.
- Revit's stock 480 V panel works, so the fault is in the family.

**Likely cause:** the recipe (`tests/recipes/healthcare/FMC_E_EQ_DB_Final_TPN.recipe.json`) sets the category
Electrical Equipment but never sets the family's **Part Type**. Revit offers the Distribution System parameter, and
accepts a board as a circuit's panel, only when the Part Type is Panelboard, Switchboard or Other Panel. The connector
side looks right: Power Balanced, with Voltage 415 and 3 poles linked to type parameters. That matches the kit's
`DS_415-240V_3Ph_4W` (L-L 415 V, L-G 240 V, Wye, 4 wires).

**Fix in the recipe:**
1. Set **Part Type = Panelboard**. The `fmc_doc` op vocabulary has no field for this yet: `set_family_params` takes no
   `part_type`, although `fmc_family` plans already do (FmcFamilyEventHandler, "Part Type for electrical equipment,
   STD-002 5.2"). Proposed op: `{ "op": "set_family_params", "name": "family", "part_type": "Panelboard" }`. That is a
   small code change to raise separately. Until then, set it by hand in Family Category and Parameters before Gate A.
2. Keep the **Supply** connector as Power Balanced, with Voltage (415) and Number of Poles (3) linked. Set the
   connector's **Load Classification** to Other, and its Apparent Load to 0 (a board is not a load).
3. Add a **single-phase type**, `12Way_SPN`, at 240 V with 1 pole (or a separate `FMC_E_EQ_DB_Final_SPN`) for
   `DS_240V_1Ph_2W`. KISIC asked for a 240 V DB type.
4. Add **FMC_Ways** (kit, type parameter) set to 12, so `fmc_diagram` reads the ways. Today it falls back to
   `Max #1 Pole Breakers`.
5. **Test in Revit** (a Revit check by a person):
   - place the board
   - set Distribution System = `DS_415-240V_3Ph_4W`
   - create a circuit from a kit socket and select this board as its panel
   - confirm the panel schedule opens

   Then `fmc_systems create_circuits` and `fmc_diagram` can work from real circuits.

**Plugin side, 19 Oct (MEP test model PR):** `set_family_params` now takes `part_type` and `add_connector` takes
`load_classification` (docs/RECIPES.md). The staged recipe `04_Families\_Staging\E\FMC_E_EQ_DB_Final_TPN.recipe.json`
now sets Part Type Panelboard and the supply connector's Load Classification Other (the original is in
`_Staging\_Batch\_Archive\FMC_E_EQ_DB_Final_TPN.recipe_before_20261019-parttype.json`). Items 3 and 4 (a single-phase
type, FMC_Ways = 12) are still open. `fmc_systems create_circuits` makes circuits and sets the distribution system
(`DS_415-240V_3Ph_4W`) on the board; scenario `tests/revit/17_mep_model.json` runs step 5 unattended. Until that scenario
passes in Revit, the fix stays unproven.

**Why:** with no circuits there is no SLD, no panel schedule and no load summary. **Needed by:** E2, E3 and E1 (it
blocks the KISIC P1 item).

**Assumed until a professional confirms.** The cause is a strong lead from the evidence, not yet proven in Revit. The
enclosure size and the 1000 mm working space in the recipe remain assumed values.

## 7. What the BIM Manager is asked to do
1. Accept, edit or reject each item above.
2. Put the accepted files in the kit and set `approved` and `revision`. Values stay `assumed` until the engineer named
   for each service confirms them.
3. Add the accepted parameters to `_build/fmc_data.py`. The GUIDs come out as listed.
4. Record each decision in the kit ChangeLog.

Until then, the plugin treats every one of these as a draft.
