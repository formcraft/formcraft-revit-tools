# Builder 5 proposals: new actions (tools 51+)

Standing rule (28 Nov 2026): Builder 5 improves and fixes existing tools and adds no new action, MCP tool or add-in command.
The new actions written before the rule are kept on `feat/research-51-plus-new-actions` (one commit per tool, on top of
`feat/research-51-plus-fixes`), unbuilt and untested since the split. Each one needs a yes before it is merged.

| Tool | Action | Research ID | What | Why |
|---|---|---|---|---|
| fmc_keynote_legend | refresh, remove | 52 (fmc_keynote_legend.md) | Plans moving an existing keynote legend to the zone (refresh, with zone_check) or taking it off (remove). Plan-only; a real run is refused with FMC-KEYNOTE-LEGEND-PLAN-ONLY. | A sheet that already has the legend is only skipped today (FMC-KEYNOTE-LEGEND-ALREADY), so a legend in the wrong place cannot be fixed from the tool. The apply needs the plan hash (Builder 1). |
| fmc_legend | list_chains | 54 (fmc_legend.md) | Read-only list of the chain-test projects already made (FMC_ChainTest_<Role>.rvt in _ChainTests and _Archive) with size, date and any result JSON beside them; role filters. Reads the folder only, opens no model. | The chain tests on disk could not be seen without opening the folder by hand. |
| fmc_material | map, repair_textures | 57 (fmc_material.md) | Read-only plans: which database material each off-library material maps to (from/to or a name match), and where each broken texture path should point (the database map, else a kit Textures file of the same name). | audit finds 139 off-library materials and 43 broken textures but cannot suggest a fix. |
| fmc_memory | purge_candidates (add-in action of fmc_memory) | 58 (fmc_memory.md) | The same PerformanceAdviser read as purge_unused, nothing deleted, no transaction: count by category and the first 200 elements. Used by the purge_unused dry run. | The purge_unused dry run shows no candidates. Note for Builder 1: fmc_memory and fmc_memory_apply share FmcMemoryHandler. |
| fmc_navis | open, viewpoints | 59 (fmc_navis.md) | open: an .nwf, .nwd or .nwc in Navisworks (dry run first). viewpoints: the saved viewpoints, read-only. Bridge commands navis_open and navis_viewpoints. | There is no way to open a federation or list viewpoints from the tool. The Navisworks bridge is not built on crafty27. |
| fmc_project | templates | PJ-3 | Read-only list of the kit's FMC_<Role>_Template_v*.rte under template_roots (released and _Staging) and the template chosen per role. | The kit template lookup itself (templates_from_kit on plan/start) is on -fixes; this action only shows the list. |
| fmc_queue | wait | QU-9 | Waits up to seconds (1-120) until nothing live is queued or running (for one document), polling once a second, and says why when the time is up. | Callers poll list in a loop today. |
| fmc_report | read | RT-9 | One saved report by name (…-RP-Z-NNNN, .md or .csv) from the dated _Reports folders, read-only, 200 kB cap. | list only gives paths; reading a report needs a file read. |
| fmc_review | help | RW-7 | help_for one action returns the fields it reads and what it writes (all 21 actions). | fmc_review has 21 actions on one schema and the text field means different things per action. |
| fmc_replace | (new read) | RP-1 | Not written. Needs a new read of the current values before a replace. | Skipped under the rule. |
