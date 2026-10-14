# Plan: the asset builder (families, symbols, templates from scratch)

Agreed with the user on 14 October 2026 in the claude.ai Project "REVIT MCP". This plan extends ROADMAP phases 2 and 3
with an engine underneath them. Follow the usual loop: plan each step, wait for a yes, server check → dry run → one
Revit handler → log → pane, and the tester retests on the pilot PC.

## What the user wants

Starting from an empty plugin and no templates, Claude (through the MCP server and the pane) can:

- start a new file from any template: project template (`.rte`), family template (`.rft`), annotation or title block
  template;
- build and edit the content of that file under the kit's rules;
- make **families from family templates**, **its own FMC family templates**, **symbols, tags and title blocks**,
  **Revit project files from templates**, and **the project template itself from scratch**: a clean template with
  units, graphics, parameters bound, families placed and nothing extra.

## Decisions

| # | Decision | Why |
|---|---|---|
| B1 | **Families first**, then symbols, then the seed and the templates | Templates need the families placed in them |
| B2 | **The seed is Revit's most bare template, stripped by the plugin** (not hand-cleaned) | Repeatable on any PC and Revit version; the strip report shows what was removed |
| B3 | **Storage**: recipes as JSON in the kit; registers stay in Excel (see "Storage") | Recipes are nested (geometry, planes, formulas); Excel can't hold them. Registers are lists people edit |
| B4 | **Limits that come only from Formcraft's own rules, not from Revit, are lifted for building.** Claude may attempt any geometry the family API supports, including manufacturer detail when a source is given | The user's call. Kit change request: FAM-039 ("simple geometry only") becomes "Recipes may build any geometry the family API supports; a result over FAM-027's size or with warnings needs a person" |
| B5 | Rules that protect models and people stay: live-model lock, staging-only writes, dry run first, never decide for a professional (rule 5), never save workshared models, sizes from photos are estimates until confirmed (FAM-036) | These are about safety and liability, not modelling scope |

## Architecture

```
recipe (kit JSON) ──► server: schema + rulebook check ──► fmc_doc: ops batch (dry run → real) ──► Revit handler
      ▲                                                                                   │
      └──── Claude writes/edits recipes from a description, photo, datasheet ◄── QA + screenshot + report
```

- **Recipes** say *how to build* an asset. **Specs** (`FMC_Family_Specs.json`) keep saying *what a family must have*
  (parameters by GUID, connectors, keynote). The server checks a recipe against its spec and the rulebooks before any
  build.
- **`fmc_doc`** is the new engine, one tool for every builder:
  - `open`: a background document from an `.rft`, an `.rte`, the seed, or a file in `_Staging` / `_ChainTests` (new
    or staging only; the live-model lock applies);
  - `apply`: a batch of named **ops** in one transaction group: dry run returns the diff (create / update / skip by
    name, never delete except during `strip` on the seed); the real run applies it;
  - `strip`: seed only (see phase B5);
  - `report`, `screenshot` (a view of the open document), `save` (to staging only), `close`.
- **Ops** are a fixed vocabulary, each validated by the server: names checked against the naming rulebook, parameters
  only from the dictionary, values from the kit. `send_code_to_revit` is never part of a build.
- The builders (`fmc_family`, `fmc_symbol`, `fmc_template`) turn a recipe into an ops batch and call `fmc_doc`.
- Every output gets a **build report** beside it: `<name>.build.json` with the recipe hash, kit revision, plugin
  commit, ops applied, warnings and QA result. The same recipe and kit always give the same file.

### Ops vocabulary v1 (families first; extend per phase)

| Group | Ops |
|---|---|
| Family setup | set_category, set_family_params (host, work-plane based, always vertical, shared), add_subcategory |
| Reference | add_ref_plane (name, strength), add_dimension, label_dimension, lock_alignment, add_ref_line |
| Parameters | add_family_param, add_shared_param (dictionary only, by GUID), set_formula, add_type, set_type_value, add_type_catalogue |
| Geometry | extrusion, blend, revolve, sweep, swept_blend, void (each with profile, work plane, constraints), set_material_param, set_visibility (detail levels, views), add_symbolic_line, add_masking_region |
| Nesting | load_nested, place_nested, link_nested_param |
| MEP | add_connector (electrical, pipe, duct, cable tray; system class, flow direction), link_connector_param |
| Annotation | add_label (parameter, text type), add_text, add_filled_region, add_line |
| Project/template (B5+) | set_units, add_line_pattern, add_fill_pattern, set_line_weights, add_text_type, add_dimension_type, set_object_style, add_material, bind_shared_param, add_wall_type / floor / roof / ceiling (layers), load_family, add_view_template, add_filter, add_schedule, add_sheet, set_title_block, set_keynote_file, set_phases, set_revision_numbering, add_export_setup |

## Storage (decision B3)

| What | Where | Edited by | Format |
|---|---|---|---|
| Registers: family register, name tokens, parameters, view templates, filters, sheets | `03_Master_Data\*.xlsx` (as now) | People | Excel; `build_all.py` exports JSON as now |
| Specs (what a family must have) | `03_Master_Data\FMC_Family_Specs.json` (as now) | Generated | JSON |
| **Recipes** (how to build) | `03_Master_Data\Recipes\Families\<Role>\<FamilyName>.recipe.json`, `…\Recipes\FamilyTemplates\`, `…\Recipes\Symbols\`, `…\Recipes\TitleBlocks\`, `…\Recipes\Templates\Base.recipe.json`, `…\Recipes\Templates\<Role>.recipe.json` | Claude, reviewed by a person | JSON, one file per asset |
| Recipe schema | `_build\recipe.schema.json`; `test_kit.py` validates every recipe | Claude Code | JSON Schema |
| Seed | `06_Templates\_Seed\FMC_Seed_v2.2.rte` + `FMC_Seed_v2.2.strip.json` | Built | Revit + report |
| Outputs | `04_Families\_Staging\<Role>\` (families), `04_Families\_FamilyTemplates\_Staging\` (`.rft`), `06_Templates\_Staging\` (`.rte`) + `.build.json` beside each | Built | Revit + report |

Recipes reference register keys (category token, parameter names, text type names); they never copy values, so a
kit change flows into every rebuild (rule 7). **Recommendation:** put the kit under git (a private
`formcraft/formcraft-kit` repo) so recipes get history, review and rollback; the claude.ai Project keeps a reading copy.

## Phases

| Phase | What | Done when |
|---|---|---|
| **B0 Baseline** | Run today's `fmc_family` on the kit's `pilot_set` (6 families): plan → build dry run → build → load_test in `_ChainTests` (EXECUTION.md "pilot run", never run yet) | Tester reports per family: built, connectors and parameters against the spec, warnings. The gaps feed B1 and B2 |
| **B1 Engine** | `fmc_doc` (open, apply with dry-run diff, report, screenshot, save, close) and the family ops group | Open an `.rft`, apply 20+ ops, dry run matches the real run, a second run changes nothing, saved to staging with a build report |
| **B2 Family recipes v1** | `recipe.schema.json`; builder `fmc_family build` from recipes; load test (place, flex every type, schedule, tag, NWC/IFC export) | The 6 pilot families rebuilt from recipes, flexing with no errors, family rulebook passing; one complex family (manufacturer detail from a datasheet) to prove B4 |
| **B3 FMC family templates** | Build FMC `.rft` files from Revit's metric `.rft`: Generic Model, face-based Electrical Fixture, Lighting Fixture, Plumbing Fixture, Mechanical Equipment, Door, Window… with reference planes, subcategories, FMC parameters and type naming ready | Recipes from B2 rebuilt on FMC `.rft`s with fewer ops and the same result |
| **B4 Symbols, tags, title blocks, detail items** | Recipes for `FMC_SYM_*`, `FMC_TAG_*`, `FMC_GA_*`, `FMC_TB_*` (STD 3.1 layout, vector logos from `11_Brand`), `FMC_DI_*` | Tags label kit parameters with kit text types; the A1 title block matches STD 3.1 |
| **B5 Seed + Base template** | `fmc_doc strip` on Revit's most bare metric template (removes loadable families, views except one plan, sheets, schedules, view templates, filters, unused materials and styles; keeps what Revit can't delete) → seed. Then `Base.recipe.json` in layers: units → graphics → materials → parameters bound → object styles → system types → families placed (B2–B4) → tags → view templates and filters → schedules → title blocks and sheets → phases, revisions, keynotes, export setups → QA | `FMC_Base_Template_v2.2.rte` in staging; Templates rulebook passing except items the API can't set (listed); a second build changes nothing |
| **B6 Discipline templates and projects** | `<Role>.recipe.json` = Base + additions; `fmc_project` uses the FMC templates (closes the selftest's ".rte" warning and F-019) | A test project started from FMC templates passes the WIP → Shared gate except model content |
| **B7 Claude authoring** | Description, photo or datasheet → recipe draft (sizes marked estimate until confirmed); batch project families under D4 naming; review loop (screenshot + QA → proposed fix as a new dry run) | Five families made from descriptions, built and load-tested without hand edits |

## Revit API limits to confirm in B1 (technical, not rule-based)

Each is tried first; only a confirmed API limit becomes a manual step recorded in the strip or build report.

- Browser organisation: the API reads it; creating or editing one may not be possible.
- Worksets: project templates can't be workshared; worksets are made at project start in a workshared model by a
  person (rule 6 also applies).
- Some export setup details (IFC configuration) go through the IFC add-in's own API.
- Some built-in elements can't be deleted from the seed (the API refuses); they're listed, not forced.

## What the tester will check per phase

The tester (Claude in the claude.ai Project) runs `fmc_selftest`, then each phase's "Done when" in Revit on new or
staging files only, closes Revit with "Don't save" when needed (the user opens it), and files findings as issues.

## Lessons from the first hand-built title block (14 Oct, `FMC_TB_A1_Cover`)

Built by the tester through `send_code_to_revit` on the user's own cover sheet (design kept); see
`04_Families\_Staging\Z\FMC_TB_A1_Cover.labels.md`. Carry these into B1/B4:

- **SVG → filled regions works.** The `11_Brand` lockup (31 paths, cubic Béziers flattened to 8 segments each) became
  74 filled regions with letter holes intact, at 295 × 64 mm and 74 × 16 mm, turned 90° where needed. Make it an op:
  `add_svg(file, box, rotation, colour)`. Merge points closer than `Application.ShortCurveTolerance` (~0.8 mm)
  in Revit, not before: pre-simplifying clipped glyph corners.
- **Minimum size:** glyphs under ~1.5 mm can't be drawn (the 1.3 mm tagline on small logos was dropped). The op should
  drop or swap to text below a threshold and say so.
- **Solid fills in families must be masking** (`IsMasking = true`), else Revit throws. Use invisible boundary lines.
- **Labels can't be created through the API.** Builders draw captions and produce a label map (typed placeholder →
  parameter, size); a person converts them. **Workaround found (14 Oct):** `ElementTransformUtils.CopyElements` copies an
  existing label between family documents, shared parameter included. A seed-label library (one label per parameter, made once
  by hand, since a label's parameter can't be changed by API) then lets `add_label` copy, resize and place instead of
  asking a person. 37 tags and heads were finished this way and by the label
  dialog; see `scripts/kitbuild/annotation/README.md`.
- **Visibility** of filled regions can be tied to Yes/No family parameters (`IS_VISIBLE_PARAM`): 67 logo shapes follow
  `FMC_TB_Brand_Main`.
- **Shared parameters by GUID:** switch `SharedParametersFilename` to the kit file, add, then restore.
- Save to staging first (SaveAs), so the user's original stays untouched.
