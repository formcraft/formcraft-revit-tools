# Handoff: the four detailed families, built with Rhino (owner, 18 Oct 2026)

**For:** Claude Code. **From:** the tester (Claude in the claude.ai Project "REVIT MCP"). **Queue:** P00 · QD01–QD05,
front of the queue. **Status:** waits for the owner's yes on this plan before code (CLAUDE.md "Plan first").

## What the owner wants
Four hospital families at true-shape LOD 400, built in Revit, shown in the healthcare catalogue (pages 9–12) and handed
to an engineer with the pack:

| Id | Family | Template | Types | Connectors | Keynote |
|---|---|---|---|---|---|
| QD01 | `FMC_I_MedEq_Bed_ICU_Electric_Detailed` | Metric Generic Model | 1020 × 2200 | power, data | F.MED_00 |
| QD02 | `FMC_E_LightFixture_OperatingLight_Ceiling_Detailed` | Metric Generic Model face based (ceiling) | 700 single, 700 + 600 double | power | E.LED_13 |
| QD03 | `FMC_I_MedEq_Machine_Anaesthesia_Detailed` | Metric Generic Model | 770 × 690 | power, 5 medical-gas hoses | Z.MEQ_01 |
| QD04 | `FMC_I_MedEq_Incubator_Neonatal_Detailed` | Metric Generic Model | 780 × 990 | power, 2 medical-gas hoses | F.MED_07 |

Recipes (chat `hgen.py`, 18 Oct): `04_Families\_Staging\_Batch\batch_DET.json` on the pilot PC, 717–1198 ops each.
They carry everything except the smooth body: category, host, types, shared parameters, keynote, connectors, clearance
zone, Coarse/Medium box, subcategories and materials.

## Where it stands
1. The recipe-only build failed at every point-profile sweep: F-065 (#183), fixed on PR #184 (profile drawn flat at the
   origin). A chat-side rebuild with that fix is running; its result goes in `docs/TEST_FEEDBACK.md` Run 11.
2. The recipe bodies are made from revolutions, sweeps and traced profiles. They read as the product but are faceted
   (12-sided tubes, polygon outlines). The owner wants smoother, more realistic bodies: that is the Rhino part.

## The approach: the hybrid family (owner's choice, 18 Oct)
- **Native Revit** for everything that must flex or carry data: frame, deck, mattress length and width, reference
  planes, parameters, connectors, clearance, Coarse/Medium box. This stays in the recipe.
- **Rhino** for the smooth, fixed-shape parts: castors, grips and handles, control panels, CPR release, light heads and
  spring arms, monitor arm, vaporisers, gauges, the incubator canopy and hand ports. Each Rhino part is a closed solid
  that arrives as a form in the family, placed by parameters, fixed in shape (owner's rule: curved parts may stay fixed
  true shape and vary by type).
- The parametric rule holds: types change values only; geometry that must flex is native.

## One family, three LODs (PR #182, owner's choice)
Each of the four is one family: LOD 200 on Coarse (the envelope box), LOD 300 on Medium (the native recipe body), LOD 400
on Fine (native parts plus the Rhino parts). Gate A runs per level. `fmc_recipe batch` fetches any missing Rhino part
before it builds. This plan is that ladder applied to the four families first.

## What to build (fits the hub plan: H1 Rhino connector with family parts first, then the cross-app import)
### Step 1 · H1: Rhino connector, enough for families
`connectors/Formcraft.Rhino` (RhinoCommon plug-in, Rhino 8, `127.0.0.1` only, writes `%APPDATA%\Formcraft\apps\rhino.json`)
and `fmc_rhino` in the server, with a stand-in for CI. Named operations only, no free scripting:
- `status`, `describe`
- `new_doc` (millimetres, staging path), `open` (staging only), `save` (to `_Staging\_Rhino\<family>.3dm`)
- `part`: build one named closed solid on a named layer from a small parametric vocabulary: `pipe` along a polyline or
  arc path with a radius and filleted corners, `revolve` a profile, `loft` sections, `extrude` + `fillet_edges`,
  `box_rounded`, `torus`, `shell`, `boolean` (union/difference of named parts), `fillet` (variable radius). Layer =
  part name; layer user text = subcategory, material, visibility (Fine only for detail).
- `check`: every part closed and manifold, edge-length floor 1 mm, bounding box per part against the type's envelope,
  total mesh weight estimate.
- `render`: a shaded view per part set to `_Staging\_Rhino\<family>_3d.png` (for the catalogue).
- `export_parts`: each part as SAT (or Brep JSON for the bridge below) to staging.

### Step 2 · H3: Rhino parts into the Revit family
A new `fmc_doc` op, `import_part`: takes a staged SAT/Brep for a named part and places it in the open family as a form
(prefer `FreeFormElement.Create` from a Revit `Solid` converted from the Brep; fall back to imported SAT in a nested
generic family). Then the existing ops apply: `set_subcategory`, `set_material_param`, `set_visibility`. Place each part
at its anchor, and where the part rides on a flexing dimension (castors at the bed corners, light head on the arm end),
nest it as a shared family on reference planes so it moves with the type (needs QG6 locking).

Rhino.Inside.Revit is an allowed alternative for the hand-over if it is simpler (its "Component Family Form" creates
editable forms with subcategory and material); the plug-in and `fmc_rhino` stay the hub's way in either case.

### Step 3 · Recipes
Each detailed recipe gets a `rhino_parts` block (part name, Rhino operation and values, anchor, subcategory, material)
and its faceted body ops are replaced by `import_part` ops. The chat writes these recipes once Step 1 is staged.

### Step 4 · Gates and results
Gate A as usual, plus: file size under 8 MB per family; every imported form on a subcategory with a material; Fine-only
detail; the Coarse box present; host test for QD02 on a ceiling. One row per family in `results/`.

## Done when
The four families build from their recipes plus Rhino parts in one batch job, pass Gate A and the host test, weigh under
8 MB each, and the chat has updated catalogue pages 9–12 with Revit renders marked "Built in Revit".

## Findings this touches
F-065 (#183), F-062 (#169, curved parts that flex), F-064 (#171). Retest F-065 first.

## Rules
Staging and `_Rhino` only; nothing into `04_Families\<Role>` (release stays the person's, in the pane). Dry run first for
every write. No brand names in the generic families. No Rhino operation reaches a live Revit model.
