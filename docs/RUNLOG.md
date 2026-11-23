# Run log (`fmc_runlog`)

Read-only. Pass `path` as `RUN_ALL_log.txt`, one result JSON file, or a folder of those. The reply is one line per batch: id, ops, ok, failed, and `FMC-` codes.

`scripts/Run-FmcRunlog.mjs` is the same summary for the shell. Put it next to `Run-FmcBatch.mjs`. It reads the built server module `server/build/fmc/runlog.js`.

```json
{ "path": "C:\\Jobs\\_Staging\\RUN_ALL_log.txt" }
```

A log line is counted when it names a batch (`B09`, or `batch-...`) and says PASS, OK, FAIL or ERROR. A JSON file uses `batch_id` and either an `ops` array or the numbers `ops`, `ok` and `failed`.
