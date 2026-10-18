# Family recipes · fmc-recipe/0.1

A recipe is a family's build as data. It names the template, lists the `fmc_doc` operations in order, and says where
each value came from. The B1 water-heater batch (`tests/doc/FMC_P_MechEq_WaterHeater_Instant.ops.json`) is already a
recipe; version 0.1 adds value sources and code checks.

```json
{
  "schema": "fmc-recipe/0.1",
  "family": "FMC_A_Door_SteelFanlight",
  "template": "Metric Door.rft",
  "ops": [ { "op": "set_category", "name": "OST_Doors" }, "…" ],
  "values": {
    "Steel gauge": { "value": "18", "source_status": "verified", "source": "supplier datasheet, Oct 2026" },
    "Fanlight height": { "value": 450, "source_status": "assumed" }
  },
  "checks": { "clear_opening_min_mm": 900, "clear_opening_param": "Width" }
}
```

| `source_status` | Means | Gate A |
|---|---|---|
| `verified` | From a datasheet, a measurement or the supplier | Pass |
| `EA` | East African practice, not confirmed for this country | Pass, with a note |
| `assumed` | A reasonable stand-in | Warn: the reviewer accepts it or sends it back |
| `pending` | Not known yet | **Fail**: it can't be released |

## LOD 400 ops (Family Authoring Standard 1–3)

| Op | Makes | Standard |
|---|---|---|
| `add_subcategory` | An object subcategory with projection and cut line weights, colour and material | 3.3: Frame, Panel, Glass, Opening, Plan Swing, Elevation Swing, Hidden Lines, Clearance |
| `set_subcategory` | Puts a solid or a line set on a subcategory | 3.3: every element on a named subcategory |
| `sweep`, `void_sweep` | A swept solid or void along a path locked to named planes (`path_planes`, plan, front or right), from points or a loaded `FMC_Profile_*`. A fixed `path` of points still works but follows nothing, and no recipe in `tests/recipes` may use it | 3.1: frames, profiles, rebates that cut correctly in section; 1.4: locked to planes |
| `revolution`, `blend` | Turned parts (roses, knobs, nozzles) and tapered parts | 2: G4 Fine geometry |
| `symbolic_lines` | Lines or an arc in plan, front or right, per detail level, on a subcategory | 3.2: swing arcs in plan, opening lines in elevation |
| `lock_face` | Aligns and locks a solid's face to a named plane | 1.4: faces locked to planes |
| `add_eq_dimension` | An EQ dimension across three or more planes | 1.4: symmetry |
| `load_family`, `place_nested` | Loads an `.rfa` by a path relative to the kit's family roots (e.g. `_Profiles\FMC_Profile_Architrave_Contemporary.rfa`) and places it, with parameters associated | 1.7: nested parts; 3.4: detail kit |
| `profile_lines` | A profile family's closed loop (template `Metric Profile.rft`, category Profiles): detail lines and 3-point arcs in the Ref. Level plan, mm, x across and y up | 3.1: the `FMC_Profile_*` families that sweeps load |
| `set_visible_param` | Ties a solid's (or sweep's) Visible to a Yes/No family parameter | One parameter switches which part shows |
| `add_material` | A material from the kit's library (`07_Materials\FMC_Materials.json`) with its class, colour, keynote, description and textures; optionally the value of a Material parameter in every type | Rule 7: kit materials only, never made up |
| `set_default_size` | Makes a type current (made when missing) and sets its Length parameters (Width, Height…) before any plane is drawn | F-026: planes drawn at the recipe's size, not the template's |
| `delete_template_element` | Deletes what the template ships and the recipe replaces (Metric Door.rft's frame, panel and swing lines), matched by kind, category, subcategory or name, never by id | 3.3: one element per job, on its own subcategory |
| `array` | Repeats a solid along x, y or z with the count tied to an Integer parameter (louvre blades, grille bars, joints) | 1.4: counts follow parameters |
| `symbolic_lines`, parametric form | Line ends and arc centres on named planes (locked), the radius labelled with a parameter, sets repeated per leaf and shown by Leaf Count | 3.2: swings and fold symbols that follow Width and Leaf Count |
| `load_family` with `shared: true` | Loads a shared nested family (handles, hinges, locks) from `04_Families\<Role>` (released) or `_Staging`; the load checks it is shared | 1.7: hardware that schedules on its own |

### Sweeps locked to planes (`path_planes`)
The owner's standard for families is "fully parametric, no mistakes", so a trim, surround or swept frame follows
Width, Height and Fanlight Height in every type, never only the first type's size.

```json
{ "op": "sweep", "name": "Surround Contemporary Ext", "path_plane": "front",
  "path_planes": [["Left", "Sill"], ["Left", "Head"], ["Right", "Head"], ["Right", "Sill"]],
  "path_host": "Trim Face Ext", "profile_family": "FMC_Profile_Surround_Contemporary", "profile_type": "70x15", "subcategory": "Frame" }
{ "op": "sweep", "name": "Frame", "path_plane": "front", "profile": [[-20, -50], [20, -50], [20, 50], [-20, 50]],
  "path_planes": [["Left", "Ref. Level"], ["Left", "Head"], ["Right", "Head"], ["Right", "Ref. Level"]],
  "path_offsets": [20, -20, -20], "path_host": "Wall Centre" }
```

- **Corners.** Each corner is where two named reference planes (or a level, such as `Ref. Level`) cross the path plane.
  Neighbouring corners share exactly one plane: the segment between them runs along it. A path whose last corner is
  its first is closed.
- **Locks.** Revit draws the path where the planes are now, then locks each segment to the plane it runs along (an
  alignment) and each open end to its corner's other plane. So the sweep moves when Width, Height or any parameter
  that drives those planes changes. A lock Revit won't make fails the op and names the planes. The sweep is never left
  at fixed coordinates.
- **`path_offsets`** (optional) gives one entry per segment: mm (a locked dimension) or a Length parameter's name (a
  labelled dimension; `-Name` puts it on the other side). Positive is +x off a plane that is vertical in the view and up
  off one that is horizontal. Two segments in a row along the same plane must keep the same offset.
- **`path_host`** (optional) hosts the path sketch on a reference plane parallel to the path plane, such as the wall
  face the trim sits on, so the sweep follows that plane too. Without it the path sits at `at`.
- **Checks.** The server refuses a sweep with both `path` and `path_planes`, or neither; a corner that names one plane
  twice; neighbours that don't share exactly one plane; the wrong number of offsets; and an offset parameter that isn't
  a Length. In `fmc_recipe check` and `build`, every plane must be made earlier in the recipe or be one of the
  template's planes (the table from #134, or the planes read on first open). Anything else is an error, not a note.
- `server/src/fmc/recipes.test.ts` fails if any sweep in `tests/recipes` has a fixed `path`, so a trim that doesn't
  follow the size can't come back.

### Family paths that work on any PC
`load_family` takes a path relative to the kit's family roots, such as `_Profiles\FMC_Profile_Architrave_Greek.rfa`.
The server resolves it on the build PC before Revit sees it. It tries the guard's `family_staging_root`, then its
parent `04_Families`, then each `library_roots` folder, and uses the first that holds the file. When none does, it
uses the staging root and says the file isn't on this PC. So the same recipe builds where the kit is on `Z:` or `D:`.
An absolute path must be inside those roots. If it isn't, the check is an error that names the fix: write it relative
to the family staging root.

### Profiles, switches and kit materials

```json
{ "op": "profile_lines", "name": "Architrave", "start": [0, 0], "subcategory": "Profile",
  "segments": [ { "to": [70, 0] }, { "to": [70, 12] }, { "to": [62, 20], "through": [67.66, 17.66] }, { "to": [0, 20] }, { "to": [0, 0] } ] }
{ "op": "set_visible_param", "name": "Track M7/Visible", "solid": "Track M7", "param": "Show M7" }
{ "op": "add_material", "name": "FMC_Timber_Mvule", "param": "Frame Material" }
```

- **profile_lines.** Each segment runs from the previous point to `to`. A segment with `through` is an arc through
  that point, else it's a straight line. The last `to` must be the start (within 0.01 mm). The server refuses an open
  loop, a segment with no length, an arc whose three points are in a line, and a loop that crosses or touches itself.
  A second run skips a loop that's already there. If the loop is there with another shape, it's left as it is: rename
  the op to draw it again. `tests/doc/FMC_Profile_Sample.ops.json` is a sample.
- **set_visible_param.** Name it `<solid>/Visible`. The parameter must be Yes/No: add it earlier in the batch with
  `add_family_param` (type `YesNo`) and give it a formula. For example, with `FMC_Design_Movement = 7`, one shared
  parameter picks which movement's sweep shows.
- **add_material.** The server looks the name up in the kit's library. A name that isn't there is refused (ask the
  BIM Manager: `fmc_material request`). The server passes the material's fields and each texture's path on this PC to
  Revit. Revit then:
  - makes the material if it's missing, or updates what differs
  - gives it its own appearance, named after the material and copied from a Generic one, with the albedo map as the
    colour bitmap and the bump map, at the kit's real-world size
  - sets the material in every type when `param` names a Material parameter

  A texture file that isn't on disk is left out with a warning, and the material is still made.

Sizes stay `pending` until the supplier visits give them (section 7); a recipe with a pending value builds, but Gate A
holds it in staging. Masking regions and freeform shapes stay hand work (FAM-039).

## Profile slots and design movements
Trims, surrounds, sills, quoins, copings and cornices come in one set per design movement (owner, 15 Oct): 16 elements
× 20 movements = 320 profile families `FMC_Profile_<Element>_<MovementToken>`, planned in the kit's
`03_Master_Data/FMC_Profile_Sets.json` (movement 1 Greek … 17 Contemporary … 20 Tropical / East African).

- **Profile recipes** live in the kit, one per profile: `03_Master_Data/Recipes/Families/_Profiles/*.recipe.json`, written by
  `_build/build_profile_recipes.py`. `Metric Profile.rft`, category Profiles, one type named by size (height × projection,
  mm), the element's keynote (A.ORN, J.TRM, I.MLD, R.FAS; one code for all 20 movements) and the outline as one closed
  `profile_lines` loop (true circular arcs as 3-point arcs, other curves as straight segments, 0.01 mm). The kit test
  checks every loop closes and doesn't cross itself. They build to `04_Families\_Staging\_Profiles\`.
- **A slot in a host family** is one profile element shown in 20 versions. The host carries the kit shared parameter
  `FMC_Design_Movement` (Integer, instance; in the project it follows the global parameter *Design Movement*). For each
  movement n: `load_family` the profile, a Yes/No instance parameter `Show_<Token>` with the formula
  `FMC_Design_Movement = n`, and one `sweep` per trimmed face with `set_visible_param` binding its Visible to
  `Show_<Token>`. Changing one number swaps every trim in the project to the other set.
- **Doors** take `Architrave` on both faces, **windows** `Surround` on the exterior face, along the jambs and head on
  the wall face. Default movement 17 (Contemporary). The sweeps sit on the Frame subcategory with `Trim Material`.
- **The trims are parametric.** Each sweep uses `path_planes` on the family's own planes: Left, Right, the head (`Head`,
  or `Frame Head` in the fanlight doors) and the sill or floor (`Sill`, `Floor`, or `Ref. Level` in the flush door).
  The path is hosted on the face the trim sits on. The timber fanlight door uses `Frame Ext`/`Frame Int`, which Frame
  Depth moves. The others use `Trim Face Ext`/`Trim Face Int`, drawn by the generator and placed from `Wall Centre` by
  the type parameter `Trim Face Offset` (130: a 230 wall plus 15 plaster, assumed). The flush door's swept frame is on
  `path_planes` too: 20 mm inside Left, Right and Head, on Wall Centre. The path locks replace its old face locks.
- **Materials** come from `07_Materials/FMC_Materials.json` with `add_material` (one per material; a second parameter
  with the same material follows the first by formula), and each type gets its `Keynote` and `FMC_Keynote_Code` from
  codes that exist in `FMC_Keynotes.txt`. Choices are recorded in `values` as `assumed`.
- `tests/recipes/_gen/gen_profile_slots.py --kit <kit>` adds all of this to the door and window recipes. It strips
  what it added before, so it can run again. Apart from the flush door's frame sweep, it leaves the base geometry ops as
  they are. It also keeps type 1 and its Width and Height before the first reference plane (size first, F-026), and it
  writes the profiles' `load_family` paths relative (`_Profiles\<family>.rfa`). `gen_windows.py` makes the window bases.

## The flow
0. **From chat, inline (F-057):** `fmc_recipe check` and `build` take the recipe itself as `recipe` (a JSON object)
   instead of `recipe_file`. The server keeps it in `<reports>\Recipes\<family>.recipe.json` and uses it like a file;
   a real build saves it beside the staged family as always, so Gate A finds it. Healthcare pack recipes start in
   `tests/recipes/healthcare/`.
1. **Check:** `fmc_recipe check`, read-only. It validates the operations against the kit's parameter dictionary and
   shows where the family will be staged and released.
2. **Build:** `fmc_recipe build`, a dry run first. It opens the template in the background, applies the operations,
   flexes every type, saves to `04_Families\_Staging\<Role>\` with the recipe beside it, and runs Gate A.
3. **Gate A:** `fmc_recipe gate` checks:
   - the library's checks: name, kit parameters by GUID, keynotes, size and type names. Each type's keynote is read
     from the saved file (`Keynote`, or the kit's keynote code parameter). The kit parameters are checked by GUID
     against the recipe's `add_shared_param` ops and never pass on "0 present". A file that couldn't be inspected
     says why.
   - the category against the register
   - that every type flexes. "Can't make cut-out" means the type is bigger than the template's host wall, so raise
     the host wall.
   - that labelled dimensions keep their planes' sides (F-026): each dimension `add_dimension` labels records which
     side of its first plane the second was drawn on, and flex fails a type where it ended on the other side
   - that solids and sweeps follow the size parameters. Flex moves Width, Height and every labelled parameter whose
     value differs between types (such as Fanlight Height) from its lowest to its highest type value, on one type. A
     one-type family is moved 10% up instead. Flex then compares each named solid's bounding box before and after. From
     the recipe, the gate knows which parameters move each plane: the template's own (Left/Right by Width, Head by
     Height), and labelled dimensions from there. So it knows which solids each parameter governs, through their
     `path_planes`, `rect`, `end_plane` and `lock_face`. Each solid is reported as "follows Width/Height", and the
     gate result lists them all in `follows`. A solid that doesn't move when its governing parameter changes is a
     **Fail**. An add-in too old to report this is **Not checked**.
   - **that it hosts as the register says (F-061).** The register's Host decides. A wall, ceiling or any face host
     needs a face based family (or one hosted on that host); a family on an unhosted template **fails**. For such a
     family Gate A also runs the **host test** (`fmc_family_host_test`). It opens a new project that is never saved,
     places the family on a wall face or the underside of a ceiling the way a click does (face based: the reference
     direction is Up × the face normal, so it lands upright), moves the host (wall 500 mm out, ceiling 300 mm up) and
     checks that the family followed, kept its host, stayed upright and has no connector pointing out of the host into
     the room. Then it closes the project without saving. A Host the register doesn't give, or no answer from Revit,
     is **Not checked** with the reason.
   - code checks, such as a clear opening of at least 900 mm
   - the IFC class
   - the value sources

   Tags, schedules, legends and detail levels need the family placed in the role's chain-test project, so they show as
   **Not checked**, never as passed.
5. **Chain test** (`fmc_legend chain role=<Role>`, F-064 #6): a role's chain-test project made from its template
   (`06_Templates\_Staging\FMC_<Role>_Template_v2.2.rte`). Every staged family of the role is loaded and one instance of
   each type placed on the host the register gives (wall face, ceiling underside, or the level). Each is keynote-tagged
   when the template has a keynote tag. A keynote legend and a type schedule per category (Family and Type, Type Mark,
   Keynote, Count) go on a sheet with the template's title block. Saved to `04_Families\_ChainTests\FMC_ChainTest_<Role>.rvt`
   (an older one goes to `_Archive`). The dry run lists the families, their hosts and those **not in the register**: the
   host comes only from the register, so a family it doesn't list goes on the level. On 18 Oct, 66 of role E's 116 staged
   families weren't in the register: a kit change request.
4. **Release or send back:** in the pane (Families › Quality and release), by a person, with a reviewer and a note. A
   release moves the family to `04_Families\<Role>` and adds a row to `04_Families\FMC_Release_Log.csv`. It needs a
   passed gate and never overwrites a released family. This is never an MCP tool: hard rule 2 keeps tools out of
   `04_Families\<Role>`, and release is a person's act, like a sync.

## Many recipes in one job: `fmc_recipe batch` (F-063)
For a pack, not one family at a time. Give `recipe_files` (recipe files, or files that hold an array of recipes, like the
chat's `batch_<Role>.json`) or a `folder`.
1. **Dry run first** (the default). Every recipe is checked as `fmc_recipe check` checks it. The plan lists what will be
   built, what is skipped and what is invalid with the reason. A family already staged from the same recipe revision
   (a hash of its template and ops) with Gate A passed is skipped, unless `rebuild` is `true` or names it. `max` limits
   how many this run builds.
2. **`dry_run: false`** writes a manifest (`<reports>\Batches\<batch>.json`) and sends one Revit job,
   `fmc_recipe_batch`. For each family it starts from the template, applies the ops (the engine's own runner, one
   transaction group), flexes every type and size parameter, moves an older staged file and its `.recipe.json` /
   `.gate.json` to `<Role>\_Archive` with a time stamp (nothing is deleted), saves to staging with the recipe beside it,
   and closes it. Each family writes one line to `<staging>\_Batch\<batch>.jsonl`: ok or the error, seconds, ops
   created, updated and skipped (with each skipped op and why), flex, and local time with offset. `seconds` stops it
   starting new families after that long; `fmc_job cancel` stops it between families. What was built stays built.
3. While it runs: `fmc_recipe batch_status batch=<batch>` reads the results file, and `fmc_job status` follows the job.
   The job keeps the PC awake, writes heartbeats and keeps its result (BRIDGE.md › Long jobs).
4. **`fmc_recipe batch_gate batch=<batch>`** runs Gate A on what was built, as many families as fit in one call. Run
   it again until nothing is left. Each verdict is added to the results file.

On 18 Oct a dry run over the healthcare pack's batch files planned 577 families to build (374,224 ops), skipped 1 and
found 17 invalid, all for one material missing from the kit's library (a kit change request). A whole pack is a big
manifest: building one discipline's file at a time, or using `max`, keeps each job short enough to follow.

## Big recipes: stepwise builds (F-029)
Revit's bridge reads one request of up to 8 KB. The LOD 400 doors and windows are 23–44 KB of ops, so a build that
sent them all in one `fmc_doc apply` never reached Revit. That is why the Ogala build stopped before op 1.
`fmc_recipe check` now reports the request size (`bridge`). A build that doesn't fit one call is refused before Revit
is touched, and you build it stepwise:

1. `fmc_recipe build` with `stepwise: true` (and `chunk_size`, 20 by default). The build is a dry run first, as
   always. The ops go in chunks that fit the bridge. Each chunk is one TransactionGroup with its own result (created,
   updated, skipped, warnings). In a dry run the chunks go into the unsaved template, which is closed without saving,
   so nothing is written.
2. Each call does the chunks that fit before the AI client's 60-second cut-off, then answers `paused` with
   `ops_done`. Call again with `resume: true` (same `recipe_file`, `dry_run` and `stepwise`) to carry on from the
   last good op. If the template's session has closed in the meantime, resume opens it again and rebuilds the good
   ops first. Resume is refused when ops already built have changed.
3. If Revit is still working on a chunk when the server stops waiting, the answer is `running in Revit` with the op
   it is on. The add-in writes its progress before every op, to `%APPDATA%\Formcraft\Progress\`, and resume picks the
   chunk's result up from there.
4. A failed build (an op error, a chunk with no answer, a failed save) closes the template without saving. It names
   the op in the whole recipe (`failed_at`) and lists the background documents builds left open. `fmc_recipe cleanup`
   lists them as a dry run, and with `dry_run: false` closes them without saving. It never closes a document a person
   opened or that shows in a Revit window (F-023). Other window-less family documents are listed for the person to
   close.

The build records (`<reports>\FMC_Recipe_Builds.json`) and the progress files are this step's own small job record.
They move to the job model (`fmc_job`) when it lands.

Revit's shared parameter file is switched to the kit's only for the length of each call. The person's file is put
back in a `finally`, and the next Formcraft call puts it back if that ever failed (F-037). Every apply reports
`shared_parameter_file.restored`.

## Planting forms
The kit's `_build/build_plant_recipes.py` writes one recipe per planting form to `03_Master_Data/Recipes/Families/L/`,
from `_build/fmc_plants.py` (the Fam_Plants board: 13 forms, 42 Ugandan species, plus 3 species kept from the
register). Each one starts from Metric Planting.rft and uses only the ops above. `tests/recipes/` has two samples:
`FMC_L_Planting_Tree_Sphere` (revolutions) and `FMC_L_Planting_Palm_Feather` (blended fronds).

- **Split (the board's default):** one family per form (sphere, umbrella, tiered, cone and column trees, feather and
  fan palms, clump, paddle, mound and rosette shrubs, hedge, climber), each species a type named size first
  (`12000_MangiferaIndica`). The owner's question on the split is still open (decisions tracker).
- **Coarse:** a box at the type's true size, locked to labelled planes (Height, Crown Diameter, Crown Height, Trunk
  Height, Trunk Diameter, EQ about the centre), so it flexes for any type. Type 1 is set before the first plane (F-026).
- **Medium and Fine:** each species' own primitives at its size. A revolution's profile can't be locked to planes yet,
  so each species has its own solids and plan lines, shown by `Show <Species>` = `Species Index = k`. A type a person
  adds shows the right Coarse box, but the copied type's shapes. Fine adds forks, fronds, fan leaves and the middle tiers.
- **Plan:** symbolic lines per species (the board's symbols at the mature spread) at every detail level. The 3D solids
  are off in plan. Hedge and climber are locked boxes at every level and show their own outline in plan. The hedge is a
  2.6 m module with an instance Length until a line-based version exists.
- **Materials:** the solids use Foliage and Trunk Material. The library has no foliage or bark materials yet, so these
  stay unassigned and are `pending` (kit change request). The hedge uses `FMC_Plant_Hedge_Duranta`, and the climber's
  trellis uses treated pine.
- **Data:** each type gets FMC_Botanical_Name, FMC_Local_Name, FMC_Plant_Spread_mm, one keynote (new L.TRE, L.PLT,
  L.SHR, L.HDG and L.CLM items), IfcExportAs `IfcGeographicElement` and FMC_Geometry_Stage G3. Sizes are the board's
  estimates (`assumed`). FMC_Planting_Size and FMC_Plant_Spacing_mm are left for the landscape designer.
- **Not built yet:** flower dots (they wait for an array op), Growth and Variation (kit parameters) and the hedge's
  rounded top.

## Template planes (F-038)
`fmc_recipe check` doesn't flag planes the template already has. It uses a table of each template's named planes,
and the planes a build read from the template the first time it opened it take over from the table
(`<reports>\FMC_Template_Planes.json`). Metric Door.rft has Left, Right, Center (Left/Right), Center (Front/Back),
Exterior, Interior and Head on Ref. Level. Metric Window.rft adds Sill.

**Which side is exterior:** in Metric Door.rft the plane named **Exterior is at +75 mm Y** and Interior at −75 mm
(the template's 150 mm host wall), so exterior is **+y**, not −y as some recipe notes said. Read the side from the
template's Exterior plane rather than assuming it. The recipes' geometry is unchanged by this note.

## Skeletons, end planes and template planes (F-062)
Ops that make a product model follow its sizes instead of keeping a fixed shape.

- **`skeleton`**: one op for the size frame most families need. It adds the Width, Depth and Height parameters (type),
  sets the default size first (F-026), draws Left/Right and Front/Back planes with labelled dimensions and an equality
  about the centre planes, and a Top plane with a labelled Height from the base (Ref. Level unless `base` names
  another). With `mounting` it adds an instance Mounting Height and a Bottom plane, and Height runs from Bottom to Top.
  Plane names can be changed with `planes`. The server sends the ops it stands for, so `check`, `batch` and Gate A's
  follow check see them. Then a solid sits on it: `rect: ["Left", "Right", "Front", "Back"]`,
  `start_plane: "Bottom"`, `end_plane: "Top"`.
- **`start_plane` / `end_plane`** on an extrusion: the bottom or top goes **onto** the plane and is locked to it. The
  end moves onto the plane first, so a lock no longer fails on a face a fraction of a millimetre off (F-064 #7). The op's
  result says what it snapped. Either may name a **level**, such as the structural column template's Upper Ref. Level,
  so a column follows its top level. A lock that still doesn't take is reported as a warning, as it used to pass silently.
- **`name_template_plane`**: names a template plane that has none ("Reference Plane"), found by the axis it is square to
  and where it is, e.g. `{ "op": "name_template_plane", "name": "Frame Head", "axis": "z", "at_mm": 2100 }` for Metric
  Door.rft's head. Then recipes can dimension and lock to it. Two unnamed planes at that place, or none, is an error
  that lists the planes it saw.

Not yet: a revolution whose axis and radius follow planes. You allowed curved parts to stay fixed and vary by type
(18 Oct), so revolutions keep fixed profiles per type for now.

## What `check` stops before Revit (F-061, F-064)
These rules come from builds that failed overnight on 17–18 Oct. An error stops the build; a warning is passed on.

| Rule | Level | Why |
|---|---|---|
| Two planes closer than 1.5 mm can't be dimensioned | Error | Revit refuses the dimension |
| A solid thinner than 0.78 mm (end − start) | Error | Revit's short-curve tolerance (0.00256 ft): the solid can't be made |
| `lock_face` where no face of the solid lies on the plane | Error; a warning when a labelled dimension drives the plane | Revit locks only a face exactly on the plane. The engine regenerates first, so a dimension-driven plane may have moved onto the face |
| `set_type_value` for a parameter the recipe never adds | Error (with the template known) | Built-ins are fine: Keynote, Description, URL, Default Elevation and the like on every family; Width, Height and Sill Height on the door and window templates |
| One name for two solids (an extrusion and a sweep) | Error | The second op can't find its own solid |
| An outline edge under 0.78 mm | Warning | 88 of the batch's families built with edges like this (rounded door stops) |
| The register's Host needs a hosted template and the recipe's is unhosted | Warning | F-061: a socket on `Metric Generic Model.rft` can't be placed on a wall. Use `… face based.rft`, which hosts on walls and ceilings, linked ones too |

**How they were checked:** against the overnight batch log. Of the 227 families the batch judged, the errors block none
of the 224 that built and catch the one current failure of these kinds (a 0.5 mm diffuser). The other overnight
failures were already fixed in their recipes, so the "catches failures" side rests on few cases.

A build's result also names each **skipped op** and why (`skipped_ops`): "already as asked" when nothing needed
changing, or the engine's reason.

## Recipe ops from the field review (run 9)
The Ogala LOD 400 review found that recipes flexed only in plan. These ops close the gaps it listed (`lock_face`,
`set_visible_param` and `profile_lines` were already there). `tests/doc/FMC_A_Door_RecipeOps_Sample.ops.json` uses all
of them on Metric Door.rft.

```json
{ "op": "set_default_size", "name": "Default size", "type": "1800x2100", "values": { "Width": 1800, "Height": 2100 } }
{ "op": "delete_template_element", "name": "Template frame", "kind": "solid", "subcategory": "Frame/Mullion" }
{ "op": "array", "name": "Grille bars", "solid": "Grille bar", "direction": "z", "count_param": "Bar Count", "spacing_mm": 150, "max": 12 }
{ "op": "symbolic_lines", "name": "Fold swing", "subcategory": "Plan Swing", "repeat": { "count_param": "Leaf Count", "max": 3 },
  "lines": [ { "from": { "planes": ["Leaf {k} Free", "Exterior"] }, "to": { "planes": ["Leaf {k} Free", "Leaf Swing"] } } ],
  "arc": { "center": { "planes": ["Leaf {k} Free", "Exterior"] }, "radius": 600, "radius_param": "Leaf Width", "start_deg": 90, "end_deg": 180 } }
{ "op": "load_family", "name": "FMC_A_Hardware_Lever", "path": "Z:\\00_Standards\\04_Families\\A\\FMC_A_Hardware_Lever.rfa", "shared": true }
```

- **set_default_size** goes first. It sets the current type's lengths, and with `type` it makes that type current
  (and makes it if it's missing). A parameter with a formula, a reporting parameter or one that isn't a Length is
  refused. `fmc_recipe check` warns (a note, not an error) when an `add_ref_plane` comes before `set_default_size` in a
  batch that sizes Width or Height. This is the recipe side of F-026; the add-in still checks every labelled
  dimension's sides after a batch and at flex.
- **delete_template_element** needs a `kind`, a `subcategory` or an `element_name`; a category alone is refused. Kinds:
  `solid`, `void`, `symbolic_line`, `model_line`, `detail_line`, `nested_family`, `opening`, `any`. Reference planes,
  views, levels and the host wall are never matched, and neither is anything an op made. When nothing matches, the op
  skips, so a second run changes nothing. More than `max` matches (10 by default) is refused, with the first five
  named. The dry run lists what would go and the dimensions and locks that go with it. Only the background family
  document being built is changed. Files are never deleted.
- **array** has two modes:
  - `copies` (the default) is the reliable one. It makes `max - 1` copies of the solid, `spacing_mm` apart, named
    `<solid> #2` … `<solid> #max`. Copy k shows when `count_param > k - 1`, through a Yes/No parameter
    `<array> Show k`. If the solid's Visible is already tied to a switch (a design-movement slot), the copies keep it:
    `and(switch, count > k - 1)`. Each copy is locked again to the planes the solid is locked to across the array, so
    copies follow Width like the solid does. The spacing is fixed; let the count follow the size with a formula such
    as `rounddown((Height - 200 mm) / 150 mm)`. Copies above the count are hidden, not deleted.
  - `linear` uses Revit's LinearArray, with the array's count labelled `count_param`. It takes exactly one of
    `spacing_mm`, `spacing_param` (a dimension between members 1 and 2, labelled) or `between: [first, last]` (the
    members spread between two planes, with the last one locked to the second plane). **Not yet confirmed in Revit**:
    if Revit refuses it, the op fails with "use mode copies" and nothing is changed.
- **symbolic_lines** keeps its fixed form (`points`, and an arc with a `[x, y]` centre). The parametric form works like
  this:
  - `lines` takes ends as `[x, y]` or `{planes: [a, b]}`. An end on planes is drawn where the planes cross and locked
    to them. A line whose two ends share a plane is locked to that plane.
  - An arc's `center` can be on planes too, and `radius_param` labels a radial dimension.
  - `show_if` ties the set's Visible to a formula (through `Show <name>`).
  - `repeat` draws the set for each leaf, k = 1..max, named `<name> #k`, with `{k}` in plane names replaced by k. Set
    k shows when `count_param > k - 1`. The recipe makes each leaf's planes and drives them by formula, e.g.
    `Leaf 2 Reach = Leaf Width * 2`.

  The server checks the leaf planes, that a repeat uses `{k}`, and the parameter types. A lock or label that Revit
  refuses is a warning on the op, and the lines stay. Flex shows whether they follow.
- **Shared nested hardware.** `load_family` takes families from the kit's `04_Families` only: released
  (`04_Families\<Role>`) or staged (`_Staging`). With `shared: true` the load checks that the family is shared and
  refuses one that isn't (rebuild it with `set_family_params shared: true`). `place_nested` then places it and
  associates its instance parameters with the host's, the same as for any nested family.

**To confirm in the Revit retest:** LinearArray in a family with its count labelled; aligning symbolic line ends and arc
centres to planes; the radial dimension labelled with a parameter; and whether Revit 2025 shows the Shared flag of a
loaded family (if not, the op says so and the flag is checked by hand). Copies, switches, deletes and the default size
use calls the engine already relies on.

## Photo to family (parts models)

`tests/recipes/tools/fmc_parts.py` turns a `*.product.json` parts model into a recipe and a four-view preview
(3D, front, side, plan). A parts model lists named parts (box, fbox, prism, front, right, cyl, turn) with a kit material
key and an LOD (c/m/f), plus connectors, clearances and sourced values. The compiler adds the kit parameters, one
subcategory and material parameter per material, a Coarse envelope, and the connectors.

**References are generic.** Each family gets a product photo page and an image-search link from `hc_refs.json`, built
from its name and use. No brand is written. `FMC_Manufacturer` and `FMC_Model_Number` are added blank and filled at
review from the owner's own photos. Supplier waits for the kit change request for `FMC_Supplier`. `URL` holds the photo
page; a datasheet, if one was used, is only a source of sizes.

Loop: write the parts model, then run `python3 ../tools/fmc_parts.py X.product.json X.recipe.json` (or
`healthcare/products/make_products.py`). Compare the preview with the photo, adjust, then build with `fmc_recipe`
(stepwise above 8 KB) and run Gate A.

### Type Image and legends

Every product recipe ends with `set_type_image`. It imports a 3D picture of the product (`render_type_image`, 800 px)
into the family as Revit's built-in **Type Image**, for every type. The picture then shows in Type Properties, in
schedules (image field) and in legends next to the legend components (plan, front and side, drawn by Revit from the
family's own geometry). Pictures live in `04_Families\_Staging\<Role>\_Images\`. A second run reloads the picture, so a
better render replaces the old one.

### Owner review before sale

The board's 3D viewer shows every product model with **✓ Pass test / ✗ Needs work** and a note. The tick is saved
with the Inbox decisions as `REV-<family>`. A family is offered for sale only after it passes this review and Gate A.
