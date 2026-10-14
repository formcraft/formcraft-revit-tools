# Template build scripts (14 Oct 2026, hand-run)

These are the C# snippets that built `06_Templates\_Staging\FMC_Base_Template_v2.2.rte` on 14 Oct 2026, run in Revit
2025 through `send_code_to_revit` (transactionMode none). Each opens the Base template in the background, so Revit
needs any document open first, such as a staging family or a workbench file. Each step can be run again: it creates
or updates items by name and never deletes (TPL-028). They are the reference for phase 1 of
`docs/PLAN_EXECUTION.md`, where each step becomes an `fmc_doc` project op and a layer of `Base.recipe.json`.

| Step | File | What it does | Kit source |
|---|---|---|---|
| 0 | `00_create.cs` | `NewProjectTemplateDocument` from Default-Multi-Discipline_Metric, SaveAs to staging | TPL-029 |
| 1 | `01_units_params.cs` | Units (TPL-004), P/C numbering (TPL-010), binds all `FMC_Master_Data.json` params by category and binding, TBC in Group 01 | Master data |
| 2 | `02_graphics.cs` | 7 text types, 6 line patterns, 12 fill patterns (FMC_Solid → built-in solid) | Revit kit › Graphics |
| 3 | `03_electrical.cs` | Voltages, distribution systems, load classifications. Never sets demand factors | Electrical_Settings, TPL-023/24/25 |
| 4 | `04_systems.cs` | Pipe and duct system types | Discipline_Settings |
| 5 | `05_filters.cs` + `FMC_Filters_build.txt` | 42 rule filters; categories without the parameter are dropped and reported | Filters |
| 6 | `06_view_templates.cs` + `FMC_VT_build.txt` + `FMC_FilterStyle_build.txt` | 81 view templates with filter overrides | View_Templates, Filters |
| 7 | `07_qa_views_schedules.cs` | QA, model and export views; schedules 00–09 | TPL-014/15/16/17 |
| 8 | `08_role_copies.cs` | 12 `FMC_<Role>_Template_v2.2.rte` copied from Base | 06_Templates README |
| 9 | `09_type_legend_schedules.cs` | 21 type legend schedules (one row per type), proposed to the kit | Change request items 38–39 |
| 10 | `10_legend_views.cs` | 52 legend views: 22 from the Sheet Register, 30 notes legends from `10_Notes` | Sheet_Register, 10_Notes |
| — | by hand, once | `LG_Seed_Component`: the first legend component, placed in any project and copied in; W and H dimensions by API (issue #85) | — |

Then run `fmc_template audit`. On 14 Oct the result was Pass with 0 warnings: 36.9 MB after step 8, 37.2 MB after step 10 (109 schedules).
After steps 9–10 the role templates were copied again; the previous copies are in `_Staging\_Archive\2026-10-14_b`. Step 8 skips existing files, so archive them first.

The `.txt` files are compact specs made from `FMC_Revit_Kit.xlsx` (tabs View_Templates and Filters). Phase 1
replaces them with a reader of the kit itself, so the kit stays the only source (rule 7).

Known limits (see the kit change request of 14 Oct):
- No API for line weights or phases.
- `FMC_Solid` can't be a second solid fill.
- Schedule filters are AND only.
- Keynote path Z: isn't on the pilot PC.
- Worksets can't live in an `.rte`.
