# The project book

One file per project, `01_WIP\FMC_Project_Book.json` beside the manifest, with an append-only journal
`01_WIP\FMC_Project_Journal.jsonl`. It keeps what a project must not forget: the team and their roles, decisions, notes
and ideas, progress, threads (one per task) and the checklists people and AI tick and submit for review. Every person
and every AI reads it first when they start work on the project. (Owner, 26 Oct 2026.)

| Part | What | Who writes |
|---|---|---|
| Team | Members with a role from the kit (`FMC_Roles.json`); an agent (AI) assists a named person and never takes a role ranked above theirs | People only |
| Decisions `D1…` | Proposed by anyone, decided by a person | Agents propose; people decide |
| Notes `N1…` | Notes, ideas, progress, task reports | People and agents |
| Threads `T1…` | One per task, ended with the task report (what was done, what was slow, a faster way next time) | People and agents |
| Checklists | Per role and stage, from the kit's role playbooks; each item points at rule IDs in the kit's rulebooks | Ticks: people and agents; reviews: people |
| Stage | The project's current stage | People only |

## Checklists

An item whose rules are all script-checked (`naming_regex`, `value_in_list`, `count_min`, `parameter_present`) passes
or fails from the model's latest QA run, with no AI and no tick. Other items (`human_gate`, `other`, or no rule) need a
tick with evidence, then **submit** sends them to the role's reviewer; a person approves or returns each one, never
their own. Progress is the share of items passed or approved, so nobody writes a progress report.

## Tools

- `fmc_projectbook` (MCP, as an agent): `get`, `find`, `checklist`, `create` (dry run first), `note`, `idea`, `progress`,
  `report`, `propose`, `thread_start`, `thread_end`, `tick`, `submit`.
- `projectbook_admin` (the pane's own command, as the Windows user; never MCP): everything above plus `set_member`,
  `remove_member`, `decide`, `set_stage`, `review`.
- Project start (`fmc_project start`) creates the book; the AI context on connect carries its summary.

## Kit

`docs/kit-proposals/FMC_Roles.json` (schema `fmc-roles/0.1`) is the proposal for `03_Master_Data\FMC_Roles.json`:
Modeller, QS, BIM Coordinator and BIM Manager, with rank and reviewer. Only the Modeller design-stage checklist is
filled in (the pilot); the BIM Manager approves the rest through the kit change process. Without the file, checklists
are empty and the book says so.
