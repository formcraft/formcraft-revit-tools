# fmc_plumb_diagrams

Drafting views for an open plumbing model such as `F26901-FMC-ZZ-ZZ-M3-P-0001_USER`. The read uses piping-system membership, the same source `fmc_trace` uses, and does not walk `Connector.AllRefs`. It does not size a pipe. A missing size is printed `TBC`.

`plan` returns, for each piping system (water, drainage, vent, or other):

- `P-Riser-<system>`: stacks grouped by position, one band per level, fixture counts, branch counts, and the pipe size on the stack. A vent system is labelled as a vent stack.
- `P-Schematic-<system>`: the system, its classification, stack count, fixture count and the sizes the model holds.

`riser` `bands` spaces levels equally. `riser` `elevation` uses level height, 12 mm on paper per metre.

A loaded `FMC_DI_P_Schematic` Generic Annotation or Detail Item is placed. Otherwise the view is detail lines and text.

A 3D view whose name says schematic or riser, and whose crop is under 8 m, is listed in `supersedes_3d`. The drafting view replaces it. The 3D view is not deleted.

`dry_run` defaults to true. `apply` with `dry_run` false needs `batch_lease` and `references.kit`, `references.standards` and `references.rulebook`. That call is `fmc_plumb_diagrams_apply`: one transaction, one subtransaction per view. The model is not saved.

## plan

```json
{
  "action": "plan",
  "document": "F26901-FMC-ZZ-ZZ-M3-P-0001_USER",
  "riser": "elevation",
  "dry_run": true
}
```

## apply

```json
{
  "action": "apply",
  "document": "F26901-FMC-ZZ-ZZ-M3-P-0001_USER",
  "riser": "bands",
  "dry_run": false,
  "batch_lease": "the-lease-id",
  "references": {
    "kit": ["FMC-BIM-MAN-001"],
    "standards": ["FMC-BIM-STD-002"],
    "rulebook": ["A diagram shows the model. A missing pipe size is TBC."]
  }
}
```

## limits

```json
{ "action": "limits" }
```

`PipingSystem.Elements` can be incomplete on a large system. A pipe with no `ReferenceLevel` is placed from its curve. Pipe size is `RBS_PIPE_DIAMETER_PARAM`.
