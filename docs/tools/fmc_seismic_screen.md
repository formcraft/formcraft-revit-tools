# fmc_seismic_screen

NBRB seismic screening form and building database (BUILD_PLAN item 60, gap G028, L011-F15: "Digital version of a screening checklist feeding a map and register; demo data only"). For the NBRB building control conference, 9-11 Dec 2026.

It never changes the Revit model. Its only model call is `fmc_struct_facts`, which is read-only and listed in `READ_VIA_SEND_COMMAND`. It writes only its own database and report files. Every write is a dry run unless `dry_run` is `false`.

## Actions

| Action | Writes | What it does |
|---|---|---|
| `form` | no | The blank form: fields by group, the kit's choices for zone, subsoil, importance and structural system, and the checklist. |
| `prefill` | no | A draft record from the open model (or `link`) plus the kit, merged with any `fields` and `checklist` given. Every value is tagged with its source. |
| `save` | yes (dry run first) | Adds a record (`SS-0001`, ...) or updates one (`id`). Updating bumps `version` and appends to `history`. `status` can be `draft`, `submitted` or `archived`. Nothing is deleted. |
| `list` / `get` | no | The register (archived records are hidden unless `include_archived`) or one full record. |
| `report` | yes (dry run first) | With `id`: one building's committee report as `.md` and `.html`. Without `id`: the register as `.md`, `.html`, `.csv` and `.geojson` (the map layer). Existing files are never overwritten. |
| `seed_demo` | yes (dry run first) | Adds three fictional demo buildings (`DEMO-0001` to `DEMO-0003`) for the conference demo. It runs only once per database. |

## Where the files go

- Database: `<project_folder>\01_WIP\_Screening\FMC_Seismic_Screening.json` when `project_folder` is given and that folder is allowed by `write_roots`. Otherwise `<reports_dir>\Screening\FMC_Seismic_Screening.json`. A `database` path can be given; it must be a `.json` file inside `write_roots` or the reports folder.
- Reports: a `Reports` folder next to the database, named `FMC_Seismic_Screening_<id>_<stamp>` or `FMC_Seismic_Register_<stamp>`.
- Nothing is ever written into a model, `02_Shared`, `03_Published`, `04_Archive` or `05_Incoming` (`checkWritePath`).

## Write gate

Every write goes through these checks:

1. `dry_run` defaults to `true`.
2. `checkWritePath`, or the reports folder.
3. Only `.json`, `.md`, `.html`, `.csv` and `.geojson` files.
4. While Stop AI is on (`%APPDATA%\Formcraft\ai_stop`), a call not started from the pane or by a person is refused.
5. One writer at a time, using `<db>.lock`. A lock older than 2 minutes is treated as stale.
6. The write goes to a temp file first, then the file is renamed.
7. A database file that does not parse is refused and left as it is.
8. `expected_revision` refuses the save when the database has changed since that revision.
9. Each write is logged to `FMC_MCP_FileLog.csv`, and the call ledger records the call.

There is no `batch_lease`, because the tool never sends a model write.

## Database schema (`fmc-seismic-screening/1`)

```json
{
  "schema": "fmc-seismic-screening/1", "title": "NBRB seismic screening register",
  "created_at": "...", "updated_at": "...", "revision": 3,
  "records": [{
    "id": "SS-0001", "version": 2, "status": "draft", "demo": false,
    "created_at": "...", "updated_at": "...", "updated_by": "ai",
    "model": { "name": "SAMPLE-FMC-ZZ-ZZ-M3-A-0001", "read_at": "..." },
    "fields": { "height_m": { "value": 7.1, "source": "model", "basis": "highest wall top or roof top, less the ground level's elevation", "unit": "m" } },
    "checklist": { "soft_storey": { "answer": "no", "source": "user" } },
    "seismic": { "applies": "yes", "criteria": [], "Z": 0.8, "C": 0.08, "I": 1.5, "K": 2, "T1_s": 0.43, "Cd": 0.192, "formula": "...", "notes": [], "kit_status": "proposed" },
    "concerns": ["visible_structural_cracks"], "tbc": ["district", "seismic.I"],
    "history": [{ "version": 1, "at": "...", "by": "ai", "changed": ["created"] }]
  }]
}
```

`source` is one of `model` (read from Revit), `user` (entered by the person screening), `derived` or `TBC`. When a person types over a model value, the model's value is kept in `model_value`.

## Form

- **A. Identification** (entered): building name, address, district, latitude and longitude (WGS84), ownership, use, public building (yes/no), year built, permit number.
- **B. Building, from the model**: model name, storeys above ground, basement levels, height, floor area (slabs), room area, plan length, width and aspect ratio, main wall material, masonry or concrete walls over the kit's height limit, structural columns, beams, foundations, structural concrete walls, column materials, and a structural system hint. The hint only names a kit key and is never used for K.
- **C. Seismic inputs** (entered, with choices from the kit): zone (`seismic.zone_factor`), subsoil class (`seismic.subsoil`), importance class (`seismic.importance`), structural system (`seismic.performance_K`).
- **D. Checklist** (yes, no, unknown or n/a, with a note): 13 items, including cracks, soft storey, plan and vertical irregularity, short columns, strong column/weak beam, foundation ties, wall anchorage, parapets, pounding, materials, unapproved alterations and a qualified professional. Each item says which answer counts as a concern.
- **E. Inspector**: screened by, date, outcome (`no_further_action`, `detailed_evaluation` or `urgent_referral`; the inspector chooses), notes, photos.

## Seismic figures

All seismic figures come from the kit's `seismic.*` standards (`FMC_Standards_Building.json`, US 319:2003, UNBS), with the project's `01_WIP\FMC_Project_Standards.json` on top. None of these values are written in code.

- Applicability: each `seismic.applies_to` sentence is parsed for its threshold, for example `height > 5 m`.
- Z, I and K: the kit's number for the chosen key. A key whose kit value is a sentence (for example `kampala`, or `dwellings: "not listed: 1.0 assumed, engineer to confirm"`) gives TBC, and the reply quotes the kit's sentence.
- T1: from the kit's `T1 = 0.06H for RC frames`, used only for frame systems.
- C: the kit's `plateau_C` while T1 is within the plateau for the subsoil class. Past the plateau, C is TBC, because the kit gives no number there.
- `Cd = C·Z·I·K` only when all four factors are numbers. Cd is indicative and for screening only. The kit's values are `proposed` until the BIM Manager approves them, and the report says so.

## Examples

```json
{ "action": "prefill", "project_folder": "Z:\\Projects\\SAMPLE", "fields": { "building_name": "Sample block", "seismic_zone": "zone_2" } }
```

```json
{ "action": "save", "project_folder": "Z:\\Projects\\SAMPLE", "dry_run": false,
  "fields": { "building_name": "Sample block", "gps_lat": 0.3163, "gps_lon": 32.5822, "public_building": "yes", "seismic_zone": "zone_2",
              "subsoil_class": "II", "importance_class": "schools_halls", "structural_system": "frame_with_masonry_infill" },
  "checklist": { "soft_storey": "no", "foundation_ties": { "answer": "unknown", "note": "ground beams not visible" } } }
```

```json
{ "action": "report", "project_folder": "Z:\\Projects\\SAMPLE", "dry_run": false }
```

Use a sample building for the demo, not a client's model, unless the client agrees (L011-F30, safeguard 4).
