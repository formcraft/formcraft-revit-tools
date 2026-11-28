# fmc_family_evolve

Evolve an existing family (.rfa) in place (tracker F127): check it against five quality gates, propose the fixes as a dry run, and
make them only on a confirm, as a **new version** with a byte-for-byte backup of the original. The original is never
written by default.

It reuses the asset builder's engine: `fmc_library inspect` (keynotes, shared GUIDs), `fmc_doc open/report/flex/apply/save/close`
(the background family session), and the kit (`FMC_Family_Specs.json`, `FMC_SharedParameters.txt`, `FMC_Keynotes.txt`).
The gate logic is pure (`server/src/fmc/evolve.ts`); the tool (`server/src/tools/fmc_family_evolve.ts`) only gathers facts
and writes files, through an injectable IO so the whole flow is tested offline.

## The gates

| Gate | Pass | Fix a tool makes | Left to a person |
|---|---|---|---|
| naming | `FMC_[Role]_[CategoryToken]_[Description]` (or the kind's rule, or named in the register) | the new version takes `new_name`, or a close suggestion (`A_Door_steel fanlight` → `FMC_A_Door_SteelFanlight`) | a name too far from the rule |
| shared_parameters | every kit parameter the spec (and `required_parameters`) names is in the file **by GUID** | `add_shared_param` for a missing one; `bind_shared_param` for a family parameter of that name | a parameter shared with another GUID (its values would go) |
| reference_planes | no plane is blank or "Reference Plane" | `name_template_plane`: the kit's own names (FAM-008: an unnamed plane at x = 0 is `Center (Left/Right)`, at y = 0 `Center (Front/Back)`), then `plane_names` (axis, at_mm, name) from a person, or `auto_name_planes` (`RP_X+450`, **provisional**: see below) | two unnamed planes at one spot, an angled plane |
| flex | every type regenerates; with `follow`, each size parameter moves and labelled dimensions keep their sides | none (geometry and constraints are never decided by a tool) | every failing type |
| keynote | every type's Keynote is `X.YYY_ZZ` (Warn when the code isn't in the kit's keynote file) | `set_type_value Keynote` from `keynote` (one, or per type), or a near value normalised (`a.dor-01` → `A.DOR_01`) | a type with no keynote and none given |

A gate is never a pass on nothing: no spec and no `required_parameters` is **Not checked** (F-039).

## check (the default; a dry run)

```json
{ "action": "check", "file": "Z:\\00_Standards\\04_Families\\_Staging\\A\\A_Door_SteelFanlight.rfa",
  "plane_names": [{ "axis": "z", "at_mm": 2100, "name": "Head" }], "keynote": "A.DOR_01",
  "follow": [{ "param": "Width", "low_mm": 800, "high_mm": 1200 }] }
```

Answers `gates`, `fixes` (id, gate, summary), `needs_person`, the `ops`, `preview.revit_dry_run` (Revit's own run of the
ops, rolled back: create / update / skip per op), `expected` (each gate now and after the fixes), `versions` (where the
backup and the new version go) and a `token`. The session is closed without saving. The only file written is the
proposal, `<reports_dir>\Evolve\<token>.json`. A file outside the library roots (a released family) is still inspected,
but without a session Revit's dry run, the plane gate and the flex gate are Not checked; apply opens the backup in staging and checks them on the saved version. Copy it into staging and check that copy to see them first.

## apply (the confirm)

```json
{ "action": "apply", "token": "EV-0123456789abcdef", "accept": ["keynote.set", "shared_parameters.bind"] }
```

1. Refused if there is no proposal, it is older than 24 h, the file changed since check (sha256), or `accept` names an
   unknown fix. Then nothing is copied.
2. The original is copied byte for byte to `<folder>\_Evolve\<family>\v001\<family>.rfa` and verified by sha256 (the
   same bytes reuse their backup). A staging file's folder is its own folder; a released family's is
   `<family_staging_root>\<Role>`.
3. The session opens **the backup**, never the original (nor a document the person has open), applies the ops (all or
   nothing), and flexes again. A type that regenerated before and fails now stops it: nothing is saved.
4. Revit saves the new version `vNNN\<name>.rfa` (never over an existing file) with its `.build.json`; the server writes
   `.evolve.json` (ops, gates before and after, diff).
5. The gates run again on the saved version: `diff` (fixed, improved, regressed, same per gate) and `changed` (name,
   parameters added and bound, planes named, keynotes).
6. `original_unchanged` and `backup_verified` are checked by sha256.

`replace_original: true` copies the new version over the original only after both checks pass, only for a file in
staging (library and write roots), not with a new name, and not when the file was open in Revit at check.

## versions

`{ "action": "versions", "file": "…\\FMC_A_Door_SteelFanlight.rfa" }` lists `v001` (the backup) and the versions.

## Rules it keeps

Writes only inside the write roots and never into `02_Shared`, `03_Published`, `04_Archive`, `05_Incoming` or
`04_Families\<Role>` (the new version goes to staging; a person releases it after Gate A). An _Evolve folder is never a staged family: the context index and fmc_changes leave it out. Nothing is deleted. Shared
parameters come only from the kit's dictionary by GUID. No geometry is changed.

## Revit side

- `fmc_doc report` adds `reference_planes_detail`: each plane's name, the axis it is square to and its position (mm),
  as `name_template_plane` finds it (`FmcDocPlanes.Describe`).
- New `fmc_doc apply` op `bind_shared_param { name, guid, instance? }`: `FamilyManager.ReplaceParameter` with the kit's
  definition (the family parameter is renamed aside first, in the same transaction). Already bound is a skip; a
  parameter shared with another GUID is refused.
- `FmcEvolveRules` holds the Revit-free rules; `tests/evolve` tests them offline.

Needs a Revit check: the ops and the save were tested with Revit mocked.

## Reference plane names: what the kit defines

Searched 28 Nov (repo docs and data, and `D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2` rulebooks, manual, notes and master data, read only). The kit has a **fixed vocabulary**, not a positional scheme:

- Rulebook `FAM-008` (STD 4.1, warning, auto-fix): "Name the planes Center (Left/Right), Front and Back, and mark them Strong."
- `docs/FAMILY_AUTHORING_STANDARD.md` 1.2: Center (Left/Right), Center (Front/Back), Left, Right, Front, Back, Top, Bottom; construction-only planes are *Not a Reference*.

So `fmc_family_evolve` names an unnamed plane square to x at 0 `Center (Left/Right)` and square to y at 0 `Center (Front/Back)` (the origin planes), by default. Left, Right, Front, Back, Top and Bottom depend on the design and are never guessed from a position. Any other unnamed plane has **no kit rule**: `auto_name_planes` gives it `RP_<axis><position mm>` as a **provisional** placeholder (the fix says so in its summary and `provisional` list). The owner should define a real rule, then `positionalPlaneName` is the one place to change. Not done: `FAM-008`'s "mark them Strong" (Is Reference) is not checked or set; the add-in's plane report doesn't carry it yet.

## repoint (after an evolve apply; a dry run by default)

`fmc_family_evolve action:"repoint" file:<the vNNN .rfa>` points the library's records at the new version. The old version stays listed as superseded; nothing is deleted.

- **Library index.** `<staging root>\_Evolve\FMC_Evolve_Index.json` (schema `fmc-evolve-index/1`), one entry list per family. The original is listed first (sha from its backup), every earlier entry is marked `superseded` with `superseded_by` and `superseded_at`, and the new version is `current`. Entries are only ever added. A file at that path that isn't this schema is never overwritten.
- **Staging catalogues.** Any `*catalogue.json` / `*catalog.json` beside the original, in the version's role folder or in the staging root (never inside `_Evolve`). A row for the family (matched by family or name, or by file stem) is repointed to the new file with `version` and `family` added; a copy of the old row stays with `status:"superseded"`. The previous catalogue is saved beside it as `<name>.<token>.bak`.
- **Assumption.** The repo had no writable library index or catalogue format before this, so the index file is this tool's own and the catalogue handling is generic (array, or an object with `families`, `entries`, `rows` or `items`). If the firm keeps a catalogue in another shape the dry run shows `none` for it and nothing is written.
- **Dry run (default)** returns the plan (index change, catalogue changes, `where_used`), a token `RP-<16 hex>` and `apply_needs`, the gate problems that would stop an apply now. It writes nothing.
- **Apply** (`dry_run:false` and the token). The token must match a fresh plan (any change to the files makes it stale). It is also gated by:
  - a **batch lease** (`fmc_batch request`, passed as `batch_lease`) that this session holds and that holds no A-0001 / HEBERT HOSTELS model, and
  - the **AI gate**: the `ai_modeller` config must exist, with the firm-wide switch on and Stop AI off. The existing AI gate (`aigate.ts`) covers project models only, so a library-file check was built on the same config; a missing `ai_modeller` section refuses (conservative).
  
  Every path written goes through `checkWritePath` and must be inside the staging or library roots. The index is verified after writing; each write is logged. The reply says `project_files_written: 0`.

## where_used (read only)

`fmc_family_evolve action:"where_used" file:<the .rfa or a vNNN .rfa> [project_folders:[...]]` lists the local project files known to use the family, and a reload plan for each.

- Reads only the plugin's own JSON/JSONL records under a project's `01_WIP\_Tree`, `_Ceilings\_Placed`, `_Casework` and `_Placed` folders (room records, the recipe tree, placed records). Project folders come from `project_folders` and from the paths of the open documents. A `.rvt` (or any other non-JSON file) is never opened, and no project file is written.
- Each row: project, document, open or not, workshared or not, the evidence (source, file, count) and a `reload_plan`. The plan is always a person's step (open the model, Insert > Load Family from the new file, overwrite parameter values if the model is workshared, then synchronise); this tool never opens, loads or syncs.
- A-0001 and HEBERT HOSTELS are listed with `listed_only:true` and a single "takes no action" line.
- **Not covered** (also returned as `not_covered`): there is no project-wide family index, so instances placed by hand, or by a tool that left no record, are not seen; a project with no records but a hand-placed use will show nothing. Treat the list as "known uses", not "all uses".