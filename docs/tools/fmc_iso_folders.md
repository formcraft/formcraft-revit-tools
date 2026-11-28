# fmc_iso_folders: ISO 19650 project folders

Owner GO (voice, 28 Nov 2026, relayed by Plugin Bot). Logic: `server/src/fmc/iso19650.ts`; tool: `server/src/tools/fmc_iso_folders.ts`; tests: `server/src/fmc/iso19650.test.ts`.

## What it makes (in a new or empty folder only)

```
<project>\
  00_Info\FMC_Project_Info.json, README.txt
  00_Info\Admin\FMC_Access.json        project access rules (central_creators, robots) read by fmc_central rule 5
  00_Info\Admin\FMC_Admin_Log.csv      timestamped admin log
  01_WIP\<Role>\                       ISO "WIP"
  02_Shared\<Role>\                    ISO "Shared"
  03_Published\                        ISO "Published"
  04_Archive\                          ISO "Archived"
  robots\<robot-id>\rights.json, settings.json, logs\
```

## Calls

1. `action=plan`: returns the tree, the file list and a `plan_token`. Show the tree to the person.
2. `action=create, dry_run=false, plan_token=<from plan>`: builds it. A changed plan (or a folder that filled up) is refused.

## Refusals

Not absolute; parent missing; folder exists and is not empty (existing projects are never touched); inside `protected_roots`; inside a CDE gate folder (`02_Shared`…); any path segment naming A-0001 or HEBERT HOSTELS; bad project code, role or robot id. Files are written with `wx` (never overwritten).
