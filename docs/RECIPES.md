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
