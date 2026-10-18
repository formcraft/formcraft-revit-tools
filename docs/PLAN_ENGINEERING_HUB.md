# One engineering hub: the apps work as one

**Status:** plan, the owner's direction of 18 Oct 2026. H0 is built (#181, docs/HUB.md). Each later step waits for the
owner's yes.

## The vision
One Formcraft MCP server connects Revit, Navisworks, Robot Structural Analysis, Rhino and Power BI, and makes them
**work together as if they were one application**, with AI as the operator and the firm's kit and rules in charge:

- **One identity:** an element has one Formcraft id, mapped to its Revit, Robot, Navisworks and Rhino ids.
- **One selection:** select a column in Revit and it is shown in Navisworks, Rhino and Robot.
- **Changes flow:** a change in one app flags what it affects in the others, offered as a dry-run update.
- **One search and one log** across every app.
- **The Formcraft pane** in Revit, Navisworks and Rhino.
- **AI conducts:** one request becomes the steps in each app, each with a dry run and a person's yes.

What makes it new is the combination. AEC interoperability exists (Speckle, BHoM, Rhino.Inside, Autodesk's data
model), and so do MCP servers for single apps. A local, AI-operated hub with one identity across apps, built on the
firm's own kit and governed by its rules, is not something we know of. The claim is earned by demonstrations, not
made: one request that touches three apps and works end to end, safely (for example: "this beam clashes in Navisworks:
fix it in Revit and check it again in Robot").

## Scripts first, AI second
AI does the thinking once: a recipe, a flow, a rule, the reading of a clash. Scripts repeat it, for free:

- **Saved flows:** a flow is a file (for example "rebuild the A pack", "Revit → Robot → results back", "weekly data to
  Power BI"). It runs from a **button** in the pane, the command line, or a scheduled run at night, with no AI and no
  credits. `fmc_recipe batch`, Gate A, the chain test and the clash read-back already run without AI.
- **Tables move by script:** Excel ↔ the kit's tables (CSV, JSON) through fixed import and export scripts with a dry
  run, never through AI. The kit stays the only source (rule 7).
- **AI only where judgement is needed:** reading a clash, proposing a fix, writing a new recipe or flow.

## Families: one family, three levels of detail
The hub's first real joint work is the family builder. Every product is **one family that carries all three LODs**, on
Revit's own detail levels (the owner's choice, 18 Oct):

| Detail level | LOD | What it shows | Made by |
|---|---|---|---|
| Coarse | **LOD 100** | The envelope box: true overall size, clearance zones, connectors, symbols | The recipe engine (skeleton, simple solids) |
| Medium | **LOD 200** (standard family) or **LOD 300** (detailed family) | LOD 200: the fully parametric, flex-tested body. LOD 300: accurate native geometry, real materials, frames and trims | The recipe engine (sweeps, profiles, kit materials) |
| Fine | **LOD 200** (standard) or **LOD 400 + Render** (detailed) | LOD 400 + Render: the detailed body drawn smooth for renders, curved castings, handles, fixings | **Rhino**, through the hub (`fmc_rhino twins`, `import_part`) |

Labels: owner, 19 Oct (`docs/handoff/SAMPLE14_LOD_LADDER.md`, QS01); this replaces "Coarse = LOD 200" of 18 Oct. The Rhino-smooth Fine level is **LOD 400 + Render** (owner, 19 Oct; not "LOD 500+"). Gate A
states the ladder each family carries ("Levels of detail", read from the recipe).

How a LOD 400 part gets into a family:
1. The recipe names each complex part with its parameters, per type, and where it sits: the reference planes that
   anchor it, its material, subcategory and detail level (Fine).
2. The hub asks Rhino to make it, per type, from a named operation or a Grasshopper definition with those parameters,
   and Rhino exports it to `04_Families\_Staging\_Parts` with a revision tag; an unchanged part is never made again.
3. Revit brings it into the family as a **real solid** (with material, subcategory and detail-level visibility), locked
   to its anchor planes so it moves with the family's sizes; each type shows its own part. A part is fixed per type
   (as allowed for curved parts on 18 Oct): a new size means a new part, made automatically from the recipe.
4. Gate A checks each level: LOD 100 size and clearances, LOD 200/300 body and materials, LOD 400 parts traceable to their recipe
   and revision, on their planes, following the sizes.
5. `fmc_recipe batch` asks Rhino for the missing parts first, then builds the families in one Revit job, so a pack
   rebuild covers the LOD 400 parts too.

The identity map links each Rhino part to the solid it became in each family, so a changed part flags every family
that uses it. build123d (free, code-made exact parts) can be a second part source through the same op.

## The apps on the pilot PC (18 Oct)
| App | Installed | Connector | Kind |
|---|---|---|---|
| Revit 2025 | Yes | The Formcraft add-in, a local socket per Revit | Add-in bridge |
| Navisworks Manage 2025 | Yes | `Formcraft.Navis`, local socket 8190, read-only (#94) | Add-in bridge |
| Robot Structural Analysis 2025 | Yes | `fmc-robot.exe` (#93) | Process |
| Rhino 8 | Yes (licence state to confirm) | To build (H1) | Add-in bridge (RhinoCommon plug-in) |
| Power BI Desktop | Yes | To build (H2) | Gateway to Microsoft's Power BI Modeling MCP server (preview), plus Formcraft's data |

## How the apps talk through the hub
1. **The identity map** per project (`WIP\_Exchange\FMC_Identity.json`): Formcraft id ↔ Revit UniqueId ↔ Robot bar ↔
   Navisworks item ↔ Rhino object, with rules for elements that are deleted, copied or rebuilt.
2. **Exchange packages:** every hand-over between apps is a package in `WIP\_Exchange`: what it is, from which app to
   which, version, time and checksum. Nothing is overwritten; every package can be traced.
3. **`fmc_flow`:** runs a named flow end to end (export, convert, import), a dry run and preview first, only what
   changed since the last exchange, as a job. Flows are files, so a button or a schedule runs them without AI.
4. **The same rules for every flow:** imports go only into staging or WIP, never a live model; anything that changes a
   design waits for a person's yes; engineering decisions stay with the engineer; nothing ranks people.

| Flow | What it does | Today |
|---|---|---|
| Rhino → family parts | LOD 400 parts into recipe families | Planned (H1, first) |
| Revit ↔ Robot | Analytical model out, forces back into `FMC_FEA_` fields | Built (#93); moves onto the identity map |
| Revit → Navisworks → Revit | Federate, clashes traced to Revit elements, review clouds | Half built (#94 reads clashes) |
| Rhino → Revit | Facade or massing into a Revit staging project | Planned |
| Rhino → Robot | A structural concept checked early | Planned |
| Revit / Navisworks / Robot → Power BI | One project data model: QA, clashes, quantities, structural results | Planned (H2) |

## Connectors: three kinds, one contract
1. **Add-in bridge:** a plug-in inside the app listens on `127.0.0.1` only (Revit, Navisworks, Rhino).
2. **Process:** a program the server starts per call (Robot; build123d later).
3. **Gateway:** the hub starts another vendor's MCP server and passes on only the operations Formcraft allows, through
   the same policy and log (Power BI).

Every connector answers `status` and `describe`, uses the shared job system (heartbeats, queue, keep-awake, results
kept), writes only to staging and WIP, and has a stand-in for CI. `fmc_apps` lists them; an app's tools load only while
it is on (H0).

## Steps (one PR each, the owner's yes before each)
| # | Step | Milestone you can see |
|---|---|---|
| H0 | The hub's foundation (built, #181) | `fmc_apps`, per-app tools, Apps in `fmc_selftest` |
| X0 | **The exchange layer** | Identity map, exchange packages, `fmc_flow` with saved flows run by a button; Revit ↔ Robot moved onto it |
| H1 | **Rhino connector, family parts first** | `fmc_rhino`; the `part` op; LOD 400 parts in recipe families; Gate A per LOD |
| X1 | **One selection** | Select in Revit, shown in Navisworks, Rhino and Robot |
| H2 | **Power BI** | The project data model from every app; the gateway to Microsoft's Modeling MCP |
| X2 | **Changes flow** | A change in one app flags what it affects in the others, as a dry-run update |
| H3 | **Navisworks, next** | Federate, clash tests from the kit's clash matrix (a kit change request), clashes back to Revit |
| X3 | **One search, one log** | "Where is D-12 and what touches it", answered across apps |
| X4 | **The pane in every app; AI conducts** | The Formcraft pane in Navisworks and Rhino; one request across three apps |
| T | **Tables by script** | Excel ↔ kit tables, dry run first, from a button |
| Later | build123d as a second part source; Blender; Speckle | — |

## The hard parts, honestly
- Geometry translation between apps loses information: parts are fixed shapes, staging only, traced by the identity map.
- Ids drift as models change: the identity map needs rules for deleted, copied and rebuilt elements.
- These apps weren't made to be driven together (threads, dialogs, licences): the job queue, heartbeats and per-app
  isolation are the base for that.
- Big models are slow to move: flows send only what changed.
- AI makes mistakes: every change has a dry run and a person's yes, and never touches a live model.
- Vendor updates break connectors: each reports its version and `fmc_selftest` names a mismatch.

## For the owner to decide
1. A yes on X0 (the exchange layer) as the next step.
2. Rhino 8's licence on the pilot PC: licensed, or the 90-day evaluation.
3. Power BI: Microsoft's Modeling MCP server is in **preview**; publishing to the Power BI service needs a Pro or Fabric
   licence (Desktop alone is free).
4. Which LOD 400 parts to pilot first (for example the clinical basin's bowl and spout, a lever handle, a cast bracket).
