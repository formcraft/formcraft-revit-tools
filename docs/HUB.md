# The engineering hub

One Formcraft MCP server reaches every engineering app through a connector per app. The plan, with its steps, is in
`docs/PLAN_ENGINEERING_HUB.md`; this page is how it works today.

## The apps
| App | Connector | Kind | Tools |
|---|---|---|---|
| Revit 2025 | The Formcraft add-in, a local socket per Revit | Add-in bridge | Every Revit tool (always on) |
| Navisworks Manage 2025 | `Formcraft.Navis` add-in, local socket 8190 | Add-in bridge | `fmc_navis` |
| Robot Structural Analysis 2025 | `fmc-robot.exe` beside the server | Process | `fmc_robot` |
| Rhino 8 | Not built yet (plan step H1) | Add-in bridge | `fmc_rhino` (to come) |
| Power BI Desktop | Not built yet (plan step H2): a gateway to Microsoft's Power BI Modeling MCP server | Gateway | `fmc_powerbi` (to come) |

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
