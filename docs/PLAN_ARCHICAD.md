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
- MEP: decompile one stock ArchiCAD MEP object (libpart2xml) to learn the connection-port format, then add ports
  to the generator for objects that need services.

## AC3 · Catalogue (Chat)
One combined catalogue (owner, 19 Oct): Revit families + ArchiCAD objects. Prices: ArchiCAD object $2, Revit family
$2, both formats $2.50. ArchiCAD pages show plan symbols at 1:50 / 1:100 and the measured file size.

## Q-MCP1 · Handshake on connect (Code, after the ArchiCAD work) — owner, 19 Oct
The hub server sends MCP `instructions` on connect (what Formcraft is, hard rules, order of work: selftest ->
fmc_context -> task, where the maps are) and serves resources: `fmc://map/folders`, `fmc://map/data`,
`fmc://map/pane`, `fmc://map/apps` (generated from the kit and code) and `fmc://state` (a session journal: last
work, open findings, what is waiting on the owner). Goal: no AI relearns the app each session.
