# One engineering hub: Formcraft's own MCP server for every app

**Status:** plan, for the owner's yes (18 Oct 2026). It replaces track RH (Rhino), which needed a paid licence.

## The idea
Formcraft has one MCP server, and it reaches every engineering application through a small **connector** per app.
That is already how Revit, Robot and Navisworks work; this plan makes it the rule, so adding an app is routine:

- one set of rules for every app: the live-model lock, writes only to staging and WIP, a dry run first, kit data only,
  the AI involvement policy, nothing ranks people;
- one job system: heartbeats, the queue, keep-awake and results Revit (or any app) keeps (#175, #176);
- one log, one self-test, one place to look;
- work that crosses apps in one conversation: a Blender facade checked against the Revit model, a frame sent to Robot,
  clashes from Navisworks traced back to Revit elements.

The open-source servers for Blender, FreeCAD and CAD-as-code are read for ideas, not copied in: ours expose **named
operations**, not "run any Python" (the open-source Blender servers do run arbitrary code, and their own docs warn
about it).

## What exists
| App | Connector | How the server reaches it |
|---|---|---|
| Revit 2025 | Add-in with a local socket (8080–8089), one per Revit | `%APPDATA%\Formcraft\instances\<pid>.json` |
| Robot 2025 | `fmc-robot.exe`, started per call (JSON in and out) | beside the server build |
| Navisworks Manage 2025 | Add-in with a local socket (8190) and a pane | `%APPDATA%\Formcraft\navis.json` |

## The connector contract (H0)
Every connector is one of two kinds, and both answer the same small set of calls:

1. **In-app bridge:** a plug-in inside the app listens on `127.0.0.1` only and writes
   `%APPDATA%\Formcraft\apps\<app>.json` (port, process id, app version, connector version, started).
2. **Process connector:** a program or script the server starts per call (Robot today; build123d next).

Every connector answers `status` (installed, running, versions) and `describe` (its operations and their arguments).
Long operations use the shared job system. A connector never writes outside staging and WIP, and never into a live
model.

**`fmc_apps`** (new tool): which apps are installed and running, the connector versions, and each one's health.
`fmc_selftest` reports them too. Revit's instance files and Navisworks' `navis.json` move to the one `apps\` folder
(the old paths keep working for one release).

**Keeping tokens down:** each app's tools load only when that app is switched on (Settings › Apps, saved per PC, and
the existing `FMC_TOOL_PROFILE`), so a person who never uses Blender never pays for its tool descriptions.

## Steps (one PR each, the owner's yes before each)
| # | Step | Delivers | Needs |
|---|---|---|---|
| H0 | Connector contract and `fmc_apps` | The `apps\` folder convention, `status`/`describe` on Robot and Navisworks, `fmc_apps`, per-app tool profiles, `fmc_selftest` lines | — |
| H1 | **build123d connector** (CAD as code, Apache 2.0) | `fmc_cad`: make a part from parameters, measure it (sizes, clearances, sections), export STEP/OBJ to `04_Families\_Staging\_Parts`; no app window. For complex fixed-shape family parts (fittings, fixtures, ornament, the curved parts allowed to stay fixed per type) | Python on the pilot PC |
| H2 | **Blender connector**, read and basic operations | Add-on bridge; `fmc_blender`: open a staging file, list objects, make and edit simple massing, screenshots | Blender installed (free) |
| H3 | Blender for concept and facades | Named operations for massing studies and facade panels (Geometry Nodes, Blender's node editor); IFC export through Bonsai, Blender's free BIM add-on | H2 |
| H4 | Into Revit through staging | Geometry from H1–H3 enters Revit **only in staging**: as DirectShape in a staging project, or as a fixed-shape part inside a recipe family. Never a live model | H1 or H3 |
| H5 | Pane: Settings › Apps and Model › Concept | Which apps are on, their health, and the concept and part tools in the pane | H0, H2 |
| H6 | FreeCAD connector (optional) | Only if precise desktop parametric work is wanted beyond H1 | — |
| — | Later | Speckle for live exchange between apps (its Blender connector is still lossy); a real Rhino only if a licence comes | — |

## Rules that don't change
Geometry from any of these apps reaches Revit as fixed shape. Parametric families keep coming from the recipe
engine and Gate A. Release, publish, sync, issue and sign stay with people.

## For the owner to decide
1. A yes on the hub idea and on H0 as the first step.
2. The order after H0: **build123d (H1) first** is recommended. It needs no app and no licence, and gives the most
   reliable AI-made geometry.
3. Blender on the pilot PC (free) for H2–H3.
4. **Licence note:** Blender add-ons that are distributed must be GPL. For use on the firm's own PCs it doesn't
   matter. If Formcraft is ever sold with a Blender add-on in it, that add-on's code must be open. build123d (Apache
   2.0) and the server have no such issue.
