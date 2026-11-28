# `fmc_file` open_local and close_local (F125)

`fmc_file` lists open documents, makes files from templates, saves, closes and archives. `open_copy` opens a **detached** copy in the background. Two actions open and close a person's own **workshared local** (not a copy):

| Action | What it does | What it never does |
| --- | --- | --- |
| `open_local {path, activate=true, worksets}` | Opens the existing local file with `UIApplication.OpenAndActivateDocument(ModelPath, OpenOptions, false)` and makes it the active document. `activate=false` opens it in the background (`Application.OpenDocumentFile`). | Detach, create a new local, synchronise, save, or open a central. |
| `close_local {document, save=false}` | Closes an open project. If it is the active document, another open project is activated first. | Synchronise or relinquish. |

`dry_run` defaults to **true** for both. A dry run reads the file's workshare info from Revit (BasicFileInfo through `fmc_docs probe`) and changes nothing.

## open_local

- `path`: the full path of the local `.rvt`. It must exist, be a project file and sit on a local or UNC drive.
- `worksets`: `all` (default for a workshared file), `last_viewed` (`last` is the same), `none`, or a list of workset names. A list closes every workset, then opens the named ones. A name the file does not have is `FMC-FILE-WORKSET-UNKNOWN` and nothing is opened.
- `DetachFromCentralOption.DoNotDetach` always. The file is opened as it is. Revit does not create a new local from it.
- A local that is already open is only activated (or left as it is with `activate=false`). Nothing is reopened.
- The result has `title`, `path`, `doc_id` (the document's creation GUID), `is_active`, `is_workshared`, `worksets`, `already_open` and `dialogs`.
- Any dialog that would synchronise, relinquish or save to central is cancelled and named in the error. Other dialogs are recorded, not clicked.
- It works with Revit on the Home page: `fmc_open_local` needs no open document.

## close_local

- `document`: title or full path from `list_open`. A missing name is `FMC-DOC-REQUIRED`, no match `FMC-DOC-NOT-FOUND`, two matches `FMC-DOC-AMBIGUOUS`. The active document is never a guess.
- Revit cannot close the active document. When the target is active the add-in activates another open project first (the plan names it in `activate_first`; a real model is preferred over a verification copy). If no other project has a saved path it stops with `FMC-FILE-ACTIVE-CLOSE`; if the target is the only open document it stops with `FMC-FILE-ONLY-DOC`.
- A document with unsaved changes is refused (`FMC-FILE-UNSAVED-CHANGES`) unless `confirm=true`. Closing then discards the changes.
- `save=true` is a **model write**. The server sends it as `fmc_close_local_apply`, which is in `WRITE_COMMANDS`: it needs `batch_lease` (from `fmc_batch request`), passes the live-model lock and the AI gate, and the add-in saves the local file with `Document.Save(SaveOptions)` before it closes. It never synchronises and never relinquishes. It is refused (`FMC-FILE-SAVE-REFUSED`) for HEBERT HOSTELS, a protected original, a detached or verification copy, a document with no path, and a title the guard excludes from saving. `save=false` (the default) goes through `fmc_close_local`, which the add-in refuses to save with.

## Error codes

| Code | Meaning |
| --- | --- |
| `FMC-FILE-PATH-REQUIRED` | open_local without a path |
| `FMC-FILE-NOT-FOUND` | the file is not on disk |
| `FMC-FILE-NOT-PROJECT` | not a `.rvt` project |
| `FMC-FILE-CLOUD-REFUSED` | BIM 360, Autodesk Docs or Revit Server path |
| `FMC-FILE-PROTECTED-REFUSED` | under `protected_roots` or a `live_paths` entry: open the local, not the original |
| `FMC-FILE-CENTRAL-REFUSED` | the file (open_local) or document (close_local) is the central model |
| `FMC-FILE-NOT-WORKSHARED` | worksets asked for a file that is not workshared |
| `FMC-FILE-WORKSETS-INVALID` / `FMC-FILE-WORKSET-UNKNOWN` | an empty list or empty name / a name the file does not have |
| `FMC-FILE-FAMILY-REFUSED` | close_local on a family document (use `close`) |
| `FMC-FILE-VERIFY-COPY` | close_local on a detached or verification copy (use `close_copy`) |
| `FMC-FILE-ONLY-DOC` | the target is the only open document |
| `FMC-FILE-ACTIVE-CLOSE` | the target is active and there is nothing to activate instead |
| `FMC-FILE-UNSAVED-CHANGES` | unsaved changes and save is false, without confirm |
| `FMC-FILE-SAVE-REFUSED` | save=true on a document a tool never saves, or sent outside `fmc_close_local_apply` |
| `FMC-DOC-REQUIRED`, `FMC-DOC-NOT-FOUND`, `FMC-DOC-AMBIGUOUS` | the document name |

```json
{ "action": "open_local", "path": "C:\\Users\\USER\\Documents\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt", "worksets": "all", "dry_run": true }
{ "action": "close_local", "document": "F26901-FMC-ZZ-ZZ-M3-P-0001_USER", "dry_run": true }
```

Installs only with the add-in (a Revit close). Revit check after install, dry run first: open a local with `activate=false`, then `close_local` it; then `activate=true`.