# Formcraft MCP service

One Node process on this PC speaks MCP over Streamable HTTP. Revit stays on 8080-8089. The service listens on **127.0.0.1:8787** only. A bearer token is required. The same tools and the same guards (live-model lock, fail-closed routing, copy-only writes, keynotes) run as on stdio.

## Connect

- URL: `http://127.0.0.1:8787/mcp`
- Header: `Authorization: Bearer <token>`
- Token file: `%APPDATA%\Formcraft\mcp-http.token` (this user only). It is not printed in logs.
- Health: `GET http://127.0.0.1:8787/health` with the same header. Build of the server, add-in builds announced by Revit, which ports answer, queue depth, and any tool that failed to register.
- Tool `fmc_health` returns the same facts. `fmc_queue` lists queued and running jobs (`list`, `cancel`, `purge_stale`). A wait or a refusal includes `busy_reason`. `GET /health` includes the same `busy_reason`.

Claude Desktop can keep stdio and still use this process:

```json
{
  "mcpServers": {
    "formcraft": {
      "command": "node",
      "args": ["C:\\Users\\USER\\mcp\\revit-fmc\\build\\index.js", "--shim"]
    }
  }
}
```

The shim reads the token file. It does not put the token on the command line.

Stdio without `--shim` or `--http` is unchanged.

## Install

Build, then one command:

```
dotnet build plugin/RevitMCPPlugin.csproj -c "Release R25"
npm run build --prefix server
powershell -File scripts/fmc-install.ps1
```

The server swaps in without closing Revit. The script prints `SERVER pass` or `SERVER fail: rolled back`, and `ADD-IN installed` or `ADD-IN waiting: Revit is open`. A failed health check restores the previous server folder. The add-in DLLs install only after Revit is closed. The updater will not close Revit.

A logon task named **Formcraft MCP** (no admin) starts the service, restarts it if it exits, and reloads it when the updater changes the build.

## Crash recovery

`fmc_recover_revit` action `plan` (the default) reports crashed or hung Revit and each document's title, path, workshared state, last sync, last save, and the risk that unsaved work may be lost. It does not close a responsive instance. `apply` needs the `confirm` token from plan, and `force_unsaved=true` when unsaved or unsynced changes were found. The plugin heartbeat, the leased port, `fmc_document_info`, and re-registering the instance need the add-in. `scripts/fmc-recover-revit.ps1` runs the same plan when this server is down. `recovery.documents` in `fmc_guard.json` is the reopen list (architecture, structural, electrical, plumbing, site for the HEBERT HOSTELS models). Empty means reopen what was open. Workshared files are opened as a new local by Revit. Originals are not written.

## The safe project save

`fmc_save_project` saves a project. Pass `title` and `path`. Both must match the open document. A family (`.rfa`, or a document open in the Family Editor) is refused. The live-model lock and the batch lease apply, because the save is `fmc_revit_file` action `save` after those checks. `revit_file` action `save` by itself does not check the title and the path and does not refuse a family.

## Sync auto-approve

`ai_modeller.auto_approve_sync` defaults to false. It does nothing unless `mode` is `testing` and `auto_approve` is true. When it is on, an AI sync uses the same checks for a direct sync, a batch-end sync and the managed timer: a workshared local (not a central, a detached copy, a family or a protected original, and not on `sync_exclude`), the caller holds the active batch lease on that document or no other lease is active, the document is not listed in `damaged_documents` and has no recent corrupt-on-sync dialog in `FMC_Jobs_Revit.jsonl`, the RAM gate is not paused, Stop AI is off, and AI is on for the model. An approval is listed as `auto-approved (sync)`. Relinquish of other people's elements stays manual. Each auto-approval and each refusal is a line in `%APPDATA%\Formcraft\FMC_SyncAutoApprove.jsonl`. `fmc_ai` action `policy` returns the effective approve, save and sync policy and does not write `fmc_guard.json`. `fmc_ai` status shows `sync_auto_approve` and the recent lines. This is server-only.
## Reload a link

`fmc_reload_link` reloads one Revit link type. Pass `document` (a title or a full path) and `link_type_id`. Pass `path` to load that file; omit `path` to reload the link from its current location. Link instances stay where they are. It is a write: the batch lease and the live-model lock apply, and a family, a verification copy, a linked document and a protected original are refused. The reload itself is in the add-in, in a handler that opens no transaction. `send_code_to_revit` cannot do it: `transactionMode` none still opens a transaction group, and Revit 2025 refuses `LoadFrom` and `Reload` while that phase is open. The add-in installs when Revit is closed. The server tool is the check and the call.

`fmc_reload_link` stays the strict reload: `LinkOpenAsHost`, `SameModelAsHost` and `SameCentralModelAsHost` are `FMC-LINK-OPEN-AS-HOST`. It does not close the blocking document. `fmc_links` is the one link tool around it (`audit`, `link`, `pin`, `reload`, `repath`, `unload`, `apply`, `offline`). `on_blocked` `published_copy` (the default on those write actions) links a read-only copy under `01_WIP\_LinkCopies` when the source is open as a host. A workshared source is a detached Save As, not a byte copy, because a byte copy keeps the central identity. The open model is not saved, synced, closed or activated. `dry_run` defaults to true. A closed `.rvt` is audited and its link paths edited only through TransmissionData, and only when the file is not a central, not open, and not under `protected_paths` or `save_exclude`.

Server-side, so a restart of the service is enough: the plan, the path guards and the choice of published copy. Add-in DLL, installed when Revit is next opened: open-document audit (`type_id`), link, pin, reload, repath, unload, the detach Save As, and TransmissionData read/write.

## Several agents, one Revit

Revit runs one API call at a time. The service accepts many clients and takes turns: one call from each waiting client, then the next, so one bot's batch does not sit in front of the others.

Every model call passes `document` (a title or a full path). With two or more documents open, a call that omits it is refused. The active document is not used as a guess. `fmc_document_info` and `fmc_selftest_facts` may omit it; they are how you see what is open.

Keep a batch to a few dozen rows. The turn boundary is the call. A call that is still waiting answers `[FMC-QUEUED]` and has not failed. `fmc_queue` shows who is running and who is waiting. Queue wait is separate from the time Revit spends on the call.

An element owned by someone else in a workshared model is a row error (`owned by another user`). The service does not synchronise with central. A rolled-back batch is that call's transaction only.

## How a bot runs a batch

One bot, one discipline. Up to five documents can be open. A bot that does not hold the document keeps reading and prepares the next batch.

1. `fmc_batch` `request` with `document`, `label` (this batch's name), `bot` (the discipline, for the day's stats), `est_ops`, and `references`. `phase` is optional and is stored on the lease for `fmc_phase` `batch_check`.
   `references` needs at least one id in each required category. The defaults are `kit` (a family or template id), `standards` (a standards-bank clause or design value) and `rulebook` (a rule id or a keynote ref such as `S.FND_01`). A missing category is `[FMC-BATCH-NOREFS]`.
2. If the answer is `queued`, call `wait` with the lease and `timeout_s` of 60 or less, or poll `status`. When the lease is granted the service also sends `notifications/fmc/batch_granted` if the session has a stream.
3. On every model-changing call pass `document` and `batch_lease` (the lease id). The lease is bound to this MCP session as well: another session that copies the id is refused with `[FMC-BATCH-LOCKED]`. Reads omit `batch_lease` and are never blocked.
4. If a gap between writes may be longer than the idle time (120 seconds unless `FMC_BATCH_IDLE_S` says otherwise), call `heartbeat`. A write refreshes the same timer. The hard maximum is 30 minutes (`FMC_BATCH_MAX_S`).
5. `release` with `outcome` `ok` or `failed`, a short `summary`, and `error` when it failed.

A failed release is not put back at the front, and it is never parked. The answer includes `correction`: the error, any matching rulebook `fix_hint`, and a recipe or template suggestion when the kit can be read (`suggestRecipe` names one when the index has no hit). The next `request` with the same `label` (or the same `batch_id`) joins the tail with `attempt` one higher. It must pass `correction` (what changed) and different `references`. The same references come back as `[FMC-BATCH-SAMEFIX]`. That refusal does not use up an attempt. There is no retry cap. A batch whose attempt is greater than 3 is marked `struggling` in `fmc_queue` and `/health`. That flag does not block the line. An expired lease or a disconnect counts as a failure the same way. Nothing is rolled back for you.

Before `release` with `failed`, undo what you committed. One `modify_model` call is already one transaction group: if an op throws, Revit rolls that call back (`Nothing was changed`). A dry run rolls back too. A call that committed answers `batch_id`. `undo_ai_batch` with that id, or with `count` for the calls you committed, takes them back with Revit's Undo, and only if a person's work is not above them. Do that while you still hold the lease (`undo_ai_batch` is a write, so pass `batch_lease`). The server does not undo on expiry.

`fmc_queue` and `GET /health` show the holder, the line, the last 20 batches (duration, summary, references, save, correction), batches with more than 3 attempts (`struggling`), and per-bot totals: batches, average wait, average duration, failures, retries, and the last references.

Different documents can be held at the same time. Their calls still take the fair queue, one Revit call at a time.

On a restart every lease is cleared and a line is written to the log. The token is never logged.

### Save, sync, and approval (the settings that already exist)

The batch line does not add its own switches. It reads `fmc_guard.json` → `ai_modeller`, the same section `fmc_ai` writes.

- **Auto-save.** `auto_save_minutes` (testing default 10, 0 off), applied by the same `autoSave` used after an AI change. After a successful `release`, and before the next bot is granted, the service saves if that rule says the file is due. It does not save a workshared model, a background document, a detached or read-only verification copy, a link, or a protected original. A save that was attempted and failed marks the batch failed, so the next request for that label joins the tail. A skip is not a failure.
- **Sync.** Workshared models sync from `fmc_guard.json` `sync_minutes` (default 15) and `sync_on_batch_end` (default true). The same values apply to every open workshared document. There is no per-file switch. Between batches, after that many minutes of changes, the service saves the local file and calls the existing `fmc_revit_file` sync, which relinquishes elements this user has borrowed. A successful batch does the same before the next bot is granted, while the lease is still held, so other writes queue and reads keep working. A busy central is retried and does not fail the batch. Non-workshared models are autosave only. Stop AI and the live-model lock still refuse the sync. A person's own `fmc_revit_file` sync, without the batch, still waits for approval. `fmc_batch` status, `fmc_queue` and `/health` show `last_sync`, `next_sync` and `last_error` per document.

- **Memory.** `ram_pause_free_mb` in `fmc_guard.json` (default 1024) is still the only threshold. Resume is still 1.5× it (1536). Below 1024 MB free is the hard tier (`FMC-MEMORY-HARD`): every model-changing call waits, and it stays hard until free memory is above 1536 MB so it does not flap. Between 1024 and 1536, while the hard latch is off, is the soft tier (`FMC-MEMORY-SOFT`): reads and small writes continue, and heavy writes, Dynamo and script jobs are queued, not failed. `fmc_batch` request stays queued in both tiers. Reads keep working in both, so the pause can be seen. `/health` shows `memory` with `tier`, `code` and `reason`. `ram_pause_free_mb` 0 turns both tiers off. In the hard tier, `fmc_hw` free runs at idle when that setting is on: it closes spare views and does not add a save.
- **Auto-approve.** On only when `mode` is `testing` and `auto_approve` is true, the same test as the approval queue. It skips that queue for an ordinary model change. It does not skip references, keynotes (`fmc_replace`, Gate A), sync and relinquish, Stop AI, or the live-model lock. `fmc_queue` and `/health` show `approval` as `auto` or `manual`.

`FMC_BATCH_IDLE_S`, `FMC_BATCH_MAX_S` and `FMC_BATCH_REQUIRED_REFS` override the lease timing and the reference categories. They are not the save or approval settings.

## Hardware and memory (`fmc_hw`)

`fmc_hw` is one tool. `scan`, `memory` and `advice` only report. `gpu_prefer`, `free` and `offload` dry-run unless `dry_run` is false. `gpu_prefer` and `offload` also need `confirm:true` before they write. The token is never printed. There is no new guard setting: the pause still uses `ram_pause_free_mb`.

The GPU cannot replace system RAM. Revit's model database, regeneration, transactions and API calls run on the CPU. Video memory holds drawn views. `gpu_prefer` sets the Windows high-performance GPU for `Revit.exe` and does not write `Revit.ini`. `offload` reports hardware acceleration, anti-aliasing and optimize-view-navigation, and writes those ini keys only with `confirm:true`. They take effect the next time Revit starts. Point, clash and ray/voxel samples run on the CPU. An optional GPU library is used only when its result matches the CPU kernel. The add-in builds without that library. `fmc_joins` pressure_test still walks the envelope in Revit on the CPU. The ray sample in `offload` does not replace that walk and does not read the open model. ExportImage stays a Revit API call.

`/health` includes `hw`, filled from the scan cached at startup. See `docs/HW.md`.

## Phases and revisions (`fmc_phase`)

`fmc_phase` is one tool. Every call names `document` (exact title or full path). A missing name is `FMC-DOC-REQUIRED`, no match is `FMC-DOC-NOT-FOUND`, and two matches is `FMC-DOC-AMBIGUOUS`. The active document is not a guess.

`phases`, `audit`, `compare` of two phases, and every dry run read the model through `fmc_phase` (one call, no transaction). `compare` of two revisions reads `%APPDATA%\Formcraft\ledger\FMC_Revisions.jsonl` and does not call Revit. `batch_check`, `revision_open`, `revision_cloud`, `issue` and `unissue` with `dry_run` false go through `fmc_phase_apply`, one transaction, at most 50 operations, and need `batch_lease`. `dry_run` defaults to true. The tool does not save or sync. `save_exclude`, `sync_exclude`, `protected_paths` and `auto_save_minutes` are the guard settings that already exist. Elements another user owns, or that are not current, are skipped.

`phase.*` and `revision.*` are read from `FMC_Standards_Building.json`. A missing key uses a provisional default and cannot PASS. A draft or approved entry with a clause can PASS. A null value is UNKNOWN.

## Joins and the envelope (`fmc_joins`)

`fmc_joins` is one tool. Every model call names `document` (exact title or full path). A missing name is `FMC-DOC-REQUIRED`, no match is `FMC-DOC-NOT-FOUND`, and two matches is `FMC-DOC-AMBIGUOUS`. The active document is not a guess.

`checks` and `limits` stay on the server. `audit`, `hosting`, `pressure_test`, `rooms` and a `fix` dry run each make one `fmc_joins` read. `fix` with `dry_run` false applies the ops from that plan through `fmc_joins_apply`, one transaction, at most 50 operations, and needs `batch_lease`. The tool does not save or sync. `save_exclude`, `sync_exclude` and `protected_paths` come from `fmc_guard.json`. Pinned elements, and elements another user owns or that are not current, are reported and not moved. Ownership is never taken.

Collectors take a level, a category, a bounding box, a room, a space or element ids. An unscoped scan above `joins.scan_cap` is refused. The reply is counts and ids per finding code. The JSON file, and a PNG only when `images` is true, go under `%LOCALAPPDATA%\Formcraft\joins`.

`joins.*` are read from `FMC_Standards_Building.json`. A missing key uses a labelled provisional default and cannot PASS. A draft or approved entry with a clause can PASS. A null status is UNKNOWN. A null value uses the labelled provisional default. A pressure-test sample with no leak is `SEALED` only against a key that can PASS. A capped or unfinished sample is `UNKNOWN`.

## Roll back

The previous server folder is `%USERPROFILE%\mcp\revit-fmc\build.bak-<time>`. The updater copies it back when health fails. To go back by hand: stop the Formcraft MCP task, rename `build` away, rename the `.bak` folder to `build`, start the task. The add-in backup is `%APPDATA%\Autodesk\Revit\Addins\_FormcraftBackup`. Point Claude at `node ...\index.js` with no `--shim` to use stdio again.
