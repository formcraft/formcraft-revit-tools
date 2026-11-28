# `fmc_archicad` map and export (AC1, generator step)

`fmc_archicad` turns a Formcraft family into an ArchiCAD library part source: GDL XML for LP_XMLConverter
(`xml2libpart`). It is a pure server tool. It never talks to Revit, never opens an `.rfa` or `.rvt`, never runs
LP_XMLConverter or ArchiCAD. Code: `server/src/hub/archicad.ts` (generator), `server/src/tools/fmc_archicad.ts` (tool).
It replaces the chat scratch `scripts/gdl/fmc_gdl.py` with the same output conventions (MainGUID from
`uuid5(DNS, "formcraft-gdl:" + family)`, Model Element / General GDL Object ancestry, Symbol version 44).

| Action | What it does | Writes |
| --- | --- | --- |
| `map` | Reads the source and returns the mapping report: parameters, geometry, materials, subcategories, each row `mapped`, `partial`, `assumed` or `unsupported`, with a summary tally. `full=false` (default) lists only rows that are not fully mapped. | nothing |
| `export` | Same report plus the object. `dry_run=true` (default) lists the files it would write. `dry_run=false` writes them. | the object folder only |

## Sources (exactly one)

- `recipe_file`: the family's `fmc-recipe/0.1` recipe. Full mapping.
- `report_file`: an `fmc_doc` report JSON of the family (saved from `fmc_doc open/report`). Geometry becomes boxes
  (`box_mm`), so every solid is `partial`; parameter types are guessed. Use it only for families without a recipe.
- `family_file`: an `.rfa` is refused with the way to get its recipe or report (Revit reads families, this tool doesn't).

`materials_file` (default the guard's `materials_file`) gives kit surface colours; they are defined inline so the object
looks the same in any template. Without it a stand-in surface is defined and the report says so.

## Output (`export dry_run=false`)

`out_dir` (default `<family_staging_root>\_ArchiCAD\src`) gets `<family>\`:

- `<family>.xml`: the library part (Script_1D master, Script_2D, Script_3D, Script_VL parameter script, Script_UI, ParamSection)
- `<family>.params.json`: the parameter list (GDL name, type, default, Revit name, group)
- `<family>.mapping.json`: the full mapping report
- `scripts\master.gdl, 2d.gdl, 3d.gdl, parameter.gdl, ui.gdl`: the scripts as plain text for review
- `build_gsm.cmd` only when `converter_path` is given: the LP_XMLConverter line, **written, never run**

Every file passes `checkWritePath` (write roots, blocked segments) and is logged in `FMC_MCP_FileLog.csv`. Refused:
`out_dir` equal to the source file's folder, any path outside the write roots, and XML that fails the structure check
(well-formed, unique parameter names, scripts present, PARAMETERS/LOCK only name existing parameters).

## Mapping

| Revit | GDL |
| --- | --- |
| Length / number / angle / area / volume / integer / yes-no / text / material params | Length / RealNum / Angle / RealNum / RealNum / Integer / Boolean / String / Material |
| Width, Depth, Height | A, B, ZZYZX (default type values) |
| Types | `fmcType` string VALUES list; picking one sets the type's values with PARAMETERS |
| Formulas (`+ - * /`, `and/or/not`, `sqrt`, units in mm) | master script assignments plus PARAMETERS + LOCK in Script_VL; `if()` is unsupported |
| extrusion (rect / points), void_extrusion | BLOCK / EXTRUDE; voids cut by GROUP / SUBGROUP / PLACEGROUP |
| revolution (full) / sweep (profile + path planes) / blend (equal point counts) | REVOLVE / TUBE / RULED |
| array | `FOR fmcK` loop |
| visibility per detail level, visible params | `iLOD` (Coarse/Medium/Fine) and Boolean conditions |
| clearance / coverage solids | dashed zone gated by `bShowClearance` and `bClear3D`, kept out of the bounding box |
| plan symbolic lines and arcs | LINE2 / ARC2 in the 2D script under `PROJECT2 3, 270, 2` |
| nested families, connectors | hotspots (placeholders) |
| subcategories | reported; pens/layers are an AC2 job |

Not mapped (reported `unsupported`): profile-family sweeps, swept blends, arcs and splines in sketches, blends with
unequal point counts, partial revolutions, FamilyType / Image params, `if()` formulas, door/window subtypes, MEP ports
(AC2a). Geometry is frozen at the default type's size (not yet driven by A/B/ZZYZX).

## CLI

`node build/fmc/cli.js fmc_archicad` with the JSON arguments on stdin, e.g.
`{"action":"export","recipe_file":"...\\FMC_I_Furniture_Table_Simple.recipe.json","out_dir":"...\\gdl_out","dry_run":false}`.
Tests: `server/src/hub/archicad.test.ts` with fixtures in `tests/archicad/`.
