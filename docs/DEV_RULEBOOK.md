# Dev rulebook: how every development session works

Every Claude Code session (and every developer) on this repo follows these rules. They exist to make each session
cheaper and faster than the last, and to make sure nothing a session learns or breaks is lost. Rules have IDs so a
session, a review or the repo index can point at one. Change a rule by PR, like code.

## Ambitions (what every choice is judged against)

| ID | Ambition | In practice |
|---|---|---|
| DEV-A1 | **Cheapest** | Scripts before AI: a step done the same way twice becomes a script, button or CI check. Use the smallest model that does the job well. |
| DEV-A2 | **Fastest** | Look things up before reading (`node scripts/index/find.mjs`). Batch calls. Run long work unattended (offline tests, CI). |
| DEV-A3 | **Best functionality** | One mechanism for people and AI (rulebooks, checklists, review); dry run first; plain words in every message. |
| DEV-A4 | **Moat** | Formcraft's knowledge is the asset: the kit, rulebooks, recipes, modelling style and the log of decisions and outcomes. Capture it as data, keep it private, never hard-code it. |
| DEV-A5 | **Dynamic** | Config over code: roles, rulebooks, recipes, model choice, budgets and feature switches are data, so new ideas can be tried without new code. |

## Rules for every session

| ID | Rule |
|---|---|
| DEV-001 | **Start:** read `CLAUDE.md`, this file, the newest `docs/TEST_FEEDBACK.md` run and open `test-finding` and `dev-handover` issues. Find before reading. |
| DEV-002 | **Plan, then yes:** write the plan (files, tests, Revit steps, risks, decisions needed) and wait for the owner's yes before code. |
| DEV-003 | **Branch per change**, never commit to `main`. Small PRs. Merge the base forward, never force-push. |
| DEV-004 | **Tests with the change:** unit tests for every refusal and edge case; server `npm test`, pane `dotnet test --project tests/shell/Formcraft.Shell.Tests.csproj`, kit `py test_kit.py`. Windows CI green before anything is staged. |
| DEV-005 | **Measure claims honestly** (`formcraft-honest-testing`): fixed questions or cases before the change, a fair baseline, every miss reported. |
| DEV-006 | **Kit data is the only source** of standards: a missing value becomes a kit change request, never a constant in code. |
| DEV-007 | **Safety gates never move:** dry run first, live and shared models read-only unless the owner's switches allow, people release, publish, sync, issue and sign. |
| DEV-008 | **Errors are handed over, not hidden:** anything a session can't fix becomes a GitHub issue labelled `dev-handover` with steps to reproduce, what was tried, and the files involved. The dev team takes it over. |
| DEV-009 | **Leave a faster way:** end every session with a report in `results/ai_reports/` (template: `results/ai_reports/TEMPLATE.md`): what was slow or costly, and the script, button, rule or doc that would make it faster next time. Recurring items become queue rows. |
| DEV-010 | **Keep the trackers true:** `docs/STATUS.md`, `docs/tracker/features.json`, `docs/TEST_FEEDBACK.md` states, in the same PR as the change. |
| DEV-011 | **Plain, short writing:** lead with the outcome; tables for structure; no recap of steps the reader saw. |
| DEV-012 | **Spend wisely:** stop exploring once there's enough to act; prefer one batch call to many; report token-heavy steps in the session report so they get automated. |

## Threads (several sessions at once)

When budget allows, several sessions run in parallel (code, tests, project work), each on its own branch or thread with
its own report. They may plan and check in parallel; changes to one Revit model go through the job queue one at a
time, one writer per model.
