# Kit change request · missing kit files (loader templates) · 28 Nov 2026

**Status: raised 28 Nov 2026, for the BIM Manager (Emlyn), through the existing kit change process.** Drafted on a new branch off cf71214 from the Revit Testing Bot / tool-research kit section (`PROPOSALS_QUEUE.md`) plus the owner's request for KeynoteLegend, TagScale, the library index, K-02 to K-06, K-15 and the `sync_exclude` spelling. Format follows `docs/kit-proposals/KIT_CHANGE_REQUEST_*.md`: a proposal lives here; nothing is written into the live kit (`FMC_Kit_v2.2` or any `03_Master_Data` path on the kit drive), into D: originals, or into `fmc_guard.json`.

**Every value in the proposed JSON is assumed until a professional confirms it.** The loader, once a file exists in the kit, should read the kit copy (rule 7: the kit decides). Until then it reports `kit file missing, see <id>` and does not invent the file.

Machine-readable index: `docs/kit-proposals/kit-change-requests.json`. The loader maps the same ids in `server/src/fmc/kitcrs.ts`.

| ID | Target in the kit (under the kit root) | Proposal in this folder | Tools | What the loader should do once the file exists |
|---|---|---|---|---|
| K-02 | `02_Keynotes\Seeds\FMC_Keynote_Seed.rvt` | (no binary; see below) | `fmc_keynote_place` | Open this seed, copy one already-linked keynote tag per type, close the seed without saving. |
| K-03 | `Details\` and `Details\FMC_Details.json` | `FMC_Details.json` | `fmc_details` | Load the catalogue; do not invent a detail. |
| K-04 | `05_Scripts\library\index.json` | `library-index.json` | `fmc_library` | `list` / `validate` / `run` read this index plus each manifest. |
| K-05 | `06_Templates\` (and `_Staging`) | (layout decision; no file) | `fmc_template`, `fmc_selftest` | After the chosen layout, the self-test `.rte` check should Pass. |
| K-06 | `03_Master_Data\FMC_Schedule_Sets.json` | `FMC_Schedule_Sets.json` | `fmc_schedules` | Make or update schedules from this set (`fmc-schedules/0.1`). |
| K-14 | `03_Master_Data\FMC_KeynoteLegend.json` | `FMC_KeynoteLegend.json` | `fmc_keynote_legend` | Use the kit file; a PROVISIONAL sample must not PASS. |
| CR-TagScale | `03_Master_Data\FMC_TagScale.json` | `FMC_TagScale.json` | `fmc_tags`, `fmc_annotate` | Use the kit table for tag text size vs view scale. |
| K-15 | Bind `FMC_Keynote_Code`, `FMC_Construction_Status`, `FMC_Trade_Package` in the test models / templates; fix `sync_exclude` | `sync_exclude.proposed.json` | `fmc_build`, `fmc_batch` | Measure only when the parameters are bound; keep a single project spelling on the exclude list. |

## K-02 · `FMC_Keynote_Seed.rvt`

**Finding:** not in the kit. The tool already answers `FMC-KEYNOTE-SEED-MISSING`. Source: `docs/KEYNOTE_PLACE.md`, `keynoteplace.ts`.

**Required content (not a file we can ship from this branch):** a real Revit model at `02_Keynotes\Seeds\FMC_Keynote_Seed.rvt` with one *linked* keynote tag of each type the tool clones (`by` = `element`, `material`, `user`). A tag made with `IndependentTag.Create` keeps an empty TagText (`FMC-NO-API-KEYNOTE-LINK`). The seed is opened, copied from, and closed without saving.

**Unresolved:** only Emlyn (or a Revit author they name) can build and place this model in the kit.

## K-03 · `Details\` and `FMC_Details.json`

**Finding:** neither exists. The tool currently returns a pass with `FMC-DETAILS-CATALOGUE`, which hides the gap.

**Proposal:** `docs/kit-proposals/FMC_Details.json` (schema below). The folder should hold the `.rvt` / `.rfa` sources named in the catalogue. The loader must say `kit file missing, see K-03` when the folder or catalogue is absent, and must not invent geometry.

**Unresolved:** which typical details belong in the kit, their ids, view and sheet names.

## K-04 · `05_Scripts\library\index.json`

**Finding:** not present; `fmc_library list` returns `ENOENT`.

**Proposal:** `docs/kit-proposals/library-index.json` — `{ "scripts": [] }` is a valid empty library. Each later script is `{ "id", "manifest" }` plus a manifest (fields in `docs/RUN_FMC_BATCH.md` and `scriptlib.ts`).

**Unresolved:** which scripts, if any, Emlyn wants in the first published index.

## K-05 · project templates (`.rte`) layout

**Finding (corrected):** 53 `.rte` files already exist, all under `06_Templates\_Staging\` (for example `FMC_Base_Template_v2.2.rte`). The self-test "no .rte files" looks only at the top of `06_Templates` (`selftest.ts` `rte-dir`). This is a layout decision, not a missing-build problem.

**Options (Emlyn chooses one):**
1. Promote the built templates out of `_Staging` into `06_Templates\`.
2. Change the self-test (and `fmc_template`) to treat `_Staging` as the template folder.

The loader, until that is decided, Warns when `.rte` files sit only in `_Staging` and points at K-05. It does not move or copy templates into the live kit.

**Unresolved:** which option, and which templates are official (not staging-only).

## K-06 · schedule-set JSON (`fmc-schedules/0.1`)

**Finding:** no kit JSON contains `fmc-schedules/0.1`. The format is already proposed in `docs/SCHEDULES.md`; the kit has not published a set.

**Proposal:** `docs/kit-proposals/FMC_Schedule_Sets.json`. The example schedule is illustrative only. A sample also exists at `tests/schedules/FMC_Schedules_sample.json`.

**Also requested in SCHEDULES.md:** a shared parameter `FMC_Schedule_Folder` bound to schedules, for browser organisation by discipline.

**Unresolved:** the real schedule list, fields, filters and folder names; binding of `FMC_Schedule_Folder`.

## K-14 · `FMC_KeynoteLegend.json`

**Finding:** not in `03_Master_Data`. The tool falls back to `server/data/FMC_KeynoteLegend.json` (status PROVISIONAL, zone inset 30 mm right and bottom), so every legend plan reads PROVISIONAL and can never PASS. Load order: named file or `FMC_KEYNOTE_LEGEND_FILE`, then the kit file, then the build sample (`keynotelegend.ts`).

**Proposal:** `docs/kit-proposals/FMC_KeynoteLegend.json`. The zone, the legend name, and whether to filter by sheet are for Emlyn. A title-block parameter `FMC_Legend_Zone` (text `x,y` in millimetres) or `FMC_Legend_X` / `FMC_Legend_Y` (length, feet) may replace the zone.

**Unresolved:** legend name, inset or parameter-driven point, `filter_by_sheet`, and when status may leave PROVISIONAL.

## CR-TagScale · `FMC_TagScale.json`

**Finding:** requested with this job. There is no K-id in the proposals queue, and no schema in the repo or tool-research under that name (searched 28 Nov 2026). Tag families are `FMC_TAG_[Role]_[Subject]`; view scale vs text size is not in the annotation standard file (itself also missing — K-01, not in this request).

**Proposal:** `docs/kit-proposals/FMC_TagScale.json`, schema `fmc-tag-scale/0.1`, all sizes `null` / assumed. Target `03_Master_Data\FMC_TagScale.json`.

**Unresolved:** every millimetre value, which tag types apply at which scales, and whether this file should live next to (or inside) the annotation standard. Only Emlyn can set those.

## K-15 · Build parameters and `sync_exclude` spelling

**Finding:** `FMC_Keynote_Code`, `FMC_Construction_Status` and `FMC_Trade_Package` are bound in none of the four test models (`params_in_model` all false), so `fmc_build quantities` measures 0 elements and still passes. `fmc_guard.json` `sync_exclude` carries two spellings of one project (HEBERT and HERBERT HOSTELS).

**Proposal:**
1. Bind the three existing kit shared parameters in the official project templates (see K-05) and in the test models used by the Testing Bot. Do not invent new GUIDs; use the kit shared-parameter file.
2. `docs/kit-proposals/sync_exclude.proposed.json` — keep **one** spelling. The standing project name in this repo is `HEBERT HOSTELS` (see CLAUDE.md and the add-in refusals). Confirm and edit the guard file by hand. The loader never writes `fmc_guard.json`.

The loader: if the three parameters are unbound in the open model, quantities does **not** pass (`see K-15`). If `sync_exclude` lists both spellings, self-test Warns with K-15.

**Unresolved:** confirm the official project spelling; which templates and test models should receive the bindings.

## Not included, awaiting approval

These batch 7–9 research items were explicitly left out of this request:

| ID | Item | Why it is listed only |
|---|---|---|
| K-16 | `08_Navisworks\FMC_Clash_Matrix.json` | Not approved for this job. A proposal already exists at `docs/kit-proposals/FMC_Clash_Matrix.json`. |
| K-18 | Casework, ceiling, circuit and calc standards (`FMC_Casework_Standards.json`, `FMC_Ceiling_Standard.json`, `trace.circuit.*`, calc engineer values) | Not approved. |
| K-19 | Conduit tolerances in `FMC_Standards_Building.json` (`trace.near_miss_tolerance`, `trace.connection_tolerance`) | Not approved. Values are marked "Emlyn sets it." |
| K-20 | Test fixtures for conduit, pipe connection and clash | Not approved. |
| P-fmc_calc-02 | Two voltage-drop limits (3/5 % workbook vs 4 % provisional bank) | Not approved. |
| P-fmc_ceiling-02 | `FMC_Ceiling_Standard.json` absent; results rest on a reference example | Not approved (overlaps K-18). |
| Tools 61–65 | Further catalog tools in later batches | Not approved. |

K-01 (annotation standard), K-07–K-13, K-14w and K-17 are also outside this request.

## Loader behaviour (this branch)

`server/src/fmc/kitcrs.ts` is the one list of ids, targets and messages. `fmc_selftest` adds Warn lines for missing CR files (and the `_Staging` `.rte` case, and a double `sync_exclude` spelling). `fmc_library` list, the details catalogue, the keynote legend sample fallback, and `fmc_build quantities` use the same `kit file missing, see <id>` wording instead of a silent pass or a bare `ENOENT`.
