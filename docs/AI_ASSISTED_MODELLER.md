# Change request: the AI-assisted modeller

**Status: proposed, 14 October 2026; v2 merges the owner's involvement level (see "Involvement level" below).** A change request against the Master Manual, Part 18, raised through the
continuous improvement loop in Part 18.4:

1. Capture
2. Analyse
3. Propose: this page
4. Test on the pilot
5. Approve: the BIM Manager (technical) and the MD (commercial)
6. Publish
7. Train
8. Check

Nothing in the plugin changes the live-model lock until steps 5 and 6 are done.

## Why

Today the live-model lock lets AI change only families, new unsaved models and files in the library folders. Project
models are modelled by assessed modellers (Part 18). That keeps live projects safe. It also means AI can find clashes,
missing data and broken rules, but a person has to make every fix by hand, even a 50 mm pipe offset.

The AI-assisted modeller is a narrow, supervised permission. AI may make listed, small, reversible changes in a
person's own WIP copy of a model, at an autonomy level the project chooses. Every change is logged, and a person
always syncs.

## What it is, and what it is not

- **It is a tool used by a person, not a team member.** Every AI change belongs to the modeller whose WIP copy it is
  in, and that modeller answers for it like their own work. The AI has no competency level, never signs, never
  approves and never reviews.
- **It works below the Junior Modeller line (18.5).** Junior modellers work under review; the AI works under
  approval, one batch at a time, unless the project chooses "Auto in WIP" for the safest operations.
- **Activity is never used to rank people (Manual 14.5).** The AI log counts operations per model and per kind, never
  per person.

## The General AI switch (owner, 26 Oct 2026)

Users were blocked: `fmc_ai status` said "fmc_guard.json has no valid ai_modeller section", and per-group levels were
too much for users. Now there is one switch, **AI On / AI Off / Stopped**, at the top of the Formcraft pane and as
**AI switch** beside Connect AI on the ribbon.

- **Any user** switches it, **per project** (the project code in the model's name; a name without one stays Off). The
  first use creates the `ai_modeller` section in fmc_guard.json with safe defaults (everything off). Stop AI overrides it.
- **Mode** (`ai_modeller.mode` in fmc_guard.json): **testing** (the pilot, owner 26 Oct) lets AI work in any file, keyed by the FMC project code, else the project folder, else the file name; **strict** (the default, for distribution) needs an FMC-compliant model in a project's 01_WIP. Never central, approvals, limits, Stop AI and the admin-only list apply in both.
- **On:** AI may model in the active WIP model (a person's local copy, never central), every batch waits for one-click
  approve or reject in the pane, and the limits apply (50 per batch, 500 per model a day, off after 3 failed batches).
  Covered, from the kit rulebook's `general` block: data, views, placing elements and fixtures, walls, floors, ceilings
  and roofs (architecture), levels and grids.
- **Admins only, always:** deleting, purging, running arbitrary code, links, workset setup and structural framing.
- **Advanced (admins):** the involvement bands and per-group levels below, in Admin › AI involvement.
- People never see lock errors: one plain line instead ("AI is off. Turn it on with the AI switch.").
- `fmc_selftest` shows "General AI switch: section present / state".

## Who may switch it on

| Decision | Who | Where |
|---|---|---|
| Allow the AI-assisted modeller on a project at all | BIM Manager | BEP, and the project's Formcraft settings |
| The admin switch and the involvement level (v2) | BIM Manager | Admin › AI involvement (U28) |
| The autonomy level per operation group | BIM Manager, with the Discipline Lead | Admin › AI modeller |
| Use it on a model | The model's author (Level 2 or above for that discipline, 18.2) | Pane toggle, per session |
| Stop it at once | Anyone on the project | "Stop AI" in the pane, and fmc_guard.json |

## Autonomy levels

| Level | What the AI does | Who approves |
|---|---|---|
| **Off** | Nothing that changes the model | — |
| **Suggest** | Shows the fix: elements, before and after, a viewpoint. A person does the work | — |
| **Fix with approval** | Prepares the fix as a dry run; it runs only after a person approves the batch | The model's author |
| **Auto in WIP** | Makes the fix in the WIP copy, then reports. Only for operations marked "auto allowed" below | Reviewed after the fact by the author, before the next sync |

The default for every new project is **Suggest**.

## Involvement level (v2: the owner's direction)

The owner wants a fully assisted plugin where AI can model, not only fix. Two controls sit above the autonomy levels:

1. **The admin switch.** AI modelling is On or Off for the whole firm, with an override per project. Only the BIM
   Manager can change it. Off means every AI write is refused, whatever the levels below say.
2. **The involvement level, 0–100% (default 20%).** It does two jobs:
   - **Which operation groups are available.** Each band unlocks more groups; the autonomy level per group still
     applies inside the band.

     | Band | Name | Adds these groups |
     |---|---|---|
     | 0 | Off | none |
     | 1–20 | Assist | Data; Views and annotation; MEP small moves; Create from brief |
     | 21–50 | Co-model | Fixtures and devices; MEP routing; Architecture modelling; Families |
     | 51–80 | Lead | MEP layouts; whole-discipline drafts from the brief, approved per area |
     | 81–100 | Full | Everything the rulebook allows; "auto allowed" groups may run as Auto in WIP |

   - **A cap on how much of a model AI may author.** At the cap, every group drops to Suggest. The measure is
     pluggable in the rulebook and **not decided yet**: share of elements stamped `FMC_Author = AI`, share of changes
     per week, or no cap (bands only).

The bands, the default and the measure live in the kit rulebook `FMC_Rulebook_AIUse`, not in code. They can change
without a release. The hard limits in "What it never does" hold at every band, including Full. Structure stays
manual at every band: the per-discipline override for S defaults to 5% and only unlocks Data and Views.

## What it may change (operation groups)

Each group has its own autonomy level. "Auto allowed" says whether a project may set it to Auto in WIP.

| Group | Examples | Auto allowed |
|---|---|---|
| Data | Fill kit parameters from the master data (codes, keynotes, statuses); fix naming against the rulebook | Yes |
| Views and annotation | Tag, tidy tags, view names, view templates from the kit, section boxes | Yes |
| MEP small moves | Offset a pipe, duct, conduit or cable tray up to 150 mm to clear a soft clash; add or adjust fittings | Yes, MEP against MEP only |
| MEP routing | Reroute a run around an obstacle, within the same system and its own zone | No |
| Fixtures and devices | Move a fixture or device up to 300 mm within the same room and host | No |
| Openings and sleeves | Propose a sleeve or opening through a wall, slab or beam | No: Suggest only, and the structural engineer must say yes |
| Families | Swap to the kit's approved family of the same category | No |
| Create from brief (v2) | Place rooms, doors, windows and fixtures from the brief (CIS) with approved kit families, in a new model or the author's WIP | No |
| Architecture modelling (v2) | Walls, floors, ceilings and roofs from approved kit types, not structural | No |
| MEP layouts (v2) | Lights from `FMC_Lux_Target`, sockets from the room programme, circuits; pipe and duct layouts between connectors | No |

## What it never does, at any level

- It never moves or changes structure: columns, beams, slabs, foundations, structural walls and bracing.
- It never moves grids, levels, the survey point or the project base point, and never changes coordinates.
- It never edits a central, shared or published model, or any file outside WIP. The live-model lock still refuses
  these.
- It never syncs, saves to central, relinquishes or borrows on anyone's behalf. A person syncs (Part 16).
- It never deletes an element it didn't create in the same batch.
- It never chooses loads, sizes or design codes, and never changes a structural section (Part 12).
- It never changes anything marked fixed: pinned elements, or elements with a status of Approved or later.

## How every change is controlled

1. **Dry run first:** the batch runs, the result is recorded, and it is rolled back.
2. **Approve:** the author sees the list, the before and after views, and the clash or rule it fixes.
3. **Run:** the batch runs as one transaction group, so one Undo removes all of it.
4. **Verify:** the clash test or rule runs again on the changed elements. If the batch didn't fix what it was meant
   to, it is rolled back and the problem goes to a person.
5. **Log:** one line per batch in `FMC_AI_Modeller_Log.csv`: when, which model, the operation group, the elements,
   before and after values, the autonomy level and the approver. The log goes to `06_QA`.

## Limits that stop a run

- At most 50 elements per batch, and at most 500 elements per model per day. The BIM Manager can lower both.
- A batch whose verification fails stops all later batches in that session.
- Three failed batches on one model in a day switch the AI modeller off for that model until the author switches it
  on again.

## How the plugin will enforce it (after approval)

- `fmc_guard.json` gets an `ai_modeller` section: on or off; each operation group's level and limits; a list of
  projects; and the stop switch. A missing or broken section means **Off**, so a broken config never widens access.
- The live-model lock gains one case. A model-changing command may run on a project model only when:
  - the active document is a local WIP copy (not central, not in `02_Shared` or `03_Published`)
  - the command belongs to an allowed operation group at the right level
  - an approval exists for "Fix with approval", or the group is "auto allowed" for "Auto in WIP"
  - the limits aren't reached
- Every refusal says which of these failed.
- The add-in checks the same rules (guard parity, as today), so the server and Revit agree.

## Test before release (Part 18.4 step 4)

1. On a copy of the pilot model, run the clash-fix loop with each autonomy level.
2. Check every "never" above with a deliberate attempt. Each must be refused and logged.
3. A Level 3 modeller reviews a sample of 20 AI batches. At most 1 may need a change.
4. Measure: clashes closed per hour, and the share of AI batches the author accepted without changes.

## Training (step 7)

A short briefing for modellers and Discipline Leads:
- what each level means
- how to review a batch
- how to stop it
- that AI changes are their work once accepted

## Editing like a person: modify_model (owner 26 Oct)

With full access, `modify_model` runs a list of ops as one batch: one approval, one Undo, all or nothing. Ops: delete,
move, set_param, change_type, attach (wall top/base to a roof, floor or ceiling), duplicate_type (with layers),
create_roof (footprint, slope per edge), create_railing, create_stair (runs, landings, railings), room_separation,
opening, shaft. `"$n"` names the first element op n made, so a roof and the walls attached to it go in one batch.
`dry_run` rolls back and lists what would change. `get_element_geometry` reads exact locations and outlines (read-only).

Every approval now says what it does, by name (`server/src/fmc/explain.ts`): the types and levels, how many of each,
the elements a delete removes, a type change that affects every element of the type, and the first lines of any code.
Deletes, type-wide changes and code show in amber. An approval runs once: it is used up before Revit starts.
