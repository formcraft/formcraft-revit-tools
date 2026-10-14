# Plan B1: the `fmc_doc` engine and the family ops (asset builder, phase B1)

Part of `docs/PLAN_ASSET_BUILDER.md`. **Waiting for a yes before coding.** B0 (today's `fmc_family` on the pilot set in
Revit) is the tester's run and feeds the gaps below; B1 can start in parallel because it doesn't change `fmc_family`.

## Goal

One engine every builder uses: open a document in the background, apply a batch of named operations ("ops") with a
dry run that shows exactly what would change, report, screenshot, save to staging, close. B1 ships the engine and the
**family** ops. Done when (from the plan): open an `.rft`, apply 20+ ops, the dry run matches the real run, a second
run changes nothing, saved to staging with a build report.

## How it works

```
Claude / builder ── ops (JSON) ──► server: fmc_doc ──► validate every op ──► commandset: fmc_doc_* ──► Revit
                                     (zod + naming rulebook +                (one TransactionGroup;
                                      dictionary + guard paths)               dry run = roll back)
```

**Sessions.** `open` returns a session id. The commandset keeps the open background documents in a table (id → document,
source, opened at); they never show in Revit's window. A session is only:
- a new document from an `.rft` in `template_roots` (or, from B3, an FMC `.rft` in `04_Families\_FamilyTemplates`);
- or a file in `_Staging` / `_ChainTests` (the live-model lock's library roots).
Never a project model, never a workshared model. `close` discards unsaved changes; idle sessions close after 30 minutes.

**Apply and the dry run.** `apply` takes an ordered list of ops. Each op has a `name` (the thing it makes: a reference
plane, parameter, type, solid, connector…), so it is idempotent:

| Before the op | Dry run says | Real run does |
|---|---|---|
| Nothing by that name | create | creates it |
| Same name, different values | update (old → new) | updates it |
| Same name, same values | skip | nothing |

The dry run runs every op inside a `TransactionGroup` and rolls it back, so the diff is what Revit actually did (not a
guess), including Revit's warnings. The real run commits the same group. Deleting is never an op (B5's `strip` is the
only exception, seed only). A failed op stops the batch and rolls everything back; the reply names the op and Revit's
message.

**Validation (server, before Revit).** Every op has a schema. On top: names follow the naming rulebook (the kit's rules,
rule 7), shared parameters only from `FMC_SharedParameters.txt` by GUID, materials and text types only from the kit,
save targets inside the write roots (staging), sizes in mm. Refusals name the op.

**Reports.** `report` gives the document's state (category, parameters, types, solids, connectors, warnings). `save`
writes the family to staging and `<name>.build.json` beside it: the ops' hash, kit revision, plugin commit, ops applied,
warnings. The same ops on the same kit give the same file.

**Screenshot.** A PNG of a 3D and a front view of the open family, to the reports folder, so Claude and the tester can
see the result.

## Ops in B1 (families)

| Group | Ops |
|---|---|
| Family setup | `set_category`, `set_family_params` (work-plane based, always vertical, shared, room calculation point) |
| Reference | `add_ref_plane` (name, is_reference strength, through two points on a view), `add_dimension` + `label_dimension` (between named planes, labelled with a family parameter), `lock_alignment` |
| Parameters | `add_family_param` (type or instance, group, data type), `add_shared_param` (dictionary only, by GUID), `set_formula`, `add_type`, `set_type_value` |
| Geometry | `extrusion` and `void_extrusion` (rectangle or polyline profile on a named plane, start/end, each edge locked to named planes), `set_material_param`, `set_visibility` (detail levels, plan/front/side) |
| MEP | `add_connector` (electrical, pipe, duct; system class, flow direction, on a named face or plane), `link_connector_param` (today's `fmc_family` code moves here unchanged) |

Blend, revolve, sweep, nesting, symbolic lines and annotation ops come in B2–B4, as the recipes need them.

## Steps (one PR each, tests in CI, tester retests on the pilot PC)

1. **B1a Sessions:** `fmc_doc open / report / screenshot / save / close`, the session table, guard checks, the build
   report. Test: open the metric Generic Model `.rft`, report, save to `_ChainTests`, close.
2. **B1b Apply engine + setup, reference and parameter ops:** the op schema, idempotent create/update/skip, the dry run
   by rollback. Test: a 12-op batch, dry run diff equals the real run, a second run is all skip.
3. **B1c Geometry ops:** extrusion and void locked to planes, material parameter, visibility; flex check (change every
   dimension parameter, the solid follows).
4. **B1d MEP ops + the acceptance batch:** connectors from today's builder; a 20+ op batch for one pilot family (the
   instant water heater: a P-owned product with pipe and electrical connectors) built, flexed and saved with its
   report.

`fmc_family build` keeps working untouched; in B2 it turns recipes into `fmc_doc` ops.

## Risks to check early (Revit API, not rules)

- Labelling a dimension needs references on reference planes and a view; tried in B1b, before geometry depends on it.
- Locking extrusion edges to planes uses `NewAlignment` between face references and plane references; tried in B1c.
- Background family documents can't use the UI's active view; screenshots use `ImageExportOptions` on the document's own
  views.

## One question for you

None blocking. If you prefer, B1 can also re-plumb `fmc_family build` onto `fmc_doc` right away instead of in B2; I'd
keep it for B2 so today's builder stays the baseline that B0 measures.
