# fmc_fam_ref

Reference planes in an fmc_doc session. A thin wrapper over the fmc_doc ops in [fmc_fam_ops.md](fmc_fam_ops.md).

| action | fields | op |
|---|---|---|
| list | – | `fmc_doc report` planes: id, name, is_reference, defines_origin, pinned, normal, at_mm |
| rename | name or id, new_name | `plane_rename` |
| move | name or id, offset_mm | `plane_move` (along the plane's normal) |
| delete | name or id | `plane_delete` (**a person approves**) |

An unnamed plane is addressed by its id from list. The template origin planes (Center (Left/Right), Center (Front/Back), Ref. Level)
and any plane with Defines Origin are never renamed, moved or deleted; a pinned plane is refused for move and delete. The kit's
naming standard for planes other than the two centre planes is still Emlyn's decision (FAM-008 names only those two), so
`plane_rename` takes any name the person or recipe gives.
