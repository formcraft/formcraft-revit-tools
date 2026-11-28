# Plan: discipline models follow a changing architecture model (owner 28 Oct 2026)

Owner: "we are still on a changing design ... set it up in a way that it accounts for corrections ... the structure or
plumbing model will show that there is a revision pending in that file, as per updates in the architecture model."

## 1. Snapshot at every design run
- The structural (later plumbing, electrical) design scripts store what they were based on: `_work/facts.json` (walls,
  floors, roofs, columns, framing, levels from `fmc_struct_facts` on the linked model) plus `_work/basis.json`:
  architecture file name, its saved date/version, the link's load time, and a fingerprint per element
  (id → hash of type, thickness, level(s), height, ends/outline, openings area).

## 2. Change check (script, no AI): `scripts/structure/arch-diff.mjs <work dir> [--flag]`
- Reads the linked architecture model now, compares with basis.json, element by element.
- Classifies each difference:
  - **structural**: wall on a structural line added/moved/removed/thickened/heightened; level elevation; slab outline,
    thickness or opening; new/removed column or RC beam; roof shape/height; new storey; use change (loads).
  - **minor**: finishes, rooms, doors and windows in non-structural walls, furniture.
- For each structural change, the affected structural members (by grid line / element id from plan.json).
- Writes `_work/arch_changes.json` and `_Structure/<date>_architecture_changes.md`.

## 3. "Revision pending" in the discipline model (with --flag, only when a structural change is found)
- A red text note on every structural sheet: "REVISION PENDING – architecture changed <date>: see <file>".
- An un-issued Revit revision ("P02 – pending: architecture changes <date>"); project parameter
  `FMC_Discipline_Status = Revision pending` (shown on the title block).
- Cleared by the re-run (step 5), which issues the revision.

## 4. When it runs
- Now: on demand, and nightly via Windows Task Scheduler (`node scripts/structure/arch-diff.mjs ... --flag`).
- Later (add-in, CI build): the Revit add-in runs the check on link reload / document open and shows the banner.

## 5. Correcting
- Re-run only what the change touches with the existing scripts: frame plan (fmc_structure frame, keeping the ids of
  unchanged members), iterate.sh (local solver; Robot for the final check), rc-design.py, revit-apply.mjs,
  drawings.py / truss-design.py. Sheets go P01 → P02 with clouds on the changed areas; the change list is attached to
  the design report's revision log.

## 6. Other disciplines
Plumbing/drainage, electrical and fire models each keep their own basis.json of the architecture model and use the
same arch-diff with their own "what matters" rules (e.g. plumbing: wet rooms, fixtures, levels, slab openings).
