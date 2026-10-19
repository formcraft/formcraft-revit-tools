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
  thread; files are written with openNURBS (Rhino must still be licensed, or in its trial, to open), and it
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
- **`twins`: LOD 400 from a recipe.** For a detailed family, each native solid (point extrusion, revolution, sweep)
  gets a smooth twin at the recipe's own coordinates: sampled arcs become true arcs (`RhinoFit`), a round 12-point
  profile becomes a true pipe. The envelope, clearance zones, connector pads and boxes between planes stay native.
  The twins are checked one by one (a failing twin stays native on Fine), exported, rendered, and the recipe gets,
  per twin, `import_part` + the native solid's subcategory, material parameter and type switch on Fine only, while
  the native solid becomes Medium only. Written to `<staging>\_Batch\<family>_LOD400.json`.

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

## How the apps talk: the exchange layer (X0)
A project's exchange is `<project>\01_WIP\_Exchange` (or `<reports>\Exchange` with no project named):

- **The identity map** (`FMC_Identity.json`): one Formcraft id (`FMC-…`) per element, mapped to its id in each app:
  Revit by UniqueId, a Robot run's bar as `<run>#<bar>`, and next Navisworks items and Rhino objects. `fmc_robot send`
  links every bar it sends to its Revit element. `fmc_flow identity` gives the counts.
- **Exchange packages** (`Packages\<time>_<from>-<to>_<what>\`): every hand-over between apps, with a `manifest.json`
  (what, from, to, when, each file's SHA-256). Nothing is overwritten. `fmc_robot send` keeps a revit → robot package
  and a real `results` a robot → revit one. `fmc_flow packages` lists them; `fmc_flow verify` checks one is unchanged.
- **Saved flows** (`fmc_flow`): repeatable work as a file, run from a button, the command line or a schedule, with **no
  AI and no credits**. Built in: `health`, `pack_rebuild` (batch_file), `chain_test` (role), `robot_send` (supports,
  cases, engineer), `robot_results` (run). A project adds its own in `Flows\<name>.flow.json` (`fmc_flow save`, a dry
  run first). A run is a dry run unless `dry_run` is false; a step can use an earlier step's answer
  (`${step.build.batch}`) or the run's variables (`${var.role}`); a failing step stops the flow; every run is kept in
  `Runs\`.

Without AI, from a command line (or a scheduled task):

```
set FMC_STARTED_BY=schedule                     (in a Task Scheduler action: the call ledger counts it as scheduled, docs/AUTOMATION_BALANCE.md)
node build\fmc\cli.js fmc_flow < run.json      (run.json: {"action":"run","flow":"chain_test","vars":{"role":"A"}})
```

## One selection: `fmc_select` (X1)
Select elements in one app and the same elements are selected, and zoomed to, in the others. Selection changes only
what each app shows (its selection and camera), never a model, so it has no dry run.

- **`show`** (`from`, `to`, `ids`): `from` is revit, navisworks, rhino or robot; without `ids` it takes that app's
  current selection. Each app is asked in its own terms, and the identity map fills in the rest:
  - **Revit:** `fmc_selection_get` reads the selection (UniqueIds, element ids, categories, model, and elements picked
    in links); `fmc_selection_show` selects by UniqueId or element id and zooms (`select: false` only looks them up).
    Revit is asked first, so every element has both its UniqueId and its element id + model.
  - **Navisworks:** `navis_select` finds the items a Revit element became by its "Element ID" property in the model
    from the same file (as the clash results read it), selects them and zooms; `navis_selection` reads the selection
    back as Revit ids.
  - **Rhino:** `rhino_select` selects objects in the open drawing by id, or by the user text `fmc.id` (the Formcraft
    id); `rhino_selection` reads it back. These run on Rhino's window thread and give up after 30 s when Rhino is busy.
  - **Robot:** `fmc-robot.exe select` selects the bars of the run open in Robot (`<run>#<bar>` in the map) and
    `selection` reads them back. It never starts Robot; Robot's API selects but doesn't zoom.
- **`read`:** every open app's current selection with what the map knows about each element; nothing changes.

The answer says, per app, what was selected, what wasn't found, and which elements have no id there yet (`not_mapped`).

## One search and one log: `fmc_find` (X3)
- **`find`** (`query`: a mark such as D-12, a room number, a name, a Formcraft id, a UniqueId or element id): the
  identity map; Revit (`fmc_find_elements`: mark, type mark, number, room name, sheet number, name, comments holding
  the tree's FMC: mark; with `touching`, the model elements within 25 mm of each match's box); Navisworks (the items
  the matches became, looked up without selecting, and every clash naming them with what they clash with); review
  tickets (by their elements, clash items, recipe node or words); recipe tree nodes (by id, name or a value such as a
  room number); exchange packages that carry it (manifest, or a text file under 1 MB).
- **`log`:** one timeline, newest first, for the same query: `FMC_MCP_FileLog.csv`, exchange packages, review ticket
  history and identity links, read from files only.

Both are read-only; an app that isn't open is skipped and said so.
