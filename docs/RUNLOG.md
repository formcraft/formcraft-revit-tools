# Run log (`fmc_runlog`)

Read-only. Pass `path` as `RUN_ALL_log.txt`, one result JSON file, or a folder of those. The reply is one line per batch: id, ops, ok, failed, and `FMC-` codes.

`scripts/Run-FmcRunlog.mjs` is the same summary for the shell. Put it next to `Run-FmcBatch.mjs`. It reads the built server module `server/build/fmc/runlog.js`.

```json
{ "path": "C:\\Jobs\\_Staging\\RUN_ALL_log.txt" }
```

A log line is counted when it names a batch (`B09`, or `batch-...`) and says PASS, OK, FAIL or ERROR. A JSON file uses `batch_id` and either an `ops` array or the numbers `ops`, `ok` and `failed`.

## Real log and result shapes (28 Nov)

`RUN_ALL_log.txt` from `Run-FmcBatch.cmd` has one section per job:

```
==== B03_A_door_window_room_tags Mon 11/23/2026  1:25:09.40
Server 16d28e8+site(2ef99c4)  idle
Batch  runner-A-tags on F26901-FMC-ZZ-ZZ-M3-A-0002_USER
Lease  11206bac-...
Preview:
  -> send_code_to_revit
[ { "tool": "send_code_to_revit", "result": { ... } } ]
Apply:
  -> send_code_to_revit
...
Result log: C:\...\B03_A_door_window_room_tags.result-20261123-012558.json
```

`fmc_runlog` reads each section as one batch: `batch_id` is the label (`runner-A-tags`), `name` the job file, `document` the model. An **op** is one item of a reply's `ops` array (a `modify_model` reply), or one tool call when the reply has no `ops` array. An op is failed when it carries `error`, `ok:false`, `refused:true` or a `code`. A reply with `applied:false` and a `reason` changed nothing and is counted as `skipped`. Codes come from `code` fields and from `[FMC-...]` in a reply's text, error or reason, so a document name such as `FMC-ZZ-ZZ-M3-A-0002` is not a code.

A result file (`<job>.result-<stamp>.json`) is `{ label, ok, applied, error, steps: [{tool, result}], preview, apply, verify, release }`. The `steps` are counted the same way, and a batch-level `error` or `ok:false` makes the batch FAIL. In a folder only `.json` files and `.txt` or `.log` files are read, so the `.cmd` and README next to the log are skipped. The older one-line log (`B10 FAIL ops=12 ok=9 failed=3 code=FMC-BATCH-LOCKED`) and result JSON with `ops`, `ok` and `failed` numbers still work. The tests read `server/src/fmc/fixtures/runlog/`.