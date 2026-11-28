# fmc_memory

The pause stays at 1024 MB free. Resume stays at 1536 MB. This tool does not change those thresholds.

## status

Free MB, the Revit working set, and open documents including family documents.

```json
{ "action": "status" }
```

## free

Closes unmodified family documents and unmodified non-active non-workshared documents, then runs `GC.Collect`. The last document stays open. Revit 2025 has no API to clear the undo stack. `dry_run` defaults to true. A real run needs `batch_lease`. The reply includes MB before and after.

```json
{ "action": "free", "dry_run": true }
```

## purge_unused

PerformanceAdviser rules whose name contains unused or purge. `categories` limits the delete. `dry_run` defaults to true.

```json
{
  "action": "purge_unused",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "categories": ["Electrical Equipment"],
  "dry_run": true
}
```
