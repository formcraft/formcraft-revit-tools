# Formcraft plugin: usage and impact report (KISIC)

19 Oct 2026 · tester (Claude in the claude.ai Project) for the owner · live copy: claude.ai doc "Formcraft plugin: usage and impact report (KISIC)"

## Summary

The plugin carried the whole Kisasi job. Every change to the model went through it, and without it there would be no model, no sheets and no families. Its impact, though, came almost entirely from one tool: `send_code_to_revit`, a C# runner. The higher-level Formcraft tools (recipe build, ceiling, casework, sheets, legends) were used only a few times, and the gaps between them were filled with hand-written scripts.

The result: a furnished fit-out model, lighting and power design, three A0 sheets (E-1001, E-1101, E-1201), 16 kit families and a 4K material set, in about two days of elapsed time. The cost was 27 step scripts (about 150 KB of C#) for work the plugin could own as features, plus a handful of crashes, dialogs and kit bugs that each cost an hour or more.

## How much it was used

In the last stretch of the job still on record, the plugin took 78 calls, and 49 of them were C# scripts sent to Revit. Earlier days are no longer in the session log; the second table covers every Formcraft tool used across the whole job, from the build notes.

| Tool (session log, 18 Oct 08:42 to 19 Oct 07:19) | Calls |
| --- | --- |
| `send_code_to_revit` | 49 |
| `fmc_job` (long-job status) | 13 |
| computer use (dialog clicks) | 10 |
| `device_stage_files` (PNG checks) | 5 |
| `device_list_dir` | 1 |
| **Total** | **78** (send_code = 63 %) |

Of the 49 scripts, 38 ran, 2 of them as long jobs over 50 s. The other 11 did not run:

- 3 the owner stopped
- 4 the bridge could not deliver while Revit was busy or showing a dialog
- 4 were compile or runtime errors in the tester's own code

A typical script ran in under 1 s; opening the kit template took 37 s.

Across the whole job the build recipe grew to 27 step scripts, about 150 KB of C#, plus 24 files for the LOD 400 families.

| Tool | Used for | Result |
| --- | --- | --- |
| `send_code_to_revit` | All modelling: shell, rooms, ceilings, finishes, furniture, lighting, power, sheets, schedules, legends | Worked; carried the job |
| `fmc_recipe` check + batch | 16 kit families from recipes (771 ops) | Built in about 3 min; 8 of 16 needed a fix and a second pass |
| `fmc_recipe` build stepwise | LOD 400 woven pendant | Built; batch mode failed its size check |
| `fmc_rhino` | Smooth parts: pendant 11, TV 10, sofa 30, planter 24 | Exported cleanly; only the pendant reached Revit |
| `fmc_ceiling` | Ceiling and fan layout check | Caught a fan 605 mm off the tray centre |
| `fmc_casework` | Lab casework run, 11 units | Built after two refused calls on the input format |
| `fmc_material` | Material lookup | Answer too large (122 k characters) |
| `fmc_file` | New model from a template | Saves at once, so the unsaved-project route was used instead |
| `fmc_job` | Following long scripts | Reliable; flagged dialogs waiting for a person |
| `fmc_diagram` | Single-line diagram | Not usable: the kit DB takes no distribution system |
| `fmc_legend` | Legends | Only a kit chain test; real legends were scripted |
| Device bridge + computer use | PNG checks, dialog clicks | PNGs fine; clicks blocked by Windows focus |

## What it delivered

The kit content (title block, symbols, families, the legend seed) gave the drawings their Formcraft look. The logic that placed that content was almost all script: only the families and the LOD 400 pendant came out of a dedicated plugin tool.

| Deliverable | How it was made | Made by |
| --- | --- | --- |
| Shell, rooms, flat board ceilings, finishes | Step scripts 01–04 and 15 | Script |
| 16 kit families (lights, switches, furniture, heater, TV) | `fmc_recipe` check + batch | Plugin tool |
| Furniture, lab casework, equipment placeholders | Scripts 05 and 09, plus `fmc_casework` for the lab run | Mixed |
| Lighting layers and switching (one layer, one switch) | Scripts 06, 12, 15 and 18, and a new "FMC Switch" parameter | Script |
| Power plan: socket type per load, X-ray and ultrasound supplies | Script 17 with 37 kit SLD symbols | Script + kit symbols |
| Single-line diagram and riser | Drafting views drawn line by line | Script (`fmc_diagram` blocked) |
| 4K materials (12 texture sets) | Python texture generator + script 13 | Outside the plugin |
| LOD 400 woven pendant | `fmc_rhino` parts + `fmc_recipe` build stepwise | Plugin tool |
| Sheets E-1001, E-1101, E-1201 | Kit title block FMC_TB_A0, layout by script | Kit + script |
| Lighting and device legends | Kit template's seed legend component, copied and retyped by script | Kit + script |
| Luminaire, switching, power & data schedules | Script | Script |

## Where it helped most

The biggest win was a safe, fast way to run code in Revit. Everything else in this list builds on that.

- **`send_code_to_revit` with structured errors.** Compile errors came back with line and column, runtime errors with the exception and script line, and warnings were cleared and listed. Most mistakes were fixed in one retry, and a typical run took under 1 s.
- **Long jobs that don't fail.** Scripts over 50 s came back as a job id instead of a timeout. `fmc_job` then named the exact dialog Revit was waiting on (Duplicate Types), which is how the stall was found.
- **Recipes as the build record.** The model lives in 27 replayable step scripts and a JSON recipe, so a crash or a site change means a rebuild, not a redraw. `fmc_recipe check` passed 16 recipes and `batch` built them in about 3 minutes.
- **Kit content with a house look.** FMC_TB_A0, 40 FMC_SYM_E symbols and the seed legend component made three sheets look like Formcraft drawings, with no drafting from scratch.
- **Checks that think like a designer.** `fmc_ceiling` caught a fan 605 mm off centre, and `fmc_casework` refused to invent workshop dimensions.
- **Kit hints with each answer.** Errors often named the family's spec and recipe path, so the right source was one step away.

## Where it got in the way

Most of the lost time came from gaps between tools, not from the tools that exist. The table is ordered by time lost, largest first.

| Problem | What happened | Workaround |
| --- | --- | --- |
| Leaked transaction crashed Revit | A script opened a transaction without `using` and threw. The bridge reported the error but left the transaction open, and Revit hit a fatal error. | Rebuilt from the recipe; every later script used `using` + rollback |
| Kit DB takes no distribution system | `FMC_E_EQ_DB_Final_TPN` refuses every distribution system, so there are no Revit circuits and `fmc_diagram` cannot draw | SLD and riser drawn line by line; circuits kept in Comments |
| No light-source op | Turning on Light Source creates no light types until a type is added; the downlight's 3 m light-source symbol drew a 10 m box into the legends | Type-recreate trick (script 16, not yet run); symbol length still to fix |
| Clearance and envelope boxes at Fine | Clearance, coarse-envelope and connector-pad solids show at Fine in renders and legends; legend views ignore the view's visibility settings | Hidden per view (795 view/subcategory pairs); legends need a family fix |
| Dialogs stop scripts | Copying the legend seed raised Duplicate Types; computer use could not click it because Windows kept the desktop in front | Waited for the owner to click OK (about 5 min, twice) |
| No project screenshot | `fmc_doc screenshot` is families-only | Image export + staging, about 10 times for plan and sheet checks |
| Blind sheet layout | Viewports landed off position, and invisible geometry stretched legend extents | Placement by outline maths; still being fixed on E-1201 |
| Revit's Switch ID is read-only | Lighting switch groups could not be stored on fittings | New shared parameter "FMC Switch" bound to fittings and switches |
| Batch size check | `fmc_recipe batch` re-injects `size_mm`; padded bounding boxes fail small parts | Built the pendant with build stepwise |
| Misleading busy message | Three calls failed with "fmc_document_info timed out" while Revit was exporting | Retried after the export finished |
| Kit materials | Paint textures render grey; new families arrived with material set to "none" | Colour-only paints, materials set by script |
| New model saves at once | `fmc_file` create_from_template saves immediately, which trips the live-model lock | Unsaved Project1 via Ctrl+N |

## Recommendations

Turn the scripts this job needed into plugin features. The first four would have saved most of the lost time; they are ranked by time saved. Full specs: `../KISIC_GAP_SCRIPTS.md`.

1. **Transaction safety in the bridge.** Refuse a script whose transactions are not in `using` (`FMC-CODE-TX-USING`), and detect a transaction left open after a run (`FMC-CODE-TX-LEAK`). Add an `FmcScript.Tx` helper that commits, rolls back on error and supports dry runs.
2. **Working distribution boards and circuits.** Fix the distribution system on `FMC_E_EQ_DB_Final_TPN` and add a single-phase 240 V type. Then add `fmc_systems create_circuits`, which reads "circuit Pn" from devices. That unlocks panel schedules and `fmc_diagram` for the SLD.
3. **Clean families for renders and legends.**
   - A recipe op `set_light_source` (lumens, K, shape, distribution, symbol length).
   - A kit rule: clearance and connector-pad solids show in 3D only, and coarse envelopes at Coarse only.
4. **Dialogs answered by rule.** Give the bridge a Duplicate Types handler (use destination types) and a short list of safe auto-answers. Never auto-answer crash or recovery dialogs.
5. **`fmc_view screenshot` for projects and sheets.** Return a PNG of any view or sheet, cropped to content, so checks need no hand-written export code.
6. **`fmc_sheets layout` and `fmc_legend build`.** Place viewports, schedules and legends in the title block's drawing area. Build legend components for every type used, measured by their visible geometry.
7. **`fmc_boq` from the model.** Counts by type, strip metres and cable estimates per circuit, written to the kit's BOQ format.
8. **Smaller fixes.**
   - `fmc_file` with `save=false`.
   - A compact `fmc_material` answer.
   - A batch size check that reads true geometry.
   - Busy messages that name the real cause (export running, dialog open).

Based on the session log for 18–19 Oct, the Project doc *FMC_Plugin_Experience_Log_KISIC.md* and the build recipe folder.
