# QS03: the detail generator, with open/close and clearances (owner's yes, 19 Oct 2026)

**For:** both sides. **From:** Claude Code. **Plan for:** QS03, QS06 and QS07 of `SAMPLE14_LOD_LADDER.md`. The owner agreed
the approach on 19 Oct and added two rules: everything that opens gets an open/close toggle, and clearances are shown.

## The owner's rules for the 10
1. **Hosted families keep cutting and flexing.** Doors and windows stay plane-driven: their opening cut, frame, leaf,
   stops and seals stay native boxes between the family's planes, so every size still works.
2. **Detail rides on the planes.** Each detail part (lever on rose, knuckle hinge, overhead closer, grille, gauge, valve,
   castor, ...) is a small **component family** with a true curved shape, nested into the host with `place_nested`
   and locked to the host's planes, so it moves with the sizes. Its shape is fixed per type (owner's curved-parts rule).
3. **Open / Closed toggle** on everything that opens: an instance Yes/No **`Open`** (default No). Open shows the leaf,
   sash, hatch, chamber door or canopy door in its open position; Closed shows it shut. Both positions are plane-driven,
   so they flex too. The plan swing symbol stays.
4. **Clearances are shown.** Every family has its clearance zone on the Clearance subcategory, on all three levels,
   with the instance switch **`Show Clearance`** (default Yes). A door's zone covers its swing; when `Open` is Yes the
   open leaf sits inside it. Families without a zone today get one: the three windows (500 mm working zone in front),
   the generator (1000 mm service zone around the canopy, doors open) and the fire pump set (1000 mm, the maintenance
   side). Values are marked `assumed` until the owner or an engineer confirms them (rule 5).
5. **Lighting shows its light path** (owner, later on 19 Oct): a beam from each lens to the light field at the working
   distance, on the Light Path subcategory, with the instance switch **`Show Light Path`** (default Yes); the distance
   and field are values an engineer confirms.
6. **The ladder:** Coarse LOD 100 (envelope box), Medium LOD 300 (the native body plus the components), Fine LOD 400
   (the components' smooth Rhino twins), as Gate A's "Levels of detail" line reads it.

## What opens in the 10
| Family | What opens | Open position |
|---|---|---|
| `FMC_A_Door_FlushSingle_Hygienic` | leaf (and the pair leaf) | swung 90° to the swing side, inside the clearance |
| `FMC_A_Door_LeadLined_Xray` | leaf (and the pair leaf) | the same |
| `FMC_A_Window_Observation_Internal_Nurse` | the sliding sash of the `SWoption` type | slid behind the fixed light |
| `FMC_A_Window_Hatch_Pharmacy_Dispensing` | the dispensing hatch | slid up |
| `FMC_A_Window_Laboratory_Fixed` | the pass-through hatch type's door | dropped open on its bottom hinge |
| `FMC_P_PlumbingEq_Steriliser_Steam_CSSD` | both chamber doors (pass-through) | slid up (vertical sliding doors) |
| `FMC_E_EQ_Generator_Diesel_Standby` | the canopy service doors | swung 90° |
| `FMC_P_MechEq_MedGas_BedheadPanel` | the front service cover | hinged down |
| `FMC_M_AirTerminal_Diffuser_LaminarFlow_Theatre`, `FMC_FP_MechEq_FirePump_Set` | nothing | no toggle |

The four detailed families get toggles in a second round (incubator canopy and hand-port doors, anaesthesia drawers,
bed side rails down), so the first 14 ship with the same behaviour where it matters most.

## How it is built (scripts first: the AI writes the spec once, the generator runs without AI)
| Step | What | Who |
|---|---|---|
| D1 | **Component library:** about 12 component recipes (`FMC_X_Part_*`): lever on rose, pull handle, knuckle hinge, overhead closer with arm, kick plate with rounded corners, vision bead, louvre grille, pressure gauge, ball valve, castor, gas outlet, cable gland. Each one family, true curved shapes (LOD 300), its twin for Fine (LOD 400), built and checked like any family | Claude Code |
| D2 | **Detail specs:** the chat's detail lists (`detail_lists.json`) as structured specs, `detail_specs.json`: per family, each component with its host planes, side, material and type values; each openable part with its hinge or slide planes; each clearance zone | Claude Code, the chat reviews |
| D3 | **The generator** (`fmc_recipe detail`): a standard recipe + its spec → the `_Detailed` recipe: nested components on planes, the Open toggle (open-position solids on new planes driven by formulas from the sizes), clearance zones and `Show Clearance`, the LOD visibilities. The recipe check and the flex test must pass on every type | Claude Code |
| D4 | **Twins:** `fmc_rhino twins` on the component families and on the fixed products (generator, fire pump, steriliser) → `batch_SAMPLE14_LOD400.json` | Claude Code |
| D5 | **Build and test in Revit:** batch, Gate A, flex test with `Open` Yes and No, host tests for the hosted items, the pictures | The tester |

## Done when
Each of the 10 builds in Revit from its generated recipe, flexes on every type with `Open` Yes and No, cuts its host
(doors and windows), shows its clearance on all levels, and Gate A reads Coarse LOD 100, Medium LOD 300, Fine LOD 400.

## Rules
Staging only. Dry run first. No brand names. Engineer values are asked, never set (rule 5). 8 MB per family at LOD 400.
