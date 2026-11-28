# fmc_fam_param

Family parameters in an fmc_doc session (open a family template or a staging .rfa with `fmc_doc open`). A thin wrapper over the
fmc_doc ops in [fmc_fam_ops.md](fmc_fam_ops.md). Nothing is saved: `fmc_doc save` does that.

| action | fields | op |
|---|---|---|
| list | – | `fmc_doc report`: name, instance, shared, group, reporting, formula, built_in |
| rename | name, new_name | `param_rename` |
| regroup | name, group | `param_regroup` |
| reporting | name, on | `param_set_reporting` |
| formula | name, formula (null clears) | `param_set_formula` |
| remove | name | `param_remove` (**a person approves**) |

Writes are dry runs unless `dry_run: false`. remove: the dry run answers `confirm_token`; `dry_run: false` with it queues the remove
for a person's Approve in the pane, which runs it (see the gate in fmc_fam_ops.md).
