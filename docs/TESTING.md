# Testing

Four layers. Each UI step in `UI_DEVELOPMENT.md` says which ones apply.

## C · CI (every push)
GitHub Actions workflow `Build`: the shell (net8 and net48), the MCP server with its tests, and the add-in for Revit
2025. A step is not done while CI is red.

## P · Preview app (no Revit)
```
dotnet run --project shell/Formcraft.Shell.Preview
```
Runs the shell on mock services. Mock sign-in: any email and password, then code `123456`. Compare each screen
with its board in `design/boards/` (or the central canvas) at 440 px and at 360 px wide.

On the pilot PC, Claude can look at the preview window itself with computer use (screenshots), when that is
switched on for the session.

## R · In Revit 2025 (pilot PC)
1. Build: `dotnet build mcp-servers-for-revit.sln -c "Release R25"`.
2. Install: close Revit, remove the old `mcp-servers-for-revit.addin` if it is there, copy `plugin/Formcraft.addin` and the built `revit_mcp_plugin` folder (from
   `plugin/bin/AddIn 2025 Release/`) into `%APPDATA%\Autodesk\Revit\Addins\2025\`. Keep the previous copy for rollback.
3. Start Revit, open a test file from `_ChainTests` (never a live project for write tests).
4. Check the pane and ribbon against the boards.

## M · Through the Revit MCP
Yes, the Revit MCP can test the plugin. Claude on the pilot PC talks to the running add-in through the MCP server:

- **Today:** the carried tools prove the add-in loads and answers: `fmc_file list_open`, document info, model
  statistics, `fmc_family plan` (read-only), and the live-model lock (a model-changing tool on a live project must
  be refused).
- **After U11:** the `fmc_ui` tool reads the pane's state (signed in, licence, section, banner, footer, open dialog),
  opens sections, switches mock licences in test builds, and saves a screenshot of the pane. That lets Claude walk
  every screen and compare it with the boards without clicking.

Limits: the Revit MCP talks to the add-in, not to Windows, so it can't click buttons in the pane. `fmc_ui` covers
navigation and state; real clicks need a person or computer use.

### Test session script for Claude (pilot PC)
1. `git pull`, then build (R step 1). Report any build error and stop.
2. Start the MCP server; confirm `fmc_file list_open` answers.
3. Run the read-only checks above and the live-model refusal check; report pass/fail per line.
4. From U11 on: for each built section, `fmc_ui open_section`, `fmc_ui get_state`, `fmc_ui screenshot_pane`;
   compare with the board; list differences.
5. Write the results to `tests/reports/<date>-<step>.md` and attach them to the pull request.
