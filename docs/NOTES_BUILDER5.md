# Builder 5 notes (tools 51+, F131)

Notes for items that needed no code, or only part of one. Written 28 Nov 2026.

- **F100 (fmc_joins: PROVISIONAL never PASSes).** Covered by 3abe95c (joins batch 13): `overallVerdict` gives PROVISIONAL when a finding or a cited limit is provisional and PASS only when every limit is in the standards bank; audit, hosting, rooms and pressure_test all use it, and pressure_test calls a clean envelope UNKNOWN (not SEALED) while the tolerance is provisional. Still open (testing): hosting, pressure_test and rooms have not been run live (only audit-noimages, batch 10); no apply on a workshared local.
- **F94 (property line keeps the human finish).** No change. `modify_model property_line` on Revit 2025.4/2026 has no PropertyLine.Create: points_mm returns FMC-NO-API-PROPERTYLINE, from_ids selects the lines and posts the Property Line command and returns FMC-NEEDS-HUMAN; a person finishes it in Revit and property_line_verify reads it back. Still due: a person's run on a scratch site plan.
- **F97 (fmc_phase batch_check threw).** The live throw was not traced to one line; f7edb89 turns any throw in the read or the plan into FMC-PHASE-BATCH-CHECK and treats a lease with no phase as no phase.
- **P-see_view-01.** The reply now says when save_to's folder was not used and that the auto-named export stays. Honouring a path under an allowed write root is a write-path change for Builder 1.
- **P-see_view-02 (testing).** The morning skips were the harness's active-document guard, not a tool failure. Restore of the previous document and view after the rolled-back transaction is still to be confirmed live.
- **P-select_by-01 (docs).** select_by only queries (FmcSelect.Find); it never sets Revit's selection. count is every match; the id lists follow limit (architectural count 52 with five ids at limit 5 is the cap working).
- **UB-2.** undo_ai_batch dry_run rides on fmc_undo_status with plan true. Safety note for Builder 1 (not changed): fmc_undo_status and fmc_undo share one handler, so a read call carrying action undo or redo would post an undo.
