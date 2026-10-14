# End-to-end without Revit

`node tests/e2e/run.mjs` (after `npm run build` in `server/`) runs the real server CLI for each Formcraft tool against
`fake_revit.mjs`, a stand-in for the add-in's socket on port 8099. It runs three rounds:

- **rich**: sample model data;
- **empty**: Revit answers `{}`, the way an older or broken add-in would;
- **live**: a shared project model is active, and every model-changing tool must be refused.

It uses its own guard file and folders under `%TEMP%\fmc-e2e`, so it never writes to real projects. The kit is read
from `FMC_KIT` (default: this PC's kit). It never talks to a real Revit, even one that is open: the port is pinned.
It exits 1 on a crash, an unreadable reply, or a write reaching Revit while the live model is open.
