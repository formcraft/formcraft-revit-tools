# fmc_queue

The waiting line. A stale queued job is listed with a `busy_reason` and can be removed. It does not sit in front of later calls with no explanation.

`busy_reason` is one of: `job running X for N s`, `lease held by Y on doc Z`, `modal dialog <title>`, `RAM gate`, `transaction open`, `Revit not idle`. The same field is on `GET /health`.

## list

```json
{ "action": "list" }
```

Each job has age, document, tool, lease holder, caller and instance.

## cancel

Queued jobs only. A running job is `FMC-JOB-RUNNING` unless it is stale and Revit is idle.

```json
{ "action": "cancel", "job_id": "abc123" }
```

## purge_stale

`dry_run` defaults to true.

```json
{ "action": "purge_stale", "older_than_min": 5, "dry_run": true }
```
