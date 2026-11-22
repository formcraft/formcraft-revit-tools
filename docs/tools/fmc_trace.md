# fmc_trace

The flow tracer. Domains are `piping`, `duct`, `both`, `conduit`, `tray` and `electrical_containment` (conduit and cable tray together). Conduit and tray report `FLOW-OPEN-END`, `FLOW-NOT-CONNECTED` and `FLOW-NEAR-MISS`. They are not piping systems, so `FLOW-NO-SYSTEM` is not raised for them.

## fix

Dry run first. Each edit has a code and a confidence. `caps: true` is required before an end cap is applied; otherwise the cap is listed under `held`. Pass `ids` to plan and apply only those elements. DirectShapes are skipped. `dry_run: false` needs `batch_lease`. One transaction, one subtransaction per edit. The transaction still rolls back if the open-end score rises.

`FLOW-OPEN-END` caps a lone end, or inserts a union or an elbow to the nearest compatible end. `FLOW-NOT-CONNECTED` calls `ConnectTo` when the connectors already face each other and are within `trace.touch_mm`. `FLOW-SIZE-MISMATCH` inserts a transition (or resizes the smaller pipe or duct). `FLOW-NO-SYSTEM` assigns the element to the one system it touches, or creates a piping system from the connector's classification. A missing classification is not invented.

```json
{
  "action": "fix",
  "document": "F26901-FMC-ZZ-ZZ-M3-P-0001_USER",
  "domain": "piping",
  "dry_run": true,
  "caps": true,
  "ids": [101, 102, 103]
}
```

```json
{
  "action": "fix",
  "document": "F26901-FMC-ZZ-ZZ-M3-P-0001_USER",
  "domain": "piping",
  "dry_run": false,
  "batch_lease": "the-lease-id",
  "caps": true,
  "ids": [101, 102, 103]
}
```

Conduit and tray ends:

```json
{
  "action": "run",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "domain": "electrical_containment",
  "checks": ["leak"]
}
```
