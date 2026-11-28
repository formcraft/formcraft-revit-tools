# fmc_elec_diagrams

Drafting views for an open electrical model such as `F26901-FMC-ZZ-ZZ-M3-E-0001_USER`. The read uses the same panel and circuit graph as `fmc_trace` (panels, supply, circuits, ratings, poles, apparent load), plus level and distribution voltage. It does not size anything. A missing rating or load is printed `TBC`.

`plan` returns three kinds of view:

- `E-SLD` (or `E-SLD-<building>`): boards, a busbar, and one way per circuit with number, rating, poles and load. A circuit whose loads include another board is marked as a feeder.
- `E-Power-Riser` (one per building): boards stacked by level, with feeders between a board and its supply. `riser` `bands` spaces levels equally. `riser` `elevation` uses level height, 12 mm on paper per metre.
- `E-Earthing`: a template (supply, main earth terminal, electrode, earth bar, water bond, gas bond, lightning bond). Electrode and bond sizes are not read from the model.

A loaded Generic Annotation or Detail Item whose family is `FMC_DI_E_SLD_Board` or `FMC_DI_E_SLD_Breaker` is placed. Otherwise the view is detail lines and text. The tool does not load a family from disk.

`dry_run` defaults to true. `apply` with `dry_run` false needs `batch_lease` and `references.kit`, `references.standards` and `references.rulebook`. That call is `fmc_elec_diagrams_apply`: one transaction, one subtransaction per view. The model is not saved.

## plan

```json
{
  "action": "plan",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "riser": "bands",
  "dry_run": true
}
```

## apply

```json
{
  "action": "apply",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "riser": "elevation",
  "dry_run": false,
  "batch_lease": "the-lease-id",
  "references": {
    "kit": ["FMC-BIM-MAN-001"],
    "standards": ["FMC-BIM-STD-002"],
    "rulebook": ["A diagram shows the model. A missing value is TBC."]
  }
}
```

## limits

```json
{ "action": "limits" }
```

`ElectricalSystem.SelectPanel` is not called here. Circuit creation stays on `fmc_circuits`. `Connector` has voltage and no poles property. A drafting view is `ViewDrafting.Create`, a detail line is `Document.Create.NewDetailCurve`, and text is `TextNote.Create`.
