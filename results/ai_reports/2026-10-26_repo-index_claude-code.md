# AI task report: repo index (Claude Code, 26 Oct 2026)

**Task:** build the repo index (docs/INDEX.md) with an impact report. **Branch:** `feat/repo-index`.

## How the tools and repo were to work with
- Finding where the AI-modeller code, rulebook, selftest and pane lived took about 12 search-and-read rounds before any
  code: the cost the index now removes (each of those is one `find` lookup).
- IDs are used consistently (F-, U, D, #), which made the index possible. Work items are written three ways (table rows,
  `### [~] U29`, `- [ ] U28`), which took two rounds to discover.
- `STATUS.md` repeats IDs in tables with different columns; a table's status lives under a "State" header in some tables
  and in the last column in others.
- Shell quoting on Windows (Git Bash + PowerShell + Python heredocs) cost several retries; writing edit scripts to the
  scratchpad was reliable.

## Improvements suggested
1. One format for work items (a table row in `STATUS.md`), so a script never has to guess.
2. A fresh set of topic questions after the next few weeks of real use, to confirm the 6/8 topic score (walk-forward).
3. Index the kit (rulebooks, registers) too, when the kit repo is on the same PC: today it covers this repo only.

## Ways to make the tools rely less on AI
- The index is maintained by a script and checked in CI: no AI is needed to keep it right.
- `fmc_index tools` gives the full tool catalogue: the pane could show it as a searchable list without asking AI at all.
- The impact check (`impact.mjs --ci`) runs with no AI and catches regressions on every push.
