# Generator recipe (N064)

`FMC_E_EQ_Generator_Diesel_Standby.recipe.json` is the generator's current recipe: the 6 Nov 2026 repair (parametric
v2 on planes, 697 ops), copied unchanged from the kit's
`04_Families\_Staging\_Repaired\E\FMC_E_EQ_Generator_Diesel_Standby.recipe.json`. It built in Revit and passed Gate A
on 6 Nov with the formcraft plugin (674dfb1), but this server refused it before Revit saw it: it is written with three
recipe-language ops (`set_line_weight`, `envelope`, `visibility_tier`) this server didn't know. N064 ports them
(`server/src/fmc/recipelang.ts`, `commandset/Services/Fmc/FmcDocLanguage.cs`).

`kit_subset.*` are the slices of the kit's shared parameter file and material library these recipes use, so
`server/src/fmc/generatorrecipe.test.ts` checks them the way `fmc_recipe check` does (rule 7 GUIDs, kit materials)
without the kit on the test machine.

The older photo-to-family compile in `../products/` is kept; its duplicate `add_material` (the "black" and "screen"
keys are one kit material) is fixed there and in `../../tools/fmc_parts.py`.
