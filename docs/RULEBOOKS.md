# Rulebooks: what QA and Rules read (rule schema v1)

The kit's rulebooks are JSON files, one per book, in the folder `rulebooks_dir` names in `fmc_guard.json`
(default `Z:\00_Standards\03_Master_Data\FMC_Rulebook`, the kit r4 layout). Check › Rules lists them; Check › QA runs the rules that name a check kind.
Rule content lives in the kit, never in the plugin (CLAUDE.md rule 7). **Please confirm** this matches the kit's
rulebooks v0.2; if the kit keeps them in another shape, the reader (`server/src/fmc/rules.ts`) follows the kit.

```json
{
  "rulebook": "Naming",
  "version": "0.2",
  "rules": [
    {
      "id": "NAM-012",
      "rule": "View name pattern",
      "severity": "Must",              // Must, Should or Advice
      "status": "Standard",            // Standard (from the Manual), Proposed, or Plugin
      "scope": "All disciplines · all stages",
      "test": "Every plan view name matches the pattern",
      "fix_hint": "Rename to A_FP_Lxx_Purpose",
      "version": "v0.2 · changed 13 Oct",
      "why": "Views are found by name across models",
      "gates": ["wip_to_shared", "shared_to_published"],   // none: runs at every gate
      "check": { "kind": "view_name_pattern", "pattern": "^[A-Z]{1,2}_[A-Z]{2}_", "view_types": ["FloorPlan"] }
    }
  ],
  "exceptions": [{ "rule": "SHT-022", "where": "A-2001", "approved_by": "[NAME A]", "until": "2026-12-31", "reason": "Issued sheet" }],
  "decisions": [{ "text": "Stages: gates and issue sets drive; RIBA a label", "state": "decided" }]
}
```

The reader also accepts `title` or `text` for `rule`, `fix` for `fix_hint`, `source` for `status`, `gate` for `gates`.
Proposed rules are listed but never run. An exception in force marks a failure as excepted (it no longer blocks).

## Check kinds the plugin runs

| Kind | Parameters | Fails when |
|---|---|---|
| `view_name_pattern` | `pattern` (regex), `view_types` (optional, Revit view types) | a non-template view's name doesn't match |
| `sheet_parameter_filled` | `parameter` | a sheet has the parameter empty |
| `type_parameter_filled` | `parameter`, `categories` (optional) | a model type has the parameter empty (keynote, element code) |
| `family_name_pattern` | `pattern` | a loadable family's name doesn't match |
| `links_pinned` | | a Revit link isn't pinned |
| `max_count` | `metric` (`warnings`, `in_place_families`), `max` | the count is above `max` (health alerts) |

A rule without `check`, or with a kind not in this table, shows as **Not checked** with the reason, never as a pass.
New kinds are added to the plugin as the rulebooks need them.
