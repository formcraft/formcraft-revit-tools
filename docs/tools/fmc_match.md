# fmc_match

Copy the type, instance parameters and a view's graphic overrides from one source element to target elements, like pyRevit Match. Gap-analysis proposal 10.

Same category only. A target in another category is refused in the diff and never changed. Pass `document` (a title or a full path); the active document is never used.

## Arguments

- `source`: element id to copy from. `targets`: element ids to change, at most 200.
- `what`: any of `type`, `parameters`, `overrides`. Default `type` and `parameters`.
- `view`: a view id. Required when `what` has `overrides`: the source's overrides in that view are copied to each target in that view.
- `parameters`: only these parameter names. `exclude_parameters`: leave these out.
- `dry_run` (default true), `plan_hash`, `batch_lease`.

## What is copied

- Type: `Element.ChangeTypeId` to the source's type, only when Revit says the type is valid for the target.
- Parameters: instance parameters that are not read-only, matched by key (shared parameters by GUID, built-in by id, others by name) and by storage type. Never copied: Mark, level, host, phase, workset, design option, family and type, edited by, IFC GUID. An element-id parameter is copied only when it is empty or a material. Type parameters are not copied (that would change every element of the type).
- Overrides: `View.SetElementOverrides(target, View.GetElementOverrides(source))`. A view template that controls graphic overrides makes Revit refuse; the whole call rolls back.

## Dry run and apply

The dry run (default) returns, per target, `will_change`, `no_change` or `refused` with reasons and the changes (type, parameter from and to, overrides), the totals, and `plan_hash`. A report is written under `%LOCALAPPDATA%\Formcraft\match`.

A real change needs `dry_run: false`, the `plan_hash` from the dry run, and `batch_lease`. The call reads the model again, plans again, and refuses `FMC-MATCH-PLAN-CHANGED` when the hash differs. One transaction: any failure rolls everything back. The project is not saved or synced.

## Safeguards

`fmc_match_apply` is in `WRITE_COMMANDS`, so the live-model lock, the AI gate and the batch lease apply. Refused: HEBERT HOSTELS, a central model, a file under a Centrals folder, a protected path, a family file, an element another user owns. Nothing is checked out on purpose; Revit's own editing rules apply to a workshared local.

```json
{ "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", "source": 123456, "targets": [123457, 123458], "what": ["type", "parameters"], "dry_run": true }
```

Design decisions for Emlyn: Mark and level-like parameters are never copied (marks should stay unique); type parameters are never copied; overrides need a view id rather than the active view. Tell me if you want any of those changed.
