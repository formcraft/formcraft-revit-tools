# Family editor tools: `fmc_fam_nested`, `fmc_fam_hosting`, `fmc_fam_connector`

From Plugin Bot's family editor proposal (canvas "Family editor tool batch proposal", page 11ee5a5f) and the coverage review of 28 Nov
(nested: swap, associate, reload; hosting: partial; connector: add validate). The proposal canvas itself was not reachable; the
parameters below follow the names in the assignment and the review, and the assumptions are listed at the end.

Rules shared by all three (same pattern as `fmc_casework`, `fmc_assemblies`, `fmc_archicad`):

- **Family documents only.** `document` names an open family (an `fmc_doc` session's document, or a family open in Revit). The server
  refuses an empty name or an `.rvt`; the add-in refuses any project document (`IsFamilyDocument`).
- **Dry run by default.** The dry run is the real change in one transaction, rolled back, sent through the read path. `dry_run=false`
  needs `confirm=true` and goes through the write path (live-model lock; `fmc_fam_*_apply` are in `WRITE_COMMANDS`). One transaction,
  one Undo; a step that fails rolls everything back. The family is never saved: use `fmc_doc save` (staging only).
- **Checked before Revit is called.** Every change is checked against the add-in's read; a bad request comes back as `refused` with
  clear reasons and nothing is sent.
- **`run_id`** (`FE-<yyyyMMddTHHmmss>-<hex>`) in every reply and in `FMC_MCP_FileLog.csv` (`run <id>: ...`).
- Code: `server/src/tools/fmc_fam_*.ts` (tools), `server/src/fmc/fam*.ts` (shared plumbing and pure rules), `commandset/Commands/Fmc/FmcFamEditCommands.cs`
  and `commandset/Services/Fmc/FmcFam*.cs` (add-in). Tests: `famnested`, `famhosting`, `famconnector`, `famedit_guard` (`*.test.ts`).

## fmc_fam_nested

| action | what |
|---|---|
| `read` | nested instances (family, type, category, shared, the `<Family Type>` parameter driving the type, instance parameters with data type and association), loaded families with their types, host parameters |
| `swap` | `nested` (ids, names or a family name for all its instances) to `to_family`/`to_type`; same category only; `load_path` loads the family first in the same transaction; refused when the type is driven by a `<Family Type>` parameter |
| `associate` | `nested` (one instance), `associate` {nested parameter: host parameter or null}, data types must match; `type_parameter` drives the nested type from a `<Family Type>` parameter (`create_type_parameter`, `is_instance`) |
| `reload` | `family` replaced from `path` (an .rfa in the family roots: staging, 04_Families, library and write roots); the file must be named like the family (otherwise Revit would load a second family); `overwrite_values`; the reply lists types added and removed |

## fmc_fam_hosting

| action | what |
|---|---|
| `read` | host (none, wall, floor, ceiling, roof, face), placement type, Work Plane-Based, Always Vertical, adaptive/conceptual mass, reference and adaptive points, instance parameters, solids and voids |
| `convert` `to`: `work_plane_based` | in place on an unhosted family (`always_vertical` optional) |
| `convert` `to`: `adaptive` | in place only in a conceptual mass or adaptive family: reference points made adaptive placement points (`points`, default all free ones); an ordinary family gets the rebuild path |
| `convert` `to`: `face_based` | **never in place**: Revit fixes the host from the template and the API has no call to change it. The dry run says so and returns the rebuild path; a real run is refused (not faked) |
| `rebuild_plan` | only the rebuild path: the template (checked on this PC), the `fmc_doc` / `fmc_fam_nested` calls (each its own dry run), the new name in staging, what a rebuild loses (voids don't cut the host through a nested copy; adaptive form must be rebuilt from adaptive points) and what blocks it |

## fmc_fam_connector

| action | what |
|---|---|
| `read` | each connector's domain (duct, pipe, electrical, cable_tray, conduit), system classification, flow direction, shape, size (mm), primary flag, linked connector and the family parameter behind each size, flow and electrical parameter; plus all family parameters with data types |
| `validate` | the read checked against the rules (below): `ok`, `errors`, `warnings`, and a report per connector |
| `set` | one connector's `system`, `flow_direction`, `associate` {diameter, radius, width, height, duct_flow, pipe_flow, voltage, poles, apparent_load, power_factor: family parameter or null} |
| `add` | a connector on a planar face of a solid (`host` {element_id or fmc_doc solid name, side}) with `domain`, `system`, `shape`, `size` {diameter or width and height}, `flow_direction`, `associate` |

Errors (refused for `set`/`add`, reported by `validate`): a system classification that isn't the domain's; `Fitting`/`Global` outside fitting
and accessory categories; a flow direction on electrical, cable tray or conduit, or not In/Out/Bidirectional; a shape the domain doesn't
take; a size parameter that doesn't fit the shape or domain (width on a round connector, voltage on a duct); a size driven by a parameter
of the wrong data type or one the family lacks; diameter and radius both associated; two primaries in a domain; links across domains.
Warnings (the engineer decides, rule 5): an undriven size, no flow direction, several connectors and none primary, linked connectors with
different systems.

## Assumptions and open points (not Revit-checked)

1. The proposal canvas was unreachable; parameters come from the assignment and `FAMILY_COVERAGE_REVIEW-2026-11-28.md`.
2. Connector system names are `MEPSystemClassification` names (read and set) and `PipeSystemType`/`DuctSystemType`/`ElectricalSystemType` (add). `Data` is accepted for `DataCircuit`.
3. The required data-type match for connector parameters is by spec-type id patterns (`famconn_rules.ts`); the live read must confirm the ids Revit 2025 returns.
4. A nested instance's type is associated through `ELEM_FAMILY_AND_TYPE_PARAM` (then `ELEM_TYPE_PARAM`); which of the two Revit offers for each category needs a live check.
5. Hosting codes (`FAMILY_HOSTING_BEHAVIOR`: none, wall, floor, ceiling, roof, face) are mapped by integer; the add-in also returns Revit's own text (`hosting_text`) so the retest can confirm the map.
6. The rebuild template names ("Metric Generic Model face based.rft", "Metric Generic Model Adaptive.rft") are looked up in `family_template_dir`; a missing one blocks the plan.
