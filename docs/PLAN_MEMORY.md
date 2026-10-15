# Plan: memory for the plugin

**Status: Designed, 15 October 2026 (owner's yes).** No code until the owner approves step 1.

## What exists today

- Ask Claude keeps the last 6 questions and answers (`ask reset` clears them).
- Touch tools keep sticky defaults per project (`touch/FEATURES.md`).

## Three layers (owner's choice: all three)

| Layer | Holds | Where | Who sees it | Who writes |
|---|---|---|---|---|
| **Project memory** | Client, decisions taken (e.g. design movement), engineer answers, open questions | `01_WIP\FMC_Memory.json` in the project | The project team | People; Claude only after a yes |
| **Personal preferences** | Answer style, default views, units, favourite tools | `%APPDATA%\Formcraft\memory.json` | That person only | The person; Claude only after a yes |
| **Lessons learned** | Fixes and gotchas from projects, retests and skill flags (`PLAN_SKILLS.md`) | Drafts in a staging file; the BIM Manager promotes them to the kit by kit change request | The whole firm | People only (Claude may suggest) |

## How the pane uses it (owner's choice: all three)

1. **Auto-load, shown.** Ask Claude reads your preferences, the open project's memory and the matching lessons when it
   starts. A **Remembered** card lists exactly what it loaded, with edit and archive buttons.
2. **Ask before saving.** Claude offers "Remember this?" with the exact text and where it goes. Nothing is saved
   without a yes (rule 3, dry run first).
3. **Notes page.** Setup › Memory lets people add, edit or archive entries. Lessons are added only here.

## Limits

- **No kit values (rule 7).** A remembered "fact" that differs from the kit becomes a kit change request, never an
  override.
- **No people ranking (rule 9).** Entries hold facts and preferences, never who did what.
- **Nothing is deleted.** Archiving moves an entry to `_Archive` (rule 2).
- **Write folders.** Writes go only to WIP, staging and `%APPDATA%`, never to Shared, Published or the kit.
- **Offline.** Every layer is a local file.
- **Logs.** Ask Claude still logs tokens only; memory is a file people can read, not a log.

## Build steps (each: server check → dry run → handler → log → pane)

| Step | What | Done when |
|---|---|---|
| ME1 | Personal preferences + Remembered card | Ask Claude shows and uses the loaded preferences |
| ME2 | Project memory + "Remember this?" | A yes writes to `FMC_Memory.json`; a no writes nothing |
| ME3 | Notes page + lessons drafts (fed by skill flags) | Lessons appear in staging; promotion is a kit change request |

## Open item for the owner

- Where lesson drafts stage: `00_Standards\_Staging\Lessons\` is proposed. It must be a staging folder (rule 2).
