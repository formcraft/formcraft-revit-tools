# Repo index: find before reading

One lookup tells you where something is, what it is and what it links to, so you open only those lines instead of
reading docs and code to rediscover it. It is a hashtable of everything the repo names, with links between entries and
a keyword table on top. A script builds it; nobody writes it by hand.

## Use it

| Who | How |
|---|---|
| Claude Code, a person | `node scripts/index/find.mjs <key or words>` (build the server once: `cd server && npm run build`) |
| Claude Desktop (MCP) | `fmc_index` tool: `find`, `get` (one key and its neighbours), `tools` (every tool with its actions) |
| The pane's AI (Ask) | `find_in_app`, called first for any question about the app itself (`server/src/fmc/ask.ts`) |
| The pane CLI | `node build/fmc/cli.js fmc_index` with `{"action":"find","q":"..."}` on stdin |

The answer gives the entry, `at <file>:<line>` (the live line, found from the entry's anchor text) and its links.
**A weak or empty answer means there is no such thing: don't guess one.** For a wrong or weak answer, fall back to
`git grep` (and report the miss, so the index improves).

## Keys

| Key | What | Defined at |
|---|---|---|
| `F-041` | Finding | `docs/TEST_FEEDBACK.md` table rows, or any doc heading or table |
| `U28` | Work item | `docs/STATUS.md`, `docs/UI_DEVELOPMENT.md` (tables, headings, checklists `- [ ]`, `[~]`, `[x]`) |
| `D1` | Decision | `docs/DECISIONS.md` only (other docs keep local D lists of their own) |
| `PR-133` (or `#133`) | Pull request, with the files it touched | git history |
| `doc:<path>`, `sec:<path>#<heading>` | A doc, one of its sections | every `.md` (`docs/history/` counts half) |
| `file:<path>`, `sym:<name>` | A code file (its header comment and exports), an exported symbol | `.ts`, `.mjs`, `.cs`, `.ps1`, `.py` |
| `tool:fmc_ai` | An MCP tool, with its actions | `server/src/tools/fmc_*.ts` |
| `cmd:fmc_document_info` | A Revit command | `CommandName => "..."` in `commandset/` |
| `ui:Manage/Project`, `ui:search/...` | A pane group, section, quick tool or search entry | `shell/Formcraft.Shell/Services/sections.json` |
| `app:rhino` | A hub app and its tools | `server/src/hub/apps.ts` |

Links come from keys named on the same line (strongest), the same PR, and the same file.

## How it stays right

- **Built, cached, never stale.** `server/src/fmc/repoindex.ts` builds it in about 1 to 3 seconds; in the repo it is cached
  in `.cache/repo-index.json` and rebuilt whenever git HEAD or the working tree changes (new untracked files included).
- **Shipped with the server.** `npm run build` writes `build/index/repo-index.json` for the plugin's AI on PCs without the
  repo. CI checks out the full history so PR entries are complete.
- **Anchors, not line numbers.** Edits never make an entry point to the wrong line.
- **Checked in CI.** `node scripts/index/impact.mjs --ci` fails the build when an ID, tool or command lookup misses, or a
  planted question (no answer exists) gets a confident hit. Unit tests: `server/src/fmc/repoindex.test.ts`.

## Impact (26 Oct 2026)

Judged on 56 questions fixed before the index was built (`scripts/index/questions.json`: seeded random findings, work
items, tools and commands, every decision, 8 topic questions and 3 planted ones), against the realistic way without it
(`git grep`, then reading the file). Reports: `results/index_impact_2026-10-26.md` (and `_v0` for the first version).

| | Index | Grep + read |
|---|---|---|
| Answers reached | 54/56 | 56/56 |
| Tokens per question (median) | 780 | 9,295 |
| Tokens, all 56 questions | 99,035 | 555,505 (82% less) |

- IDs, tools, commands and decisions: 41 of 41, at a fraction of the cost. The baseline finds everything too: the index
  saves cost and time, it doesn't find what grep can't.
- Topic questions: 6 of 8, and both misses were confident wrong answers. The topic search was improved after the first
  version scored 1 of 8 on the same questions, so 6 of 8 still needs confirming on fresh topic questions (walk-forward).
- Re-run with `node scripts/index/impact.mjs`; add new questions to a fresh set rather than editing this one.
