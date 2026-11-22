# fmc_circuits

Power and lighting on a workshared local such as `F26901-FMC-ZZ-ZZ-M3-E-0001_USER`. Lighting and sockets are never on one circuit. A missing standards key is PROVISIONAL and uses the stated default (lighting 6 A type B, 1.5 mm², 10 points or 1 kW; ring 32 A type B, 2.5 mm², 10 points or 100 m²; AC spur 16 A type C, 2.5 mm²; shower 32 A type B, 6 mm²; final circuits 240 V). `trace.voltage_drop_pct` (alias `trace.voltage_drop_max`) and `trace.phase_imbalance_max.max_pct` are read the same way as the other trace keys.

`Connector.IsConnected` is not used. A device is already on a circuit when `MEPModel.GetElectricalSystems()` says so. A family with no electrical connector is `FMC-NO-CONNECTOR`. Data, telephone and fire alarm are skipped. Replacing a panel family in place is not done.

A panel is electrical equipment whose part type is Panelboard, Switchboard or Other Panel, or whose family has a panel-schedule MEP connector (power balanced or unbalanced). A board family is accepted. When that board has no distribution system the reply is `FMC-PANEL-NO-DISTRIBUTION`, with the hint to set the Distribution System parameter and a dry-run plan that sets it. Nothing is written until `dry_run` is false and `batch_lease` is passed.

## plan

```json
{
  "action": "plan",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "panel": "DB-BQ",
  "pattern": "{board}/{zone}-{type}{n}",
  "load_unit": "W",
  "include_switches": true,
  "non_board_ids": [12345],
  "dry_run": true
}
```

## apply

Dry run first. `dry_run: false` needs `batch_lease`. One transaction, one subtransaction per circuit. Breaker rating, poles and wire size are set where the API allows; the reply lists the parameters it could not set. `FMC_Phase` is bound to Electrical Circuits when it is missing.

```json
{
  "action": "apply",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "dry_run": false,
  "batch_lease": "the-lease-id",
  "panel": "DB-BQ",
  "pattern": "{board}/{zone}-{type}{n}",
  "load_unit": "W",
  "include_switches": true
}
```

## panel

```json
{
  "action": "panel",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "dry_run": true,
  "panel": "DB-BQ",
  "distribution": "DS_415-240V_3Ph_4W",
  "supply_from": "MDB-1",
  "feeder": "from MDB-1",
  "mains_a": 125,
  "mains_type": "MCCB"
}
```

## audit

```json
{
  "action": "audit",
  "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER",
  "distribution": "DS_415-240V_3Ph_4W",
  "accept_no_supply": ["MDB-1"],
  "non_board_ids": [12345]
}
```

## limits

```json
{ "action": "limits", "document": "F26901-FMC-ZZ-ZZ-M3-E-0001_USER" }
```
