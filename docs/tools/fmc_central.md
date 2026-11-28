# fmc_central: central file creation (the 13 approved rules)

Owner GO (voice, 28 Nov 2026, relayed by Plugin Bot). Logic: `server/src/fmc/central.ts` (pure + ports), real ports
`server/src/fmc/centralports.ts`, tool `server/src/tools/fmc_central.ts`, Revit side `commandset/Services/Fmc/FmcCentral.cs`
(commands `fmc_central_build`, `fmc_central_selftest`, `fmc_central_promote`). Tests: `server/src/fmc/central.test.ts`, `server/src/fmc/centralguard.test.ts`. Guard: `server/src/fmc/centralguard.ts`.

| # | Rule | Where |
|---|---|---|
| 1 | Ask first: path, worksets, any detach | `planCentral().ask_user`. A real create is a person's pane action (or Approve there, which runs it). `plan_token` and `confirmed_by` are not an approval. |
| 2 | Existing central: refuse without override; back up when overridden | `overwrite` + `override_reason`; `backup_moves` to `_Archive`; restored on failure |
| 3 | Worksets default Architecture/Structure/MEP, custom allowed | `DEFAULT_WORKSETS`, `worksetProblems` |
| 4 | Only on the shared drive at the ISO 19650 location | `centralFolder` = `<project>\01_WIP\<Role>`; `checkSharedDrive` (UNC or DriveType 4) |
| 5 | Permissions per project access rules | `00_Info\Admin\FMC_Access.json` + `robots\<id>\rights.json` + guard `write_roots` |
| 6 | Timestamped log per creation | `00_Info\Admin\FMC_Central_Log.csv` (ready / queued / aborted) |
| 7 | Dry-run preview quoted before the real run | `plan_token` must match on create |
| 8 | ISO 19650 name | `centralName`, `centralNameProblems` |
| 9 | `_v2` when the name exists (default) | `nextFreeName` |
| 10 | Drive reachable with space, else abort | `checkSharedDrive` at plan and again at run |
| 11 | Queue behind another Revit session | `[FMC-CENTRAL-BUSY]` → `CentralQueue` (`FMC_Central_Queue.json` in reports_dir); `queue_list`, `queue_run`, `queue_remove` |
| 12 | One transaction, no half-made central | build + self-test in local temp; promote; quarantine + restore on failure |
| 13 | Self-test then ready | read-only file checks, all worksets open in a throwaway local, one sync, local deleted |

## Notes for the Revit check (not verifiable offline)

- Promote is a Revit "detach and preserve, save as central" of the tested temp central at the share path, not a file
  move: a central stores its own path, so a raw move would leave it pointing at temp.
- "Read-only open" is done from the file (BasicFileInfo + workset preview) without opening the central for writing.
- The busy check (rule 11) is a file-share probe plus Revit's own "in use" errors; it needs a live two-session test.


## Person, lease and the AI gate (follow-up, 28 Nov 2026)

- `action=plan` and a create with `dry_run` not false stay ungated (no lease, no person, no queue).
- A real write (`create` with `dry_run=false`, `queue_run`, `queue_remove`) needs `batch_lease` from `fmc_batch request`, on the same terms as `fmc_dynamo` apply. Missing lease: `[FMC-BATCH-LOCKED]`.
- Confirmation must come from a person in the Formcraft pane (`FMC_CALLER=pane` on the CLI, never an MCP call). The pane's Approvals list uses the existing AI queue (`CENTRAL_APPROVAL`). After they Approve, **the pane runs the create**; an approved AI still has no path to save-as-central or the rule-13 sync (CLAUDE.md rule 6) until the owner allows an exception.
- `queue_run` does not treat a stored `confirmed_by` as a new approval.
- `queue_remove` needs the lease and a pane approval; after that approval an AI may retry the remove (it is a queue-file write, not a sync).
- The three Revit commands (`fmc_central_build`, `fmc_central_promote`, `fmc_central_selftest`) are in `WRITE_COMMANDS` and `NEVER`. `aiGate` refuses them even with `access=full` and with no document. The tool still uses `sendRaw` after the tool-side gates, so the live-model lock is not applied to the wrong open document.
- The self-test throwaway and the temp build path must canonicalise to a local (non-UNC, non-network) folder inside `%LOCALAPPDATA%\Formcraft\central-temp`. Recursive delete is refused for any other path, and never of the temp root itself. Promote's target must be on the share under `\01_WIP\`, not in the temp root. Promote and self-test also probe whether the target/central is held (`HeldBy`).
- The pane CLI registers `fmc_central` so a person can run it with `FMC_CALLER=pane`.

