# fmc_ceiling hardening

Source: the approved proposals in `tool-research/fmc_ceiling.md` (build `cfc56f5`) plus three owner points (28 Nov 2026).
Code: `server/src/fmc/ceiling/guard.ts` (pure + file ports), `server/src/tools/fmc_ceiling.ts`, `server/src/tools/fmc_ai.ts` (pane Approve). Tests: `server/src/fmc/ceiling/guard.test.ts`.

## 1. A real person's approval (not a flag)

`confirm=true` still has to be sent, but it is only a statement that the dry run was shown. A real `pack`, `place`, `edit` or `drawings` also needs one of:

- **A person's own click in the pane.** The pane runs the CLI with `FMC_CALLER=pane` (plugin/Fmc/ServerCli.cs). A call that came over MCP (`registerFmcCeilingTool` passes `viaMcp: true`) is never a person, whatever its environment says.
- **A batch a person approved in the pane's Approvals list.** This reuses the AI approval queue (`%APPDATA%\Formcraft\ai_queue`, `aiuse_io.ts`): the AI's real call queues an item (`fmc_ceiling_approval`, keyed by the exact batch: action, design hash, placement hash, level, origin, project), the person presses Approve (`paneAi ai_approve`, CLI-only, never an MCP tool; for this item type it sends nothing to Revit), the AI repeats the same call, and the tool claims the approval once (marked used before the work, like `claimApproval` elsewhere). A different origin, level or design is a different batch and needs its own approval; the stored parameters must match the call.

The AI waits with `fmc_ai wait id <approval_id>`.

## 2. Placement record before the Revit change

`place`/`edit` real run: approval claimed, then **the record is written first** (`status: "pending"`, design hash, approver, start time; an edit keeps the previous elements as `made` and the previous record as `previous`), then Revit, then:

| Revit result | Record |
|---|---|
| ok | `status: "placed"` with the element ids (write retried 3 times; if it still fails the ids go to a `.orphan.json` side file and in the answer) |
| error | place: `status: "failed"` (a new place is allowed); edit: the previous record is restored with `last_failed_attempt` |
| still running / unknown (`FMC-JOB-RUNNING`) | stays `pending` with `error: "unconfirmed: ..."`; a pending place blocks the next place/edit until a person has checked the model |

If the record can't be written, nothing is changed in the model. Records written before this change have no `status` and count as placed. Writes are atomic (temp file then rename).

## 3. Design hash and kit revisions

Every single-design answer (checks, setout, quantities, boq, pack, place, edit, drawings) carries `design_hash` (SHA-256 of kind, room/fixtures/brief, the evaluated design and the kit file revisions) and `kit_revisions` (short SHA-256 of each kit file read: materials, keynotes, master_data, ceiling_standard, family_register, sheet_register; `missing` when unreadable). Pass `design_hash` back to `place`/`edit`/`drawings`/`pack`: a different design is refused. The record keeps `design_hash`, `placement_hash`, `kit_revisions`, `origin_mm`.

## Origin against the room boundary

`place.room_bbox_mm {x0,y0,x1,y1}` (the room in the model, from fmc_room): the design's room, moved by `origin_mm`, must land within 150 mm of it or the call is refused. Without it the check is skipped with a warning.

## Known limits

The approval queue and the pane's `FMC_CALLER` are files and environment on this PC: a process running as the same Windows user can write them. This is the same trust level as the existing AI gate; it stops an AI using the tool through MCP, not malware or a person's own shell.
