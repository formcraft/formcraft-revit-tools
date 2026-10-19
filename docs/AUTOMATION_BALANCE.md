# Automation balance (F74)

Owner's decisions, 19 Oct 2026: the tracker comes first, before the add-on work; it shows in a pane section, in the
Power BI data model and in the weekly report. The goal is to move work from AI-written code (`send_code_to_revit`)
into plugin tools and saved scripts, and to see the balance between AI and automation. On KISIC, 49 of 78 calls
(63 %) were `send_code_to_revit` (`docs/handoff/kisic_gap_scripts/IMPACT_REPORT.md`).

## The call ledger

The server records every tool call, one JSON line each, in a monthly file on this PC:

```
%APPDATA%\Formcraft\ledger\calls-YYYY-MM.jsonl       every call to the Formcraft server
%APPDATA%\Formcraft\ledger\external-YYYY-MM.jsonl    runs outside the server, from the hooks below
```

`FMC_LEDGER_DIR` moves the folder (the tests use it). A call line:

```json
{"at":"2026-10-19T08:00:00.000Z","tool":"send_code_to_revit","action":"","ok":true,"ms":930,"project":"KISIC",
 "started_by":"ai","purpose":"export sheet PNGs","code_hash":"3f2a9c1b7d40"}
```

- **tool, action** (`args.action` when the tool has one), **ok** (false when the answer is an error or a refusal, or the
  call threw), **ms**.
- **project**: `project_code`, a code in `project`, the front of `project_folder`'s name (`F26001_Clinic` → `F26001`), or
  the front of the call's document (`KISIC-FMC-…` → `KISIC`). Blank when the call names none: Revit is never asked.
- **started_by**: `ai` (an MCP client), `pane` (the pane's `ServerCli`; the Navisworks connector too), `job` (a step of a
  flow or of an `fmc_scripts` automation), `schedule` (Task Scheduler) or `cli` (a command line). The MCP server is `ai`
  unless `FMC_STARTED_BY` says otherwise; the CLI is `cli` unless `FMC_STARTED_BY` says otherwise. A scheduled task sets
  `FMC_STARTED_BY=schedule` in its action; a flow it runs records its steps as `schedule` too.
- **send_code_to_revit only**: `purpose` (the new optional argument, at most 120 characters kept) and `code_hash` (the
  first 12 hex of the SHA-256 of the code, whitespace folded) so a re-send shows. The code itself is never kept.
- **fmc_scripts addon_run only** (when it exists): `addon`, the add-on's name.

What is never written: the arguments, the model's content, the answers, and anyone's name (rule 9: activity never ranks
people). Logging never blocks or fails a call (every write is wrapped and ignored on error), and the ledger is never sent
anywhere. Housekeeping commands of the pane (`specs`, `probe`, `ask_status`) and a person's own acts (release, AI approve)
aren't recorded: they aren't automation.

Where it is wired: `withLedger` in `server/src/fmc/ledger.ts`, installed once in `tools/register.ts` (it wraps every
`server.tool` handler); the CLI records its command in `fmc/cli.ts`; flow steps in `tools/fmc_flow.ts` (`callTool`) and
automation steps in `tools/fmc_scripts.ts`. The pane sets `FMC_STARTED_BY=pane` in `plugin/Fmc/ServerCli.cs`.

## Kinds

| Kind | What |
|---|---|
| AI code | `send_code_to_revit` |
| Plugin tools | `fmc_*` and the other built-in tools, split by who started them |
| Saved add-ons | `fmc_scripts addon_run` (the coming add-on runner, `KISIC_GAP_SCRIPTS.md` §4.2) |
| External automation | pyRevit, Dynamo, Python, Grasshopper, JS, PowerShell, batch and others, from the hooks |

Shares are of calls (runs); time is summed beside them.

## Hooks for outside scripts

Outside scripts run where the server can't see them, so each records its own run with one short function that appends
a line to `external-YYYY-MM.jsonl`: `kind`, `script`, `ok`, `ms`, and optionally `project` and `started_by`
(`FMC_STARTED_BY`, else `person`: run by hand). Every hook swallows its own errors, so it can never fail the script.
Ready-to-paste files are in `resources/hooks/`:

| Where | File | How |
|---|---|---|
| pyRevit (IronPython or CPython) | `fmc_ledger_pyrevit.py` | function at the top of `script.py`, the button's work in the `try` |
| Dynamo Python node | `fmc_ledger_dynamo.py` | in the graph's main Python node, around the node's work |
| Grasshopper (GhPython / Rhino 8) | `fmc_ledger_ghpython.py` | records only when the `run` input is True, so slider drags don't fill the ledger |
| Plain Python | `fmc_ledger.py` | `with fmc_run("python", "fmc_boq_build"): main()`, or `python fmc_ledger.py <kind> <script> [ok\|error] [ms]` |
| JavaScript / Node | `fmc_ledger.js` | `fmcLedger("js", "tidy", ok, Date.now() - t0)`, or `node fmc_ledger.js <kind> <script> [ok\|error] [ms]` |
| PowerShell | `fmc_ledger.ps1` | `& .\fmc_ledger.ps1 -Kind powershell -Script MyScript -Ok $true -Ms 1200`, or the one line in its header |
| Batch | `fmc_ledger.cmd` | one line at the end of the .bat (in its header); keeps the batch file's exit code |

The function, as pasted into a pyRevit, Dynamo or GhPython script (IronPython 2.7 and CPython 3 alike):

```python
def fmc_ledger(kind, script, ok, ms, project=""):
    try:
        import os, io, json, time
        d = os.environ.get("FMC_LEDGER_DIR") or os.path.join(os.environ["APPDATA"], "Formcraft", "ledger")
        if not os.path.isdir(d):
            os.makedirs(d)
        now = time.gmtime()
        line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", now), "kind": kind, "script": script, "ok": bool(ok),
                           "ms": int(ms), "project": project, "started_by": os.environ.get("FMC_STARTED_BY") or "person"})
        with io.open(os.path.join(d, "external-%s.jsonl" % time.strftime("%Y-%m", now)), "a", encoding="utf-8") as f:
            f.write(u"%s\n" % line)
    except Exception:
        pass
```

PowerShell, as one line at the end of a script (`$?` is whether the last command worked):

```powershell
$ok=$?; try { $d=if($env:FMC_LEDGER_DIR){$env:FMC_LEDGER_DIR}else{"$env:APPDATA\Formcraft\ledger"}; $n=(Get-Date).ToUniversalTime(); New-Item -ItemType Directory -Force $d | Out-Null; Add-Content -Encoding UTF8 -Path "$d\external-$($n.ToString('yyyy-MM')).jsonl" -Value (@{at=$n.ToString('yyyy-MM-ddTHH:mm:ssZ');kind='powershell';script='MyScript';ok=$ok;ms=0;started_by=$(if($env:FMC_STARTED_BY){$env:FMC_STARTED_BY}else{'person'})} | ConvertTo-Json -Compress) } catch {}
```

Batch, as one line at the end of a .bat (with `fmc_ledger.ps1` beside it):

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fmc_ledger.ps1" -Kind batch -Script "%~n0" -Ok %ERRORLEVEL% & exit /b %ERRORLEVEL%
```

The kind is normalised when read (`IronPython` → pyrevit, `GhPython` → grasshopper, `node` → js, `pwsh` → powershell,
`bat` → batch; anything else → other).

## `fmc_balance`

Read-only (export writes CSVs, a dry run first). Period: the last `weeks` whole weeks (default 4, Monday to today), or
`from`/`to`. `project` narrows to one project's calls.

- **summary**: total, AI code's share and automation's share; shares by kind, by who started them, the plugin tools by who
  started them, the outside scripts by kind; per project; and a gap-free trend by week (`week` = the Monday).
- **backlog**: the move list. AI-code calls grouped by purpose (case and punctuation folded); a call without a purpose
  joins the purpose its code hash was sent with before, else it groups by its hash. Ranked by calls, then time. Each
  group gets a suggested home from the mapping and that home's status.
- **inventory** (`kit_folder`): the kit's 05_Scripts (read by `fmc/scripts.ts`, as Check › Scripts) beside how often each
  ran (matched by name, file name or pyRevit button folder), the scripts that ran but aren't in the kit, and counts per type.
- **export** (`project_folder`, `dry_run`): `FMC_Balance_Calls.csv` and `FMC_Balance_Backlog.csv` into
  `<project>\01_WIP\_Exchange\Balance` (only that project's calls), or `<reports>\Balance` without a project. The path is
  checked with `checkWritePath`; an older export moves to `Balance\_Archive`.

### The mapping (suggested homes)

Seeded with the KISIC inventory, `docs/handoff/KISIC_GAP_SCRIPTS.md` §3 (script → proposed tool, priority), in
`server/src/fmc/balance_homes.ts` (it ships compiled with the server). A group matches the first entry whose keywords
start a word in its purpose. Add or replace entries without a build in `%APPDATA%\Formcraft\ledger\FMC_Balance_Homes.json`:

```json
[{ "id": "rebar", "keywords": ["rebar", "bar bending"], "home": "fmc_rebar schedule", "priority": "P2", "feature": "F80" }]
```

A new id is matched first; the same id replaces the seed's. **Status**: when an entry names a tracker `feature`, or a
`docs/tracker/features.json` feature mentions its tool action (e.g. `fmc_view screenshot`), the status is the tracker's
(Planned/Designed → planned, In progress/Waiting on you → in progress, Built → built, i.e. merged with the Revit check
due, Tested in Revit → tested); otherwise the entry's own `status`, default planned. The tracker file is found beside
the build (a repo checkout), from `FMC_TRACKER_FILE`, or the `tracker_file` argument.

## Pane: Check › Automation

`shell/Formcraft.Shell/ViewModels/AutomationPage.cs` (interface and mock in `Services/BalanceTools.cs`, the plugin's
`plugin/Shell/RevitBalanceTools.cs` calls the CLI). Period (4, 8 or 12 weeks) and scope (this project or every
project); share bars by kind; who started the plugin tools; the trend by week; outside scripts by kind; the move list
(click for the detail: home, status, priority, the KISIC scripts that did the job, projects); Export for Power BI (dry
run, then a yes). The board `design/boards/manage/PaneAutomation.dc.html` is a placeholder still to draw.

## Weekly report

`fmc_report make` (Weekly project report) adds **Automation balance**: this week's shares by kind, AI code's share this
week against last week (the change in points) and the top 5 of the move list over the last 4 weeks, with the same numbers
as rows in the report's CSV (section `Automation balance`). It counts the project's calls, or every project's when the
ledger names none for the project. Client reports leave it out (internal, like the activity log).

## Power BI

Two tidy tables from `fmc_balance export`:

- `FMC_Balance_Calls.csv`: `week_start, project, kind, sub, started_by, calls, errors, ms` (sub = the tool, or the outside
  script's kind).
- `FMC_Balance_Backlog.csv`: `rank, purpose, calls, errors, ms, code_hashes, projects, home, priority, status,
  tracker_status, feature, first, last`.

The Power BI data model (PR #220, `server/src/hub/powerbi.ts`) isn't merged yet; once it is, add `FMC_Balance_Calls.csv`
as one fact table (`week_start` to the date table, `project` to the project table) and the backlog as a plain table.
