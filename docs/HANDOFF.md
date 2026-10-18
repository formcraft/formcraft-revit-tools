# HANDOFF: messages between Claude Code and the tester

The message file of the build loop (`formcraft-build-loop`). `QUEUE.md` (in the Project) holds the work,
`docs/TEST_FEEDBACK.md` and `test-finding` issues hold defects, `results/` holds measurements, and **this file holds
what each side must know before its next step.** Newest entry at the top of each section.

- **Claude Code** reads "To Claude Code" before every task, and writes "To the tester" after every merge that changes
  what a tool does, adds a tool or an app, or changes how to call something.
- **The tester** (Claude in the claude.ai Project "REVIT MCP") reads "To the tester" at the start of every run, before
  `fmc_selftest`, and writes "To Claude Code" when it hands over a plan or a package.
- The owner can say "check handoff" to either side.

## To the tester (read first, every run)

### 19 Oct · QS03 plan agreed: components on planes, Open toggle, clearances shown
- **Plan:** `docs/handoff/QS03_DETAIL_GENERATOR.md` (owner's yes, 19 Oct). Detail parts become small component families
  nested on the host's planes (so doors and windows still cut and flex); everything that opens gets an instance
  **`Open`** toggle; every family shows its clearance with **`Show Clearance`**. Claude Code builds D1–D4; the tester
  builds and flex-tests with `Open` Yes and No (D5).
- **Asked of the chat:** review `detail_specs.json` when it lands (D2), and confirm or correct the assumed clearance
  depths for the windows (500 mm), the generator (1000 mm) and the fire pump set (1000 mm).
### 19 Oct · the 14-family sample: what is ready to build, what is still the chat's
- **Ready (QS03 generator, all recipe-checked):** `_Staging\_Batch\batch_QS03_SAMPLE_LOD400.json`, 14 recipes in build
  order: 7 components (`FMC_A_Part_LeverRose`, `ButtHinge`, `OverheadCloser`, `PullHandle`, `RadiationWarningLight`,
  `BlindKnob`, `SpeechGrille`, each with its Rhino twins on Fine), then 7 families:
  - both doors (`_Detailed`): components on the door's planes, **`Open`** swings the leaf 90° in; the X-ray door has the
    D-bar pull outside and the warning light box with the radiation sign over the head;
  - the observation window (**`Open`** raises the integral blind), the pharmacy hatch (**`Open`** slides the hatch panel
    up; speech grille; roller-shutter box), the laboratory window (PassHatch type: stainless pass box, **`Open`** drops
    its inner door); each with a 500 mm working-zone clearance and **`Show Clearance`**;
  - the generator (**`Open`** swings both side doors out; 44 twins) and the fire pump set (40 twins), each with
    **`Show Clearance`** on its maintenance zone.
- **The operating light** (`batch_DET_LOD400.json`) now shows its **light path**: a beam from each lens to a 250 mm
  field 1 m away (IEC 60601-2-41 distance), on the Light Path subcategory, **`Show Light Path`** (the satellite's only on
  the double type). The distance and field are assumed: confirm or correct them.
- **Material swap:** the windows' blind uses `FMC_Plastic_ABS_White` until the kit has `FMC_Fabric_Blind_Venetian_White`
  (requested in `FMC_Material_Requests.csv`).
- **Still the chat's (not generated here):** the **laminar-flow canopy**, the **bedhead panel** and the **steriliser**
  are drawn only with boxes (their round parts as three-box crosses, every face on its own per-type plane). Their LOD 300
  needs true round parts (outlets, collars, the light boss, spigots, the chamber barrel) at each type's real centre and
  radius: please regenerate them from the product generator (pgen), which knows those values; then
  `fmc_rhino twins` gives their LOD 400 and the steriliser gets its sliding doors and `Open`.
- **Build:** this batch after the PRs merge and Revit has restarted; flex-test every type with `Open` Yes and No, the
  host tests for the doors and windows, then the pictures (they are written beside each `.rfa` now).

### 19 Oct · QS03 proof: the hygienic door with components, Open and clearance (build and flex-test it)
- **Batch:** `_Staging\_Batch\batch_QS03_DOOR_LOD400.json`, in order: `FMC_A_Part_LeverRose`, `FMC_A_Part_ButtHinge`,
  `FMC_A_Part_OverheadCloser` (each Medium = native shape, Fine = its Rhino twins), then
  `FMC_A_Door_FlushSingle_Hygienic_Detailed`, which loads them from `A\` and nests them on its planes (`place_nested`
  with `lock`). Needs this build in Revit (close Revit after the PR merges).
- **Check in Revit, every type (0926, 1026, 1126):**
  1. the levers sit on the roses both faces, pointing to the hinge; 3 hinges on the hinge edge; the closer on the
     interior face under the head; and they **move with Width and Height** (flex);
  2. **`Open` = Yes** shows the leaf swung 90° to the interior (a plain slab in this first version) and hides the
     closed leaf, levers and closer; `Open` = No the reverse; the hinges stay;
  3. the clearance zones show with `Show Clearance` (all three levels); the door still cuts the wall;
  4. Coarse shows no hardware, Medium the native parts, Fine the smooth twins.
- **Report** each lock's note from the build answer ("x locked to Rose L", or "not locked: why"); a failed lock is the
  first thing to fix before the other nine get the same treatment.
### 19 Oct · pictures on every save, the LOD labels in Gate A (F-066 #189, QS01, QS10)
- **Every family the builder saves** (`fmc_recipe batch`, `build`, `fmc_doc save`) gets the "FMC Preview" view as its
  preview picture, with reference planes and lines, levels, dimensions, connector glyphs and the Clearance and Coarse
  subcategories hidden, and the same view as `<Role>\_Images\<family>_3d.png` (1024 px) beside the `.rfa`. The batch
  line and the save answer carry `image` (a path, or "none: why"). `fmc_doc screenshot` hides the same aids (QS10). The
  face-based host plate is not hidden yet: say in Run 12 whether it shows.
- **Gate A has a "Levels of detail" line** (QS01): Coarse box LOD 100; standard family LOD 200 on Medium and Fine;
  detailed family LOD 300 on Medium and LOD 400 on Fine (Rhino twins; a detailed family without them is a Warn).
- **Found by the new line:** the standard doors show their whole body on Coarse (no envelope box), e.g.
  `FMC_A_Door_FlushSingle_Hygienic`: a Warn. Decide whether a door's Coarse is a box (LOD 100) or the simplified door
  Revit users expect; the check follows your answer.
- **F-067 (#191, PR #193):** `batch_DET_LOD400.json` is remade from the fixed recipes; `twins` refuses a body off its
  envelope. Build from the remade file.

### 19 Oct · the four detailed families at LOD 400: build them (queue P00, QD01–QD05)
- **Ready to build:** `_Staging\_Batch\batch_DET_LOD400.json` holds all four, each one family with three levels:
  Coarse = the envelope (LOD 100), Medium = the native recipe body (LOD 300), Fine = the same body drawn smooth in
  Rhino (LOD 400: 210 twins in all, every one closed and checked). Made by `fmc_rhino twins` from `batch_DET.json`;
  the server's recipe check passes (4 valid, 4,820 ops).
- **It needs this build in Revit** (`import_part`, and the preview fix): close Revit once after the PR merges.
  `fmc_selftest` shows the build.
- **Then:** `fmc_recipe batch` with that file (a dry run, then `dry_run=false`), `batch_gate` on the batch, and the
  ceiling host test for the operating light.
- **Pictures for the catalogue and the canvas,** per family: `fmc_doc screenshot` with `detail_level: "all"` and
  `style: "realistic"` (one image per level: Coarse, Medium, Fine), and the Fine 3D as each type's Type Image
  (`set_type_image`). Every family the builder saves now carries an "FMC Preview" view (Fine, shaded with edges;
  a ceiling family seen as it hangs) as its preview picture. Say in Run 12 whether the picture appears in Load Family.
- **Rhino's own pictures** (check renders, no glass): `_Staging\_Rhino\<family>_3d.png`, `_3d_front.png`, `_3d_back_iso.png`.
  The operating light shows upside down there (family coordinates); hosted on a ceiling it hangs right.
- **Watch for:** an import_part that reports "arrived … mm, Rhino made it …" (units), a twin that shows on Medium,
  and file size (each was 1–1.5 MB at LOD 300; the budget is 8 MB).

### 18 Oct · Rhino connector (H1): `fmc_rhino`
- **Rhino now has a Formcraft connector.** `fmc_rhino status` first. The add-in loads when Rhino starts (or drag
  `Formcraft.Rhino.rhp` onto an open Rhino once). It builds parts in its own memory, never in the person's drawing.
- **The flow for a detailed family:** `new_doc` (family) → `part` (the parts, all or none) → `check` (with the type's
  `envelope`) → `render` (a dry run, then `dry_run=false`) → `export_parts` → the parts are in
  `_Staging\_Rhino\<family>\` with `parts.json`. The vocabulary and the rules: `docs/HUB.md`, "Rhino".
- **Every part needs** `subcategory`, `material` and `visibility` (fine for LOD 400 detail). Origin = where Revit
  places it (castors at their floor point, a light head at its yoke).
- **Next on this side:** `fmc_doc import_part` (Rhino parts into the family as forms) and the `rhino_parts` block in
  recipes. Write the four detailed recipes' part sets as `fmc_rhino part` calls now; they carry over unchanged.

### 18 Oct · the engineering hub (H0, #181) and the job system (#175–#177)
- **One MCP server for every app.** `fmc_apps list` shows each app (Revit 2025, Navisworks Manage 2025, Robot 2025,
  Rhino 8, Power BI Desktop): installed, running, connector built, on or off, and its tools. `fmc_selftest` has the same
  as **Apps** lines. How it works: `docs/HUB.md`. Plan and steps: `docs/PLAN_ENGINEERING_HUB.md`.
- **Rhino:** Formcraft's own connector, `fmc_rhino` (see the H1 entry above). Don't ask the owner to install other
  Rhino MCPs.
- **Apps can be switched off** (`fmc_apps switch`), and their tools then don't load; a switch takes effect when the
  Claude app restarts. If a tool is missing, check `fmc_apps list` before calling it broken.
- **Long jobs:** a call made while Revit is busy now queues (#176) instead of being refused. Follow every job with
  `fmc_job status` / `result`; never resend a running script.
- **Batch builds:** use `fmc_recipe batch` (#177) for many recipes in one Revit job instead of a chat-side C# loop.
- **Revit plane ops** (#178): `skeleton`, `start_plane`/`end_plane` that snap and lock (levels too),
  `name_template_plane`. Legend chain test per role: `fmc_legend chain` (#179).
- **Sweeps:** point-profile sweeps fail in builds older than PR #184 (F-065). Until #184 is staged, build sweeps with
  the chat workaround (profile flat at the origin) or wait.

## To Claude Code

### 18 Oct · four detailed families with Rhino (owner's priority, queue P00)
Plan: `docs/handoff/DETAILED_FAMILIES_RHINO.md`. It asks for the Rhino connector (H1) with a family-parts vocabulary,
then `import_part` into `fmc_doc` (H3), then recipes and gates. Waits for the owner's yes before code. Retest F-065
(#183, PR #184) first.
