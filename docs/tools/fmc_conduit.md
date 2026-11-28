# fmc_conduit

Free conduit ends, and cable tray when `domain` is `tray` or `both`. Tolerances are `trace.near_miss_mm`, `trace.touch_mm`, `trace.size_mismatch_mm` and `trace.direction_deg`. A missing key is PROVISIONAL. Each fitting is its own subtransaction, with a failure preprocessor, so a missing size (for example 20 mm on RNC Sch 40, which has 16, 21 and 27) does not roll back the fittings that succeeded.

`fmc_trace` with `domain` `conduit`, `tray` or `electrical_containment` reports the same open ends, unconnected connectors and near-misses. It does not raise `FLOW-NO-SYSTEM` for them.

## scan

```json
{
  "action": "scan",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "domain": "conduit"
}
```

## fix

```json
{
  "action": "fix",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "dry_run": true,
  "domain": "conduit",
  "junction": false,
  "resize_fallback": true
}
```

Apply:

```json
{
  "action": "fix",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "dry_run": false,
  "batch_lease": "the-lease-id",
  "resize_fallback": true,
  "junction": true,
  "junction_family": "FMC_E_ElecFixture_JunctionBox 75x75_Galv"
}
```

A missing family is `FMC-NO-FITTING-TYPE`. `resize_fallback` sets the nearest size in the table and writes Comments `nominal 20 mm PVC`.

## sizes

```json
{
  "action": "sizes",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "dry_run": false,
  "batch_lease": "the-lease-id",
  "type_name": "RNC Sch 40",
  "standard_name": "RNC Sch 40",
  "sizes": [
    { "nominal_mm": 20, "id_mm": 18, "od_mm": 21 },
    { "nominal_mm": 25, "id_mm": 22, "od_mm": 27 }
  ]
}
```

The reply says whether each size is in the table and whether elbow, union and transition are set on the type. Revit still looks the fitting up when that subtransaction commits. There is no separate routing-coverage API.

## fittings

```json
{
  "action": "fittings",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "dry_run": false,
  "batch_lease": "the-lease-id",
  "type_name": "RNC Sch 40",
  "elbow": "FMC_E_ConduitFitting_Elbow",
  "union": "FMC_E_ConduitFitting_Union",
  "tee": "FMC_E_ConduitFitting_Tee",
  "cross": "FMC_E_ConduitFitting_Cross",
  "transition": "FMC_E_ConduitFitting_Transition"
}
```
