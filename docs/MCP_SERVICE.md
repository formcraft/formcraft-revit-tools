# Formcraft MCP service

One Node process on this PC speaks MCP over Streamable HTTP. Revit stays on 8080-8089. The service listens on **127.0.0.1:8787** only. A bearer token is required. The same tools and the same guards (live-model lock, fail-closed routing, copy-only writes, keynotes) run as on stdio.

## Connect

- URL: `http://127.0.0.1:8787/mcp`
- Header: `Authorization: Bearer <token>`
- Token file: `%APPDATA%\Formcraft\mcp-http.token` (this user only). It is not printed in logs.
- Health: `GET http://127.0.0.1:8787/health` with the same header. Build of the server, add-in builds announced by Revit, which ports answer, queue depth, and any tool that failed to register.
- Tool `fmc_health` returns the same facts. `fmc_queue` is the waiting line only.

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

## Several agents, one Revit

Revit runs one API call at a time. The service accepts many clients and takes turns: one call from each waiting client, then the next, so one bot's batch does not sit in front of the others.

Every model call passes `document` (a title or a full path). With two or more documents open, a call that omits it is refused. The active document is not used as a guess. `fmc_document_info` and `fmc_selftest_facts` may omit it; they are how you see what is open.

Keep a batch to a few dozen rows. The turn boundary is the call. A call that is still waiting answers `[FMC-QUEUED]` and has not failed. `fmc_queue` shows who is running and who is waiting. Queue wait is separate from the time Revit spends on the call.

An element owned by someone else in a workshared model is a row error (`owned by another user`). The service does not synchronise with central. A rolled-back batch is that call's transaction only.

## How a bot runs a batch

One bot, one discipline. Up to five documents can be open. A bot that does not hold the document keeps reading and prepares the next batch.

1. `fmc_batch` `request` with `document`, `label` (this batch's name), `bot` (the discipline, for the day's stats), `est_ops`, and `references`.
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
- **Sync.** Not run. Admin › Automation › Scheduled sync is locked off (rule 6). The sync interval is a reminder a person pastes into Synchronize with Central. `fmc_revit_file` sync still waits for a person's approval. The pane toggles `admin.autosave` and `admin.scheduledsync` are held in memory in the shell (`AdminService.TeamValues`) and `FMC_Team.json` is not written yet, so the server cannot read them.
- **Auto-approve.** On only when `mode` is `testing` and `auto_approve` is true, the same test as the approval queue. It skips that queue for an ordinary model change. It does not skip references, keynotes (`fmc_replace`, Gate A), sync and relinquish, Stop AI, or the live-model lock. `fmc_queue` and `/health` show `approval` as `auto` or `manual`.

`FMC_BATCH_IDLE_S`, `FMC_BATCH_MAX_S` and `FMC_BATCH_REQUIRED_REFS` override the lease timing and the reference categories. They are not the save or approval settings.

## Roll back

The previous server folder is `%USERPROFILE%\mcp\revit-fmc\build.bak-<time>`. The updater copies it back when health fails. To go back by hand: stop the Formcraft MCP task, rename `build` away, rename the `.bak` folder to `build`, start the task. The add-in backup is `%APPDATA%\Autodesk\Revit\Addins\_FormcraftBackup`. Point Claude at `node ...\index.js` with no `--shim` to use stdio again.
