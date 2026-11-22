# fmc_details

Typical details from the kit. `list` reads the kit `Details` folder (`.rvt` and `.rfa`) and `FMC_Details.json` in that folder. A missing folder is `FMC-DETAILS-CATALOGUE` and is a kit change. No detail is invented.

`place` creates a drafting view in the named project and copies detail components, lines, text and filled regions from the source view with `CopyElements`. A `.rfa` is loaded if needed and placed as a detail item. The source opens in the background and is closed without saving. The kit file is not edited.

`OpenOptions` has no read-only flag. A workshared source is detached and its worksets are discarded, so the central is not touched. If the file is already open, it is used and not closed.

`detail_ids`, `details`, or `batch_file` lists more than one id, so a batch can run without an AI composing each call. One call takes at most 50. `dry_run` defaults to true. A real place is `fmc_details_apply`, one transaction, one subtransaction per detail. It needs `batch_lease` and `references.kit`, `references.standards` and `references.rulebook`.

Pass `document` on `place`. The active document is not a guess. HEBERT HOSTELS, a central, a protected path and a kit original are refused. The project is not saved or synced.

List:

```json
{ "action": "list" }
```

Place one detail, dry run:

```json
{
  "action": "place",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "detail_id": "D-A-001",
  "view_name": "DET Window head",
  "sheet": "A-501",
  "dry_run": true
}
```

A batch file:

```json
{ "detail_ids": ["D-A-001", "D-A-002"] }
```

```json
{
  "action": "place",
  "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
  "batch_file": "D:\\Jobs\\_Staging\\details-batch.json",
  "dry_run": true
}
```

Catalogue row:

```json
{
  "id": "D-A-001",
  "name": "Window head",
  "source": "D-A-001.rvt",
  "view": "Head",
  "kind": "drafting",
  "sheet": "A-501"
}
```

An existing drafting view of the same name is reused and not copied again. A source with several drafting views and no `view` in the catalogue is `FMC-DETAIL-VIEW`.
