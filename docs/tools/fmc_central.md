# fmc_central: central file creation (the 13 approved rules)

Owner GO (voice, 28 Nov 2026, relayed by Plugin Bot). Logic: `server/src/fmc/central.ts` (pure + ports), real ports
`server/src/fmc/centralports.ts`, tool `server/src/tools/fmc_central.ts`, Revit side `commandset/Services/Fmc/FmcCentral.cs`
(commands `fmc_central_build`, `fmc_central_selftest`, `fmc_central_promote`). Tests: `server/src/fmc/central.test.ts`.

| # | Rule | Where |
|---|---|---|
| 1 | Ask first: path, worksets, any detach | `planCentral().ask_user`; create needs `confirmed_by` |
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
