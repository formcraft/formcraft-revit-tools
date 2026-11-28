# fmc_docs

Open and close models. Writes default to `dry_run: true` and need `batch_lease`.

## list

```json
{ "action": "list" }
```

## open

A workshared central opens as a new local in Documents (`as_local` defaults to true). `detach` opens a detached copy and does not write the central. `worksets` is `all` or `last`.

```json
{
  "action": "open",
  "path": "D:\\Models\\F26901-FMC-ZZ-ZZ-M3-E-0001.rvt",
  "as_local": true,
  "detach": false,
  "worksets": "all",
  "dry_run": true
}
```

## close

`save` defaults to false. A dirty document is refused unless `save` is true. The last open document is never closed. A save is refused under `protected_roots`, for a title in `save_exclude`, and for `HEBERT HOSTELS_USER`. A workshared model is not saved.

```json
{ "action": "close", "document": "Sketch", "save": false, "dry_run": true }
```
