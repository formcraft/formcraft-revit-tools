# plugin (Revit add-in)

Carried from `formcraft/mcp-servers-for-revit`. Loads in Revit, starts the MCP bridge, and holds the Formcraft parts
that already work:

| Folder | What |
|---|---|
| `Core/` | Add-in start-up, ribbon, socket service the MCP server talks to |
| `Fmc/` | Formcraft Browser pane (current), file log, guard status, readiness checks, pane CLI bridge |
| `UI/` | Current WPF pane (`FormcraftBrowserPage`), settings window, styles, IBM Plex fonts |
| `Configuration/`, `Utils/` | Settings and helpers |

Build: `dotnet build mcp-servers-for-revit.sln -c "Release R25"` (other years: R20–R26 configurations).
Next: host `shell/Formcraft.Shell` in a dockable pane and move the ribbon to five panels (UI step U10). The current
`FormcraftBrowserPage` stays until the shell covers what it does.
