# KISIC gap scripts → plugin features (handoff to Claude Code)

From the tester (Claude in the claude.ai Project, Kisasi Imaging Centre job, 16–19 Oct 2026), for Claude Code.
Owner's request (19 Oct): *"Package all the scripts used to bridge the gap between the plugin and the work, with every
improvement suggested, so the system runs mostly on scripts saved in the plugin or on its server and uses less AI.
This project cost a lot of credits."*

**What you (Claude Code) decide:** where each item below lives (command-set handler, server tool action, kit recipe
op, kit rule, saved add-on run by `fmc_scripts`, CLI), in what order, and what to drop. Plan it in `QUEUE.md` /
this file's "To the tester" section and **wait for the owner's yes before coding** (CLAUDE.md "How work runs").
Touches no open finding; the defects below should be filed as `test-finding` issues by the tester or by you on the
owner's yes.

Everything referenced is in `docs/handoff/kisic_gap_scripts/`:

- `IMPACT_REPORT.md`: **read first**: how much the plugin was used on the job, what it delivered, where it helped and where it got in the way

- `revit/`: the 28 C# bodies sent through `send_code_to_revit` (numbered in build order; `_superseded_*` kept for history)
- `python/`: `make_lod400.py` (staged recipe + Rhino parts → LOD 400 recipe) and `tex4k_gen.py` (procedural 4K albedo/bump textures)
- `data/`: `KISIC_Model_Recipe.json` (the project's positions, rules and layers), `BUILD_LOG.md`, `RECIPE_README.md`, LOD 400 specs, parts and recipes

---

## 1. Why this matters: where the credits went

The job produced a furnished fit-out model, lighting and power design, 3 A0 sheets (E-1001, E-1101, E-1201),
16 kit families, a LOD 400 pendant and 12 texture sets. Almost all of it went through **one tool**,
`send_code_to_revit`; the dedicated tools were used a handful of times.

| Measure (session log, last day of the job) | Value |
|---|---|
| Plugin calls | 78 |
| …of which `send_code_to_revit` | 49 (38 ran, 3 stopped by the owner, 4 undeliverable while Revit was busy or a dialog was open, 4 compile/runtime errors) |
| `fmc_job` polls for long scripts | 13 |
| Computer-use calls (to click one dialog; failed) | 10 |
| PNG check exports staged and read by the AI | 5 (≈10 over the job) |
| C# written by the AI over the job | 27 step scripts, ≈150 KB, most of it written, debugged and re-sent in chat |

**The cost driver:** the AI wrote, re-sent and debugged general-purpose Revit code (finding faces, placing on hosts,
laying out sheets, measuring legends) on every turn, and looked at full-sheet PNGs to check layouts. None of that is
design thinking; it is code the plugin should own. **Target:** the AI writes a short JSON of *design intent*
(what, where, which switch, which circuit), and saved add-ons/tools do the Revit work, return a short summary and
a check image only when asked.

---

## 2. The proposal in one picture

```
design intent (AI or person)        saved, versioned, tested code (no AI)
  project JSON  ───────────────▶  fmc_scripts addon run <name> {params}  ──▶  command-set handler / C# add-on
  (positions, layers, circuits)       │  dry run → yes → real run                   │
                                      └─ CLI: node build/fmc/cli.js fmc_scripts      └─ summary JSON + optional PNG
  nightly / watcher / pane button ───┘  (Task Scheduler, no tokens)                    → results/, FMC_MCP_FileLog.csv
```

Three layers, cheapest first:

1. **Kit data and rules** (no code at all): family visibility rules, light-source data, DB distribution systems,
   socket types per load, colour per circuit, legend seed. Fix once in the kit; every project inherits it.
2. **Saved add-ons** (C# bodies with a header manifest and JSON parameters) that `fmc_scripts` can list, dry-run and
   run, from the server CLI too, so a pane button, a job file or a scheduled task runs them **with zero AI**.
3. **Proper tools/actions** for the add-ons that prove themselves (promote by usage), with server-side checks.

---

## 3. Inventory: every script, the gap it filled, its proposed home

Priority: **P1** = would have saved the most time/credits on this job; **P2** = clear repeat value; **P3** = nice to have.

| File | What it did on KISIC | Gap in the plugin | Proposed home | Prio |
|---|---|---|---|---|
| `01_shell.cs` | Centreline walls from recipe, joins checked (20/20), doors, openings, slabs | No "shell from survey JSON"; no post-commit join QA | `fmc_qa walls` (post-commit joins, free ends, short T-ends) + add-on `shell_from_json` | P2 |
| `02_rooms.cs` | Rooms at points, area check vs recipe | — | add-on `rooms_from_json` (+ area tolerance report) | P3 |
| `03_check_views.cs`, `24_export_png_pdf.cs` | Check views, crop to model, PNG/PDF export | `fmc_doc screenshot` is families-only | **`fmc_view screenshot`** (view/sheet → PNG, cropped, template off, levels hidden) and `fmc_sheets export pdf` | **P1** |
| `03b_ceilings.cs`, `15_flat_ceilings_relight.cs` | Flat board ceilings from room boundaries; re-hang fittings after host changes | Deleting a host orphans face-based fittings silently | add-on `ceiling_from_room` + **`fmc_qa orphans`** (Host==null, floating, re-host on nearest face) | P2 |
| `04_finishes.cs`, `13_materials_finish_pass.cs` | Paint/finish per face, material params on furniture | Kit paints render grey (texture at full fade); families arrive with material "none" | Kit fix (paints = colour) + recipe rule (every material param defaulted) + add-on `paint_faces_by_rule` | P2 |
| `05_furniture.cs`, `09_casework_equipment_placeholders.cs` | Furniture/equipment from recipe frame; casework massing | — | add-on `place_from_json` (family, type, host rule, point, rotation, clearance check vs routes) | P2 |
| `06_lighting.cs`, `12_*`, `18_veranda_switching.cs`, `_superseded_04_strips.cs` | Fittings on ceilings/walls/planes; perimeter wall strips per room at height + corner run; switch groups | No lighting layout helpers; Revit Switch ID read-only | add-ons `lights_on_ceiling` (grid/points), **`strips_on_room_walls`** (room, height, walls, corner run), `rehost_to_face` | P2 |
| `19_fmc_switch_param.cs` | Shared parameter **FMC Switch** bound to fittings, switches, generic models | Switching cannot be recorded without circuits | Kit shared-parameter file + template binding (no code) | **P1 (kit)** |
| `07_devices_mep_equipment.cs`, `17_power_plan.cs` | Sockets by load type (UPS, FCU unswitched, IP66, DP 20 A), DB, AC, heaters; power plan with 37 FMC_SYM_E symbols, colour by circuit, collision-free labels and home-run arcs | No power-plan annotator; no circuit colours | **`fmc_annotate power`** (symbol per device from kit map, label = mark · circuit · height, home runs, colour per circuit from kit JSON) | P2 |
| `14_sld_riser_drafting.cs` | SLD + riser drawn as drafting lines from "circuit Pn" comments, loads summed (strips = W/m × length) | `fmc_diagram` can't draw: kit DB `FMC_E_EQ_DB_Final_TPN` refuses every distribution system → no circuits | **Kit fix DB + `fmc_systems create_circuits`** (reads "circuit Pn"), then `fmc_diagram` from real circuits; keep the drafting fallback as an add-on | **P1** |
| `11_render_materials.cs` | Emissive LED materials (cd/m², K) via AppearanceAssetEditScope | — | **`fmc_material emissive {name, luminance, K}`**; recipe rule: light-emitting parts get an emissive material | P2 |
| `16_family_light_source.cs` | Light source on a staged family: recreate types so light types exist, set lm/K/shape/distribution | No recipe op; enabling Light Source by API makes **0 light types** until a type is created | **Recipe op `set_light_source`** {lm per type, K, shape, distribution, beam/field, symbol length, source offset} | **P1 (recipe)** |
| `22a_hide_boxes_views.cs`, `23_family_hide_boxes.cs` (not run) | Hide Clearance / Coarse Envelope / Connector Pads / Light Source per view; family-level fix + downlight symbol 3048 → 50 mm | Boxes show at Fine in renders, plans and **legends** (legend views ignore view visibility; downlight light-source symbol makes a 10 m extent) | **Kit rule** + `fmc_recipe check` rule (clearance/connector solids 3D-only, envelope Coarse-only, light-source symbol ≤ 100 mm) + `fmc_family fix_visibility` for already-built families | **P1 (kit)** |
| `20a_legends_sheet.cs`, `22b_legend_relayout.cs` | Legend views with **real legend components**: seed copied from the kit template's `LG_Seed_Component`, retyped per type used, best face chosen, rows sized from visible geometry, 2 balanced columns | No API to create legend components; `fmc_legend` is only the kit chain test | **`fmc_legend build {categories, scale, view per category}`** using the seed (copy with a destination-types handler, see §4.3) | P2 |
| `20b_fan_keys.cs` | Ceiling fan + light kit on a reference plane under the motor; **colour-swatch circuit keys** (filled regions per circuit) | Fan family has no light; no key generator | Kit family "fan with light kit" (recipe); **`fmc_annotate key`** (filled-region swatches from the circuit colour JSON) | P2 |
| `20c_east_canopy.cs` | Canopy slab + soffit from a polygon; re-host lights; IP65 edge-glow strip under canopy edges | — | add-on `slab_soffit_from_polygon` (+ re-host) | P3 |
| `21_boq_export.cs` | JSON lines of every electrical item (type, mark, circuit, switch, xyz, strip length, load) + plan notes | No BOQ export | **`fmc_report boq`**: counts by type, strip metres, cable estimate per circuit (DB → chain → drops × waste), rates blank for the QS, kit BOQ format (xlsx) | P2 |
| `python/make_lod400.py`, `data/*lod400*`, `*_parts.json` | Staged recipe + Rhino parts → LOD 400 recipe (native solids Coarse/Medium, Rhino parts Fine) | `fmc_recipe batch` re-injects `size_mm`; padded bounding boxes fail small parts (used `build stepwise`) | Port to `fmc_recipe lod400` + fix the batch size check (true geometry) | P3 |
| `python/tex4k_gen.py` | 12 procedural 4K albedo/bump sets (timber, bark cloth, terrazzo, tiles, bamboo…) | Kit textures low-res | Kit asset job (run once, commit textures to the kit, not to git) | P3 |
| `08_pipework_tank_gullies.cs` | Refrigerant, condensate, cold water, waste pipes; tank/gullies as DirectShapes | No pipework-from-route helper | Out of scope for now; keep as reference | P3 |

---

## 4. Specs for the P1 items

### 4.1 Bridge transaction safety (crashed Revit once)
Evidence: a script opened `new Transaction(...)` without `using`, threw; the bridge returned `FMC-CODE-RUNTIME`
but the transaction stayed open; Revit then hit "Pure Virtual Function Call" → fatal error (journal 19 Oct 02:15).
- Before compile (Roslyn): every `new Transaction(`, `SubTransaction(`, `TransactionGroup(` must be the subject of a
  `using` → else refuse `FMC-CODE-TX-USING`.
- After every run: `document.IsModifiable` still true → roll back if possible, report `FMC-CODE-TX-LEAK`, mark the
  document "needs a person", refuse further scripts on it.
- Helper `FmcScript.Tx(document, name, dryRun, () => {...})`: start → action → rollback-if-dry / commit, rollback on
  exception, `FmcFailures` attached. Add `FmcScript.CopyOptionsUseDestinationTypes()` (§4.3).
- When a call times out: check the Revit pid and the newest journal for "fatal error"; answer "Revit crashed at
  <time> (journal.NNNN)" instead of "fmc_document_info timed out". Same message is used today when Revit is merely
  busy exporting: say "Revit is busy (export/dialog: <id>)".

### 4.2 Saved add-ons run without AI (the owner's main ask)
- **Format:** one `.cs` body per add-on with a header block:
  ```
  // @addon strips_on_room_walls  @version 1.0  @writes model  @dryrun yes
  // @params {"room":"06","height_mm":2850,"inset_mm":30,"walls":"all|N,E,S,W","corner_run_mm":2500,"type":"FMC_E_LightFixture_StripLED:14Wpm_24V_3000K","switch":"L4"}
  // @returns {"placed":n,"skipped":[...],"ids":[...]}
  ```
  `parameters[0]` = the JSON string, `parameters[1]` = `"dry"|"real"`. Always `FmcScript.Tx`; return a short summary.
- **Where:** kit `05_Scripts\Addons\` (versioned with the kit, released through the Manual 17 gate) or the repo
  `resources/addons/` shipped with the server. Your call.
- **`fmc_scripts`:** new actions `addon_list` (reads headers) and `addon_run {name, params, dry_run}` (default dry;
  real run needs the same yes as any write; live-model lock unchanged). Steps can also be add-ons, so an
  automation chains them: `steps: ["addon:qa_orphans", "addon:export_png"]`.
- **CLI:** `node build/fmc/cli.js fmc_scripts` already exists, so add-on runs work from the pane, a job file or Task
  Scheduler with **no AI**. Add a `job` form: a JSON list of `{addon, params}` executed in order, stop at the first
  failure, write `results/<job>_<date>.json`.
- **Project data:** move project specifics into a project JSON (like `data/KISIC_Model_Recipe.json`); add-ons read
  it, never hard-coded coordinates. The KISIC scripts hard-code coordinates; generalising them is the porting work.

### 4.3 Dialogs answered by rule
Evidence: copying the legend seed from the kit template raised **Duplicate Types** (`Dialog_Revit_PasteSimilarSymbolsPaste`);
the script waited ≈5 min twice for the owner; computer use could not click it (Windows kept the desktop frontmost).
- Pass a `CopyPasteOptions` with an `IDuplicateTypeNamesHandler` returning `UseDestinationTypes` in every copy the
  plugin makes; expose it to scripts as `FmcScript.CopyOptionsUseDestinationTypes()` (scripts can't declare classes).
- A short allow-list of dialogs the bridge may auto-answer (Duplicate Types → OK; "Elements have duplicate Mark" →
  OK), logged. **Never** auto-answer crash, recovery, save or sync dialogs (Manual rule).

### 4.4 Distribution boards and circuits
Evidence: `ElectricalSystem.Create` works but `SelectPanel` fails for `FMC_E_EQ_DB_Final_TPN` with every distribution
system (also a 415/240 system set on the instance); the stock 480 V panel works → family fault.
- Kit: fix the DB family's connector/distribution system; add a single-phase 240 V DB type; document connector
  voltage and poles per device family (unbalanced connectors have Apparent Load Phase 1..3: `fmc_recipe check`
  should validate `link_connector_param` against the connector system).
- `fmc_systems create_circuits`: read device Comments `circuit Pn` (or a `FMC Circuit` parameter), create circuits on
  the named panel, report orphans. Then `fmc_diagram` draws the SLD/riser from real circuits and panel schedules work.
- Keep `14_sld_riser_drafting.cs` as the fallback add-on until then.

### 4.5 Family visibility and light sources (kit rules + recipe ops)
- `fmc_recipe check` rules: solids on `Clearance*` and `Connector Pads` → shown in 3D only; `Coarse Envelope` →
  Coarse only; envelopes/clearances must not enclose the light source ("Light source is inside solid geometry").
- Recipe op `set_light_source` (see §3 row 16): creates the light types correctly (recreate-type workaround inside the
  engine), sets lm per type, K, shape, distribution, beam/field, **symbol length ≤ 100 mm**, source offset.
- Recipe rule: every material parameter gets a kit default; light-emitting parts get an emissive material.
- `fmc_family fix_visibility` for families already built (prototype `23_family_hide_boxes.cs`).

### 4.6 Project screenshots and sheet layout (the AI's most expensive habit)
- `fmc_view screenshot {view|sheet, crop: model|sheet, px, hide: [levels, grids, refplanes]}` → PNG path + size.
- `fmc_sheets layout {sheet, items: [{view|schedule|legend, anchor: top-left, at_mm}]}`: reads the title block's
  drawing area, places by outline (viewport outlines need a regenerate after creation; legend extents include
  invisible geometry → measure visible geometry, see `22b`), fills title-block fields (Drawn/Designed = firm;
  Checked/Approved left blank for people).
- A sheet "lint" returning overlaps between viewports, schedules and text, so the AI reads a list, not a picture.

---

## 5. P2/P3 specs (short)
- **`fmc_qa orphans`**: face-hosted instances with `Host == null`, instances floating above/below hosts, duplicates at
  the same point; re-host action (`rehost_to_face`). KISIC had 21 orphans after ceiling/fascia deletion.
- **`fmc_qa routes`**: clear path from entrance to every room door (furniture bounding boxes vs a path width), the
  owner's "nothing in the pathways" rule.
- **`fmc_annotate power` / `key`**: kit map device family → FMC_SYM_E symbol; colour per circuit from
  `03_Master_Data` (new `FMC_Circuit_Colours.json`); label collision avoidance as in `17_power_plan.cs`.
- **`fmc_report boq`**: from `21_boq_export.cs`; cable = Manhattan chain DB → devices + drops (ceiling − height) ×
  waste factor from the kit; xlsx with formulas, rates blank.
- **`fmc_material emissive`**, **paint colour-only fix**, compact `fmc_material` answers (122 k chars today).
- **`fmc_file create_from_template save=false`** (opens an unsaved project; the live-model lock forced Ctrl+N via computer use).
- **`fmc_recipe batch`**: size check from true geometry (padded bounding boxes fail small parts); close the family
  documents a batch opened (open windows broke archiving).
- **`fmc_ceiling`**: non-orthogonal outlines (slanted façade), lumens per fitting from the family.
- **`fmc_casework`**: refusal shows one valid nested example.
- `send_code_to_revit` defaults: add `Autodesk.Revit.DB.Lighting` to the usings (misleading "protection level" error).
- Warnings returned with category + Mark/Comments of each element, not bare ids.

---

## 6. Lessons the add-ons must encode (found the hard way)
1. Never leave a transaction open; always `using` + rollback on error (§4.1).
2. Face-based families: find the face by projecting a probe point onto `HostObjectUtils.GetSideFaces/GetBottomFaces`;
   a horizontal reference plane for under-cabinet lights needs normal −Z (`bubble − free` × `cutVec`).
3. Deleting a host leaves face-based instances in place with `Host == null`: audit after every host change.
4. Revit's `Switch ID` is read-only on fittings → use the shared `FMC Switch` parameter.
5. `FilteredElementCollector(...).OfCategory(c).Cast<FamilyInstance>()` throws on DirectShapes; add `OfClass(FamilyInstance)`.
6. C# script scope: a local in a `foreach` clashes with a lambda parameter of the same name in an enclosing scope (CS0136); generated code should prefix names.
7. Viewport outlines are only valid after `document.Regenerate()`; legend extents include hidden family geometry.
8. Legend components: no create API; copy a seed component and set `LEGEND_COMPONENT` (type) and `LEGEND_COMPONENT_VIEW`
   (−4 ceiling plan, −8 floor plan, −7/−6/−9/−10 elevations front/back/right/left, −3 3D, −5 section).
9. `computer_open_application("Revit 2025")` launched a second Revit once; computer use cannot click dialogs owned by
   Revit when Windows keeps the desktop frontmost. Prefer bridge-side dialog rules.
10. Paint materials with a diffuse image at full fade render dark grey; use colour.

---

## 7. Suggested order (your call)
1. §4.1 transaction safety + `FmcScript.Tx` + copy-options helper (small, prevents crashes).
2. §4.2 add-on format + `fmc_scripts addon_list/addon_run` + CLI job runner; port 3 add-ons first:
   `export_png_pdf` (24), `qa_orphans` (from 15), `strips_on_room_walls` (from 15/18). Measure: a KISIC relight runs
   from a job file with no AI.
3. Kit: DB distribution system, `FMC Switch` shared parameter, visibility rule + `set_light_source` op (kit change
   requests via the tester).
4. `fmc_view screenshot`, `fmc_sheets layout`, `fmc_legend build`.
5. `fmc_annotate power/key`, `fmc_report boq`, `fmc_systems create_circuits` → `fmc_diagram`.

Acceptance for the whole package (honest-testing): re-run the KISIC lighting, power plan, sheets and BOQ from job files
in a fresh unsaved project; count AI calls (target: one call to start the job, one to read the summary) and compare
outputs to the PDFs issued on 19 Oct.

## 8. Safety (unchanged)
Add-ons run only where `send_code_to_revit` may run (live-model lock, D1 toggle). Dry run first. No auto-answer of
crash/recovery/save/sync dialogs. No add-on releases, publishes, signs or saves workshared models. Kit data stays the
only source of values; a missing value is a kit change request.
