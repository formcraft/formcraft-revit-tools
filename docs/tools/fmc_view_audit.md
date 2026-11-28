# fmc_view_audit

Audits views and view templates in one open document. The report always comes first. Fixes are optional, run in one batch, and only after a dry run the person has seen.

**Report** (`fmc_view_audit_read`, no transaction):

- views with no view template (view types that take one);
- template parameters that are not controlled, from `View.GetNonControlledTemplateParameterIds`, by parameter name;
- unused view templates (no view uses them) and unused filters (no view or template has them);
- views not on any sheet (viewports and schedule instances);
- state: discipline and detail level counts, the view range of each plan (level and offset in mm for top, cut, bottom and depth), views with the crop off, views with the crop region shown, scope boxes, and link overrides (`View.GetLinkOverrides`, Revit 2024 and later) that are not By Host View.

Each list returns at most `limit` rows (default 200) with its total.

**Fixes** (`fixes`, checked against the read before they are planned):

| op | Fields | Does |
| --- | --- | --- |
| `assign_template` | `view`, `template` | sets the view template; the template must be the same view type, and Revit's `IsValidViewTemplate` must agree |
| `control_template_params` | `template`, `parameters` (empty = all) | makes those parameters controlled by the template |
| `set_detail_level` | `view`, `level` (Coarse, Medium, Fine) | |
| `set_discipline` | `view`, `discipline` | |
| `set_crop` | `view`, `crop_active`, `crop_visible` | |
| `set_scope_box` | `view`, `scope_box` (empty removes it) | |

A name that is missing or used twice is skipped with a code. A fix on a view that already has a template comes with a warning: if the template controls that setting, Revit refuses it and it is reported under `failed`.

**Gate.** `dry_run` defaults to true and returns the planned fixes and a `plan_hash`. A write needs `dry_run: false`, `confirm: true`, the same fixes and `plan_hash`, and `batch_lease`. A central model, HEBERT HOSTELS, a protected path and `save_exclude`/`sync_exclude` are refused. `fmc_view_audit_apply` is one transaction, one subtransaction per fix, found by the element id from the dry run and checked by name. Nothing is deleted: unused templates and filters are reported only. Nothing is saved or synced.

```json
{ "document": "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", "fixes": [{ "op": "assign_template", "view": "Level 1", "template": "FMC_A_Plan" }], "dry_run": true }
```

Needs a live Revit check: link overrides on Revit 2025, and parameter names for shared parameters in `control_template_params`.
