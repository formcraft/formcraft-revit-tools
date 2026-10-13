---
description: Plan the next UI step from docs/UI_DEVELOPMENT.md and wait for a yes
---
1. Read `docs/UI_DEVELOPMENT.md`. Pick the first step marked `[ ]` (or the step named in $ARGUMENTS).
2. Open the step's boards in `design/boards/` and read the tokens in `shell/Formcraft.Shell/Theme/FmcTheme.xaml`.
3. Write a short plan: files to add or change, what "done" means, how it will be tested (C/P/R/M from `docs/TESTING.md`).
4. Stop and wait for a clear yes before writing code.
5. After the yes: branch `feat/u<NN>-<name>`, build, test, open a pull request, mark the step `[~]`, and `[x]` once merged.
Rules: follow `CLAUDE.md`; text matches the boards; no colours outside the theme; no Revit API in `shell/`.
