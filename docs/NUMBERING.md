# fmc_numbering

Renumbers doors, windows, rooms, sheets, views and grids by rule, using the kit prefix.
A read is `fmc_numbering` (add-in command, no transaction). A write is `fmc_numbering_apply` (one transaction).

## What each category renumbers

| Category | Revit property | Order |
|---|---|---|
| Doors, Windows | Mark | level, then x, then y (or y then x, or current) |
| Rooms | Room Number | level, then x, then y; unplaced and unenclosed rooms are skipped |
| Sheets | Sheet Number | current order, natural (A-2 before A-10) |
| Views | Detail Number of the viewport on its sheet; restarts on every sheet. A view on no sheet is skipped | current detail number, then position |
| Grids | Grid Name. Vertical grids 1, 2, 3 by x. Horizontal grids A, B, C by y (I and O skipped). A grid not parallel to an axis is skipped | position |

## Rules

Per category: `prefix`, `separator`, `start`, `step`, `width`, `order` (`x_then_y`, `y_then_x`, `current`), `level_block`, `alpha_skip`.
`levels` limits doors, windows and rooms to named levels; the numbers on other levels stay and still count for duplicates.
Prefixes may not contain `\ : { } [ ] | ; < > ? ` ~`.

### Defaults (labelled, need confirmation)

The kit and the repo hold no numbering table (CLAUDE.md rule 7: kit data comes from the kit). Until the kit has one these are defaults,
and a kit change request is due:

| Category | prefix | separator | width | start | step | order | notes |
|---|---|---|---|---|---|---|---|
| Doors | D | - | 2 | 1 | 1 | x_then_y | D-01 |
| Windows | W | - | 2 | 1 | 1 | x_then_y | W-01 |
| Rooms | (none) | | 3 | 1 | 1 | x_then_y | 001; `level_block` 100 gives 001, 101, 201 |
| Sheets | A | - | 4 | 1 | 1 | current | A-0001 (pattern `[Role]-[4 digits]` from the rulebook example) |
| Views | (none) | | 0 | 1 | 1 | current | 1, 2, 3 on each sheet |
| Grids | (none) | | 0 | 1 | 1 | position | alpha_skip IO |

## Dry run and write

- `dry_run` defaults to true. The reply has one row per element: `category`, `id`, `label`, `old`, `new`, `status`
  (`rename`, `unchanged`, `skipped`, `error`), and a `code` and `reason` for skipped and error rows. Nothing is changed.
- A resulting number carried by two or more items is `FMC-NUM-DUPLICATE` on every one of them, with a `duplicates` list.
  Duplicates are counted over the numbers after the write, items outside the scope and skipped items included, and ignore case.
  A swap (A-2 and A-1 trade places) is not a duplicate. While any duplicate exists a write is refused and the add-in is not called.
- A write needs `dry_run` false, `batch_lease`, and `references.kit`, `references.standards`, `references.rulebook`.
  It is refused on a central model, HEBERT HOSTELS, a protected path, and by the live-model lock (`saveBlocked`).
- The add-in checks every old value first (a changed value is `FMC-NUM-STALE` and nothing is written), gives every changing room,
  sheet, viewport and grid a temporary name `~FMC<id>`, then its final number, in one transaction. Any failure rolls back everything.
  It never saves and never synchronises.

## Tests

`server/src/fmc/numbering.test.ts`: rule, order, level blocks, alpha labels, skipped rows, swap, duplicates, the dry-run default,
the write gates and the policy sets. Offline, fixture data only. The add-in handler needs a Revit check on a `_Staging` copy.