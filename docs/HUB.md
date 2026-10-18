# The engineering hub

One Formcraft MCP server reaches every engineering app through a connector per app. The plan, with its steps, is in
`docs/PLAN_ENGINEERING_HUB.md`; this page is how it works today.

## The apps
| App | Connector | Kind | Tools |
|---|---|---|---|
| Revit 2025 | The Formcraft add-in, a local socket per Revit | Add-in bridge | Every Revit tool (always on) |
| Navisworks Manage 2025 | `Formcraft.Navis` add-in, local socket 8190 | Add-in bridge | `fmc_navis` |
| Robot Structural Analysis 2025 | `fmc-robot.exe` beside the server | Process | `fmc_robot` |
| Rhino 8 | `Formcraft.Rhino` package, local socket 8191 (H1) | Add-in bridge | `fmc_rhino` |
| Power BI Desktop | Not built yet (plan step H2): a gateway to Microsoft's Power BI Modeling MCP server | Gateway | `fmc_powerbi` (to come) |

## Rhino: `fmc_rhino` (H1)
The smooth, fixed-shape parts of LOD 400 families (castors, grips, light heads, knobs, canopies): the hybrid family in
`docs/handoff/DETAILED_FAMILIES_RHINO.md`. The add-in (`connectors/rhino`) is a Rhino 8 package in
`%APPDATA%\McNeel\Rhinoceros\packages\8.0\Formcraft.Rhino\1.0.0`; it loads when Rhino starts, listens on `127.0.0.1`
only (8191, the next free port up to 8199 for a second Rhino) and writes `%APPDATA%\Formcraft\apps\rhino.json`.

- **Never the person's drawing.** Parts are built in the add-in's own memory, one set per family, on its own worker
  thread; files are written with openNURBS. So it works whatever Rhino's licence state, as long as Rhino opens, and it
  never waits on Rhino's window.
- **Named operations only:** `box_rounded`, `extrude` (rect, rounded_rect, circle, ellipse, points), `revolve` (a lathe
  profile, smooth or with corner_radius), `pipe` (a path with corner_radius, or an arc; flat or round caps), `loft`,
  `torus`, `sphere`, `shell` (open faces by direction), `boolean` (union, difference, intersection), `fillet` (all,
  vertical or horizontal edges); `fillet` on any op, then `rotate` and `move`. Millimetres; a part's origin is where
  Revit places it. Each part carries `subcategory`, `material` and `visibility` (`fine`, `medium_fine`, `all`). A
  `part` call is all or none.
- **The check** (in the server, tested in CI): closed, manifold and valid; no edge under 1 mm (Revit drops edges under
  0.78 mm); a subcategory and a material (Gate A); no part larger than the type's envelope; a warning past 150,000
  render-mesh faces (the 8 MB family budget). `export_parts` refuses while the check has errors.
- **Files**, only in `<family_staging_root>\_Rhino`, a dry run first: `save` (`<family>.3dm`, a layer per part with
  its user text), `render` (`<family>_3d.png`, shaded with outlines, drawn by the add-in), `export_parts`
  (`<family>\<part>.3dm` each, plus `parts.json` with sizes and SHA-256). Revit reads `.3dm` directly
  (`ShapeImporter`), which `fmc_doc import_part` uses next (H3 in the handoff).
- **Without AI:** `connectors\rhino\samples\smoke.ps1` runs a part set through `fmc_rhino` end to end.

## `fmc_apps`
- **`list`:** each app, whether it is installed (its program exists) and running (its process), its connector and
  whether it is built, whether it is on, and the tools it brings. `fmc_selftest` has the same, as its **Apps** lines.
- **`switch`** (`app`, `on`): turns an app on or off for this PC, in `%APPDATA%\Formcraft\apps.json`. An app's tools
  load only while it is on, so an app nobody uses costs no tokens. By default every installed app is on, and Revit
  always is. A switch takes effect the next time the MCP server starts (restart the Claude app).

An app installed somewhere else can be pointed at with `FMC_APP_<ID>_EXE` (for example `FMC_APP_RHINO_EXE`).

## Adding an app
1. Its entry in `server/src/hub/apps.ts` (`APPS`): name, kind, program, process, tools, where its connector lives.
2. The connector: an add-in that listens on `127.0.0.1` only, or a program the server starts. Named operations only;
   writes only to staging and WIP; long operations through the shared job system.
3. Its tool (`fmc_<app>`), with a dry run first, a stand-in for CI, and docs.
