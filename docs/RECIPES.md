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

Sizes stay `pending` until the supplier visits give them (section 7); a recipe with a pending value builds, but Gate A
holds it in staging. Masking regions and freeform shapes stay hand work (FAM-039).

## The flow
1. **Check:** `fmc_recipe check`, read-only. It validates the operations against the kit's parameter dictionary and
   shows where the family will be staged and released.
2. **Build:** `fmc_recipe build`, a dry run first. It opens the template in the background, applies the operations,
   flexes every type, saves to `04_Families\_Staging\<Role>\` with the recipe beside it, and runs Gate A.
3. **Gate A:** `fmc_recipe gate` checks:
   - the library's checks: name, kit parameters by GUID, keynotes, size and type names
   - the category against the register
   - that every type flexes
   - code checks, such as a clear opening of at least 900 mm
   - the IFC class
   - the value sources

   Tags, schedules, legends and detail levels need the family placed in the role's chain-test project
   (`fmc_family load_test`), so they show as **Not checked**, never as passed.
4. **Release or send back:** in the pane (Families › Quality and release), by a person, with a reviewer and a note. A
   release moves the family to `04_Families\<Role>` and adds a row to `04_Families\FMC_Release_Log.csv`. It needs a
   passed gate and never overwrites a released family. This is never an MCP tool: hard rule 2 keeps tools out of
   `04_Families\<Role>`, and release is a person's act, like a sync.
