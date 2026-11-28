# fmc_family_evolve

Evolve an existing family (.rfa) in place: check it against five quality gates, propose the fixes as a dry run, and
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
| reference_planes | no plane is blank or "Reference Plane" | `name_template_plane` from `plane_names` (axis, at_mm, name), or `auto_name_planes` (`RP_X+450`) | two unnamed planes at one spot, an angled plane |
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
`04_Families\<Role>` (the new version goes to staging; a person releases it after Gate A). Nothing is deleted. Shared
parameters come only from the kit's dictionary by GUID. No geometry is changed.

## Revit side

- `fmc_doc report` adds `reference_planes_detail`: each plane's name, the axis it is square to and its position (mm),
  as `name_template_plane` finds it (`FmcDocPlanes.Describe`).
- New `fmc_doc apply` op `bind_shared_param { name, guid, instance? }`: `FamilyManager.ReplaceParameter` with the kit's
  definition (the family parameter is renamed aside first, in the same transaction). Already bound is a skip; a
  parameter shared with another GUID is refused.
- `FmcEvolveRules` holds the Revit-free rules; `tests/evolve` tests them offline.

Needs a Revit check: the ops and the save were tested with Revit mocked.
