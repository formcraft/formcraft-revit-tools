# Schedule sets · fmc-schedules/0.1

Schedules for every discipline (F60) are made from a **schedule set**: the schedules as data, checked before Revit and
made or updated in the open template or WIP model by `fmc_schedules`. The designs are the chat's `Sch_*` canvases. The
kit has no schedule set yet, so this format is the plugin's proposal; when the kit publishes one, the kit wins (rule 7)
and this page follows it.

```json
{
  "schema": "fmc-schedules/0.1",
  "name": "FMC schedule set",
  "revision": "P01",
  "schedules": [{
    "name": "A_Door_Schedule", "discipline": "A", "category": "OST_Doors",
    "fields": [{ "name": "Mark" }, { "name": "FMC_Zone", "heading": "Zone" }, { "name": "Count", "total": true }],
    "filters": [{ "field": "FMC_Zone", "op": "equals", "value": "Z1" }],
    "sort": [{ "field": "Mark" }],
    "itemized": true, "grand_totals": true, "folder": "A Architecture"
  }]
}
```

| Field | Rules |
|---|---|
| `category` | A BuiltInCategory (`OST_Doors`), a category name, or `*` for a multi-category schedule |
| `fields` | In column order. `heading` renames the column, `hidden` keeps a field for filtering or sorting only, `total` shows its total. An `FMC_` field must be a kit parameter, bound to the category in the kit (a warning otherwise). Revit's own fields (Mark, Family and Type, Count, Area…) are found by name in Revit; a missing one is reported, never invented |
| `filters` | `equals`, `not_equals`, `contains`, `not_contains`, `begins_with`, `greater`, `less` take a value; `has_value` and `has_no_value` don't. Only on the schedule's own fields |
| `sort` | In order; `group` adds a header (and a footer with `totals`) |
| `folder` | Set on the schedule's `FMC_Schedule_Folder`, when the template has that parameter |

## How a run works
- `check` needs no Revit.
- `plan` runs in the open template or WIP model and is rolled back. It lists what would be made, what updated, and the fields the category doesn't have.
- `apply` with `dry_run=false` writes in one transaction, behind the live-model lock.
- A schedule that already exists (same name) only gets the fields it lacks. Its own columns, filters, sorting and formatting stay, and the extra columns are listed as kept. Nothing is ever deleted.

A sample is in `tests/schedules/FMC_Schedules_sample.json`.

## Kit change requests
1. **`03_Master_Data/FMC_Schedule_Sets.json`:** the discipline schedule sets from the `Sch_*` canvases, in this format, so every template and project makes the same schedules from the kit.
2. **`FMC_Schedule_Folder`:** a shared parameter bound to schedules, for the browser organisation by discipline.
