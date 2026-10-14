# Rulebooks: what QA and Rules read (kit schema v0.1, and rule schema v1)

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

## The kit's schema v0.1 (read as the kit writes it, F-017)

The kit's rulebooks (`03_Master_Data\FMC_Rulebook\FMC_Rulebook_<Feature>.json`, kit r4) use their own schema. Rule 7:
the kit wins, so the plugin reads it as written:

| Kit | Plugin |
|---|---|
| `feature`, `rulebook_version` | book name and version |
| `severity`: `error` / `warning` / `info` | Must / Should / Advice |
| `status`: `from_standard` / `proposed` | Standard / Proposed (proposed rules are listed, never run) |
| `stages`: `"all"` or RIBA stages `["4", "5"]` | runs at every stage, or only when `fmc_qa run` gets that `stage`; otherwise Not applicable |
| `title`, `rule`, `applies_to`, `clause`, `auto_fix` | rule, test, scope, why, fix hint |
| `check`: `{ "type": …, "params": {…} }` | bound to a check kind below when the kit's data is unambiguous |

How a kit check type becomes a check the plugin runs:

| Kit `check.type` | Runs as | When |
|---|---|---|
| `naming_regex` | `view_name_pattern`, `view_template_name_pattern`, `sheet_number_pattern` | `applies_to` is exactly `views`, `view templates` or `sheets`, and `params` show what the pattern names (`example`, `examples` or `roles`). Without that the pattern may be for a subset (working views, logistics sheets) or a parameter, so it isn't run |
| `naming_regex` with `forbidden_regex` | `type_name_forbidden` | `applies_to` names types |
| `parameter_present` | `sheet_parameters_filled`, `type_parameters_filled` | `params.required` or `params.parameter`, on `sheets` or on `OST_` categories |
| `count_min` with `metric` | `health_count` (amber → Warning, red → Fail) | the plugin measures the metric: `warnings total`, `in-place families` |
| `human_gate` | Not checked: "A person confirms this" | always |
| anything else | Not checked, with the reason | until the plugin learns it |

**The QA verdict (F-018)** is Blocked (a Must rule fails), **Not clear** (no Must rule fails, but Must rules weren't
checked, or nothing was) or Clear (every Must rule that applies was checked and passed). Not checked is never a pass.

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
