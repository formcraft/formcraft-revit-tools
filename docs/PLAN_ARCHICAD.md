# PLAN: ArchiCAD in the hub (owner, 19 Oct 2026)

Why: the first four ArchiCAD objects were built and checked by hand through the screen (computer use). It worked but
cost far too many credits. Everything below makes it one or two tool calls.

## Done on 19 Oct (chat)
- `fmc_gdl.py` (chat scratch, to move into `scripts/gdl/`): recipe -> GDL XML (3D Coarse/Medium/Fine, plan symbol by
  scale, scale-aware dashed clearance, cover fill, kit surfaces inline, 4-page settings UI, FMC data parameters).
- Four detailed hospital objects compiled with LP_XMLConverter (ArchiCAD 28) into
  `04_Families\_Staging\_ArchiCAD\gsm\`. In ArchiCAD 28: 3D, 2D (warning only), Parameter and Interface scripts
  checked; all four render in 3D. Sizes 28-55 KB each.
- Findings fixed in the generator: (1) the Parameter script is `Script_VL`, not `Script_PR` (that is Properties);
  (2) PROJECT2 PARAMETERS may only name parameters the object has. Sources updated; the .gsm need one rebuild.

## AC1 · `fmc_archicad` connector in the hub (Code, first)
Talk to ArchiCAD through its JSON API (port 19723+) plus the free Tapir add-on; run LP_XMLConverter from the server
(the server already runs on the pilot PC, so no screen is needed). Named operations only:
- `status`: ArchiCAD running, version, Tapir present, open project, libraries.
- `build`: recipe(s) -> GDL XML -> .gsm (LP_XMLConverter xml2libpart + libpart2xml round-trip), log per object.
- `library_reload`: add the staging folder to the project libraries and reload.
- `check`: for each object run the scripts (Tapir / GDL check) and return errors with line numbers.
- `place`: place objects in a test project (a staging .pln) at set points.
- `capture`: 3D view and plan at 1:50 and 1:100 to PNG for the catalogue (and the object preview picture).
- `selftest` lines for ArchiCAD.
Gates as for Revit: dry run first, staging only, no saving of live projects.

## AC2 · Kit for ArchiCAD (Chat, then Code)
- FMC ArchiCAD template (.tpl): FMC surfaces and building materials, pen set, line types, fills, layers.
- FMC properties: the shared parameter file mapped to the Property Manager (XML import) and to GDL parameter names.
- Classification: Uniclass in the Classification Manager; FMC keynote code as a property (ArchiCAD has no keynotes).
- MEP: see **AC2a** below.

## AC2a · MEP connectors in ArchiCAD objects (owner talk, 19-20 Oct)
ArchiCAD's equivalent of Revit connectors is the **MEP Modeler** (inside ArchiCAD since 25). MEP objects are GDL
objects with an MEP subtype (MEP Equipment, MEP Terminal, ...) that declare **connection ports**: position, direction,
shape and size, and domain (duct, pipe, cable carrier). Ducts and pipes drawn from a port snap and route.
What ArchiCAD does not do: duct/pipe sizing and pressure checks, and electrical circuits or panel schedules. So the
promise is **right geometry, ports that snap, all engineering data on board**; calculations stay with the engineers
in Revit, and IFC carries the data between the two.
- **One source.** The generator reads the connector entries already in each recipe (position, facing, size,
  system), so one recipe still drives both formats.
- **Base layer (any ArchiCAD).** A hotspot and a small plan mark at each connection point; the kit's flow, power and
  pressure values as ArchiCAD properties; ports exported to IFC so a Revit engineer sees where services join.
- **MEP layer.** MEP subtype plus real ports declared through the MEP library's own macros, so routing snaps.
  Trade-off: needs the MEP library loaded; without it the base layer still shows, schedules and exports.
- **Learn the real format first.** `libpart2xml` one stock MEP object from the ArchiCAD 28 library (an AHU and a
  basin) and copy how it declares ports. Never guess the port parameter names.
- **Test (in `fmc_archicad selftest`).** Place the object, draw a duct and a pipe from its ports, export IFC, check
  the ports come through.
- **First families with ports (hospital set):** clinical basin and scrub trough (water in, waste out), medical gas
  outlets (one pipe port per gas), laminar-flow diffuser (duct), AHU and VRF outdoor unit, fire pump and hose reel,
  final distribution board (cable carrier plus load data).
- **Waiting on the owner:** is *Design › MEP Modeling* in the pilot PC's ArchiCAD 28? Yes: build both layers from the
  start. No: base layer first, MEP ports when it is switched on.

## AC3 · Catalogue (Chat)
One combined catalogue (owner, 19 Oct): Revit families + ArchiCAD objects. Prices (owner, 20 Oct): Revit family $2,
ArchiCAD object $2, **both formats $3** (was $2.50 on 19 Oct).
Done 19-20 Oct: "Formcraft Family Catalogue — General Edition" (claude.ai design canvas, private until the owner
shares it), 11 A4 pages: cover, the four hospital families, the role list, two families for each of the 10 design
disciplines, the six other roles (title block, logistics with 3D temporary works coming, Q/G/K/Y data), "Coming soon
· ArchiCAD" with the four ArchiCAD 28 screenshots, and prices. Every image is labelled *Revit render* or *Recipe
preview*. Next: swap recipe previews for real Revit renders and ArchiCAD captures (`capture`) as they are built.

## Q-MCP1 · Handshake on connect (Code, after the ArchiCAD work) — owner, 19 Oct
The hub server sends MCP `instructions` on connect (what Formcraft is, hard rules, order of work: selftest ->
fmc_context -> task, where the maps are) and serves resources: `fmc://map/folders`, `fmc://map/data`,
`fmc://map/pane`, `fmc://map/apps` (generated from the kit and code) and `fmc://state` (a session journal: last
work, open findings, what is waiting on the owner). Goal: no AI relearns the app each session.

## AC4 · Touch features (Formcraft Flow / TouchKit) in ArchiCAD — owner, 19 Oct
Owner wants the touch features in ArchiCAD too. Suggested shape (Claude Code to confirm against the TouchKit code):
- Split TouchKit into a **touch layer** (the overlay, radial menus, gestures, pen palette) that runs as its own small
  Windows app, and **app profiles** that say what each button does in each program (Revit, ArchiCAD).
- ArchiCAD profile: map buttons to ArchiCAD menu commands and keyboard shortcuts (ArchiCAD can export its shortcut
  scheme from Work Environment, so the profile can be generated, not typed), and to `fmc_archicad` / Tapir calls
  where a command needs data (place an FMC object, switch layer combination, set scale).
- One touch UI then serves Revit, ArchiCAD and later other apps; only the profile changes. A native ArchiCAD
  add-on (C++ palette) is the fallback if the overlay cannot do something.
