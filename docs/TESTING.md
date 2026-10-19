# Testing

Five layers. Each UI step in `UI_DEVELOPMENT.md` says which ones apply.

## C · CI (every push)
GitHub Actions workflow `Build`: the shell (net8 and net48), the MCP server with its tests, and the add-in for Revit
2025. A step is not done while CI is red.

## P · Preview app (no Revit)
```
dotnet run --project shell/Formcraft.Shell.Preview
```
Runs the shell on mock services. Mock sign-in: any email and password, then code `123456`. Compare each screen
with its board in `design/boards/` (or the central canvas) at 440 px and at 360 px wide.

On the pilot PC, Claude can look at the preview window itself with computer use (screenshots), when that is
switched on for the session.

## R · In Revit 2025 (pilot PC)
1. Build: `dotnet build mcp-servers-for-revit.sln -c "Release R25"`.
2. Install: close Revit, remove the old `mcp-servers-for-revit.addin` if it is there, copy `plugin/Formcraft.addin` and the built `revit_mcp_plugin` folder (from
   `plugin/bin/AddIn 2025 Release/`) into `%APPDATA%\Autodesk\Revit\Addins\2025\`. Keep the previous copy for rollback.
3. Start Revit, open a test file from `_ChainTests` (never a live project for write tests).
4. Check the pane and ribbon against the boards.

## M · Through the Revit MCP
Yes, the Revit MCP can test the plugin. Claude on the pilot PC talks to the running add-in through the MCP server:

- **Today:** the carried tools prove the add-in loads and answers: `fmc_file list_open`, document info, model
  statistics, `fmc_family plan` (read-only), and the live-model lock (a model-changing tool on a live project must
  be refused).
- **After U11:** the `fmc_ui` tool reads the pane's state (signed in, licence, section, banner, footer, open dialog),
  opens sections, switches mock licences in test builds, and saves a screenshot of the pane. That lets Claude walk
  every screen and compare it with the boards without clicking.

Limits: the Revit MCP talks to the add-in, not to Windows, so it can't click buttons in the pane. `fmc_ui` covers
navigation and state; real clicks need a person or computer use.

### Working in the background (issue #85)
The owner keeps the screen while Revit runs minimised, so every Formcraft tool takes **`document`**: a document title
or a full path. It is sent with every command, so a tool works on that document even when another one is active.

| The document named | Read-only tools (facts, checks, measures, QA, issue facts, scans) | Model-changing tools |
|---|---|---|
| Open (active or in the background) | Work on it | Work on it, behind the live-model lock, which checks **this** document |
| Not open, given as a path | Open it in the background (detached, worksets kept, if workshared), read it, close it without saving | Refused: open it first (`OpenDocumentFile` in the background is fine) |
| Not given | The active document, else the only open one, else a clear refusal listing the open ones | Same |

A few things need the document on screen, because they work on the active view or the selection, and say so when it
isn't:
- the missing-tags check on the current view (in the background, pass `sheet` with a sheet number instead)
- assigning a material to the selection
- review clouds and the review context
- QA select

Keep `04_Families\_Staging\FMC_Claude_Workbench.rvt` open (minimised is fine), so Revit always has a document and
the AI connection stays on.

### Templates as data (Phase 1, U29)
`fmc_template recipe` reads the base template's layers from the kit, read-only. The counts should match the hand build
of 14 October: 171 parameters, 42 filters, 81 view templates and 10 schedules. Its `readings` list every choice the
kit's wording left open; each is a kit change request.

To test a rebuild without touching the hand-built file:
1. `fmc_template build` with a new `template_path` in `06_Templates\_Staging` (for example
   `FMC_Base_Template_v2.2_rebuild.rte`), `seed_path` = Revit's Default-Multi-Discipline_Metric.rte, and `dry_run` true.
   Then run it again with `dry_run` false. Revit's shared parameter file must be the kit's.
2. `fmc_template compare` on that file: it should list nothing missing.
3. `fmc_template audit` on that file: expect Pass with 0 warnings, the same as the hand-built file.

A layer that runs out of time (view templates) carries on by itself in slices of about 33 seconds.

### Robot (track R, U33)
The connector `fmc-robot.exe` is built on the pilot PC (`dotnet build connectors/robot`, Robot 2025 installed) into
`server\robot` and is staged beside the server. Use a staging copy of a small frame model, never a live one.
1. `fmc_robot status`: installed true. It never starts Robot.
2. `fmc_robot send` with the engineer's form (supports, cases with nature and self-weight yes/no, engineer), dry run:
   the node, bar and support counts. Members without an analytical model are counted, not sent.
3. The same with `dry_run` false: Robot opens a new frame model, saved as `<reports_dir>\Robot\FEA-yyyymmdd-hhmm.rtd` with
   its `.json` mapping. Check in Robot: bars, sections (unresolved ones are listed), materials, supports, the cases.
4. In Robot the engineer adds the loads; then `fmc_robot calculate` and `fmc_robot results` (dry run): NEd and MEd per member.
5. `results` with `dry_run` false on the staging copy: FMC_FEA_NEd_kN, FMC_FEA_MEd_kNm and FMC_FEA_Run_Ref are set as one
   Undo. FMC_FEA_Approval_Ref stays empty. On a live model it's refused by the lock.

### Navisworks (track N, step 1: read-only)
The add-in `Formcraft.Navis` is built on the pilot PC (`dotnet build connectors/navisworks -c Release`, Navisworks Manage
2025 installed). The updater puts it in `%APPDATA%\Autodesk Navisworks Manage 2025\Plugins\Formcraft.Navis` when Navisworks
is closed. Use a copy of a federated file (NWF or NWD) with clash tests in it.
1. Open Navisworks and the file. View › Windows › Formcraft: the pane says "Listening on 127.0.0.1:8190", lists the models
   and each clash test with its results and New/Active counts. Refresh after running a test by hand.
2. `fmc_navis status`: running, with the file and the number of tests. With Navisworks closed: closed or not found.
3. `fmc_navis tests`, then `fmc_navis results` with a test's name: each clash has both items' Revit Element ID,
   category and source model, and `groups` puts the clashes by model and category pair, largest first.
4. Nothing changes in Navisworks: no test runs, no status changes, no saves.

### Test session script for Claude (pilot PC)
0. **First, `fmc_selftest`** (read-only): the build in Revit and whether it matches the server, the AI connection,
   every command known to Revit, the guard's paths and the kit layout. Fix-first lines are findings; go on when it says
   "Ready to test". Installs come from the Formcraft Updater (it installs a staged build when Revit is closed and never
   closes Revit). Close Revit for an install only when "Safe to close Revit for an install" passes (every open
   document new and unchanged); otherwise ask the user.
1. `git pull`, then build (R step 1). Report any build error and stop.
2. Start the MCP server; confirm `fmc_file list_open` answers.
3. Run the read-only checks above and the live-model refusal check; report pass/fail per line.
4. From U11 on: for each built section, `fmc_ui open_section`, `fmc_ui get_state`, `fmc_ui screenshot_pane`;
   compare with the board; list differences.
5. Write the results to `tests/reports/<date>-<step>.md` and attach them to the pull request.

## U · Unattended Revit tests (no AI, F75)
The checks that say "Built, Revit check due" run by themselves, with no AI and no person: scenarios as data, a runner
that starts its own Revit, and a scheduled task. Nothing is posted to GitHub; a person (or the AI, later) turns the
findings into `test-finding` issues.

**Scenarios** are `tests/revit/<id>.json`, one per scenario, run in file-name order:
- `setup`, `steps`, `teardown`: lists of actions. An action is a CLI tool call (`tool` + `args`, exactly as
  `node build/fmc/cli.js <tool>` takes them), a read-only Revit command (`revit`: `fmc_document_info`,
  `fmc_element_facts` or `fmc_design_options`), `read_json` (a file a step wrote, such as a room build's record) or a
  runner action (`open_in_revit` a scratch file, `close_revit` without saving).
- `checks` on each reply: `no_error`, `is_error`, and on a `path` (`elements.0.unique_id`; in a list, `[key=value]`
  picks the first item whose key is that value and `[key^=value]` the first that starts with it:
  `lines[check^=Hosts].state`): `equals`, `at_least`,
  `at_most` (a list counts its items), `contains`, `matches`, `exists`. No checks means `no_error`. `when` runs a step
  only if a check on earlier replies holds; `repeat_until` runs it again until a check holds (batch_gate).
- Placeholders: `{{run}}`, `{{scenario}}`, `{{attempt}}`, `{{scratch}}` (a new folder per run and try under
  `_ChainTests\_TestRun`), `{{staging}}`, `{{batch_dir}}`, `{{chaintests}}`, `{{templates}}`, `{{kit}}`,
  `{{project_template}}`, `{{scenarios_dir}}` and `{{steps.<id>.<path>}}` (an earlier reply).
- `needs: ["navisworks" | "rhino" | "robot"]`: skipped, with the reason, when that app isn't open. `revit: false`: no
  Revit (offline tools). `skip: "why"`: listed and skipped (a tool not on main yet).
- A test (`server/src/fmc/testrun.test.ts`) parses every scenario and checks each argument is the tool's own, so a
  scenario can't invent arguments. A scenario never passes `revit`: the runner alone says which Revit.

The first set: 01 self-test; 02 and 03 the hospital sample's batches (`batch_DET_LOD400_run.json`,
`batch_QS03_SAMPLE_LOD400_run.json`: dry run, real run, batch_status, batch_gate until nothing is left); 04 Gate A
with the host test on the sample's door, window and operating light; 05 the ICU bay shell built in a scratch project,
its element facts, no hand edits, a rebuild, design options read; 06 the whole sample ICU bay with its families;
07 Mark & Review on a scratch wall (ticket, plan_fix from Revit's facts, apply_fix dry run, the real apply refused
without a person's yes, review show) and selection read and show; 08 3D pictures of the staged ICU bed (3D, front,
plan; one per detail level); 09 offline: the bay's room plan and ceiling designs; 10 schedules from
`tests/schedules/FMC_Schedules_sample.json` (check, plan, apply in a scratch project, plan again); 11 ceiling and
casework place in a scratch room (fmc_ceiling place and fmc_casework place, each a dry run then the real place, the
counts and the placed elements' facts; the staged Vanity stands in for the unbuilt KitchenUnit); 12 to 14 Navisworks, Rhino and Robot (need the app open).

**The runner** (`fmc_testrun`, a tool and a CLI command): `list`; `plan` (dry: what would run now, the power state, the
paths); `run` (a new run; in the background unless `foreground`); `resume` (the last unfinished run; with `auto`, a new
one when the last ended more than 20 hours ago); `status`; `report` (summary.md and the findings as issue drafts).
- **Its own Revit, never the person's.** It starts `C:\Program Files\Autodesk\Revit 2025\Revit.exe` with
  `FMC_UNATTENDED_TEST=1` and `FMC_NO_KEEP_AWAKE=1`, at below-normal priority, and knows it by its pid and the
  process's start time. Every call goes to that pid through the multi-Revit registry (`instances\<pid>.json`, which
  must say `unattended: true`, so an older add-in is refused). A person's Revit can be open beside it and is never
  sent anything. Scratch projects are created from the kit template into `_ChainTests\_TestRun\<run>\<scenario>-<try>`
  (a new folder each time: nothing is saved over), opened by restarting the runner's Revit with that file, and closed
  by ending that Revit without saving.
- **Results** go to `<reports_dir>\testrun\<run>\` (the reports folder, beside the logs and screenshots): one JSON per
  scenario (every try, every reply and check), `summary.md`, `findings.json` (scenario, step, expected, got, and an
  issue draft each) and `png\` with the pictures.
- **Checkpoint**: `%APPDATA%\Formcraft\testrun\<run>.json`, `last.json`, and `runner.lock` (a heartbeat every 30 s);
  `runner.log` follows the run. A scenario that fails runs once more from its setup; passed ones are never run again.
- **Pausing, not keeping awake.** Before each step, and every 60 s while paused, it reads Windows' power state
  (GetSystemPowerStatus): battery saver on pauses; on battery pauses too (`pause_on_battery`, default on). Paused means
  no new step starts; a running step finishes and Revit stays open; it resumes by itself. Its Revit never calls
  SetThreadExecutionState (`FMC_NO_KEEP_AWAKE`), so the PC sleeps as it would anyway.
- **Sleep and shutdown** stop the runner with the PC. On the next start it sees the unfinished run, records the gap
  (the heartbeat's age), and runs the interrupted scenario again from its setup (an interruption isn't counted as a
  try; after 3 the scenario fails). A jump in the clock while it runs (sleep) does the same. If its Revit died, it
  starts a fresh one.
- **Dialogs answered by rule** (KISIC_GAP_SCRIPTS.md §4.3), only in the runner's Revit and only during a job:
  Duplicate Types → OK (the destination's types); warnings are deleted and listed by the bridge's failure handling,
  as for every AI job. Nothing about saving, synchronising, recovery, a crash or an error is ever answered: the dialog
  is recorded with its id (`FMC_Jobs_Revit.jsonl`, now with the Revit's pid), the runner asks Revit to cancel the job,
  records a `dialog` finding naming it, and replaces its Revit before the next scenario. A step with no answer within
  its `timeout_s` (default 900 s) is cancelled the same way.
- Settings: `%APPDATA%\Formcraft\testrun\config.json` (optional): `revit_exe`, `pause_on_battery`, `power_poll_s`,
  `revit_start_timeout_s`, `step_timeout_s`, `project_template` (default the kit's `FMC_A_Template_v2.2.rte`),
  `new_run_after_hours`, `scenarios_dir`.

**Starting it, with no AI:**
- By hand: `powershell -ExecutionPolicy Bypass -File scripts\fmc-testrun.ps1` (resume, or a new run once the last is
  old); `-Mode new -Only 01_selftest` for one scenario. It uses the installed server, else this repo's build.
- On a schedule (the owner runs this once; nothing registers it for you):
  `powershell -ExecutionPolicy Bypass -File scripts\fmc-testrun-schedule.ps1` registers "Formcraft Unattended Revit
  Tests": at logon, after wake and nightly at 02:00 (`-NightlyAt`), on mains power only, never waking the PC, at
  below-normal priority. `-Remove` takes it away.
