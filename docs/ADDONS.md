# Saved add-ons

Saved add-ons move repeat Revit work out of AI-written `send_code_to_revit` code into saved, versioned, tested C#
(KISIC gap plan, `docs/handoff/KISIC_GAP_SCRIPTS.md` §4.2; owner's yes 19 Oct 2026). The AI, or a person, writes a short
JSON of design intent. The add-on does the Revit work and answers with a short summary. A job file or a scheduled task
runs add-ons with **no AI at all**.

- **Where:** `resources/addons/<name>.cs` in this repo. They are checked by CI (`server/src/fmc/addons.test.ts`) and
  copied into `server/build/addons` by the server build (`server/scripts/copy-addons.mjs`), so they ship with the
  server through `scripts/fmc-stage.ps1` and the updater. Each add-on has sample parameters in
  `resources/addons/samples/<name>.params.json`. `FMC_ADDONS_DIR` points the server at another folder (tests).
- **How they run:** through the send_code bridge (`send_code_to_revit`, `transactionMode: "none"`). So they run only where
  a script may run (live-model lock, D1 toggle; CLAUDE.md rule 1), with the bridge's transaction safety (`docs/BRIDGE.md`).

## The format

One `.cs` file per add-on: a C# body (as for `send_code_to_revit`), headed by a `//` comment block:

```
// @addon strips_on_room_walls  @version 1.0  @writes model  @dryrun yes
// @does Perimeter LED strips on the walls of each room at a height …
// @params {"rooms":[],"type":"","height_mm":2850,"walls":"all","switch":"", …}
// @required rooms,type
// @paths out_dir
// @returns {"dry_run":bool,"placed":n,"total_m":x,"skipped":[…],"ids":[…]}
// @usings Newtonsoft.Json.Linq
```

| Tag | Meaning |
|---|---|
| `@addon` | The name: lower case, digits and `_`, the same as the file name |
| `@version` | `1.0`; raise it when the parameters or the answer change |
| `@writes` | `model` (it changes the model) or `none` (reads, or writes files only) |
| `@dryrun` | `yes`: a dry run is supported. Required for `@writes model` |
| `@does` | One line: what it does |
| `@params` | Every parameter with its **default**. The default's JSON type is the parameter's type (`null`: any). It may run over several lines until the JSON is whole |
| `@required` | Parameters a run must give, not empty. Their `@params` value is only a placeholder |
| `@paths` | Parameters naming folders the add-on writes files to. The server checks them with the folder rules (CLAUDE.md rule 2) before the run |
| `@returns` | The shape of the answer, for people and the AI |
| `@usings` | Extra namespaces, as `usings` for `send_code_to_revit` |

The body:

- reads `var args = FmcScript.Params(parameters);` (`parameters[0]` is the JSON object) and
  `bool dryRun = FmcScript.IsDryRun(parameters);` (`parameters[1]` is `"dry"` or `"real"`);
- makes **every** model change inside `FmcScript.Tx(document, name, dryRun, () => { … return summary; })`. It commits,
  rolls back on any exception and rolls a dry run back. Build the summary from plain values (ids, counts, names);
- never opens its own `Transaction` (CI checks this), never hard-codes project coordinates or element ids (inputs come
  from the parameters or the project's JSON), never loads a family (kit data comes from the kit, CLAUDE.md rule 7);
- returns a short object: counts, what was skipped and why, ids only of what a real run made;
- encodes the KISIC lessons (`KISIC_GAP_SCRIPTS.md` §6) and names the ones it relies on in its header.

The server reads the header, refuses unknown parameters, wrong types and missing required ones, fills defaults, and
sends the whole file as the body, so error lines are the file's own lines.

### The first three (ported from the KISIC scripts)

| Add-on | Writes | From | What it does |
|---|---|---|---|
| `export_png_pdf` | none | 03, 24 | PNG check images of views or sheets, PDFs of sheets, into a WIP folder. A dry run lists the views and the files it would write |
| `qa_orphans` | model (only with `rehost`) | 15 | Face-based instances with no host, ones floating off their host's faces, duplicates at one point. With `rehost: true`, a new instance goes on the nearest ceiling, floor or wall face, with Comments, Mark and the family's own parameters copied, and the orphan is deleted |
| `strips_on_room_walls` | model | 04, 15, 18 | A strip per straight wall segment of each room at a height (inset from the corners), on the sides asked for, with an optional vertical corner run; the switch goes in the shared `FMC Switch` parameter; `replace` makes a re-run idempotent |

## Running one

**From Claude or any MCP client:**

```
fmc_scripts addon_list
fmc_scripts addon_run {"name": "qa_orphans", "params": {"rehost": true}}                    ← dry run (the default)
fmc_scripts addon_run {"name": "qa_orphans", "params": {"rehost": true}, "dry_run": false}  ← after the person's yes
```

A run over about 50 s answers with a job id (`fmc_job status` / `result`), like any script.

**From the pane, a button or a script:** the pane runs the same tool code through the server's CLI
(`plugin/Fmc/ServerCli.cs`), with JSON on stdin:

```
node build\fmc\cli.js fmc_scripts < run.json      run.json: {"action":"addon_run","name":"export_png_pdf","params":{…},"dry_run":true}
```

`document` in the JSON picks the Revit document; `revit` picks the Revit when two are open. The pane's Check › Scripts
page still lists kit scripts and runs automations; an add-on list with Run buttons there is still to build.

**In an automation:** a step `"addon:<name>"` runs an add-on, with its parameters in `addon_params`:

```
{"action":"run","name":"Nightly QA","steps":["selftest","addon:qa_orphans","addon:export_png_pdf"],
 "addon_params":{"export_png_pdf":{"views":["E-1001"],"out_dir":"D:\\…\\01_WIP\\E\\_check"}},"dry_run":true}
```

## Job files (no AI)

A job is a JSON list of `{addon, params}`, run in order, stopping at the first failure. Every step is checked (the
add-on exists, its parameters are valid, its folders are allowed) before any step runs, so a bad job never half-runs.

```json
{
  "name": "kisic_relight",
  "dry_run": false,
  "document": "",
  "results_dir": "",
  "steps": [
    { "addon": "qa_orphans", "params": { "categories": ["OST_LightingFixtures"], "rehost": true } },
    { "addon": "strips_on_room_walls", "params": { "rooms": ["06"], "type": "FMC_E_LightFixture_StripLED:14Wpm_24V_3000K", "switch": "L4" } },
    { "addon": "export_png_pdf", "params": { "views": ["FMC Check - Plan"], "out_dir": "D:\\…\\01_WIP\\E\\_check" } }
  ]
}
```

- `dry_run` defaults to **true**. Writing `false` in the job file is the person's yes (CLAUDE.md rule 3): dry-run the job
  once, read the results, then set it to false.
- `document`: the document title or path the job works on (else the active one).
- The results go to `results_dir`, else `<reports_dir>\results\` (`fmc_guard.json`, default `%USERPROFILE%\FMC_Reports`),
  as `<job>_<yyyy-mm-dd_HHMMSS>.json`: every step, its answer or error, its time, where it stopped and what was skipped.
  The `results/` folder in the claude.ai Project holds the tester's measurements. Copy a job's results there when they
  are a measurement.
- While the steps run, `FMC_STARTED_BY` is `job` (kept as `schedule` when a scheduled task started it), so the call
  ledger (F74, `docs/AUTOMATION_BALANCE.md`) counts them as saved add-ons started by a job.

Run it with `fmc_scripts job {"job_file": "D:\\jobs\\kisic_relight.job.json"}`, or with no AI:

```
node "%USERPROFILE%\mcp\revit-fmc\build\fmc\cli.js" fmc_scripts < D:\jobs\kisic_relight.run.json
    kisic_relight.run.json: {"action":"job","job_file":"D:\\jobs\\kisic_relight.job.json"}
```

### Task Scheduler

1. Revit must be open with the document (a job never opens or saves a model; rule 6).
2. Task Scheduler › Create Task: run only when the user is logged on (Revit runs in the person's session).
3. Action: **Start a program**: `cmd.exe`, arguments
   `/c set FMC_STARTED_BY=schedule&& node "%USERPROFILE%\mcp\revit-fmc\build\fmc\cli.js" fmc_scripts < "D:\jobs\kisic_relight.run.json"`.
4. Exit code 0: every step ran. 1: refused or stopped (the results file says why).

## Promoting an add-on to a tool

An add-on that proves itself (used often, stable parameters: the call ledger's "saved add-ons" counts, F74) becomes a
proper tool action:

1. Its logic moves into a command-set handler (`commandset/Commands/Fmc/…`) with the same parameters and answer, and
   its own command name in `WRITE_COMMANDS` or `READ_VIA_SEND_COMMAND` (`server/src/fmc/policy.ts`). A read-only one
   then also works on live models, where the bridge doesn't run (e.g. `export_png_pdf` → `fmc_view screenshot`, §4.6).
2. The server action does its checks before Revit (server check → dry run → one handler → log → pane: CLAUDE.md "How
   work runs"), with tests.
3. The add-on file stays one release with a header note pointing at the tool, then moves to `resources/addons/_retired/`
   so old job files fail with a clear message rather than running stale code.

## Checking the bodies compile

The bridge compiles add-ons in Revit at run time. `tests/addons/AddonCompileCheck.csproj` compiles every add-on the
way the bridge does: the same wrapper, the same transaction rule and tracking (`commandset/Bridge/FmcScriptSource.cs`,
compiled as is), against `RevitAPI.dll` and the built command set. It needs Revit 2025 installed, so it is not in the
solution or in CI:

```
dotnet build commandset/RevitMCPCommandSet.csproj -c "Release R25"
dotnet run --project tests/addons/AddonCompileCheck.csproj
```
