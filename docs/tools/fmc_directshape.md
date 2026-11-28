# `fmc_directshape`: DirectShape volumes under a lease

Gap proposal 25 (gap analysis canvas 55c7b2a5): DirectShape volumes for clearances, survey solids and IFC proxies.
Makes a DirectShape from a box or a straight extrusion of a flat polygon, only in a whitelisted category, under a batch
lease. Nothing is saved or synced.

## The lease

The lease is the one the server already has: `fmc_batch request` gives a `batch_lease` for a document (`server/src/fmc/batchline.ts`).
A real `create` or `remove` needs `dry_run: false`, `confirm: true` (after a person said yes to the dry run) and a `batch_lease` that this
server holds **for that document** (`leaseHeldDocuments` and `leaseCoversAny`, as `fmc_dynamo apply` does). An unknown lease, or one for another
document, is `FMC-BATCH-LOCKED` and nothing is sent. `fmc_directshape_apply` is in `WRITE_COMMANDS`, so the live-model lock, the AI gate and the
batch board's `admit` check apply as well. No new lease mechanism was added.

## Actions

| Action | What it does |
|---|---|
| `limits` | The whitelist in force, the caps and the lease rule. No Revit. |
| `create` | Dry run by default: lists what would be made (category, parts, volume m³, bounding box), asks Revit to build every solid in memory and returns `plan_hash` and `run_id`. A real create is one transaction, all or nothing. |
| `list` | The shapes this tool made (`ApplicationId`), by `of_run` or `ids`. Read-only. |
| `remove` | Dry run by default. A real remove needs `ids`, `of_run` or `all: true`, plus confirm and the lease. Only this tool's shapes; pinned ones, ones another user owns and any id that is not ours come back in `skipped`. |

## Solid spec (mm, degrees, Z up)

- Box: `kind: "box"`, `origin_mm` = centre of the bottom face, `size_mm` = `[dx, dy, dz]`.
- Extrusion: `kind: "extrusion"`, `origin_mm`, `profile_mm` = `[[x, y], ...]` relative to the origin (3 to 64 vertices, no crossing or zero-length sides; either winding), `height_mm`.
- `rotation_deg` turns a part about the vertical through its origin. `level` adds that level's elevation to Z.
- One simple shape can be given directly, or `shapes` (at most 50). A shape can have `parts` (at most 20) that become one DirectShape.
- `purpose`: `clearance`, `survey`, `ifc_proxy` or `other` (kept in the Comments parameter). `mark` goes to Mark.
- Sizes 1 mm to 500 m; coordinates within ±10,000 km of the origin.

## Whitelist

Default: **Generic Models** and **Mass**. `directshape_categories` in `fmc_guard.json` may add from this fixed list only: Entourage, Site, Parking,
Planting, Furniture, Specialty Equipment, Casework, Mechanical Equipment, Electrical Equipment, Plumbing Fixtures. Names outside it are ignored
and reported by `limits`; a broken list falls back to the default. Walls, floors, roofs, doors, windows, columns, rooms and levels cannot be enabled.
Anything else is `FMC-DS-CATEGORY` with the allowed list in the message. The add-in keeps the same universe and checks again.

## Traceability

Every shape has `ApplicationId` = `Formcraft.fmc_directshape` and `ApplicationDataId` = `fmc_directshape|<run_id>|<n>`. `run_id` is `DS-yyyymmddHHMMSS-xxxx` (UTC)
and is in every reply. Each call is a line in `FMC_MCP_FileLog.csv` (dry runs and refusals too).

## Refusals

| Code | When |
|---|---|
| `FMC-DOC-REQUIRED` | No `document`. The active document is never used. |
| `FMC-DS-SPEC` | Bad numbers, polygon, kind, purpose or count. |
| `FMC-DS-CATEGORY` | Category not on the whitelist, or not valid for a DirectShape in the document. |
| `FMC-DS-CONFIRM` | A real write without `confirm: true`. |
| `FMC-BATCH-LOCKED` | No lease, a lease this server does not hold, or one for another document. |
| `FMC-DS-PLAN-CHANGED` | `plan_hash` given and the spec differs from the dry run. |
| `FMC-DS-SELECT` | `remove` with no `ids`, `of_run` or `all`, or a malformed `of_run`. |
| `FMC-DS-DOC` | A family, a central model, HEBERT HOSTELS or a protected path. |
| `FMC-DS-LEVEL` | `level` names no level. |

## Not done

- Overlapping parts in one shape are counted twice in `volume_m3`.
- Parametric or sweep/blend/revolve solids, and `.rvt` link or IFC export settings, are out of scope. IFC proxy shapes are made as ordinary Generic Models shapes; their IFC class is set in Revit's export mapping.
- Needs a Revit check after install: `IsValidCategoryId` per category, `Name` on a DirectShape, and the transaction on a workshared file.
