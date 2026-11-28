# fmc_cloud: Autodesk Docs cloud models

Autodesk Docs (ACC / BIM 360) cloud model operations through the Revit API. Revit 2025 (Release R25).

## Actions

| Action | Kind | What it does |
|---|---|---|
| `facts` | read | For each name in `documents` (or the target document): `is_cloud` (`Document.IsModelInCloud`), `is_workshared`, `is_detached`, `is_modified` (unsaved changes), `is_read_only`, `version` (`Document.GetDocumentVersion`: version GUID, number of saves), and for a cloud model `cloud`: `region` (`ModelPath.Region`), `project_guid`, `model_guid`, user-visible path, `model_urn`, `hub_id`, `project_id`, `folder_id`. For a workshared model `central` (path, cloud or not). One result per document; a missing document is an `error` row, not a failure of the call. Never opens a file (`mayOpen: false`). |
| `cloud_path` | read | Each `{ region, project_guid, model_guid }` item to Revit's cloud path with `ModelPathUtils.ConvertCloudGUIDsToCloudPath`. Regions: `US`, `EMEA` (the two `ModelPathUtils.CloudRegion*` values in the 2025 API). Bad items are `refused` rows and are not sent to Revit. Nothing is opened. |
| `parse` | offline | Splits user-visible paths: `Autodesk Docs://Project/[folders/]Model.rvt`, `BIM 360://…`, `RSN://…`, local and UNC. No Revit. |
| `save_as_cloud` | **write** | `Document.SaveAsCloudModel(accountId, projectId, folderId, modelName)` on an open project document that is not workshared, not already cloud, not a family and not read-only. `account_id` / `project_id` take the bare GUID or the `b.` form. `folder_id` is the Docs folder URN. |
| `sync`, `publish` | never run | The dry run lists what a person does in Revit. A real run is refused, even approved (`FMC-CLOUD-RULE6`, CLAUDE.md rule 6). |

## The write gate

1. `dry_run` defaults to `true`: the reply lists exactly what would happen (`plan.would`) and any problems.
2. A real write needs **both** `dry_run: false` **and** `approved_by`: the name of the person who approved it. Missing, or a word like `yes`, `ok`, `AI`, a bot name: refused with `FMC-CLOUD-APPROVAL`. Nothing is sent to Revit.
3. `fmc_cloud_save_as` is in `WRITE_COMMANDS`, so the live-model lock and the AI gate apply as for every write.
4. The add-in checks the document again before it calls `SaveAsCloudModel`.
5. Every refusal and every write is logged to `FMC_MCP_FileLog.csv` in the reports folder, with the approver's name.

## CollaborationCache

Revit's local cloud cache (`%LOCALAPPDATA%\Autodesk\Revit\Autodesk Revit 2025\CollaborationCache`) is never read, written, deleted or listed.

- Server: any argument (at any depth, key or value; any case, URL-encoded, with spaces, `_`, `-` or `.` between the words) naming `CollaborationCache` is refused with `FMC-CLOUD-CACHE` before Revit is asked.
- Server: any string in a Revit reply that points inside it is replaced with `(inside CollaborationCache: not read)`.
- Add-in: `FmcCloudGuard.RejectParameters` refuses the same arguments; `FmcCloudGuard.Safe` redacts `doc.PathName` and model paths. The handler does no file system access at all.

## Add-in commands

| Command | Class | Policy |
|---|---|---|
| `fmc_cloud_facts` | `FmcCloudFactsCommand` | `READ_VIA_SEND_COMMAND` |
| `fmc_cloud_path` | `FmcCloudPathCommand` | `READ_VIA_SEND_COMMAND` |
| `fmc_cloud_save_as` | `FmcCloudSaveAsCommand` | `WRITE_COMMANDS` |

## Tests

`server/src/fmc/cloud.test.ts` with `server/src/fmc/fixtures/cloud_paths.json` (offline): the path guard, cache redaction, path parsing, GUID and region checks, one result per item, the dry-run and approval gate, and the policy classes.
