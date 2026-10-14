# Execution plan: templates, families, AI-assisted modelling, coordination and data

Proposal of 14 Oct 2026, awaiting the owner's yes. It joins three things:
- the repo's own plans (`ROADMAP.md`, `PLAN_ASSET_BUILDER.md`, `IDEAS.md`, `STATUS.md`);
- the work done by hand in Revit on 13–14 Oct (staged families and templates, `scripts/kitbuild/`);
- the owner's new direction (AI that can model, under an admin switch and an involvement level).

The same plan lives in the claude.ai Project as `FMC_MCP/EXECUTION_PLAN_TEMPLATES_FAMILIES.md`. UI steps are U28–U36 in
`UI_DEVELOPMENT.md`; boards are in `design/boards/`.

## Who does what (owner's decision, 14 Oct)
| Track | Who | How |
|---|---|---|
| All code: the full UI (U28–U36), server tools, the policy-aware lock, recipes engine ops, connectors (Robot, Navisworks, Rhino), automation, data | **Claude Code** in this repo | One step at a time from `UI_DEVELOPMENT.md` Stage D and the phases below: plan → owner's yes → branch → PR → CI → the tester's run in Revit |
| Templates and families: building, filling and checking them in Revit | **Claude in the claude.ai Project** (the tester) | Through the Revit MCP only, in the background, in staging: open files with `OpenDocumentFile`, never `OpenAndActivateDocument`, no zooming, no clicks, no screenshots. The owner keeps the PC screen. Revit stays open (minimised) with a document open (`_Staging\FMC_Claude_Workbench.rvt`) and AI on |

Hand-offs between the two:
- The tester's hand-built work lands in `scripts/kitbuild/` and in a findings issue. Claude Code turns it into tools and ops.
- When Claude Code ships a tool (e.g. `fmc_doc` ops, `fmc_library release`), the tester switches from raw `send_code_to_revit` to that tool and reports gaps as `test-finding` issues.
- Steps that need a person at the screen are batched, so the owner can do them in one short sitting:
  - the first legend component per legend;
  - a seed label per parameter;
  - line weights.

## Where things stand
- **UI:** U00–U27 are done in code. The B1 `fmc_doc` engine passed its Revit run (39 ops, 0 warnings).
- **In staging on the pilot PC, built by hand on 13–14 Oct:**
  - About 340 annotation families: title blocks A0/A1/A3/A1 Cover, 4 data panels, 300 `FMC_SYM_*`, 5 typed symbols, 37 tags and heads, 3 detail items.
  - `FMC_Base_Template_v2.2.rte` plus 12 role copies. Base holds:
    - 171/171 parameters bound;
    - units, revisions and graphics;
    - electrical settings and system types;
    - 42 filters and 81 view templates;
    - QA views and 10 schedules.

    Audit: Pass, 0 warnings.
- **Kit change request** (34 items) and the **Uganda product research** (`docs/research/`).
- **Pilot PC:** Revit 2025 and Robot Structural Analysis are installed; Navisworks Manage is being installed (14 Oct).

## Improvements found in the review (before moving on)
1. **`fmc_doc` can't be called from the Claude client.** `server/src/fmc/ops.ts:10` builds a JSON Schema tuple the API
   rejects. One small fix unblocks every recipe phase. **Do first.**
2. **The hand-built work was only on one machine.** The build scripts lived in a session scratchpad. They're now in
   `scripts/kitbuild/` (annotation + template), so phase 1 converts versioned code, not memory.
3. **The "lessons from the cover title block" were on an unmerged branch** (`docs/asset-builder-plan`). They're now carried in
   `PLAN_ASSET_BUILDER.md`, corrected: labels **can** be reused by copying a seed label (`CopyElements`). That makes
   `add_label` automatable with a seed-label library: one per parameter, made once by hand.
4. **F-011 / F-003 (needs-user): the plug-in's idea of the kit doesn't match the real kit.** Templates, families and
   rulebooks all read the kit, so this must be settled before the builders ship. Bring it to the owner in phase 0.
5. **Nine "Please confirm" items in `STATUS.md`** (rule 6 vs scheduled sync, who sets "Claude in shared models", annotation
   standard shape, sheet register columns, revision codes, links source, print folder, material DB shape, rulebook
   location). Several touch this plan. Answer them in one sitting.
6. **Hard rule 1 (live-model lock) vs AI modelling.** Merged into one change request, `AI_ASSISTED_MODELLER.md` v2: autonomy levels per operation group plus the owner's admin switch and involvement level. The owner wants AI to model. That needs a deliberate rule change:
   - Manual role;
   - kit rulebook;
   - CLAUDE.md wording;
   - a policy-aware server lock, WIP only.

   It must not be worked around. It's phase A, and U28 is its pane.
7. **The AI involvement measure is undecided** (elements, changes, or tier-only). Make it pluggable in the rulebook so
   the build doesn't wait for the decision.
8. **Robot is installed and Navisworks is only now being installed.** Move the Robot track (R) ahead of Navisworks (N). Coordinate › Clashes
   (U35) can start on an imported Navisworks XML report before the connector exists.
9. **Stale branches.** About 25 remote branches are already squash-merged or superseded. Archive the list in
   `docs/history/` and prune, to keep "what's open" honest.
10. **Kit tables the builders need** don't exist yet:
    - `Column_Sets`;
    - discipline value tables (sizes, covers, wire types);
    - clash matrix;
    - `FMC_Rulebook_AIUse`;
    - a browser-folder parameter;
    - a `source_status` field per family value (verified, EA, assumed, pending, from the Uganda research).

    Raise them as one kit change request.
11. **Electrical's 16 missing `FMC_` parameters** (U25) still block Enrich and Size. They should go into the same kit change request.
12. **Tests.** Add the template rebuild to `tests/e2e` with a sample kit and a tiny recipe (IDEAS: e2e in CI). A weekly Revit
    journal smoke test (IDEAS 52: Revit smoke test) should run the template audit and one family load test.

## Phases
Each phase ends with a Revit run (the tester's protocol in `TESTING.md`) and a report. The owner's yes comes before each one.

| # | Phase | Delivers | UI | Waits on |
|---|---|---|---|---|
| 0 | Unblock | `fmc_doc` schema fix; workbench file in `_Staging` (Revit always has a document); B0 on the 6-family pilot set; settle F-011 and the "Please confirm" list | — | owner answers |
| A | AI involvement policy | Manual role, `FMC_Rulebook_AIUse`, CLAUDE.md rule 1 rewritten, policy-aware lock, `FMC_Author` stamping, approval queue, first ops at 20% (rooms, doors, windows, fixtures, views, sheets, tags) | U28 | owner approves the wording |
| 1 | Templates as data (B5) | `scripts/kitbuild/template` → `fmc_doc` project ops + `Base.recipe.json`; strip seed (CR #29); browser structure; materials with appearance assets; rebuild Base and compare | U29 | 0 |
| 2 | Recipes + quality gate (B2) | `recipe.schema.json`, `fmc_family build`, extended load test, seed-label library, `fmc_library release` + log; first family: parametric door | U30 | 0 |
| 3 | Legends and schedules | `add_schedule` with kit column sets, `add_legend` (seed copy), refresh legends, BOQ formulas + UGX rates | U31 | 2, kit tables |
| R | Robot | COM connector, engineer's loads form, results to `FMC_FEA_`, engineer sign-off | U33 | A (for WIP writes), S chain-test model |
| 4 | Uganda family set | Steel fanlight door, steel casement + burglar bars, accessible door set, gates, fences, razor wire, electric fence, CCTV, gate motor; `pending` values flagged | — | 2, supplier data |
| 5 | Annotation assets registered and released (B4) | Register rows for today's ~340 families, audit, release | — | 2 |
| 6 | Discipline templates (B6) | Value tables per role, S analytical settings, clash matrix, released families loaded, publish gate, `fmc_project` + chain test per role; AI ops grow to Co-model (walls, floors, MEP layouts) | — | 1–5 |
| AU | Automation | Scheduled runs (needs the workbench), Revit triggers (IUpdater), morning report | U32 | 1, 2 |
| D | Data | Excel round trip (staging copies, dry run), kit tables via change requests, Power BI dashboards via Microsoft's authoring MCP | U34 | 3; Power BI licence |
| 7 | Guided first project, then local permit packs | IDEAS 4 (guided first project) and 37 (permit packs) on top of the published templates | — | 6 |
| N | Navisworks | Evaluate open-source Navisworks MCPs; connector; federate, clash matrix, nightly runs, Review; AI triage/fix within the policy | U35, U36 | Navisworks is being installed; can run in parallel with R after phase 1 |
| RH | Rhino | McNeel's official Rhino MCP (MIT; Rhino 8/9; Grasshopper tools, Python/C#) for massing, facades, form-finding and complex families. Geometry goes to Revit only through staging, as DirectShape or a family from a Rhino export, never into a live model. One hub with the Revit, Robot and Navisworks connectors; same log and policy | U37 (Model › Rhino) | Rhino isn't installed on the pilot PC; licence (Rhino 8); after phase 2 |
| 8 | Later | B7 recipes from datasheets/photos, LOD 400 assemblies and shop sheets, Design Automation, Blender renders, Speckle | — | — |

**In parallel:** shortcuts standard (IDEAS 10), CI e2e and the weekly smoke test, and branch clean-up.

## People gates (unchanged by AI)
These are always done by a person:
- family release;
- template publish;
- engineer sign-off;
- applying Excel changes to the kit;
- sync;
- issue.

AI batches above the policy threshold also wait for a person.

## Decisions needed from the owner
1. A yes on this order, and which IDEAS go on the roadmap.
2. The AI involvement policy wording. Confirm or defer:
   - the default of 20%;
   - the tier bands 20/50/80;
   - the cap measure (pluggable until decided).
3. Answers to F-011 and the nine "Please confirm" items.
4. Reviewers for the S, E, M/P/FP and LP families; the release approver.
5. The kit change request for the new tables (improvement 10) and the 16 electrical parameters.
6. Supplier visits for the Uganda gaps.
7. A Power BI licence (Pro or Fabric), or skip D3 for now.
8. Navisworks Manage: being installed (14 Oct), so N can run in parallel with R.
9. Rhino (track RH): a Rhino 8 licence and install on the pilot PC. Also, whether Rhino.Inside.Revit is wanted alongside the MCP for live exchange.
