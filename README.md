# Formcraft Revit Tools

Formcraft's Revit plugin bundle: **Core** plus four modules, **Manage**, **Flow**, **Model** and **Build**, in one pane,
one Settings page and one Formcraft ribbon tab. It serves the Formcraft BIM system (Master Manual FMC-BIM-MAN-001,
Revit standard FMC-BIM-STD-002 and the kit in `Z:\00_Standards\`).

Private repository. Started fresh on 13 October 2026 from the design canvases and the proven parts of
`formcraft/mcp-servers-for-revit`.

## What is here

| Folder | What it is | State |
|---|---|---|
| `shell/Formcraft.Shell` | The pane shell: theme (UI kit), frame, navigation, sign-in, account, locked states. No Revit reference | New, runs on mock data |
| `shell/Formcraft.Shell.Preview` | Runs the shell on its own, without Revit | New |
| `plugin/` | The Revit add-in (ribbon, pane host, Formcraft file and family tools, guard) | Carried from the fork |
| `commandset/` | Revit command handlers the MCP server calls | Carried from the fork |
| `server/` | MCP server for Claude: `fmc_file`, `fmc_family`, guard policy, pane CLI, Ask Claude | Carried from the fork |
| `tests/` | Command set tests, guard parity tests | Carried from the fork |
| `design/` | Every screen's design board (source of the canvas) and the generators that wrote them | New |
| `resources/` | Icons (SVG, ribbon PNG 16/32), IBM Plex fonts, brand pointer | New |
| `docs/` | Roadmap, **UI development list**, testing, decisions, UI kit, screen list; `docs/history/` keeps the fork's docs | New |
| `.claude/commands/` | `/ui-next` (plan the next UI step), `/ui-test` (run the test session) | New |

## Update · 20 October 2026

**Where things stand.** The pane, the MCP server and the add-in are built and staged on the pilot PC on every merge.
The family engine builds families from recipes and checks them with Gate A in Revit. Over 80 features are listed on
the owner's Build Tracker (`docs/tracker/`). Open live-test findings are GitHub issues labelled `test-finding`.

**New since 19 October (plans, not code yet):**
- **ArchiCAD in the bundle** (`docs/PLAN_ARCHICAD.md`). ArchiCAD is the most used BIM tool locally, so the families
  go to both programs from one recipe. The first four hospital objects (ICU bed, neonatal incubator, anaesthesia
  machine, ceiling operating light) were built and script-checked in ArchiCAD 28 by hand. The first code is the
  `fmc_archicad` connector (AC1), so the next ones are built and checked with no screen work.
- **MEP connectors in ArchiCAD objects** (AC2a). Ports that ducts and pipes snap to through the MEP Modeler, with
  flow, power and pressure as ArchiCAD properties and the ports carried to IFC.
- **One family catalogue for both programs.** A general catalogue now covers every discipline, with ArchiCAD objects
  marked as coming. Prices: Revit family $2, ArchiCAD object $2, both formats $3.
- **4D / 5D and temporary works** (`docs/PLAN_4D_5D_TEMPWORKS.md`, parked). 4D in Navisworks TimeLiner, temporary
  works (cranes, scaffold, props, hoarding) in Formcraft Model, the 3D cost model in Formcraft Build. The kit's
  shared parameter file already has the 4D date parameters.
- **Hub handshake** (Q-MCP1). When an AI connects, the hub gives it the rules, the folder, data and pane maps and a
  session journal, so no session starts from zero.
- **Touch in ArchiCAD** (AC4). TouchKit becomes one touch layer with a profile per program.

## Ideas for later

Ideas, not commitments. Each one waits for the owner's yes and a row in the queue.
- **IFC round-trip check.** Export an ArchiCAD object to IFC, open it in Revit and the other way round. Check that
  classification, properties and MEP ports survive, so mixed Revit/ArchiCAD teams can trust the exchange.
- **One register for both formats.** The family register gets an ArchiCAD column (file, size, check result), so the
  catalogue, the store and Gate A read one list. This is a kit change request.
- **Gate A for ArchiCAD.** The same honest checks for objects: scripts pass, plan symbol at each scale, detail
  levels, properties filled, ports where the recipe has connectors, file size limit.
- **Catalogue from the register.** Catalogue pages and their pictures come straight from `capture`, Revit renders
  and the register, so a new family appears with no design work. Each image is labelled with where it came from.
- **Family store downloads.** Paid families delivered as Revit, ArchiCAD or both, from the Formcraft account
  website (payments never happen in Revit or ArchiCAD).
- **Temporary works with the programme.** Crane, scaffold and hoarding families take their dates and hire costs from
  the programme, so 4D playback and the cash flow show site set-up as well as the building.
- **Saved add-ons over AI.** Repeatable work (rebuilds, captures, selftests) runs as scripts and nightly runs. AI
  is kept for design thinking, to keep credit use low.

## Try the shell

```
dotnet run --project shell/Formcraft.Shell.Preview
```

Sign in with any email and password, then the code `123456`. Model shows as a trial and Build as not licensed,
so the locked state is visible. All values are samples.

## How work runs

1. `/ui-next` plans the next step in `docs/UI_DEVELOPMENT.md` and waits for a yes.
2. The step is built on a `feat/` branch and tested as `docs/TESTING.md` says, including through the Revit MCP on the pilot PC.
3. A pull request with the test report; CI must pass.

## Design reference

Every screen is drawn, clickable, on the central canvas "Formcraft Revit Tools — Central Canvas" (claude.ai),
one column per module plus Core and Account. `docs/SCREENS.md` lists them.

## Rules that don't change

See `CLAUDE.md`: live-model lock, dry run first, nothing deleted, never save or sync a workshared model,
never decide for a professional, kit data comes from the kit.
