# Kit change request, 20 Oct 2026: the Rhino rulebook and two materials

The owner asked for this on 20 Oct. It needs the owner's approval before anything goes into the kit.

## 1. Add `03_Master_Data\FMC_Rulebook\FMC_Rulebook_Rhino.json`
- **Proposal:** `docs/kit-proposals/FMC_Rulebook_Rhino.json` (schema `fmc-rhino/0.1`, rules RHN-001 to RHN-025, all Proposed).
- **Without it:**
  - `fmc_rhino` passes no part.
  - Recipes with `import_part` are refused (no Rhino proof).
  - Gate A fails the reference and likeness lines.
  - `fmc_selftest` reports "Rhino rulebook: Fail".
- **Why:** this is what the other PC lacked. The rulebook has to travel with the kit to every PC.
- **Limits it sets** (the same as the values the code used until now):
  - 1 mm edge floor.
  - 150,000 render-mesh faces before a warning.
  - 8 MB per family.
  - 150 mm envelope error.
- **New limits:**
  - Reference evidence: 3 views, 2 sources, 3 verified dimensions, material evidence, 5 features.
  - Likeness: IoU 0.80, 8 % aspect, every feature, a blind reviewer, 6 rounds.

## 2. Materials for the sofa practice (and the furniture store)
| Name | Colour | Why |
|---|---|---|
| `FMC_Timber_Walnut` | #5C3A21 | Walnut frames: mid-century furniture; mahogany stands in now |
| `FMC_Fabric_Velvet_ForestGreen` | #2F4A3A | Velvet upholstery; grey wipe-clean stands in now |
