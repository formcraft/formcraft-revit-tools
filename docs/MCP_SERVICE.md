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

## Roll back

The previous server folder is `%USERPROFILE%\mcp\revit-fmc\build.bak-<time>`. The updater copies it back when health fails. To go back by hand: stop the Formcraft MCP task, rename `build` away, rename the `.bak` folder to `build`, start the task. The add-in backup is `%APPDATA%\Autodesk\Revit\Addins\_FormcraftBackup`. Point Claude at `node ...\index.js` with no `--shim` to use stdio again.
