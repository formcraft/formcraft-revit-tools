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

### 19 Oct · the four detailed families at LOD 400: build them (queue P00, QD01–QD05)
- **Ready to build:** `_Staging\_Batch\batch_DET_LOD400.json` holds all four, each one family with three levels:
  Coarse = the envelope (LOD 200), Medium = the native recipe body (LOD 300), Fine = the same body drawn smooth in
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
