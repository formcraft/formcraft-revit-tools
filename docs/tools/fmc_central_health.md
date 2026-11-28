# fmc_central_health

Central model health, read-and-plan only. It reports; it never acts. It never runs an audit, a compact, a sync or a relinquish, never deletes a backup, and never opens, copies or saves a model file: it reads a file's size and date only (Rule 6).

## What it reports

- **Central file**: size, modified date, and a level (`ok`, `watch` at 500 MB, `act` at 1000 MB; set with `central_warn_mb`, `central_act_mb`). A Revit Server or cloud central has no file to read; only the Revit facts apply.
- **Growth over time**: from `FMC_CentralHealth_History.json` in the reports folder. Needs samples on different days (see `record`). Flags a rise of `growth_warn_pct` (20%) inside `growth_window_days` (30) and projects the days to the `act` size.
- **Backups**: the folder `<central folder>\<central name>_backup` (or `backup_dir`): state (`not_found`, `empty`, `ok`, `watch`), file count, total size, newest and oldest, largest files, and warnings (over `backup_warn_gb`, `backup_warn_count`, or no new file for `backup_quiet_days`).
- **Stale locals**: `<central>_<user>.rvt` files in `local_dirs` (not searched recursively) not touched for `stale_days` (14).
- **Borrowed**: workset owners from the open model (`fmc_workshare_facts`, read-only). Borrowed element counts appear only when the add-in reports them; otherwise the reply says so.
- **Plan**: audit, compact, review of stale locals, review of backups, and ask owners to relinquish. Cadence comes from `last_audit` / `last_compact` (ISO dates a person gives) and `audit_every_days` (30) / `compact_every_days` (90). **Every plan line has `needs_person: true` and `executed_by_tool: false`.**

The thresholds are this tool's defaults, not Revit limits.

## Dry run first

`dry_run` defaults to true and nothing is written. The only thing the tool can write is one size sample to the history file, and only with `record: true` **and** `dry_run: false`. A dry run with `record: true` shows `would_record`.

```json
{ "central_path": "\\\\server\\Proj\\02_Shared\\Model.rvt", "local_dirs": ["D:\\Locals"], "last_audit": "2026-10-20" }
```

```json
{ "central_path": "\\\\server\\Proj\\02_Shared\\Model.rvt", "record": true, "dry_run": false }
```

Leave `central_path` empty to read the central from the open workshared model. With `use_revit: false`, or when Revit is not reachable, only the file checks run.

## Reply

`status` (`ok`, `watch`, `act`), `findings` (each with a code `FMC-CENTRAL-*`, a level and a message), `central`, `growth`, `backups`, `locals`, `borrowed`, `plan` (`items`, `schedule`), `history_record`.
