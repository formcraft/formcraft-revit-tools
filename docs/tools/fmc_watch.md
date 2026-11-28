# fmc_watch: a change ledger for an open model

`fmc_watch` records who changed what in an open project model, as JSON lines on disk. It never changes the model: no
transaction, no save, no synchronise, nothing sent over a network.

## Actions

| action | needs Revit | what it does |
|---|---|---|
| `start` | yes | Registers a document-specific updater and the `DocumentChanged` hook on ONE document (`document` is required) and opens the ledger. A second `start` on the same document changes nothing (`already_running`). |
| `stop` | yes | Unregisters the updater and the hook, writes a closing row, returns a summary of the ledger. `all: true` stops every watch. |
| `status` | yes | The running watches (counts, file, errors) and the ledger files found. |
| `read` | no | Ledger rows, newest last (`limit` 100, max 500), with filters. |
| `summary` | no | Changes grouped by user, category, change type, transaction and time (`bucket` hour or day), with advice. |

Filters for `read` and `summary`: `since`, `until` (ISO dates), `user`, `category`, `change_type`, `element_id`.

## How it records

- **Updater** (`WatchUpdater`, `commandset/Bridge/FmcWatch.cs`): triggers on element addition, deletion, geometry change and any
  change, for the model categories (plus levels, grids, rooms, areas; `scope: all` adds annotation and view elements). It
  classifies each id as added, deleted, geometry or parameter and remembers the category. It only reads, does no file I/O, and
  catches every exception (an updater that throws is switched off by Revit): errors are counted and shown in `status`.
- **DocumentChanged** (complement and fallback): after every commit, undo and redo it writes one line per element, with the
  transaction names and the operation (`TransactionCommitted`, `TransactionUndone`, `TransactionRedone`), merging the updater's
  classification. Anything the updater did not see is still logged, typed `added`, `modified` or `deleted`.
- Both are removed on `stop` and on `DocumentClosing`.
- Limits: at most 500 lines per event (the rest is counted in a `summary` row). A deleted element's category is known only
  if it was seen after `start`; otherwise it shows as `(unknown)`.

## Ledger file

`<project_folder>\06_QA\Watch\FMC_Watch_<model>_<yyyyMMdd-HHmm>.jsonl` where `fmc_guard.json` allows a write, else
`<reports_dir>\Watch` (the same guard and fallback as `fmc_warnings`). The server picks the path; the add-in checks it again:
an absolute `.jsonl` in a folder called `Watch`, never under `_Reviews` or the review register. One line per change:

```json
{"t":"2026-11-28T09:05:00.0000000+03:00","user":"anna","doc":"M","op":"TransactionCommitted","tx":"Create walls","id":123456,"cat":"Walls","type":"added"}
```

Other `type`s: `watch_started`, `watch_stopped`, `summary` (`not_listed`), for bookkeeping.

## Tests

`server/src/fmc/watch.test.ts` (offline, temp folders only; a fake Revit writes the ledger the way the add-in does, and source
assertions check the updater never writes, never does I/O, never throws, and is unregistered on stop and close).
