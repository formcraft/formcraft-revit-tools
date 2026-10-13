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
