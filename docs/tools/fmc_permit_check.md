# fmc_permit_check

Permit pre-check of a Revit model against the Uganda building permit rules held in the standards bank: the Building
Control Act and Regulations (NBRB), the 2026 amendment, the National Building Code and the planning guidelines.

**Read-only.** No transaction; nothing is applied, saved or synced; nothing is submitted to BIMS. The report is a
DRAFT for the responsible registered professional, not a determination of the Building Committee or NBRB.

Tracker: F128. Status: Phase A (TypeScript only, installed read commands). Phase B (`fmc_permit_facts` add-in read for
ceilings, windows, doors and stair geometry) is not started.

## Actions

| action | Revit | What it does |
|---|---|---|
| `rules` | no | Lists the rule table and the interim defaults. |
| `check` | yes | Reads the model, evaluates every rule, writes a run JSON and a markdown report. |
| `report` | no | Renders a saved run by name (`permit-...`). Only names inside the report folder are accepted. |

`check` needs `document` (title or full path). A missing name is `FMC-DOC-REQUIRED`; the active document is never used.

Optional: `use` (residential, commercial, public_assembly, education, healthcare ...), `category` (the A/B/C you expect),
`ground_level`, `plot { area_m2, zone }` (zone A-E residential density, or `commercial`), `standards_dir`, `sample_limit`.

## Reads

All three are in `READ_VIA_SEND_COMMAND`; each call passes `document` explicitly.

- `fmc_struct_facts` – levels, floors, roofs, rooms, stairs.
- `fmc_sheets_layout` with `action: "park", sheets: []` – every sheet and the views placed on it. Heavy: the payload lists every view for each sheet.
- `fmc_sheets_layout` with `action: "pack", sheet: <first sheet>` – every viewport with its scale.
- `fmc_model_check` with `checks: ["rooms"]` – rooms not placed or not enclosed.

A failed sheets or room read gives NOT_CHECKED for those rules and a note; a refused `fmc_struct_facts` refuses the run.

## Data

Thresholds come only from `FMC_Standards_Building.json` (and caveats from `FMC_Standards_Sources.json`) in the standards
folder: `standards_dir`, else env `FMC_PERMIT_STANDARDS_DIR`, else `C:\Users\USER\agent-tools\standards\kit`.
A missing key gives NOT_CHECKED and a data-gap line. The guard config and the project review checklists are not read.
Runs go to env `FMC_PERMIT_DIR`, else `%LOCALAPPDATA%\Formcraft\permit`.

## States

FAIL, REVIEW, PASS ("no exception found on model data"), NOT_CHECKED, NOT_APPLICABLE, ADVICE (Formcraft typical sizes, not law), INFO.

## Interim defaults (server/src/fmc/permit/defaults.ts)

| Question | Default | Change with |
|---|---|---|
| Q1 proposed bank values | may produce FAIL, with a caveat | `FMC_PERMIT_PROPOSED_MAY_FAIL=0` holds them at REVIEW |
| Q2 demo model | none; unit fixtures only | – |
| Q3 stairs | REVIEW | `FMC_PERMIT_STAIRS_STATE` |
| Q10 boundary | REVIEW at exactly 30 m2 and exactly 12 m | `FMC_PERMIT_BOUNDARY_REVIEW=0` |

## Known limits

- View kind (site, layout, section/elevation) is read from view names.
- Room use is read from room names with Formcraft's word list (`roomuse.ts`), an assumption.
- The use-to-category-A mapping (`CATEGORY_A_USES`) is an assumption.
- The kitchen small-dwelling allowance exists only in a bank note, so a small kitchen is REVIEW, not FAIL.
- The project standards override is not read.
- No live Revit check yet.
