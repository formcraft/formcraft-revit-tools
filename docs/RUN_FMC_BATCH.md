# Run-FmcBatch library steps

The no-AI runner `Run-FmcBatch.mjs` lives outside this repo. `scripts/Run-FmcRunlog.mjs` sits next to it and summarises `RUN_ALL_log.txt` or a folder of result JSON. It is read-only. The same summary is `fmc_runlog`. A step that runs a kit script is:

```json
{"tool":"library","id":"sheets","arguments":{"level":"01"},"background":true}
```

`tool` is `library`. `id` is the script id in `05_Scripts/library/index.json`. `arguments` are the script inputs. `background` true submits the job and polls; omit it to run in the call.

The helper is `prepareLibraryStep` and `pollBackgroundJob` in `server/src/fmc/batchstep.ts`.

## What the runner fills in

- `references.kit`, `references.standards` and `references.rulebook` come from the manifest when the step omits them. A manifest that is missing any of the three is refused.
- `--preview-only` is `dry_run: true` and `mode: "preview"`. The graph or script runs inside a transaction that is rolled back. It does not save, and it does not trigger the autosave that follows an AI command.
- Before `apply`, the runner checks `revit_version`, `workshared_safe` and `target_doc_rules`. A mismatch is a refusal. Apply needs `batch_lease` for that document. Apply does not save. The existing timer and the batch-end sync do.

## Background

`background: true` calls `submit` and returns `{job_id, state:"queued", position}` without waiting. The runner then polls `status` every 5 seconds, backing off to 30 seconds, until the job is `finished`, `failed`, `cancelled` or `interrupted`. It writes `result_ref` into its log.

`result_ref` is a folder `%LOCALAPPDATA%\Formcraft\jobs\<job_id>\` with `result.json` (diff, outputs, `resolved_document`, `auto_saved`, `batch_end_sync`) and `log.txt`.

The queue file is `%APPDATA%\Formcraft\jobs\queue.json`. One job runs at a time for each Revit. A job that was running when the server restarts is marked `interrupted` and is not started again. Apply heartbeats its lease while it is queued or running. Revit that is not idle (`FMC-REVIT-NOT-IDLE`) is waited on, not failed.

## Tools

| Tool | Actions |
|---|---|
| `fmc_library` | `list`, `validate`, `run` (script library). Family actions are unchanged. |
| `fmc_dynamo` | `inspect`, `status`, `run`, `submit`, `list`, `log`, `cancel`. `graph_run` on `fmc_scripts` forwards here. |
| `fmc_script_run` | `run`, `submit`, `status`, `list`, `log`, `cancel`. |

`mode` is `preview`, `apply` or, for Dynamo only, `offline`. Offline uses DynamoCLI and only when the graph has no Revit nodes (`FMC-DYNAMO-NEEDS-REVIT` otherwise). Revit is not launched and a journal is not replayed.

`dry_run` defaults to true (preview). `document` is an exact title or path (`FMC-DOC-REQUIRED`, `FMC-DOC-NOT-FOUND`, `FMC-DOC-AMBIGUOUS`). Every result carries `resolved_document`.

## Manifest

`05_Scripts/library/index.json` is `{ "scripts": [ { "id", "manifest" } ] }`. Each manifest has: `id`, `entry`, `runner` (`dynamo`, `csharp`, `python`, `pyrevit`, `unavailable`), `inputs`, `outputs`, `revit_version`, `kit_version`, `references` (`kit`, `standards`, `rulebook`), `dry_run`, `writes_model`, `workshared_safe`, `target_doc_rules`, `replaces_plugin_tools`, `est_ai_calls_saved`.

Graphs and entries must sit in `05_Scripts/library` or `05_Scripts/Dynamo` under the kit root (the folder above `specs_path`, or `FMC_KIT`).
