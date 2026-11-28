# fmc_workshare_owners

Who owns or borrows what in the open workshared model, and which planned operations someone else's ownership would block. **Read-only.** It never relinquishes, synchronises, saves or checks anything out, and it never grants an editing request: a person does those in Revit (Rule 6). It sends only two commands to Revit, `fmc_workshare_facts` and `fmc_elem_currency`, and both only read.

There is no `dry_run`: nothing is written.

## What it reports

- **worksets**: each user workset with its owner, `state` (`yours`, `others`, `unowned`), whether it is open, and `can_edit`: `yes` (you own it), `by_borrowing` (nobody owns it, so an edit borrows only the elements it changes) or `no` (someone else owns it).
- **owners**: each person who owns a workset, with the worksets, and how many of the elements you named they hold.
- **elements** (for `element_ids` and the ids inside `planned_ops`): `can_edit` true, false or null, a `basis`, and a `code`:
  - `FMC-ELEM-OWNED-BY-OTHER`: another user has it checked out (`owner` says who).
  - `FMC-ELEM-NOT-CURRENT`: changed or deleted in central since your last reload; a person reloads latest.
  - `FMC-WORKSET-OWNED-BY-OTHER`: its workset is owned by someone else. Needs `element_worksets` (see gaps).
  - none: `owned_by_you`, `will_borrow` (nobody holds it) or `not_workshared`.
  - `can_edit: null`, `basis: unknown`: Revit gave no row for it.
- **planned_ops**: for each operation `verdict` (`clear`, `partly_blocked`, `blocked`, `unknown`, `no_targets`), `would_run_for`, `would_skip` (id, code, owner), `blocked_worksets`, `needs_person` and a `next` line (for example: ask BOB to sync and relinquish, or a person reloads latest).
- **summary**, **editing_requests** (always `granted: false`) and **gaps**.

It uses the same rules as the edit tools, which skip elements held by someone else: `splitCheckout`-style codes from `coordination.ts`, and the op ids found by `namedElementIds`.

## Arguments

```json
{
  "element_ids": [123456, "123457"],
  "planned_ops": [
    { "label": "Move walls", "tool": "modify_elements", "params": { "ids": [123456, 123457] } },
    { "label": "New tags in Interior", "params": { "workset": "A_Interior" } }
  ],
  "element_worksets": { "123456": "A_Interior" }
}
```

An op may carry `params` (ids under `ids`, `element_ids`, `id`, `host`; worksets under `workset`, `workset_name`, `worksets`), or `element_ids` and `worksets` on the op itself. At most 500 element ids are checked per call. Name the document with the usual `document` argument when more than one is open.

## Gaps (what this cannot tell you)

- **Element workset**: `fmc_elem_currency` does not return an element's workset, so an element nobody holds shows `will_borrow` unless you pass `element_worksets`. A free element in a workset owned by someone else is only caught when its workset is named.
- **No model-wide list of borrowed elements**: Revit reports ownership one element at a time, so only the ids you name are checked. A model-wide scan needs a new add-in handler and is not built. (`fmc_central_health` therefore shows borrowed element counts as `null`.)
- **Editing requests**: Revit 2025 has no API to list or grant them.
- **Freshness**: workset owners are as of your last sync or Reload Latest.
- **Older add-in**: if `fmc_elem_currency` is not there, the element rows come back `unknown` and the reply says so; workset ownership is still reported.
