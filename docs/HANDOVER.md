# fmc_handover: handover package at each milestone

Source: L011-F24 (Pursuits Feasibility, tools row 15, NBRB and DITACO), build plan item 66 / G034, Manual Part 15.5
("model, parameters, reports, manifest"). COBie 2.4 and the IDS check come later (item 41 / G009).

## What it does
One zip per milestone, named `<Model>_<Milestone>_Handover_<yyyyMMdd-HHmm>.zip`:

| entry | what |
|---|---|
| `parameters/elements.csv` | one row per element of the kit categories: id, unique id, category, family, type, level and the kit parameters (instance value, else type value) |
| `parameters/project_info.csv` | every Project Information parameter |
| `reports/parameter_completeness.csv` | per category and parameter: elements, filled, missing, percent; required values flagged |
| `reports/<file>` | each file named in `report_files` (QA, health, clash reports, PDFs); model files are refused |
| `model/<file>.rvt` | only with `include_model: true`: the last saved file, copied byte for byte (stored, streamed) |
| `manifest.json` | schema `fmc.handover/1`: milestone, build, document, spec, counts, gaps, every file with size and SHA-256, COBie/IDS "later" |

## Safety
- Read-only against the model: `fmc_handover_read` has no transaction, saves nothing, syncs nothing (READ_VIA_SEND_COMMAND).
- The only write is the zip (written as `.partial`, renamed when complete, never overwriting).
- `output_folder` must be absolute and inside `write_roots` or `reports_dir`; never 02_Shared, 03_Published, 04_Archive,
  05_Incoming, the family library or a protected original. Default: `reports_dir\Handover`.
- `dry_run` defaults to true and writes nothing. The write needs the dry run's `plan_id`; if the model data, the report
  files, the model file or the request changed, the write is refused (FMC-HANDOVER-PLAN).
- `include_model` refuses workshared/central, cloud, unsaved-to-disk and HEBERT HOSTELS models. For a workshared model the
  person detaches and saves a handover copy in Revit, opens it and runs the tool on the copy.
- Status: PROVISIONAL (sample spec), GAPS (required values missing, read cut short or empty) or READY. `can_pass` is true
  only for READY on a kit spec; the person marks the milestone.

## Kit file
`03_Master_Data/FMC_Handover.json` (sample: `server/data/FMC_Handover.json`, PROVISIONAL): `categories` (OST_ names),
`parameters`, `required` (`"*"` plus per category), `project_info` (values that must not be empty), `milestones`.
