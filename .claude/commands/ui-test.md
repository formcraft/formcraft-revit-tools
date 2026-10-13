---
description: Run the test session for a UI step (CI, preview, Revit, Revit MCP) and write the report
---
Follow "Test session script for Claude" in `docs/TESTING.md` for the step in $ARGUMENTS (default: the step marked `[~]`).
Never run write tests on a live project. Write the report to `tests/reports/<date>-<step>.md` and summarise pass/fail.
