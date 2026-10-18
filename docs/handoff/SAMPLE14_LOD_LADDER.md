# Handoff: the 14-family engineer sample, every family at three levels (owner, 19 Oct 2026)

**For:** Claude Code (and the tester for the recipe steps marked Chat). **From:** the tester. **Queue:** P00 · QS01–QS12,
front of the queue, after F-067 (#191). **Status:** the owner asked for this on 19 Oct; plan steps wait for his yes before
code (CLAUDE.md "Plan first").

## What the owner wants
The catalogue for the engineer shows **14 families, each one at three levels side by side**, exactly like the first four
(catalogue pages 12–15):

| Level | What it is | Size seen so far |
|---|---|---|
| **LOD 200** | The standard family: fully parametric, flex-tested, light | 0.6–0.9 MB |
| **LOD 300** | The detailed family at Medium: native recipe body, more parts, true outlines | 0.9–1.5 MB |
| **LOD 400** | The same detailed family at Fine: the smooth Rhino twins (`fmc_rhino twins`, `import_part`) | ≈ 8 MB budget |

The plain envelope box at Coarse is **LOD 100**, not LOD 200 (owner, 19 Oct). Use these labels in the recipes'
`FMC_LOD` values, Gate A rows and the catalogue. This replaces the "Coarse = LOD 200" wording of #182 and #190.

The rest of the catalogue comes off the sheet; the sample folder `_Staging\_Sample_Engineer_14` holds the 14.

## The 14 (owner wants doors and windows in the mix)
| # | Family | LOD 200 (standard) | LOD 300 recipe (`_Detailed`) | LOD 400 (Rhino twins) |
|---|---|---|---|---|
| 1 | `FMC_I_MedEq_Bed_ICU_Electric` | built | built (`batch_DET2.json`) | twins: redo from `batch_DET2.json` (F-067) |
| 2 | `FMC_E_LightFixture_OperatingLight_Ceiling` | built | built; heads stepped, arms missing in Revit: fix | twins built |
| 3 | `FMC_I_MedEq_Machine_Anaesthesia` | built | built (`batch_DET2.json`) | twins: redo (F-067) |
| 4 | `FMC_I_MedEq_Incubator_Neonatal` | built | built (`batch_DET2.json`) | twins: redo (F-067) |
| 5 | `FMC_A_Door_FlushSingle_Hygienic` | built (v6) | **to write** | to make |
| 6 | `FMC_A_Door_LeadLined_Xray` | built (v6) | **to write** | to make |
| 7 | `FMC_A_Window_Observation_Internal_Nurse` | built (v6) | **to write** | to make |
| 8 | `FMC_A_Window_Hatch_Pharmacy_Dispensing` | built (v6) | **to write** | to make |
| 9 | `FMC_A_Window_Laboratory_Fixed` (**new family**) | **to write and build** | **to write** | to make |
| 10 | `FMC_M_AirTerminal_Diffuser_LaminarFlow_Theatre` | built (v6) | **to write** | to make |
| 11 | `FMC_P_MechEq_MedGas_BedheadPanel` | built (v6) | **to write** | to make |
| 12 | `FMC_P_PlumbingEq_Steriliser_Steam_CSSD` | built (v6) | **to write** | to make |
| 13 | `FMC_E_EQ_Generator_Diesel_Standby` | built | **to write** | to make |
| 14 | `FMC_FP_MechEq_FirePump_Set` | built | **to write** | to make |

Doors and windows are hosted (wall openings, `Metric Door.rft` / `Metric Window.rft`): their LOD 300/400 keep the
opening cut, the frame on the wall planes and the swing/opening symbols; only leaf, frame, glazing beads and
ironmongery get Rhino twins. The laboratory window (9) is new: an internal or external fixed laboratory window with a
sealed, coved, flush-glazed frame (no ledges, cleanable), optional pass-through hatch type, per HBN 15 laboratory and
cleanroom finish rules. Write its LOD 200 recipe like the observation window (plane-driven, flex-tested) first.

## Tasks
| Id | Task | Who | Done when |
|---|---|---|---|
| QS01 | **Labels:** `FMC_LOD` values and Gate A levels: Coarse box = LOD 100, standard family = LOD 200, detailed Medium = LOD 300, detailed Fine = LOD 400 | Code | Gate A rows and the recipe check use these labels |
| QS02 | **F-067 first:** twins for bed, anaesthesia machine and incubator from `batch_DET2.json`; `twins` refuses a twin outside the Coarse envelope | Code | `batch_DET_LOD400.json` rewritten; envelope check tested |
| QS03 | **Detail generator for any recipe:** `fmc_rhino detail` (or a server script) that turns a standard recipe into a `_Detailed` recipe: keeps planes, parameters, types, connectors, clearance, keynote, materials; replaces box parts with true outlines, adds the small parts (handles, hinges, grilles, gauges, castors, beads, seals) from the family's parts list; Coarse = envelope (LOD 100). The chat's `hgen.py` approach (18 Oct) is the reference | Code | Run on the 10 standard recipes; each passes the recipe check |
| QS04 | **Product detail lists** for the 10 (what the LOD 300 body must show, from the reference photos in `hc_refs.json`) | Chat | One list per family in `_Staging\_Batch\detail_lists.json` |
| QS05 | **Laboratory window LOD 200** recipe, build, flex test | Chat | `FMC_A_Window_Laboratory_Fixed.rfa` in staging, Gate A Pass |
| QS06 | **LOD 300 recipes** for the 10 from QS03 + QS04, into `batch_SAMPLE14_DET.json` | Code + Chat | 10 valid recipes; the chat reviews each 3D preview |
| QS07 | **LOD 400:** `fmc_rhino twins` on the 10 (plus the 4 redone) → `batch_SAMPLE14_LOD400.json`; wall-hosted items keep their opening and frame native | Code | All twins closed and checked; envelope check passes |
| QS08 | **Operating light fix:** smooth heads and visible arms and axis at LOD 300 (stepped heads, missing arms seen in Revit 18 Oct) | Chat | Revit picture shows heads, arms and axis |
| QS09 | **Build all 14** with `fmc_recipe batch` (dry run, then real), `batch_gate`, host tests for the hosted items (door, windows, light, canopy, bedhead panel) | Tester | 14 Pass rows; LOD 400 sizes measured |
| QS10 | **Pictures:** per family, Coarse/Medium/Fine `fmc_doc screenshot` (realistic), connector glyphs and the face-based host plate hidden; preview and Type Image set | Code (screenshot options) + Tester | 42 images in `_Staging\_Sample_Engineer_14\_Images` |
| QS11 | **Sample folder:** the 14 LOD 300/400 families replace the current files; the four dropped families (delivery bed, nurse station, patient hoist, theatre AHU) move to `_Archive` | Tester | Folder holds the 14, nothing deleted |
| QS12 | **Catalogue:** 14 three-level pages with measured sizes; the rest of the catalogue taken off | Chat | Pages show Revit pictures and measured sizes |

## Rules
Staging only; nothing into `04_Families\<Role>` (release stays the person's, in the pane). Dry run first. No brand names.
File-size budget 8 MB at LOD 400; report any family over it. Curved parts stay fixed in shape per type (owner's rule);
straight parts stay plane-driven.
