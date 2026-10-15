# Family Authoring Standard (approved by the owner, 14 Oct 2026)

Every Formcraft family is parametric, carries every G-stage in one file, cuts correctly in sections, and has one
keynote per type. This file is the repo copy of the owner's approved standard (a Docs page in the claude.ai Project);
recipes (`fmc_recipe`, PR #91) and Gate A must enforce it. Kit rules FAM-001 to FAM-043 still apply; FAM-017 and FAM-039
were rewritten on 14 Oct (below).

## 1. Parametric skeleton
1. Origin at the set-out point (FAM-007): door and window = wall centre and opening centre; device = mounting point;
   equipment = floor centre. The two origin planes carry *Defines Origin*. Which side is exterior comes from the
   template: in Metric Door.rft the plane named Exterior is at +75 mm Y (Interior at −75 mm, the 150 mm host wall),
   so exterior is +y, not −y. Read it from the template's Exterior plane; never assume it.
2. Named planes with their named *Is Reference* values: Center (Left/Right), Center (Front/Back), Left, Right, Front,
   Back, Top, Bottom. Construction-only planes are *Not a Reference*.
3. Labelled dimensions on every driving size. Sizes are type parameters; per-element offsets (sill, mounting height)
   are instance parameters, using dictionary names where they exist.
4. EQ constraints for symmetry; every solid face aligned and locked to a plane; no solid dimensioned to another solid.
5. Formulas for derived values (clear opening, glazed and openable area, apparent load = power / power factor).
6. Yes/No visibility switches for options (vision panel, kick plate, fanlight, burglar bars).
7. Nested families for repeated parts; *Shared* only when the part schedules or tags alone (FAM-013).
8. Up to ten types in the family, more in a type catalogue (FAM-011). Type names: size first, then variant; no colon.
9. Flex test before saving: every type, every driving parameter to its minimum and maximum, 0 warnings.

## 2. Levels of detail (FAM-010, FAM-030)
| G-stage | LOD | Detail level | Shows |
|---|---|---|---|
| G2 | 200 | Coarse | Symbol or box at true overall size |
| G3 | 300 | Medium | True outline, connectors at true positions, clearance zones |
| G4 | 350–400 | Fine | Frames, leaves, profiles, fixings, interfaces with wall or slab |
| G5 | 500 (data) | Fine | Same, plus the ASSET pack filled from the installed product |

**FAM-039 (rewritten):** recipes build to LOD 400 Fine geometry (frames, profiles, rebates, fixings, interfaces);
freeform shapes stay hand work.

## 3. Detail views
1. Fine geometry swept from `FMC_Profile_*` profiles with FMC_ materials, so sections show the real profile.
2. Symbolic lines and masking regions per detail level (swing arcs in plan, opening-direction lines in elevation),
   readable at 1:20, 1:50 and 1:100.
3. Object subcategories (kit Graphics tab, approved): Frame, Panel, Glass, Opening, Plan Swing, Elevation Swing,
   Hidden Lines, Clearance. Line weights are set by hand in Base (no API).
4. A detail kit per family: `FMC_DI_<Role>_*` head, jamb and sill/threshold components matching the Fine profile and
   sharing the part's keynote; placed in project callouts (Revit cannot show a nested 2D item in a section through a
   model family). First six rows are in the register: `FMC_DI_A_DoorHead`, `DoorJamb`, `DoorThreshold`,
   `WindowHead`, `WindowJamb`, `WindowSill`.
5. Clearance and maintenance zones as solids on the Clearance subcategory, off by default.

## 4. Keynotes
**FAM-017 (rewritten):** one keynote per type. Revit Keynote equals `FMC_Keynote_Code`, a code that exists in
`02_Keynotes/FMC_Keynotes.txt`. A type without a code stops the build and files `fmc_library keynote_request`; codes are
never invented. Materials carry material keynotes; detail-kit components carry element keynotes; Generic Models also
need `IfcExportAs` (FAM-004).

## 5. What recipes carry and Gate A checks
| Recipe carries | Gate A checks |
|---|---|
| Named planes, *Is Reference*, *Defines Origin* | All planes named; origin on the set-out point |
| Labelled dimensions, EQ, locks | Faces locked to planes; min/max flex of every driving parameter gives 0 warnings |
| Formulas | Formulas name existing parameters (FAM-035) |
| Visibility per detail level | Coarse, Medium and Fine each show something; no 3D solid in plan at 1:100 |
| Subcategories, FMC_ materials | Every element on a named subcategory; materials FMC_ named and parameter-driven |
| Keynote per type | Keynote = `FMC_Keynote_Code` and the code exists in the keynote file |
| Clearance zones | Present on doors, windows and equipment, off by default |
| Detail kit | Each `FMC_DI_*` component exists and shares its part's keynote |
| Legend views (plan, elevation) | The legend component places, retypes and dimensions in a test legend |

A family that fails any line stays in staging.

## 6. Legend components
After release and loading into Base: copy `LG_Seed_Component`, set the type and view (plan for devices and fixtures,
elevation for equipment, both for doors and windows), dimension from the named reference faces, and redraw the
dimensions after every type change. Method: issue #85.

## 7. Pending
- Frame widths and depths, rebates and leaf thicknesses: supplier visits approved; values stay `pending` until then.
- Rebuild the six B0 pilot families from recipes under this standard once the recipe tool merges.
- The office-wide `Z:` mapping for the keynote file (the pilot PC's Base points at the D: kit file).
