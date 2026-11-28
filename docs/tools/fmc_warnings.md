# fmc_warnings and the model_check fix

## model_check: a check that throws is an error

Bug (cf71214): `FmcModelCheckHandler.Check()` stored a check that threw as `{count: 0, check_failed: msg}`. `problems` is the sum of
`count`, so the reply said `"next": "No problems found by these checks"`, and `server/src/tools/see_view.ts` passed it through.

Fix, both sides:

- Revit (`commandset/Services/Fmc/FmcVision.cs`): a throwing check is recorded in `checks_failed` (`{check, error}`) and the
  reply gets `status`: `error` (a check threw, or no check ran), `partial` (elements were skipped: odd families in
  `blind_openings`, `clashes`; counted per check in `skipped`), `problems`, or `ok`. `complete` is true only for `ok` and
  `problems`. "No problems found by these checks" is reachable only from `ok`. Problems found by the other checks stay listed.
- Server (`server/src/fmc/modelcheck.ts`, used by `see_view.ts`): `guardModelCheck` recomputes the verdict from the reply, so an
  older add-in's `count 0 + check_failed` is also an error (`isError: true`) and its "No problems found" text is replaced.

## fmc_warnings (read-only)

`document` is required. The add-in command `fmc_warnings` calls `Document.GetWarnings()` (no transaction, no warning is deleted) and
returns one row per warning: failure definition id (GUID), severity, sentence, and per element (failing first, then additional;
25 per warning) its category, level, workset and owner (`EDITED_BY`, the person who has it checked out; `include_creator` adds the
creator). The server (`server/src/fmc/warnings.ts`) does the triage and trend, so it is tested without Revit.

- Groups by failure id, level, workset, owner (and creator if asked). A warning counts once per distinct value of its failing
  elements. Each group: `warnings`, `failing_count`, `additional_count`, `failing_ids` and `additional_ids` capped by
  `ids_per_group` (default 20).
- Trend: the current run against the PREVIOUS snapshot of the same model: total change, new and resolved warnings, change per
  failure id, level, workset and owner.
- Snapshot: `<project_folder>\06_QA\Warnings\warnings-<model>-<hash>.json` where `fmc_guard.json` allows a write there, else
  `<reports_dir>\Warnings`. A filtered or cut-short run is neither compared nor saved.
- `csv: true`: a long-format CSV (one row per warning and element, UTF-8 with BOM) in the project's `06_QA\Warnings` only, only where
  the guard allows. Import it in Power BI Desktop. No network and no Power BI API.
- `ticket_drafts: true`: review-ticket drafts (text) for the biggest failure groups. Nothing is raised, and nothing is ever written
  to the project's review folder or register (any path there is refused).
- A reply that cannot be read, or whose count does not match, is an error, never "no warnings".

Tests: `server/src/fmc/warnings.test.ts`, `server/src/fmc/modelcheck.test.ts` (offline, temp folders only).