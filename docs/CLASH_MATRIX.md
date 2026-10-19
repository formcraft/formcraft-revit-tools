# Clash matrix · fmc-clash-matrix/0.1

`fmc_navis clash_create` makes Navisworks clash tests from a clash matrix: which pairs of disciplines (or selection
sets) are tested, and how. The kit has no clash matrix yet (`08_Navisworks` holds only a README), so this is the
plugin's proposal, raised below as a kit change request. When the kit publishes one, the kit wins (rule 7) and this
page follows it.

```json
{
  "schema": "fmc-clash-matrix/0.1",
  "name": "FMC Clash Matrix",
  "revision": "P01",
  "approved": "2026-10-20",
  "tests": [
    { "id": "S-M", "a": { "role": "S" }, "b": { "role": "M" }, "type": "hard", "tolerance_mm": 10 },
    { "id": "MEP-FP", "a": { "roles": ["M", "P", "E"] }, "b": { "role": "FP" }, "type": "hard", "tolerance_mm": 10 },
    { "id": "CLG-M", "a": { "set": "FMC Coordination/Ceilings" }, "b": { "role": "M" }, "type": "clearance", "tolerance_mm": 50 },
    { "id": "DUP-A", "a": { "role": "A" }, "b": { "role": "A" }, "type": "duplicates", "tolerance_mm": 1 }
  ]
}
```

| Field | Rules |
|---|---|
| `schema` | Exactly `fmc-clash-matrix/0.1`. |
| `name`, `revision` | Needed. They're shown with every run, so a test result can be traced to the matrix revision that made it. `approved` is the date the BIM Manager approved that revision (empty in a draft). |
| `tests[].id` | 1 to 24 letters, digits, dot, dash or underscore, unique in the matrix. The test is named `FMC <id> · <a> vs <b> (<type> <tolerance>)` in Navisworks. The id is what finds it again, so a changed tolerance updates the same test. |
| `a`, `b` | One side each: `role` (one role code, Manual 4.3), `roles` (several), or `set` (a selection or search set in the open document, as `Folder/Sub/Name`, or a name found anywhere). Never both roles and a set. A role side takes every model in the federation whose container name carries that role (Manual 4.1: `…-<Role>-<Number>`). |
| `type` | `hard`, `hard_conservative`, `clearance` or `duplicates` (Navisworks' Hard, Hard (Conservative), Clearance, Duplicates). |
| `tolerance_mm` | 0 to 5000 mm. For `hard`, clashes shallower than this are ignored; for `clearance`, it is the clearance and must be above 0; for `duplicates`, how close counts as the same. Default 0. |
| `note` | Optional, for people. |

A sample is in `tests/navis/FMC_Clash_Matrix_sample.json`; the proposal for the kit is
`docs/kit-proposals/FMC_Clash_Matrix.json`. The server reads the kit's file from `clash_matrix_file` in fmc_guard.json
(default `Z:\00_Standards\08_Navisworks\FMC_Clash_Matrix.json`); `matrix` names another file, for a draft.

## How a run works

- `fmc_navis matrix` checks the matrix and, with a federation open, says which tests it can run (a role no model
  carries is named).
- `clash_create` is a dry run unless `dry_run` is false. It adds a test the document doesn't have and edits one it made
  before (same id) from a copy. It only ever touches tests named `FMC …`: a person's test is never edited, run or
  removed. `remove_stale` removes Formcraft tests the matrix no longer has; nothing else.
- `clash_run` runs the matrix's Formcraft tests (a dry run first). Saving the `.nwf` afterwards is a person's step.
- `back` hands the newest results to Revit: as Mark & Review tickets (through `fmc_review clashes`' own logic, so a
  clash is ticketed once), then as review clouds in the Revit model open now (behind the live-model lock).
- `clash_status` changes a status (Active, Reviewed, Approved, Resolved) and adds a comment only on the results a person
  names, only with their yes: the dry run gives a `plan_hash`; the real run needs `approved_by` (that person, never the
  AI) and the same hash.

## Kit change request: publish a clash matrix

**Status: raised 19 Oct 2026 (hub step H3).** For the BIM Manager, through the kit change process.

1. **`08_Navisworks\FMC_Clash_Matrix.json`** in the schema above, with the firm's pairs, test types and tolerances.
   `docs/kit-proposals/FMC_Clash_Matrix.json` is a starting point: hard tests between structure and every other
   discipline and between the services (10 mm), one inside mechanical (5 mm), MEP against fire protection, a 50 mm
   service clearance over ceilings, 600 mm working space in front of distribution boards, and duplicates in A and S.
   Every value there is a proposal; the BIM Manager sets them.
2. **The selection sets the matrix names** (`FMC Coordination/Ceilings`, `FMC Coordination/Distribution boards`): their
   search rules (category, or an `FMC_` parameter) in the same folder, so the sets can be made the same way in every
   federation.
3. **The federated model's name**: the plugin uses `<Project>-<Originator>-ZZ-ZZ-M3-Z-0001.nwf` in
   `01_WIP\_Navisworks` (role Z for federated). The Manual should confirm the role and type codes and the folder.
4. **Who approves a clash** (status Approved) per discipline pair, so `clash_status` can name the right person in its
   dry run (Manual 10.5 review roles).
