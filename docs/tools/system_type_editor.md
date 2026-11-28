# System-type editor (modify_model duplicate_type, edit_type, delete_type, plan_only)

Review item 3 of `FAMILY_COVERAGE_REVIEW-2026-11-28.md`, approved by the owner on 28 Nov at 13:24 EAT. It extends the
existing `modify_model` tool (add-in command `fmc_model_edit`). No new tool was added.

## What it does

| Op | What |
|---|---|
| `duplicate_type {type \| type_name + kind, new_name, EDITS}` | Copies a type, then runs the edits on the copy. A name that is already in use is refused with `FMC-TYPE-NAME-TAKEN`. |
| `edit_type {type \| type_name + kind, EDITS}` | Edits an existing type in place, with no duplicate made first. Every element of that type changes. |
| `delete_type {type}` | Never runs. Deleting a type needs a person (`FMC-NEEDS-PERSON`). With `plan_only` it lists how many instances and dependents the type has. |
| `delete {ids}` | Now refuses any id that is a type, with `FMC-NEEDS-PERSON`. |
| batch flag `plan_only: true` | Accepts type ops only (`edit_type`, `duplicate_type`, `delete_type`, `set_param` with `on_type`). It reads the model and returns a plan, with no transaction. |

The `kind` values are `wall`, `floor`, `roof`, `ceiling`, `stair`, `stair_run`, `stair_landing`, `pipe`, `duct` and `cable_tray`. `conduit` is also accepted, but conduit edits are refused in favour of `fmc_conduit apply`.

EDITS:

- **Compound layers** (walls, floors, roofs and compound ceilings):
  - `layers`: replaces every layer.
  - `layer_edits`: edits layers in place by index, where 0 is the exterior or top layer. An edit can set `width_mm`, `function`, `material` or `wraps`. It can also insert a layer with `{insert_at, ...}` or remove one with `{index, remove: true}`.
  - `core`: the shell layer counts.
  - `structural_layer`.
  - `wrapping {openings, ends}`: walls only.
  - Revit's own `CompoundStructure.IsValid` check runs on an in-memory copy before anything is set.
  - A basic ceiling or sloped glazing has no layers. That case is refused by name.
- **Type parameters**: `params {name: value}`.
- **Stair types**:
  - `stair {max_riser_mm, min_tread_mm, min_run_width_mm, left/right_lateral_offset_mm, run_type, landing_type, left/right/middle_support, middle_supports_number}`.
  - `stair_run {riser_thickness_mm, tread_thickness_mm, nosing_length_mm, structural_depth_mm, material}`. On a stair type this edits the type's run type, and the answer says how many other stair types share it.
  - `stair_landing {thickness_mm}`.
- **Pipe and duct types**:
  - `routing {add: [{group, part, min_mm?, max_mm?, index?, description?}], remove: [{group, index}], preferred_junction: tee|tap}`.
  - `segment_sizes {segment?, add: [{nominal_mm, id_mm, od_mm}], remove: [nominal_mm]}`: pipe types only. The segment is shared, and the answer says how many pipe types use it.
- **Cable tray types**:
  - `fittings {elbow, tee, cross, transition, union}`.
  - `fitting_params {"Type Properties name": "Family : Type"}`, for example vertical bends.

Every requested edit returns one row in `items`, with `ok`, `before`, `after`, `applied`, or a `code` and a `reason`. An unknown key or an edit that doesn't fit the type is also a refused row, never silently dropped. In a real run, each edit group runs in its own SubTransaction, following the `fmc_conduit apply` pattern. If any row fails, the whole batch rolls back, and the answer still carries every row. With `partial: true`, the groups that worked are kept.

Scope: this covers type definitions only. Nothing here sizes, routes, reconnects or changes an existing pipe, duct or tray run; the MEP tools own that. A source-scan test checks this.

## Safety

- **Gates:** `modify_model` still goes through `sendCommand`, so the batch lease, the live-model lock and the AI gate all apply. There is no `sendRaw`, and a test checks this.
- **Deleting types:**
  - The server refuses a real `delete_type` before anything is sent.
  - The AI gate refuses it too, ahead of the dry-run exemption.
  - The add-in throws `FMC-NEEDS-PERSON`.
  - `delete` refuses types.
- **Plan-only path:** it is tested to contain no `Transaction`, `TransactionGroup` or `SubTransaction`. The one `SetCompoundStructure` call is guarded by `apply`. Every MEP and stair write sits behind `apply`, and a test checks each line.

## Dry runs on a workshared local: the borrowing finding

- **The existing `dry_run: true` borrows.** It runs each op in a `Transaction` that commits inside a `TransactionGroup`, and the group is then rolled back.
  - On a workshared local, a committed change to an existing element that the user doesn't own makes Revit take ownership of it, borrowing it from central.
  - Element ownership is not part of the undo stack, so `TransactionGroup.RollBack` undoes the change but does not give the ownership back. The element stays borrowed until the next sync or relinquish.
  - So a `dry_run` of `set_param on_type` or of a layer edit on an existing type can leave that type borrowed.
  - `FmcCheckout.Partition` skips elements another user owns, but it does not stop this borrow.
  - This comes from the Revit API's worksharing design (`WorksharingUtils`, and `CheckoutElements` being outside the transaction model). It was **not reproduced live**: no model was opened for this build.
- **A duplicate borrows nothing that exists.** It is a new element. Whether creating it needs the Project Standards workset entry was not checked live.
- **`plan_only: true` never borrows.** It starts no transaction of any kind.
  - Its reads are `GetCompoundStructure`, which returns a copy, plus `IsValid` on that copy, parameter reads, routing-rule reads, `FilteredElementCollector` counts, and `WorksharingUtils.GetCheckoutStatus` / `GetModelUpdatesStatus`. They change nothing and check nothing out.
  - Each type row has `ownership.would_borrow`, which is true when a real edit of that existing type would take ownership of it. `ownership.blocked` is true when another user owns it, and then a real `edit_type` is refused with `FMC-ELEM-OWNED-BY-OTHER`.
  - Use `plan_only`, not `dry_run`, to preview type edits on a workshared model.

## create_line_based_element and create_surface_based_element (review gap 11)

The ignored thickness and the first-type fallback are fixed by matching or refusing. Nothing is created as a side effect.

- **When `typeId` is given:**
  - The type is used if it exists and fits.
  - A missing type, or one that doesn't fit, is refused (`FMC-TYPE-NOT-FOUND`). The first type is never used in its place.
  - A thickness that differs from the given wall, floor, roof or ceiling type is refused (`FMC-TYPE-THICKNESS-MISMATCH`).
- **When there is no `typeId`:**
  - Walls, floors, roofs and ceilings use the one existing type whose total thickness matches within 0.5 mm. If there is none, the item is refused with `FMC-TYPE-NO-THICKNESS-MATCH`, and the reason points to `modify_model duplicate_type`. If there are several, it is refused with `FMC-TYPE-AMBIGUOUS`.
  - Other categories need `typeId` (`FMC-TYPE-REQUIRED`). For those, the thickness is reported as not applying.
- **Per-item results:** every item returns a row in `Items`. A missing level, a bad category, or a duct with no supply-air system is a row, where before it was skipped silently. `Success` is false when any item was refused.
- **Removed helpers:** the dead `CreateOrGetWallType`, `CreateOrGetDuctType` and `CreateOrGetFloorType` helpers were removed. They were never called, and they made Chinese-named types.

## What the Revit 2025 API can't do (checked against RevitAPI.xml)

- **Stairs:**
  - `StairsType.ConstructionMethod`, `StairsType.HasMiddleSupports`, `StairsRunType.HasRisers`, `HasTreads`, `IsMonolithic`, `IsSlanted`, `TotalDepth` and `StairsLandingType.IsMonolithic` have no setter. They are refused by name with `FMC-API-READONLY`.
  - `StairsRunType.StructuralDepth` and `MaterialId` apply to monolithic runs only.
  - Stair length setters reject values of 0 or less, or above 30000 ft. The editor checks this before sending.
- **Routing groups:**
  - Duct types have no segment group in their routing preferences, and no mechanical joint or cap groups. Those are refused.
  - Pipe types have no rectangular or oval transition groups.
- **Size tables:**
  - Pipe size ranges live on the shared `PipeSegment` (`Segment.AddSize`/`RemoveSize`), not on the pipe type. The answer reports which pipe types share the segment.
  - Duct sizes (`DuctSizeSettings`) and cable tray sizes (`CableTraySizes`) are document-wide tables, not type definitions, and are left out on purpose. Routing-rule size ranges (`PrimarySizeCriterion`) are on the type and are covered.
- **Cable trays:** cable tray vertical bends have no named `MEPCurveType` property. Set them with `fitting_params` by their Type Properties name.
- **Not built:**
  - Wall sweeps and reveals in the type (`AddWallSweep` exists, but nothing was approved for it).
  - Variable layers, stacked walls, and railing structure (railings are on `446a53c`, which is not merged).

## Tests

- **`server/src/fmc/systypes.test.ts`:** 11 tests covering the refusal rules, the wire params, the description, the gate order, and source scans (no transaction in the plan path, apply guards, MEP scope, delete guards, and no first-type fallback).
- **`tests/systypes/SystemTypes.Tests.csproj`:** 14 offline xunit tests for `TypeEditCore`.
