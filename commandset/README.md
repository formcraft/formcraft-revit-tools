# commandset

Carried from `formcraft/mcp-servers-for-revit`. The Revit-side handlers the MCP server calls (create, read, tag,
Formcraft file and family commands). Each handler runs through Revit's external event, one transaction, and is
classified by the guard (model-changing commands are refused on live models).

New handlers follow the pattern in `CLAUDE.md`: server check → dry run → one Revit handler → log.
