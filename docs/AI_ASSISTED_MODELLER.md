# Change request: the AI-assisted modeller

**Status: proposed, 14 October 2026.** A change request against the Master Manual, Part 18, raised through the
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

## Who may switch it on

| Decision | Who | Where |
|---|---|---|
| Allow the AI-assisted modeller on a project at all | BIM Manager | BEP, and the project's Formcraft settings |
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
