# MEP upgrades plan

Owner-approved on 28 Nov 2026. Item 1 has code (below); items 2 to 9 are plan only. Every item follows the house rules:
a dry run first, no model write without a batch lease and a person's yes, and numbers from the kit or the standards bank
(a missing key is PROVISIONAL, never invented).

## 1. Constraint-aware routing (started)

`fmc_trace` action `route`: a preview only. No Revit call, no file, no write.

- Solver: `server/src/fmc/route.ts`, pure TypeScript with no Revit dependency. A* on a grid (`grid_mm`, default 100) with a
  constraint state: cell, centreline elevation, direction, length so far and bends so far.
- Constraints: obstacles as boxes inflated by half the size plus `clearance_mm`, the bounds, an elevation band
  (`z_min_mm`, `z_max_mm`), `max_length_mm`, `max_bends`, and the slope.
- `flow: gravity`: every horizontal piece falls at `slope.min`, vertical pieces only drop, the run never rises, and a run
  that arrives high is regraded evenly up to `slope.max` (which defaults to `slope.min`, a required slope). A route that
  cannot still reach the end at `slope.min` is pruned.
- `flow: pressure`: level horizontal pieces, vertical rises and drops.
- Backtracking: a move that breaks a constraint is pruned, and an end reached at the wrong elevation is rejected, so the
  search backs up to the next best partial route (a detour to lose height, a way out of a dead end). The reply counts
  backtracks, goal rejections and prunes by reason.
- No route: `FMC-ROUTE-NONE` with `blocking` (fall, max_length, bends, elevation, enclosed, start_blocked, goal_blocked)
  found by relaxing one constraint at a time, a plain reason (for example the shortest length when `max_length_mm` is the
  cause) and a hint. `FMC-ROUTE-LIMIT` when the search cap is hit.
- Output: run polylines (trunk, then branches that join the network), each piece's length and slope (`1:40`), and the
  fitting points for the connector tool (item 9): `corner` (with its angle), `tee` (with the branch), `joint` (every
  `stock_length_mm` along a straight piece, default 6000) and `open_end` (start, end, branch_start).

Next for item 1: read the obstacles from the model (structural framing, ceilings and soffits from `fmc_mep_facts` or a
new read), a 45-degree move set for ducts, hand the preview to `modify_model` pipe or duct ops through the usual dry run,
and a live read-only check on a copy.

## 2. System-level duct optimisation

Solve the whole duct network together: terminals and their airflow from the model, a trunk-and-branch tree that keeps
total length and fittings low (a Steiner tree on the routing grid, using item 1's solver for each leg), then size by
velocity or equal friction from kit bands. Read-only plan first.

## 3. Pressure-drop preview

Static pressure along a run before committing: friction per metre (Darcy-Weisbach with the kit's roughness, or
equal-friction tables) plus fitting losses (K factors per fitting type from the kit) on item 1's fitting points. Reply
per piece and the index run. Fills `fmc_trace`'s `duct_airflow` gap (listed as not run yet).

## 4. Auto-tag MEP elements by system in one pass

One `fmc_tags`-style batch: tag pipes, ducts, fittings and equipment per system (system abbreviation, size, slope or
flow), kit tag families only, dry run with counts per view.

## 5. Interference clearance with architecture

Check pipes and ducts against finished ceilings, soffits and structural members at the code minimum (clearance keys in
the standards bank). Builds on `fmc_clash` and `fmc_headroom`; the same boxes become item 1's obstacles.

## 6. Room-based equipment placement

Place equipment (fan coils, water heaters, boards) by room using the design generator's clearance rules and room
boundaries, scored candidates, dry run with a preview id.

## 7. Schedule export for fabricators

A spreadsheet per system: pipe and duct length by size and material, fittings counted by type and size (`fmc_trace`
counts already has the bill of quantities), hangers per stock length. Written under the project's WIP folder, dry run
first.

## 8. Parametric family sizing from calculated flow

Size pipes, ducts and equipment families from `fmc_calc` results (water demand, drainage flow) and item 3, through the
family type parameters, dry run first. Values only from the calculation sheet, never guessed.

## 9. Plumbing connector tool (plan only, added 28 Nov 08:34)

Place elbows at corners, tees at junctions, couplings and unions at joints, and caps at open pipe ends, triggered when
routes meet or end. It consumes item 1's fitting points. Existing code to reuse: `modify_model` runs already place
elbows at corners and `connect` places elbows, transitions and tees; `fmc_trace fix` places caps (with `caps: true`),
unions, elbows and transitions; `fmc_conduit fix` places conduit elbows, unions and transitions. Caps need a cap family
loaded; the connector tool reports a missing one.
