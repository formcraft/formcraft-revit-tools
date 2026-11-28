# fmc_transfer (GAP-13)

Copies view templates, parameter and selection filters, legend views, revisions and sheets from one open document to another of the same project. Only the target changes.

**Same project only.** Both documents must be saved, under the same project folder (the path above the first `0N_` folder, such as `01_WIP` or `02_Shared`), and have the same Project Information number when both have one. Anything else is `FMC-TRANSFER-PROJECT`, on the dry run too.

**Matching by name.** View templates, filters and legends match by name, sheets by sheet number, and revisions by description and date. When the target already has the key:

- same signature (view type for templates, categories for filters, sheet name for sheets, issued to/by for revisions) is a duplicate, `FMC-TRANSFER-DUPLICATE`;
- a different signature is a conflict, `FMC-TRANSFER-CONFLICT`, with both signatures;
- two source items with the same key are `FMC-TRANSFER-SOURCE-DUPLICATE`.

Nothing in the target is ever overwritten. A sheet whose name is already used under another number is copied with the warning `FMC-TRANSFER-SHEET-NAME`.

**Dry run first.** `dry_run` defaults to true and returns the plan, the counts and a `plan_hash`. A write needs `dry_run: false`, `confirm: true`, the same `plan_hash` and `batch_lease` on the target. A changed model changes the hash (`FMC-GAP-PLAN-CHANGED`). A central model, HEBERT HOSTELS, a protected path and `save_exclude`/`sync_exclude` are refused (`FMC-GAP-GUARD`).

**What the write does.** `fmc_transfer_apply` is one transaction in the target, with one subtransaction per item, so one failure is reported and skipped:

- templates, filters and legends: `ElementTransformUtils.CopyElements` from the source document, with the target's types kept on a name clash (filters used by a template come with it);
- revisions: `Revision.Create`, then description, date, issued to and issued by. They are created unissued and numbered by the target's sequence;
- sheets: `ViewSheet.Create` with the same title block family and type when the target has it loaded (otherwise none), then number and name. Views placed on the source sheet are not copied.

Nothing is saved or synced.

```json
{ "source": "F26901-FMC-ZZ-ZZ-M3-A-0001", "target": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", "kinds": ["view_templates", "filters"], "dry_run": true }
```

Needs a live Revit check: copying a legend view between documents with `CopyElements`, and the title block match on sheets.
