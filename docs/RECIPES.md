# Family recipes · fmc-recipe/0.1

A recipe is a family's build as data. It names the template, lists the `fmc_doc` operations in order, and says where
each value came from. The B1 water-heater batch (`tests/doc/FMC_P_MechEq_WaterHeater_Instant.ops.json`) is already a
recipe; version 0.1 adds value sources and code checks.

```json
{
  "schema": "fmc-recipe/0.1",
  "family": "FMC_A_Door_SteelFanlight",
  "template": "Metric Door.rft",
  "ops": [ { "op": "set_category", "name": "OST_Doors" }, "…" ],
  "values": {
    "Steel gauge": { "value": "18", "source_status": "verified", "source": "supplier datasheet, Oct 2026" },
    "Fanlight height": { "value": 450, "source_status": "assumed" }
  },
  "checks": { "clear_opening_min_mm": 900, "clear_opening_param": "Width" }
}
```

| `source_status` | Means | Gate A |
|---|---|---|
| `verified` | From a datasheet, a measurement or the supplier | Pass |
| `EA` | East African practice, not confirmed for this country | Pass, with a note |
| `assumed` | A reasonable stand-in | Warn: the reviewer accepts it or sends it back |
| `pending` | Not known yet | **Fail**: it can't be released |

## LOD 400 ops (Family Authoring Standard 1–3)

| Op | Makes | Standard |
|---|---|---|
| `add_subcategory` | An object subcategory with projection and cut line weights, colour and material | 3.3: Frame, Panel, Glass, Opening, Plan Swing, Elevation Swing, Hidden Lines, Clearance |
| `set_subcategory` | Puts a solid or a line set on a subcategory | 3.3: every element on a named subcategory |
| `sweep`, `void_sweep` | A swept solid or void along a polyline (plan, front or right), from points or a loaded `FMC_Profile_*` | 3.1: frames, profiles, rebates that cut correctly in section |
| `revolution`, `blend` | Turned parts (roses, knobs, nozzles) and tapered parts | 2: G4 Fine geometry |
| `symbolic_lines` | Lines or an arc in plan, front or right, per detail level, on a subcategory | 3.2: swing arcs in plan, opening lines in elevation |
| `lock_face` | Aligns and locks a solid's face to a named plane | 1.4: faces locked to planes |
| `add_eq_dimension` | An EQ dimension across three or more planes | 1.4: symmetry |
| `load_family`, `place_nested` | Loads an `.rfa` from the kit's `04_Families` and places it, with parameters associated | 1.7: nested parts; 3.4: detail kit |
| `profile_lines` | A profile family's closed loop (template `Metric Profile.rft`, category Profiles): detail lines and 3-point arcs in the Ref. Level plan, mm, x across and y up | 3.1: the `FMC_Profile_*` families that sweeps load |
| `set_visible_param` | Ties a solid's (or sweep's) Visible to a Yes/No family parameter | One parameter switches which part shows |
| `add_material` | A material from the kit's library (`07_Materials\FMC_Materials.json`) with its class, colour, keynote, description and textures; optionally the value of a Material parameter in every type | Rule 7: kit materials only, never made up |

### Profiles, switches and kit materials

```json
{ "op": "profile_lines", "name": "Architrave", "start": [0, 0], "subcategory": "Profile",
  "segments": [ { "to": [70, 0] }, { "to": [70, 12] }, { "to": [62, 20], "through": [67.66, 17.66] }, { "to": [0, 20] }, { "to": [0, 0] } ] }
{ "op": "set_visible_param", "name": "Track M7/Visible", "solid": "Track M7", "param": "Show M7" }
{ "op": "add_material", "name": "FMC_Timber_Mvule", "param": "Frame Material" }
```

- **profile_lines.** Each segment runs from the previous point to `to`. A segment with `through` is an arc through
  that point, else it's a straight line. The last `to` must be the start (within 0.01 mm). The server refuses an open
  loop, a segment with no length, an arc whose three points are in a line, and a loop that crosses or touches itself.
  A second run skips a loop that's already there. If the loop is there with another shape, it's left as it is: rename
  the op to draw it again. `tests/doc/FMC_Profile_Sample.ops.json` is a sample.
- **set_visible_param.** Name it `<solid>/Visible`. The parameter must be Yes/No: add it earlier in the batch with
  `add_family_param` (type `YesNo`) and give it a formula. For example, with `FMC_Design_Movement = 7`, one shared
  parameter picks which movement's sweep shows.
- **add_material.** The server looks the name up in the kit's library. A name that isn't there is refused (ask the
  BIM Manager: `fmc_material request`). The server passes the material's fields and each texture's path on this PC to
  Revit. Revit then:
  - makes the material if it's missing, or updates what differs
  - gives it its own appearance, named after the material and copied from a Generic one, with the albedo map as the
    colour bitmap and the bump map, at the kit's real-world size
  - sets the material in every type when `param` names a Material parameter

  A texture file that isn't on disk is left out with a warning, and the material is still made.

Sizes stay `pending` until the supplier visits give them (section 7); a recipe with a pending value builds, but Gate A
holds it in staging. Masking regions and freeform shapes stay hand work (FAM-039).

## The flow
1. **Check:** `fmc_recipe check`, read-only. It validates the operations against the kit's parameter dictionary and
   shows where the family will be staged and released.
2. **Build:** `fmc_recipe build`, a dry run first. It opens the template in the background, applies the operations,
   flexes every type, saves to `04_Families\_Staging\<Role>\` with the recipe beside it, and runs Gate A.
3. **Gate A:** `fmc_recipe gate` checks:
   - the library's checks: name, kit parameters by GUID, keynotes, size and type names. Each type's keynote is read
     from the saved file (`Keynote`, or the kit's keynote code parameter). The kit parameters are checked by GUID
     against the recipe's `add_shared_param` ops and never pass on "0 present". A file that couldn't be inspected
     says why.
   - the category against the register
   - that every type flexes. "Can't make cut-out" means the type is bigger than the template's host wall, so raise
     the host wall.
   - that labelled dimensions keep their planes' sides (F-026): each dimension `add_dimension` labels records which
     side of its first plane the second was drawn on, and flex fails a type where it ended on the other side
   - code checks, such as a clear opening of at least 900 mm
   - the IFC class
   - the value sources

   Tags, schedules, legends and detail levels need the family placed in the role's chain-test project
   (`fmc_family load_test`), so they show as **Not checked**, never as passed.
4. **Release or send back:** in the pane (Families › Quality and release), by a person, with a reviewer and a note. A
   release moves the family to `04_Families\<Role>` and adds a row to `04_Families\FMC_Release_Log.csv`. It needs a
   passed gate and never overwrites a released family. This is never an MCP tool: hard rule 2 keeps tools out of
   `04_Families\<Role>`, and release is a person's act, like a sync.

## Big recipes: stepwise builds (F-029)
Revit's bridge reads one request of up to 8 KB. The LOD 400 doors and windows are 23–44 KB of ops, so a build that
sent them all in one `fmc_doc apply` never reached Revit. That is why the Ogala build stopped before op 1.
`fmc_recipe check` now reports the request size (`bridge`). A build that doesn't fit one call is refused before Revit
is touched, and you build it stepwise:

1. `fmc_recipe build` with `stepwise: true` (and `chunk_size`, 20 by default). The build is a dry run first, as
   always. The ops go in chunks that fit the bridge. Each chunk is one TransactionGroup with its own result (created,
   updated, skipped, warnings). In a dry run the chunks go into the unsaved template, which is closed without saving,
   so nothing is written.
2. Each call does the chunks that fit before the AI client's 60-second cut-off, then answers `paused` with
   `ops_done`. Call again with `resume: true` (same `recipe_file`, `dry_run` and `stepwise`) to carry on from the
   last good op. If the template's session has closed in the meantime, resume opens it again and rebuilds the good
   ops first. Resume is refused when ops already built have changed.
3. If Revit is still working on a chunk when the server stops waiting, the answer is `running in Revit` with the op
   it is on. The add-in writes its progress before every op, to `%APPDATA%\Formcraft\Progress\`, and resume picks the
   chunk's result up from there.
4. A failed build (an op error, a chunk with no answer, a failed save) closes the template without saving. It names
   the op in the whole recipe (`failed_at`) and lists the background documents builds left open. `fmc_recipe cleanup`
   lists them as a dry run, and with `dry_run: false` closes them without saving. It never closes a document a person
   opened or that shows in a Revit window (F-023). Other window-less family documents are listed for the person to
   close.

The build records (`<reports>\FMC_Recipe_Builds.json`) and the progress files are this step's own small job record.
They move to the job model (`fmc_job`) when it lands.

Revit's shared parameter file is switched to the kit's only for the length of each call. The person's file is put
back in a `finally`, and the next Formcraft call puts it back if that ever failed (F-037). Every apply reports
`shared_parameter_file.restored`.

## Planting forms
The kit's `_build/build_plant_recipes.py` writes one recipe per planting form to `03_Master_Data/Recipes/Families/L/`,
from `_build/fmc_plants.py` (the Fam_Plants board: 13 forms, 42 Ugandan species, plus 3 species kept from the
register). Each one starts from Metric Planting.rft and uses only the ops above. `tests/recipes/` has two samples:
`FMC_L_Planting_Tree_Sphere` (revolutions) and `FMC_L_Planting_Palm_Feather` (blended fronds).

- **Split (the board's default):** one family per form (sphere, umbrella, tiered, cone and column trees, feather and
  fan palms, clump, paddle, mound and rosette shrubs, hedge, climber), each species a type named size first
  (`12000_MangiferaIndica`). The owner's question on the split is still open (decisions tracker).
- **Coarse:** a box at the type's true size, locked to labelled planes (Height, Crown Diameter, Crown Height, Trunk
  Height, Trunk Diameter, EQ about the centre), so it flexes for any type. Type 1 is set before the first plane (F-026).
- **Medium and Fine:** each species' own primitives at its size. A revolution's profile can't be locked to planes yet,
  so each species has its own solids and plan lines, shown by `Show <Species>` = `Species Index = k`. A type a person
  adds shows the right Coarse box, but the copied type's shapes. Fine adds forks, fronds, fan leaves and the middle tiers.
- **Plan:** symbolic lines per species (the board's symbols at the mature spread) at every detail level. The 3D solids
  are off in plan. Hedge and climber are locked boxes at every level and show their own outline in plan. The hedge is a
  2.6 m module with an instance Length until a line-based version exists.
- **Materials:** the solids use Foliage and Trunk Material. The library has no foliage or bark materials yet, so these
  stay unassigned and are `pending` (kit change request). The hedge uses `FMC_Plant_Hedge_Duranta`, and the climber's
  trellis uses treated pine.
- **Data:** each type gets FMC_Botanical_Name, FMC_Local_Name, FMC_Plant_Spread_mm, one keynote (new L.TRE, L.PLT,
  L.SHR, L.HDG and L.CLM items), IfcExportAs `IfcGeographicElement` and FMC_Geometry_Stage G3. Sizes are the board's
  estimates (`assumed`). FMC_Planting_Size and FMC_Plant_Spacing_mm are left for the landscape designer.
- **Not built yet:** flower dots (they wait for an array op), Growth and Variation (kit parameters) and the hedge's
  rounded top.

## Template planes (F-038)
`fmc_recipe check` doesn't flag planes the template already has. It uses a table of each template's named planes,
and the planes a build read from the template the first time it opened it take over from the table
(`<reports>\FMC_Template_Planes.json`). Metric Door.rft has Left, Right, Center (Left/Right), Center (Front/Back),
Exterior, Interior and Head on Ref. Level. Metric Window.rft adds Sill.

**Which side is exterior:** in Metric Door.rft the plane named **Exterior is at +75 mm Y** and Interior at −75 mm
(the template's 150 mm host wall), so exterior is **+y**, not −y as some recipe notes said. Read the side from the
template's Exterior plane rather than assuming it. The recipes' geometry is unchanged by this note.
