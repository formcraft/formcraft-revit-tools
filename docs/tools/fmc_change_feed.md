# fmc_change_feed

The change record and sync feed (F19, L011 tools row 10, for NBRB and DITACO). Read-only. One timeline, newest first, of
what changed, who changed it and when. There is no dry run because nothing is ever changed.

## Hard limit (decision 5, CLAUDE.md rule 6)

A "sync feed" reports syncs. It never runs one. Neither `fmc_change_feed` nor the add-in command `fmc_model_changes`
synchronises with central, saves, reloads latest, relinquishes, checks out, opens or closes a model, or starts a
transaction. There is no auto-sync path. The tests prove it: `server/src/fmc/changefeed.test.ts` and
`tests/changefeed` scan the sources for those calls, and `fmc_model_changes` is in `READ_VIA_SEND_COMMAND`, never in
`WRITE_COMMANDS`. A person syncs in Revit.

## Sources

| Source | What | Who |
|---|---|---|
| `ledger` | The hub call ledger, `%APPDATA%\Formcraft\ledger\calls-YYYY-MM.jsonl`: every Formcraft tool call, its action and result | Who started it: `ai`, `pane`, `job`, `schedule`, `cli`. Never a person's name |
| `external` | Hook runs (pyRevit, Dynamo, scripts), `external-YYYY-MM.jsonl` | The hook's starter |
| `created` | Elements a batch created, `FMC_Created.jsonl`, one entry per batch and model | The tool that recorded it |
| `syncs` | The sync log (`01_WIP\FMC_Sync_Log.csv`, else the reports folder) and the managed save/sync clocks (`fmc_sync_state.json`) | The sync log's user; the clocks name nobody |
| `revit` | `fmc_model_changes` on an open model: the session journal (committed, undone and redone transactions, saves, syncs, closing) and, with `since_version`, elements created, modified and deleted since that document version | The Revit user name, with `ai` or `person`; for changed elements Revit's creator, last changed by and owner (workshared models) |
| `flows` | `fmc_changes` out-of-date flags (asked for by name: a snapshot of now) | - |

Every source asked for is listed in `sources` with `read`, `count` and a note: a source that could not be read says why.
`revit` needs `document` (an open model's title or path). It is never guessed from the active document, and a model
that isn't open is not opened.

The session journal is in memory in Revit. It starts listening at the first Formcraft call of the Revit session (or the
first `fmc_model_changes`), keeps the last 2000 entries, and says so (`gap`) when entries were dropped before they were
read. Element ids are kept up to 50 per entry, with full counts. For what changed before the journal started, use the
version diff: pass `next.since_version` from an earlier reply. Revit's version moves on each save or sync.

Counts are per source and per kind, never per person (rule 9).

## Arguments

| Name | Default | Notes |
|---|---|---|
| `document` | `""` | Open model for Revit's record; empty reads files only |
| `project_code` | `""` | Keeps ledger lines of this project |
| `project_folder` | `""` | The project's sync log and flows |
| `since`, `until` | `""` | ISO times |
| `sources` | ledger, external, created, syncs, revit | Add `flows` for fmc_changes flags |
| `since_version` | `""` | Version GUID from `next.since_version` |
| `after_seq` | 0 | Journal position from `next.after_seq` |
| `element_limit` | 200 | Changed elements listed (all are counted) |
| `limit`, `cursor` | 100, `""` | Paging; `next_cursor` |

## Reply

`read_only`, `transaction`, `saved`, `synced` (always true, false, false, false), `worksharing`, `as_of`, `model`
(resolved document, workshared, version, diff counts), `sync` (last sync, last save, last change, changed since the last
sync, and "None taken"), `total`, `counts`, `entries[]` (`at`, `source`, `kind`, `what`, `who`, `project`, `document`,
`ok`, `detail`), `next_cursor`, `next` (`since_version`, `after_seq`), `sources[]`, `notes[]`.

```json
{ "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", "since": "2026-11-28T00:00:00Z" }
{ "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", "since_version": "<next.since_version>", "after_seq": 42 }
{ "project_code": "F26901", "sources": ["ledger", "created", "syncs"] }
```

The pane can run it through the server CLI: `node build/fmc/cli.js fmc_change_feed` with the JSON on stdin.

## fmc_model_changes (add-in command)

`document` (required), `after_seq`, `limit` (journal, at most 1000), `since_version`, `element_limit` (at most 1000).
Returns `resolved_document`, `workshared`, `user`, `version {guid, saves}`, `journal {listening, since, last_seq,
next_after_seq, more, gap, dropped, entries}`, `diff` (null without `since_version`; `FMC-CHANGES-VERSION` when Revit
doesn't know the version), `notes`. Errors: `FMC-DOC-REQUIRED`, `FMC-DOC-NOT-FOUND`, `FMC-DOC-AMBIGUOUS`.
