# plugin (Revit add-in)

The Formcraft add-in (`Formcraft.addin`), grown from `formcraft/mcp-servers-for-revit`. One add-in, one pane, one
ribbon tab: it hosts the Formcraft pane (`shell/Formcraft.Shell`), builds the Formcraft ribbon, starts Flow's touch
engine (`touch/`) and runs the MCP bridge Claude talks to.

| Folder | What |
|---|---|
| `Core/` | Add-in start-up and shut-down, socket service the MCP server talks to |
| `Shell/` | The pane in a dockable pane (`ShellHost`), the ribbon (`RibbonBuilder`, `RibbonCommands`), and the adapters that give the pane live values: Connect (`RevitConnectInfo`), Setup › Families and Templates (`RevitSetupTools`), touch (`RevitTouch`), the `fmc_ui` bridge (`UiBridgeHost`) |
| `Fmc/` | Guard status, readiness checks and their fixes, the server CLI bridge (`ServerCli`), file log, open documents |
| `UI/` | The command set's settings window (enable or disable MCP commands) |
| `Configuration/`, `Utils/` | Settings and helpers |

Build: `dotnet build mcp-servers-for-revit.sln -c "Release R25"` (other years: R20–R26 configurations). Local builds
don't copy into Revit; install by hand (docs/TESTING.md).
