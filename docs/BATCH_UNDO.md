# Undo a batch after sync (`fmc_batch_undo`)

`undo_ai_batch` uses Revit's Undo. A sync or a close clears that list. `fmc_batch_undo` deletes the elements the batch created, from `FMC_Created.jsonl` in the ledger folder.

A write that returns `created_ids` or `created` (id, fingerprint, category) is recorded against its `batch_id` and against the lease id. `modify_model` now returns both. A dry run is not recorded.

Each id is deleted only when it still exists, this user can edit it (`GetCheckoutStatus` is not `OwnedByOtherUser`, and it is current with central), and a stored fingerprint still matches the bounding box. No fingerprint means the unchanged check is skipped and the id can still be deleted. Nothing is checked out.

`dry_run` defaults to true. Apply needs `confirm` true, `batch_lease`, and `references`. The apply is `fmc_batch_undo_apply`, one transaction. The reply lists `deleted`, `kept` and `skipped`.

## Example

```json
{
  "batch_id": "B09",
  "document": "F26901-FMC-ZZ-ZZ-M3-P-0001_USER",
  "dry_run": true
}
```

## API limits

- Revit 2025 has no undo list after sync. This deletes created elements. It does not restore a moved or edited element.
- `CheckoutElements` is never called. An element another user owns is skipped.
- The fingerprint is the bounding box in millimetres to 0.1. A change that does not move the box is not seen.
