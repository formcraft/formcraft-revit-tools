# Family editor ops (fmc_doc) and the person gate for deletes

Plugin Bot's family editor batch (Emlyn, 28 Nov 13:35 EAT). Tool Research's coverage review (FAMILY_COVERAGE_REVIEW-2026-11-28,
section 5 item 4) recommends fmc_doc ops rather than new engines, so `fmc_fam_param`, `fmc_fam_type` and `fmc_fam_ref` are thin
wrappers: each action becomes one of these ops and runs through `fmc_doc apply` (same checks, same dry run, same session ledger).

| Op | Fields | What Revit does | Person-gated |
|---|---|---|---|
| `param_rename` | name, new_name | FamilyManager.RenameParameter. Never a shared (kit) parameter or a built-in one | no |
| `param_regroup` | name, group | InternalDefinition.SetGroupTypeId (the Properties group; `Dimensions` is Geometry) | no |
| `param_set_reporting` | name, on | MakeReporting / MakeNonReporting (a parameter with a formula can't become reporting) | no |
| `param_set_formula` | name, formula (string or null) | FamilyManager.SetFormula; null or "" clears it | no |
| `param_remove` | name | FamilyManager.RemoveParameter. Refused while another formula uses it; the plan says how many labels and associations go | **yes** |
| `type_rename` | name, new_name | RenameCurrentType | no |
| `type_flex_matrix` | params, ranges {low, high, steps}, types? | Each type regenerated with each parameter at `steps` values (2-6) from low to high; every run in one TransactionGroup that is rolled back. A read: sent on its own, never kept or saved | no |
| `type_delete` | name | DeleteCurrentType; never the last type | **yes** |
| `plane_rename` | name or id, new_name | ReferencePlane.Name | no |
| `plane_move` | name or id, offset_mm | ElementTransformUtils.MoveElement along the plane's own normal; warns when a lock or labelled dimension holds it elsewhere | no |
| `plane_delete` | name or id | Document.Delete; the plan names what depends on the plane (dimensions, alignments) | **yes** |

Center (Left/Right), Center (Front/Back), Ref. Level and any plane with Defines Origin are never renamed, moved or deleted (server
check and add-in check). Renames refuse a name already used (case-insensitive) or a character Revit refuses. A second run of the same
batch answers skip (rename to a name that is already there, remove of a parameter that is gone); `plane_move` always moves.

## Deletes need a person

1. **Dry run** (the default): the real run rolled back, so the plan is Revit's own answer, for example "depends on it: 2 Dimension;
   Revit deletes 2 other element(s) with it". The reply carries `confirm_token` (sha256 of the session and the exact ops, 16 hex) and
   `person_lines`; the plan is kept in `<reports_dir>\FamEdit\<token>.json` for 24 h.
2. **dry_run false with the token** does not delete. The server checks the token (same session, same ops, under 24 h), then puts the
   batch in the pane's approval queue (`%APPDATA%\Formcraft\ai_queue`, group `family_delete`, with the person lines). The reply
   says `queued: true` and the `approval_id`; the AI waits with `fmc_ai wait`.
3. **A person approves in the Formcraft pane** (Approvals). Approve runs the queued batch (`ai_approve`, a pane-only CLI command;
   no MCP tool can approve). This queue item never passes the AI gate, so testing mode's `auto_approve` does not apply.
4. **The add-in checks too**: a real `fmc_doc_apply` with a delete op runs only when the queue holds an item for this command,
   session, confirm token and the exact ops, approved by a named person (not `auto-approved`). It marks the item used before
   anything changes, so a replay is refused. A raw call that skips the server is refused the same way.

A rejected item stays rejected (the same batch is refused). After the person's run, the same call answers `already ran`; a new
delete needs a new dry run. `delete_template_element` (recipe builds of a new family from a template) is unchanged.

Known limits: the queue folder is the person's own `%APPDATA%`; a process that can write files there as the same Windows user
could forge an approval (as for every queue item today). The where-used of a family in projects is out of scope here.
