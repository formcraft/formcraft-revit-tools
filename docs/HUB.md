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
| Power BI Desktop | Files Power BI reads (H2); the gateway to Microsoft's Power BI Modeling MCP server is designed, not set up | Gateway | `fmc_powerbi` |

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

## Power BI: `fmc_powerbi` (H2)
The project's data model as files Power BI Desktop reads, with no binary step and no connector to install.

- **Tables** (tidy CSV in `data\`): `Rooms` (Revit's rooms joined by number to the recipe tree's planned area and the
  brief's target; Over, Under or On target past `tolerance_pct`), `Quantities` (by keynote code, from the same read as
  `fmc_build`; quantities only, never rates), `QA` (one row per rule result of a read-only QA run), `Tickets` and
  `TicketElements` (the review register by discipline and priority; no owner, raiser or answerer, rule 9), `Clashes`
  (every Navisworks clash test, both Revit elements, the ticket raised for it; never Navisworks' "assigned to"),
  `Structural` (NEd and MEd from the newest Robot results package), `Identity` (the identity map) and `Sources` (where
  each table came from and why one is empty). Keys: room number, Revit UniqueId or element id, ticket id, Formcraft id.
- **The model:** `FMC_Project.pbip` with a TMDL semantic model (`FMC_Project.SemanticModel\definition\`): each table
  reads its CSV through Power Query from one parameter, `DataFolder`; relationships TicketElements → Tickets,
  TicketElements → Identity, Clashes → Tickets, Rooms → Identity, Structural → Identity; measures for rooms over and
  under target, open and overdue tickets (slice by `lead_discipline` and `priority`), clashes open and with a ticket,
  quantity lines and unmeasured lines by bill, QA fails and warnings, the largest NEd and MEd. The report is one blank
  page for a person to build on.
- **Where:** an exchange package (hub → powerbi, `Packages\<time>_hub-powerbi_Project_data_model\`, its model pointing
  at its own `data\`), and `<project>\01_WIP\_Exchange\PowerBI\latest\` for Power BI to point at. Each build replaces
  the latest CSVs; the latest model is written once and then kept with the person's edits (`refresh_model=true`
  archives it to `PowerBI\_Archive\` and writes a new one, refused while Power BI Desktop is open). Writes are checked
  with the guard's write folders and go only to the project's WIP.
- **Actions:** `plan` (the tables, their columns and what each reads now; read-only), `build` (a dry run first; Revit
  and Navisworks are read only when they answer, otherwise the table is empty with a note; `live=false` reads files
  only), `status` (the newest package, the latest folder, whether Power BI Desktop is running), `gateway`.
- **Opening it:** in Power BI Desktop, File › Open › `PowerBI\latest\FMC_Project.pbip`, then Refresh. If Desktop asks,
  turn on the preview features for Power BI Project files and the TMDL format (Options › Preview features). To read
  another folder: Transform data › Edit parameters › `DataFolder` (ending in a backslash).

**The gateway to Microsoft's Power BI Modeling MCP server (design note; not set up).** Microsoft's Modeling MCP server
(preview) edits a semantic model open in Power BI Desktop. The hub will start it as a gateway like any connector: off by
default, a dry run first, and passing on only an allow-list of read operations (list tables, columns, measures and
relationships; run a DAX query), every write refused until the owner decides otherwise, each call through the same log.
Its exact package name and start command are to be confirmed from Microsoft's release before it is wired; until then
`fmc_powerbi gateway` answers "not set up" and nothing is started. The Formcraft data model above works without it.

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
node build\fmc\cli.js fmc_flow < run.json      (run.json: {"action":"run","flow":"chain_test","vars":{"role":"A"}})
```
