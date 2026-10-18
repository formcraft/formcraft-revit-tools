# The AI–Revit bridge: jobs, scripts, failures and dialogs

How a call from an AI app reaches Revit and comes back, after the Ogala Residence field review (15 Oct 2026,
findings F-030 to F-036 and F-041, issues #122–#128 and #133).

```
AI app ──MCP (stdio)──▶ MCP server (server/) ──TCP 127.0.0.1:8080-8089, JSON-RPC──▶ add-in (plugin/) ──ExternalEvent──▶ command set handler (commandset/)
```

## Jobs (F-030, F-036)

Every call is a **job**; its id is the JSON-RPC request id.

| When | What happens |
|---|---|
| The answer comes within the limit (`FMC_SOFT_TIMEOUT_MS`, 50 s; the MCP client cuts a call at about 60 s) | The tool shows the answer. Nothing is recorded. |
| The limit passes | The tool answers `[FMC-JOB-RUNNING] … still running in Revit (not failed). Job <id>` (send_code: `{"status": "running", "job": …}`). The server records `running` in `%APPDATA%\Formcraft\FMC_Jobs.jsonl` and keeps waiting: up to `FMC_JOB_MAX_MS` (35 min), then for as long as Revit's heartbeats for the job are under 3 min old (F-064). |
| The job finishes later | Its answer goes to `%APPDATA%\Formcraft\FMC_LateResults.jsonl` with `job`, from the server and from Revit itself (`"from": "revit"`), so it is kept even when the server stopped waiting or was restarted (F-064). |
| Revit itself | The add-in writes `running` (after 20 s), a `heartbeat` every minute and `finished` lines, the dialogs it saw and any cancel to `%APPDATA%\Formcraft\FMC_Jobs_Revit.jsonl`, so a job's end is known even if the MCP server that sent it has gone. |

`fmc_job` reads the three files:

- `list`: recent long jobs, newest first, with a state: `running`, `waiting_for_dialog`, `finished`, `failed`,
  `cancelled`, `no_answer`.
- `status <job>`: one job's state, times and the Revit dialog it waits on, if any.
- `result <job>`: the final answer (cut at 30,000 characters).
- `cancel <job>`: a dry run first; with `confirm: true` it writes `%APPDATA%\Formcraft\jobs\cancel\<job>`. Revit is never
  closed or interrupted. The add-in honours it: before a send_code job or an `fmc_*` job that resolves a document starts
  (nothing changed); at `FmcScript.ThrowIfCancelled()` in a script; by rolling back send_code's own transaction instead
  of committing it; and at a transaction commit that raises failures. Transactions already committed stay.
  `fmc_doc` and `fmc_recipe` builds don't check it yet (they can call `FmcAiJob.ThrowIfCancelled()` between ops).

The AI never sends a "still running" call again: it follows the job.

**Long jobs (F-064).** While any command is in flight the add-in tells Windows the system is in use (every 30 s), so the
PC doesn't sleep in the middle of a batch; the screen may still turn off. send_code waits up to 12 h for its script
(`FMC_SEND_CODE_MAX_MS` overrides). A job the server stopped waiting for stays `running` in `fmc_job` while heartbeats
come. Times in the files are UTC (`…Z`); `fmc_job` also gives each one in this PC's local time with its offset
(`local`, e.g. `2026-10-18T09:03:47+03:00`), so they line up with other logs.

**One command at a time, queued (F-064).** Revit's API thread runs one command at a time. A command that arrives while
another runs **waits its turn** in the add-in instead of timing out and being refused: `fmc_job` shows it as `queued`
("waiting in Revit behind N command(s)"), with heartbeats, then `running` when it starts. Its result is kept like any
long job's. While a command runs, `fmc_document_info` answers from its last reading (`"cached": true`, with the time and
why): Revit's interface is frozen during a command, so the active document can't change, and the live-model lock reads
it instead of refusing because Revit was busy. A call for a named `document` is never answered from the cache.

## send_code_to_revit (F-031, F-033, F-034, F-035)

- **Size.** Scripts up to 1,000,000 characters (the server's schema and the add-in both check). The add-in now reads a
  request until its JSON closes (`plugin/Core/JsonFrameReader.cs`); before, it read once into an 8 KB buffer, so a
  request over 8 KB (about a 7–10 KB script once escaped) arrived in pieces, failed to parse, and the server waited for an
  answer that never came. Requests over 16 M characters are refused with `FMC-BRIDGE-TOO-LARGE`.
- **The template.** The script is the body of `object Execute(Document document, object[] parameters)`. Its first line is
  line 1 in every error. Always in scope: `System`, `System.Linq`, `System.Collections.Generic`, `System.Text`,
  `Autodesk.Revit.DB` (+ `.Architecture`, `.Structure`), `Autodesk.Revit.UI`, `RevitMCPCommandSet.Bridge`. Add more with
  `usings` (e.g. `["System.IO", "Autodesk.Revit.DB.Mechanical", "static System.Math"]`; names only).
- **Helpers** (`commandset/Bridge/`): `FmcScript.Mm(mm)` → feet, `FmcScript.ToMm(feet)`, `FmcScript.M2`/`ToM2`,
  `FmcScript.PointMm(x, y, z)`, `FmcScript.Run(document, name, () => …)` (a transaction with the default failures
  handling, for `transactionMode: "none"`), `FmcScript.ThrowIfCancelled()`, and `FmcFailures`, an `IFailuresPreprocessor`
  (warnings deleted and listed, errors roll back), e.g. `stairsScope.Commit(new FmcFailures())`.
- **Document.** The script runs on the call's `document` (title or path) when it names one, else the active one: the
  same document the live-model lock checked (F-025, #110).
- **Answer.** `success`, `result` (JSON text), `compileMs` and `runMs` apart (the first compile in a Revit session
  includes Roslyn's start-up), `job`, `document`, `transaction` (Committed / RolledBack / none), `warnings`, `failures`,
  `dialogs`. On failure `errorCode` and `errorMessage` (`[CODE] text`, English) and `error`:

| Code | Meaning | `error` |
|---|---|---|
| `FMC-CODE-COMPILE` | It didn't compile | `errors[]`: id, line, column, message |
| `FMC-CODE-RUNTIME` | The script threw (unwrapped from TargetInvocationException) | type, message, line, stack |
| `FMC-CODE-ROLLED-BACK` | Revit rolled the transaction back (an error from the failures preprocessor) | Revit's errors in `failures` |
| `FMC-CODE-CANCELLED` | `fmc_job cancel` stopped it | |
| `FMC-CODE-NO-DOCUMENT` | The document named isn't open, or none is | |
| `FMC-CODE-USINGS` | A `usings` entry isn't a namespace | |
| `FMC-CODE-PARAMS` / `FMC-CODE-TOO-LARGE` | No code / over the size limit | |
| `FMC-CODE-BUSY` | Another script is still waiting or running (one at a time); nothing was run | |
| `FMC-CODE-TIMEOUT` | Revit's API thread didn't run or finish the script in 12 h (`FMC_SEND_CODE_MAX_MS`) | |

The other upstream tools' messages are English too, with `[FMC-BRIDGE-TIMEOUT]` and `[FMC-TOOL-FAILED]`.

## Failures and dialogs (F-032)

An AI job is "executing" from the moment its handler starts work (`FmcAiJob.Enter`: `FmcTarget.Resolve` for every
Formcraft handler, send_code itself, and the upstream model-changing handlers) until Revit next goes idle. Only then:

- **Failures.** Transactions send_code and `FmcScript.Run` open carry `FmcFailures`. For any other transaction without a
  preprocessor that handled its failures, the add-in's `FailuresProcessing` handler does the same: **warnings are
  deleted and listed** in the result (e.g. "Elements have duplicate 'Mark' values", "Highlighted walls overlap"), and
  **errors roll the transaction back** with their text (e.g. "Can't keep elements joined") instead of opening Revit's
  error dialog. An error is never resolved by Revit's default resolution behind the person's back.
- **Dialogs** (`DialogBoxShowing`):

| Dialog | Answer | Why |
|---|---|---|
| "Project Not Saved Recently" (the save reminder; matched by an id containing *save* with *remind*, *recent* or *periodic*, or by the English text "not saved recently") | Closed with **Cancel**: the model is **not saved** | Rule 6: a tool never saves. If Revit refuses Cancel, the reminder stays for a person and the job shows `waiting_for_dialog`. |
| Every other dialog | **Not answered**: left for a person | Recorded with its id and text in the job's `dialogs` and in `FMC_Jobs_Revit.jsonl`, so `fmc_job status` says what Revit waits for. |

- **The command set's own notices.** The upstream tools used to open a modal TaskDialog when they failed. They now record
  the notice with the job (`FmcAiJob.Notice`) and never show it; the error is in the tool's result.

Outside an AI job (a person working in Revit) none of this applies: Revit's own dialogs and failure handling are
unchanged.

## For other tools

`commandset/Bridge/FmcFailures.cs` and `FmcAiJob.cs` are shared: a handler that opens its own transactions can attach
`FmcAiJob.Failures` (`FmcAiJob.Failures.Attach(transaction)`) to return the job's warnings, and call
`FmcAiJob.ThrowIfCancelled()` between steps.
